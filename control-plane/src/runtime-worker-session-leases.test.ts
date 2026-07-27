import { describe, expect, test } from "bun:test";

import {
  isLiveVoiceSessionBootstrapPath,
  liveVoiceSessionReleaseId,
  parseManagedPooledVoiceSessionBootstrap,
  parsePooledVoiceSessionBootstrap,
  RuntimeWorkerSessionLeaseRegistry,
} from "./runtime-worker-session-leases.js";
import type {
  RuntimeWorkerRequestFinishResult,
  RuntimeWorkerRouteIdentity,
  RuntimeWorkerRouteTimer,
} from "./runtime-worker-request-router.js";

const IDENTITY: RuntimeWorkerRouteIdentity = {
  organizationId: "org-a",
  userId: "user-a",
  assistantId: "assistant-a",
  actorId: "actor-a",
};

class DeterministicTimer implements RuntimeWorkerRouteTimer {
  private nextId = 1;
  readonly callbacks = new Map<number, () => Promise<void>>();

  schedule(callback: () => Promise<void>): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  async runOne(): Promise<void> {
    const entry = this.callbacks.entries().next().value as
      | [number, () => Promise<void>]
      | undefined;
    if (!entry) throw new Error("No timer.");
    this.callbacks.delete(entry[0]);
    await entry[1]();
  }
}

function harness() {
  const timer = new DeterministicTimer();
  const finishes: Array<{
    requestHandle: string;
    identity: RuntimeWorkerRouteIdentity;
  }> = [];
  const finishResult: RuntimeWorkerRequestFinishResult = {
    status: "release_scheduled",
  };
  const registry = new RuntimeWorkerSessionLeaseRegistry({
    coordinator: {
      finishRequest: async (input) => {
        finishes.push(input);
        return finishResult;
      },
    },
    timer,
    nowMs: () => 1_000,
    maxHeldSessions: 2,
  });
  return { timer, finishes, registry };
}

