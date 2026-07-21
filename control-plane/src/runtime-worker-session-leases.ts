import type { RuntimeWorkerProductionCoordinator } from "./runtime-worker-production-coordinator.js";
import type {
  RuntimeWorkerRequestFinishResult,
  RuntimeWorkerRouteIdentity,
  RuntimeWorkerRouteTimer,
} from "./runtime-worker-request-router.js";

const MAX_VOICE_SESSION_TTL_MS = 31 * 60 * 1_000;
const DEFAULT_MAX_HELD_SESSIONS = 1_000;

interface HeldRuntimeSession {
  kind: "live_voice";
  sessionId: string;
  requestHandle: string;
  identity: RuntimeWorkerRouteIdentity;
  expiresAtMs: number;
  expiryTimer: unknown;
}

export interface RuntimeWorkerSessionLeaseRegistryOptions {
  coordinator: Pick<RuntimeWorkerProductionCoordinator, "finishRequest">;
  timer: RuntimeWorkerRouteTimer;
  nowMs?: () => number;
  maxHeldSessions?: number;
  onReleaseFailure?: (input: {
    sessionId: string;
    result: RuntimeWorkerRequestFinishResult | null;
  }) => void;
}

export type HoldRuntimeVoiceSessionResult =
  | { status: "held" | "already_held" }
  | {
      status: "rejected";
      reason:
        | "invalid_session"
        | "invalid_expiry"
        | "capacity_exhausted"
        | "session_conflict";
    };

/**
 * Keeps a pooled worker lease alive after the short HTTP bootstrap request
 * returns. The retained request handle is released only by the authenticated
 * session DELETE or its bounded expiry timer.
 */
export class RuntimeWorkerSessionLeaseRegistry {
  private readonly held = new Map<string, HeldRuntimeSession>();
  private readonly nowMs: () => number;
  private readonly maxHeldSessions: number;

  constructor(private readonly options: RuntimeWorkerSessionLeaseRegistryOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.maxHeldSessions =
      options.maxHeldSessions ?? DEFAULT_MAX_HELD_SESSIONS;
    if (
      !Number.isSafeInteger(this.maxHeldSessions) ||
      this.maxHeldSessions < 1
    ) {
      throw new Error("Runtime held-session capacity is invalid.");
    }
  }

  holdLiveVoiceSession(input: {
    sessionId: string;
    requestHandle: string;
    identity: RuntimeWorkerRouteIdentity;
    expiresAtMs: number;
  }): HoldRuntimeVoiceSessionResult {
    if (
      !validOpaqueId(input.sessionId) ||
      !validOpaqueId(input.requestHandle) ||
      !validIdentity(input.identity)
    ) {
      return { status: "rejected", reason: "invalid_session" };
    }
    const now = this.nowMs();
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(input.expiresAtMs) ||
      input.expiresAtMs <= now ||
      input.expiresAtMs - now > MAX_VOICE_SESSION_TTL_MS
    ) {
      return { status: "rejected", reason: "invalid_expiry" };
    }

    const existing = this.held.get(input.sessionId);
    if (existing) {
      return existing.requestHandle === input.requestHandle &&
        sameIdentity(existing.identity, input.identity) &&
        existing.expiresAtMs === input.expiresAtMs
        ? { status: "already_held" }
        : { status: "rejected", reason: "session_conflict" };
    }
    if (this.held.size >= this.maxHeldSessions) {
      return { status: "rejected", reason: "capacity_exhausted" };
    }

