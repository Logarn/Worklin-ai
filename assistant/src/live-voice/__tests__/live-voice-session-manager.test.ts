import { describe, expect, mock, test } from "bun:test";

import {
  type LiveVoiceSession,
  type LiveVoiceSessionCloseReason,
  type LiveVoiceSessionFactoryContext,
  LiveVoiceSessionManager,
  LiveVoiceSessionStartupError,
} from "../live-voice-session-manager.js";
import type {
  LiveVoiceClientFrame,
  LiveVoiceClientStartFrame,
  LiveVoiceServerFrame,
} from "../protocol.js";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

interface TestSession extends LiveVoiceSession {
  readonly clientFrames: LiveVoiceClientFrame[];
  readonly binaryChunks: Uint8Array[];
  readonly closeReasons: LiveVoiceSessionCloseReason[];
}

function createTestSession(overrides: Partial<LiveVoiceSession> = {}) {
  const session: TestSession = {
    clientFrames: [],
    binaryChunks: [],
    closeReasons: [],
    start: mock(() => {}),
    handleClientFrame: mock((frame: LiveVoiceClientFrame) => {
      session.clientFrames.push(frame);
    }),
    handleBinaryAudio: mock((chunk: Uint8Array) => {
      session.binaryChunks.push(chunk);
    }),
    close: mock((reason: LiveVoiceSessionCloseReason) => {
      session.closeReasons.push(reason);
    }),
    ...overrides,
  };
  return session;
}

function createSink() {
  const frames: LiveVoiceServerFrame[] = [];
  return {
    frames,
    sink: {
      sendFrame: mock((frame: LiveVoiceServerFrame) => {
        frames.push(frame);
      }),
    },
  };
}