describe("pooled runtime held session leases", () => {
  test("retains the bootstrap request handle until explicit release", async () => {
    const { finishes, registry, timer } = harness();
    expect(
      registry.holdLiveVoiceSession({
        sessionId: "voice-1",
        requestHandle: "request-1",
        identity: IDENTITY,
        expiresAtMs: 31_000,
      }),
    ).toEqual({ status: "held" });
    expect(registry.hasLiveVoiceSession("voice-1", IDENTITY)).toBe(true);
    expect(finishes).toHaveLength(0);

    expect(
      await registry.releaseLiveVoiceSession({
        sessionId: "voice-1",
        identity: IDENTITY,
      }),
    ).toEqual({ status: "release_scheduled" });
    expect(finishes).toEqual([
      { requestHandle: "request-1", identity: IDENTITY },
    ]);
    expect(timer.callbacks.size).toBe(0);
  });

  test("expiry releases exactly once and tenant swaps cannot release it", async () => {
    const { finishes, registry, timer } = harness();
    registry.holdLiveVoiceSession({
      sessionId: "voice-1",
      requestHandle: "request-1",
      identity: IDENTITY,
      expiresAtMs: 31_000,
    });
    expect(
      await registry.releaseLiveVoiceSession({
        sessionId: "voice-1",
        identity: { ...IDENTITY, organizationId: "org-b" },
      }),
    ).toBeNull();
    await timer.runOne();
    expect(finishes).toHaveLength(1);
    expect(
      await registry.releaseLiveVoiceSession({
        sessionId: "voice-1",
        identity: IDENTITY,
      }),
    ).toBeNull();
    expect(finishes).toHaveLength(1);
  });

  test("does not route a held session after its expiry even before its timer runs", () => {
    const timer = new DeterministicTimer();
    let now = 1_000;
    const registry = new RuntimeWorkerSessionLeaseRegistry({
      coordinator: {
        finishRequest: async () => ({ status: "release_scheduled" }),
      },
      timer,
      nowMs: () => now,
    });
    registry.holdLiveVoiceSession({
      sessionId: "voice-1",
      requestHandle: "request-1",
      identity: IDENTITY,
      expiresAtMs: 2_000,
    });
    now = 2_000;
    expect(registry.hasLiveVoiceSession("voice-1", IDENTITY)).toBe(false);
  });

  test("rejects conflicts, bad expiry, and capacity overflow", () => {
    const { registry } = harness();
    const hold = {
      requestHandle: "request-1",
      identity: IDENTITY,
      expiresAtMs: 31_000,
    };
    expect(
      registry.holdLiveVoiceSession({ sessionId: "voice-1", ...hold }),
    ).toEqual({ status: "held" });
    expect(
      registry.holdLiveVoiceSession({ sessionId: "voice-1", ...hold }),
    ).toEqual({ status: "already_held" });
    expect(
      registry.holdLiveVoiceSession({
        sessionId: "voice-1",
        ...hold,
        requestHandle: "other",
      }),
    ).toEqual({ status: "rejected", reason: "session_conflict" });
    expect(
      registry.holdLiveVoiceSession({
        sessionId: "voice-2",
        ...hold,
        requestHandle: "request-2",
      }),
    ).toEqual({ status: "held" });
    expect(
      registry.holdLiveVoiceSession({
        sessionId: "voice-3",
        ...hold,
        requestHandle: "request-3",
      }),
    ).toEqual({ status: "rejected", reason: "capacity_exhausted" });
    expect(
      registry.holdLiveVoiceSession({
        sessionId: "expired",
        ...hold,
        expiresAtMs: 1_000,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_expiry" });
  });
});

describe("pooled live voice route contracts", () => {
  test("parses only the exact route shapes used to retain and release a lease", () => {
    expect(
      isLiveVoiceSessionBootstrapPath(
        "POST",
        "/v1/assistants/a/live-voice/sessions",
      ),
    ).toBe(true);
    expect(
      isLiveVoiceSessionBootstrapPath(
        "GET",
        "/v1/assistants/a/live-voice/sessions",
      ),
    ).toBe(false);
    expect(
      liveVoiceSessionReleaseId(
        "DELETE",
        "/v1/assistants/a/live-voice/sessions/session-1",
      ),
    ).toBe("session-1");
    expect(
      liveVoiceSessionReleaseId(
        "DELETE",
        "/v1/assistants/a/live-voice/sessions/%2F",
      ),
    ).toBeNull();
  });

  test("parses a bounded bootstrap lease without accepting malformed values", () => {
    expect(
      parsePooledVoiceSessionBootstrap({
        sessionId: "session-1",
        expiresAt: "2026-07-20T00:30:00.000Z",
      }),
    ).toEqual({
      sessionId: "session-1",
      expiresAtMs: Date.parse("2026-07-20T00:30:00.000Z"),
    });
    expect(
      parsePooledVoiceSessionBootstrap({
        sessionId: "",
        expiresAt: "not-a-date",
      }),
    ).toBeNull();
  });

  test("retains only managed provider bootstraps, never the native fallback", () => {
    expect(
      parseManagedPooledVoiceSessionBootstrap({
        sessionId: "session-1",
        expiresAt: "2026-07-20T00:30:00.000Z",
        engine: "hume",
        connection: { transport: "hume", sessionToken: "secret" },
      }),
    ).toEqual({
      sessionId: "session-1",
      expiresAtMs: Date.parse("2026-07-20T00:30:00.000Z"),
    });
    expect(
      parseManagedPooledVoiceSessionBootstrap({
        sessionId: "session-1",
        expiresAt: "2026-07-20T00:30:00.000Z",
        engine: "native",
        connection: { transport: "native" },
      }),
    ).toBeNull();
    expect(
      parseManagedPooledVoiceSessionBootstrap({
        sessionId: "session-1",
        expiresAt: "2026-07-20T00:30:00.000Z",
        engine: "hume",
        connection: { transport: "elevenlabs" },
      }),
    ).toBeNull();
    expect(
      parseManagedPooledVoiceSessionBootstrap({
        sessionId: "session-1",
        expiresAt: "2026-07-20T00:30:00.000Z",
        engine: "elevenlabs",
        connection: {
          transport: "elevenlabs",
          conversationToken: "provider-token",
          sessionToken: "worklin-token",
        },
      }),
    ).toBeNull();
  });
});
