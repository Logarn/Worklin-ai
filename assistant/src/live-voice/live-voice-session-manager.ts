import { randomUUID } from "node:crypto";

import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type MaybePromise<T> = T | Promise<T>;

export type LiveVoiceSessionCloseReason =
  | "client_end"
  | "error"
  | "websocket_close"
  | "manager_shutdown";

export interface LiveVoiceSession {
  start(): MaybePromise<void>;
  handleClientFrame(frame: LiveVoiceClientFrame): MaybePromise<void>;
  handleBinaryAudio(chunk: Uint8Array): MaybePromise<void>;
  close(reason: LiveVoiceSessionCloseReason): MaybePromise<void>;
}

export interface LiveVoiceServerFrameSink {
  sendFrame(frame: LiveVoiceServerFrame): MaybePromise<void>;
}

export interface LiveVoiceSessionFactoryContext {
  sessionId: string;
  startFrame: LiveVoiceClientStartFrame;
  tenantContext?: LiveVoiceTenantContext;
  ownerTrust?: LiveVoiceOwnerTrust;
  sendFrame(frame: LiveVoiceServerFramePayload): Promise<LiveVoiceServerFrame>;
}

export interface LiveVoiceTenantContext {
  version: 1;
  organizationId: string;
  userId: string;
  assistantId: string;
  actorId: string;
  requestId: string;
}

export interface LiveVoiceOwnerTrust {
  actorPrincipalId: string;
  userId: string;
}

export interface LiveVoiceSessionLeaseIdentity {
  tenant: {
    orgId: string;
    assistantId: string;
  };
  workerStackId: string;
  generation: number;
}

export interface LiveVoiceSessionIdentityContext {
  tenantContext?: LiveVoiceTenantContext;
  ownerTrust?: LiveVoiceOwnerTrust;
  pooledWorkerLease?: LiveVoiceSessionLeaseIdentity;
}

export type LiveVoiceSessionFactory = (
  context: LiveVoiceSessionFactoryContext,
) => LiveVoiceSession;

export interface LiveVoiceSessionLifecycle {
  registerSession(input: {
    sessionId: string;
    identity: LiveVoiceSessionIdentityContext;
  }): MaybePromise<void>;
  isSessionCurrent(sessionId: string): MaybePromise<boolean>;
  unregisterSession(sessionId: string): MaybePromise<void>;
}

export interface LiveVoiceSessionManagerOptions {
  createSession: LiveVoiceSessionFactory;
  createSessionId?: () => string;
  lifecycle?: LiveVoiceSessionLifecycle;
}

export class LiveVoiceSessionStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveVoiceSessionStartupError";
  }
}

export type LiveVoiceStartSessionResult =
  | {
      status: "accepted";
      sessionId: string;
    }
  | {
      status: "failed";
      sessionId: string;
    }
  | {
      status: "busy";
      activeSessionId: string;
      frame: LiveVoiceServerFrame;
    };

export type LiveVoiceSessionDispatchResult =
  | {
      status: "handled";
      sessionId: string;
    }
  | {
      status: "not_found";
    };

export type LiveVoiceSessionReleaseResult =
  | {
      released: true;
      sessionId: string;
    }
  | {
      released: false;
    };

interface ActiveLiveVoiceSession {
  sessionId: string;
  session: LiveVoiceSession;
  closing: boolean;
  lifecycleRegistered: boolean;
}

export class LiveVoiceSessionManager {
  private readonly createSession: LiveVoiceSessionFactory;
  private readonly createSessionId: () => string;
  private readonly lifecycle: LiveVoiceSessionLifecycle | undefined;
  private activeSession: ActiveLiveVoiceSession | null = null;

  constructor(options: LiveVoiceSessionManagerOptions) {
    this.createSession = options.createSession;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.lifecycle = options.lifecycle;
  }

  get activeSessionId(): string | null {
    return this.activeSession?.sessionId ?? null;
  }