describe("LiveVoiceSessionManager", () => {
  test("creates and starts the first accepted live voice session", async () => {
    const sessions: TestSession[] = [];
    const contexts: LiveVoiceSessionFactoryContext[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: (context) => {
        contexts.push(context);
        const session = createTestSession({
          start: mock(async () => {
            await context.sendFrame({
              type: "ready",
              sessionId: context.sessionId,
              conversationId:
                context.startFrame.conversationId ?? "conversation-new",
            });
          }),
        });
        sessions.push(session);
        return session;
      },
    });
    const { frames, sink } = createSink();

    const result = await manager.startSession(START_FRAME, sink);

    expect(result).toEqual({ status: "accepted", sessionId: "session-1" });
    expect(manager.activeSessionId).toBe("session-1");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionId).toBe("session-1");
    expect(contexts[0]?.startFrame).toEqual(START_FRAME);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-1",
        conversationId: "conversation-123",
      },
    ]);
  });

  test("carries the authenticated tenant and owner identity into session creation", async () => {
    let received: LiveVoiceSessionFactoryContext | undefined;
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-tenant",
      createSession: (context) => {
        received = context;
        return createTestSession();
      },
    });
    const tenantContext = {
      version: 1 as const,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      actorId: "vellum-principal-user-1",
      requestId: "request-1",
    };
    const ownerTrust = {
      actorPrincipalId: tenantContext.actorId,
      userId: tenantContext.userId,
    };

    await manager.startSession(START_FRAME, createSink().sink, {
      tenantContext,
      ownerTrust,
    });

    expect(received?.tenantContext).toEqual(tenantContext);
    expect(received?.ownerTrust).toEqual(ownerTrust);
  });

  test("rejects concurrent start attempts with a busy frame", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();

    const accepted = await manager.startSession(START_FRAME, first.sink);
    const rejected = await manager.startSession(START_FRAME, second.sink);

    expect(accepted).toEqual({ status: "accepted", sessionId: "session-1" });
    expect(rejected).toEqual({
      status: "busy",
      activeSessionId: "session-1",
      frame: {
        type: "busy",
        seq: 1,
        activeSessionId: "session-1",
      },
    });
    expect(second.frames).toEqual([
      {
        type: "busy",
        seq: 1,
        activeSessionId: "session-1",
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledTimes(1);
  });

  test("releases the active session once for repeated close events", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const firstRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );
    const secondRelease = await manager.releaseSession(
      "session-1",
      "websocket_close",
    );

    expect(firstRelease).toEqual({
      released: true,
      sessionId: "session-1",
    });
    expect(secondRelease).toEqual({ released: false });
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(session.closeReasons).toEqual(["websocket_close"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock on a normal end frame", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession();
        sessions.push(session);
        return session;
      },
    });

    await manager.startSession(START_FRAME, createSink().sink);
    const result = await manager.handleClientFrame("session-1", {
      type: "end",
    });
    const next = await manager.startSession(START_FRAME, createSink().sink);

    expect(result).toEqual({ status: "handled", sessionId: "session-1" });
    expect(sessions[0]?.clientFrames).toEqual([{ type: "end" }]);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.closeReasons).toEqual(["client_end"]);
    expect(next).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(sessions).toHaveLength(2);
  });

  test("releases the lock when session start throws", async () => {
    const sessions: TestSession[] = [];
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(() => {
                  throw new Error("session start failed");
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    await expect(
      manager.startSession(START_FRAME, createSink().sink),
    ).rejects.toThrow("session start failed");
    const retry = await manager.startSession(START_FRAME, createSink().sink);

    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock without rethrowing terminal startup failures", async () => {
    const sessions: TestSession[] = [];
    const first = createSink();
    const second = createSink();
    const startupErrorMessage = "Live voice transcription could not be started";
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: (context) => {
        const session = createTestSession(
          context.sessionId === "session-1"
            ? {
                start: mock(async () => {
                  await context.sendFrame({
                    type: "error",
                    code: "invalid_field",
                    message: startupErrorMessage,
                  });
                  throw new LiveVoiceSessionStartupError(startupErrorMessage);
                }),
              }
            : {},
        );
        sessions.push(session);
        return session;
      },
    });

    const failed = await manager.startSession(START_FRAME, first.sink);
    const retry = await manager.startSession(START_FRAME, second.sink);

    expect(failed).toEqual({ status: "failed", sessionId: "session-1" });
    expect(first.frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "invalid_field",
        message: startupErrorMessage,
      },
    ]);
    expect(sessions[0]?.closeReasons).toEqual(["error"]);
    expect(retry).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("releases the lock when session frame handling throws", async () => {
    const session = createTestSession({
      handleClientFrame: mock(() => {
        throw new Error("client frame failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleClientFrame("session-1", { type: "interrupt" }),
    ).rejects.toThrow("client frame failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("releases the lock when binary audio handling throws", async () => {
    const session = createTestSession({
      handleBinaryAudio: mock(() => {
        throw new Error("binary audio failed");
      }),
    });
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    await expect(
      manager.handleBinaryAudio("session-1", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow("binary audio failed");
    expect(session.closeReasons).toEqual(["error"]);
    expect(manager.activeSessionId).toBeNull();
  });

  test("ignores stale session ids without releasing the active lock", async () => {
    const session = createTestSession();
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-1",
      createSession: () => session,
    });

    await manager.startSession(START_FRAME, createSink().sink);

    expect(
      await manager.handleClientFrame("session-stale", { type: "end" }),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.handleBinaryAudio("session-stale", new Uint8Array([1])),
    ).toEqual({ status: "not_found" });
    expect(
      await manager.releaseSession("session-stale", "websocket_close"),
    ).toEqual({ released: false });
    expect(session.close).not.toHaveBeenCalled();
    expect(manager.activeSessionId).toBe("session-1");
  });

  test("holds the session lock until close completes", async () => {
    const sessions: TestSession[] = [];
    let resolveClose: (() => void) | undefined;
    const manager = new LiveVoiceSessionManager({
      createSessionId: mock(() => `session-${sessions.length + 1}`),
      createSession: () => {
        const session = createTestSession({
          close: mock(
            (reason: LiveVoiceSessionCloseReason) =>
              new Promise<void>((resolve) => {
                sessions[sessions.length - 1]?.closeReasons.push(reason);
                resolveClose = resolve;
              }),
          ),
        });
        sessions.push(session);
        return session;
      },
    });
    const first = createSink();
    const second = createSink();
    const third = createSink();

    await manager.startSession(START_FRAME, first.sink);
    const releasePromise = manager.releaseSession("session-1", "client_end");
    const concurrent = await manager.startSession(START_FRAME, second.sink);
    const concurrentDispatch = await manager.handleClientFrame("session-1", {
      type: "interrupt",
    });

    expect(concurrent).toEqual({
      status: "busy",
      activeSessionId: "session-1",
      frame: { type: "busy", seq: 1, activeSessionId: "session-1" },
    });
    expect(concurrentDispatch).toEqual({ status: "not_found" });
    expect(sessions).toHaveLength(1);

    resolveClose?.();
    await releasePromise;

    const next = await manager.startSession(START_FRAME, third.sink);
    expect(next).toEqual({ status: "accepted", sessionId: "session-2" });
    expect(manager.activeSessionId).toBe("session-2");
  });

  test("registers native voice identity and releases its lifecycle fence on close", async () => {
    const registerSession = mock(() => {});
    const unregisterSession = mock(() => {});
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-tenant",
      createSession: () => createTestSession(),
      lifecycle: {
        registerSession,
        isSessionCurrent: () => true,
        unregisterSession,
      },
    });
    const identity = {
      tenantContext: {
        version: 1 as const,
        organizationId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        actorId: "actor-1",
        requestId: "request-1",
      },
    };

    await manager.startSession(START_FRAME, createSink().sink, identity);
    await manager.releaseSession("session-tenant", "client_end");

    expect(registerSession).toHaveBeenCalledWith({
      sessionId: "session-tenant",
      identity,
    });
    expect(unregisterSession).toHaveBeenCalledWith("session-tenant");
    expect(manager.activeSessionId).toBeNull();
  });

  test("closes native voice and drops outbound callbacks after its lease becomes stale", async () => {
    let current = true;
    let context: LiveVoiceSessionFactoryContext | undefined;
    const session = createTestSession();
    const unregisterSession = mock(() => {});
    const manager = new LiveVoiceSessionManager({
      createSessionId: () => "session-lease",
      createSession: (value) => {
        context = value;
        return session;
      },
      lifecycle: {
        registerSession: () => {},
        isSessionCurrent: () => current,
        unregisterSession,
      },
    });
    const sink = createSink();
    await manager.startSession(START_FRAME, sink.sink);
    current = false;

    await expect(
      context!.sendFrame({
        type: "thinking",
        turnId: "turn-stale",
      }),
    ).rejects.toThrow("lease is stale");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sink.frames).toEqual([]);
    expect(session.closeReasons).toEqual(["error"]);
    expect(unregisterSession).toHaveBeenCalledWith("session-lease");
    expect(manager.activeSessionId).toBeNull();
  });

  test("does not import runtime, gateway, provider, or conversation modules", async () => {
    const source = await Bun.file(
      new URL("../live-voice-session-manager.ts", import.meta.url),
    ).text();
    const imports = Array.from(
      source.matchAll(/from\s+["']([^"']+)["']/g),
      (match) => match[1],
    );

    expect(imports).toEqual(["node:crypto", "./protocol.js"]);
    for (const importPath of imports) {
      expect(importPath).not.toContain("runtime");
      expect(importPath).not.toContain("gateway");
      expect(importPath).not.toContain("stt");
      expect(importPath).not.toContain("tts");
      expect(importPath).not.toContain("conversation");
    }
  });
});