    const expiryTimer = this.options.timer.schedule(
      () => this.releaseExpiredSession(input.sessionId),
      input.expiresAtMs - now,
    );
    this.held.set(input.sessionId, {
      kind: "live_voice",
      sessionId: input.sessionId,
      requestHandle: input.requestHandle,
      identity: { ...input.identity },
      expiresAtMs: input.expiresAtMs,
      expiryTimer,
    });
    return { status: "held" };
  }

  async releaseLiveVoiceSession(input: {
    sessionId: string;
    identity: RuntimeWorkerRouteIdentity;
  }): Promise<RuntimeWorkerRequestFinishResult | null> {
    const existing = this.held.get(input.sessionId);
    if (!existing || !sameIdentity(existing.identity, input.identity)) {
      return null;
    }
    this.held.delete(existing.sessionId);
    this.options.timer.cancel(existing.expiryTimer);
    return this.finish(existing);
  }

  hasLiveVoiceSession(
    sessionId: string,
    identity: RuntimeWorkerRouteIdentity,
  ): boolean {
    const existing = this.held.get(sessionId);
    return (
      !!existing &&
      existing.expiresAtMs > this.nowMs() &&
      sameIdentity(existing.identity, identity)
    );
  }

  sizeForTesting(): number {
    return this.held.size;
  }

  private async releaseExpiredSession(
    sessionId: string,
  ): Promise<void> {
    const existing = this.held.get(sessionId);
    if (!existing) return;
    this.held.delete(sessionId);
    await this.finish(existing);
  }

  private async finish(
    session: HeldRuntimeSession,
  ): Promise<RuntimeWorkerRequestFinishResult | null> {
    let result: RuntimeWorkerRequestFinishResult | null = null;
    try {
      result = await this.options.coordinator.finishRequest({
        requestHandle: session.requestHandle,
        identity: session.identity,
      });
      if (
        result.status === "release_failed" ||
        result.status === "route_handle_mismatch" ||
        result.status === "unknown_request"
      ) {
        this.options.onReleaseFailure?.({
          sessionId: session.sessionId,
          result,
        });
      }
      return result;
    } catch {
      this.options.onReleaseFailure?.({
        sessionId: session.sessionId,
        result: null,
      });
      return null;
    }
  }
}

export function parsePooledVoiceSessionBootstrap(value: unknown): {
  sessionId: string;
  expiresAtMs: number;
} | null {
  if (!isRecord(value)) return null;
  const sessionId = value.sessionId;
  const expiresAt = value.expiresAt;
  if (
    !validOpaqueId(sessionId) ||
    typeof expiresAt !== "string" ||
    !expiresAt
  ) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  return { sessionId, expiresAtMs };
}

export function parseManagedPooledVoiceSessionBootstrap(value: unknown): {
  sessionId: string;
  expiresAtMs: number;
} | null {
  if (!isRecord(value)) return null;
  const connection = isRecord(value.connection) ? value.connection : null;
  if (
    value.engine !== "hume" ||
    connection?.transport !== "hume"
  ) {
    return null;
  }
  return parsePooledVoiceSessionBootstrap(value);
}

export function isLiveVoiceSessionBootstrapPath(
  method: string,
  pathname: string,
): boolean {
  return (
    method.toUpperCase() === "POST" &&
    /^\/v1\/assistants\/[^/]+\/live-voice\/sessions\/?$/u.test(pathname)
  );
}

export function liveVoiceSessionReleaseId(
  method: string,
  pathname: string,
): string | null {
  if (method.toUpperCase() !== "DELETE") return null;
  const match =
    /^\/v1\/assistants\/[^/]+\/live-voice\/sessions\/([^/]+)\/?$/u.exec(
      pathname,
    );
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return validOpaqueId(decoded) &&
      !decoded.includes("/") &&
      !decoded.includes("\\") &&
      encodeURIComponent(decoded) === match[1]
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function sameIdentity(
  left: RuntimeWorkerRouteIdentity,
  right: RuntimeWorkerRouteIdentity,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.userId === right.userId &&
    left.assistantId === right.assistantId &&
    left.actorId === right.actorId
  );
}

function validIdentity(value: RuntimeWorkerRouteIdentity): boolean {
  return (
    validOpaqueId(value.organizationId) &&
    validOpaqueId(value.userId) &&
    validOpaqueId(value.assistantId) &&
    validOpaqueId(value.actorId)
  );
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