  async startSession(
    startFrame: LiveVoiceClientStartFrame,
    sink: LiveVoiceServerFrameSink,
    identity: LiveVoiceSessionIdentityContext = {},
  ): Promise<LiveVoiceStartSessionResult> {
    const existingSessionId = this.activeSessionId;
    if (existingSessionId !== null) {
      const busySequencer = createLiveVoiceServerFrameSequencer();
      const frame = busySequencer.next({
        type: "busy",
        activeSessionId: existingSessionId,
      });
      await sink.sendFrame(frame);
      return {
        status: "busy",
        activeSessionId: existingSessionId,
        frame,
      };
    }

    const sessionId = this.createSessionId();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const context: LiveVoiceSessionFactoryContext = {
      sessionId,
      startFrame,
      ...identity,
      sendFrame: async (payload) => {
        if (!(await this.isSessionCurrent(sessionId))) {
          this.scheduleStaleSessionRelease(sessionId);
          throw new Error("Live voice session lease is stale.");
        }
        const frame = sequencer.next(payload);
        await sink.sendFrame(frame);
        return frame;
      },
    };
    const session = this.createSession(context);
    const active: ActiveLiveVoiceSession = {
      sessionId,
      session,
      closing: false,
      lifecycleRegistered: false,
    };
    this.activeSession = active;

    try {
      await this.lifecycle?.registerSession({ sessionId, identity });
      active.lifecycleRegistered = this.lifecycle !== undefined;
      await session.start();
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      if (err instanceof LiveVoiceSessionStartupError) {
        return { status: "failed", sessionId };
      }
      throw err;
    }

    return { status: "accepted", sessionId };
  }

  async handleClientFrame(
    sessionId: string,
    frame: LiveVoiceClientFrame,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    if (!(await this.isSessionCurrent(sessionId))) {
      await this.releaseSession(sessionId, "error");
      return { status: "not_found" };
    }

    try {
      await active.session.handleClientFrame(frame);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    if (frame.type === "end") {
      await this.releaseSession(sessionId, "client_end");
    }

    return { status: "handled", sessionId };
  }

  async handleBinaryAudio(
    sessionId: string,
    chunk: Uint8Array,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    if (!(await this.isSessionCurrent(sessionId))) {
      await this.releaseSession(sessionId, "error");
      return { status: "not_found" };
    }

    try {
      await active.session.handleBinaryAudio(chunk);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    return { status: "handled", sessionId };
  }

  async releaseSession(
    sessionId: string,
    reason: LiveVoiceSessionCloseReason = "websocket_close",
  ): Promise<LiveVoiceSessionReleaseResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { released: false };
    }

    active.closing = true;
    try {
      await active.session.close(reason);
    } finally {
      try {
        if (active.lifecycleRegistered) {
          await this.lifecycle?.unregisterSession(sessionId);
        }
      } finally {
        if (this.activeSession === active) {
          this.activeSession = null;
        }
      }
    }
    return { released: true, sessionId };
  }

  private findActiveSession(sessionId: string): ActiveLiveVoiceSession | null {
    const active = this.activeSession;
    if (active === null || active.sessionId !== sessionId || active.closing) {
      return null;
    }

    return active;
  }

  private async releaseAfterSessionError(sessionId: string): Promise<void> {
    try {
      await this.releaseSession(sessionId, "error");
    } catch {
      // The original session error is more useful to callers than a cleanup error.
    }
  }

  private async isSessionCurrent(sessionId: string): Promise<boolean> {
    const active = this.activeSession;
    if (
      active === null ||
      active.sessionId !== sessionId ||
      active.closing ||
      !active.lifecycleRegistered
    ) {
      return this.lifecycle === undefined && active?.sessionId === sessionId;
    }
    try {
      return (await this.lifecycle?.isSessionCurrent(sessionId)) === true;
    } catch {
      return false;
    }
  }

  private scheduleStaleSessionRelease(sessionId: string): void {
    queueMicrotask(() => {
      void this.releaseSession(sessionId, "error").catch(() => {});
    });
  }
}
