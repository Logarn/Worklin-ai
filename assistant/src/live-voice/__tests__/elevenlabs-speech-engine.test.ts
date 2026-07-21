import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ElevenLabsSpeechEngineSession,
  isValidElevenLabsEventId,
  verifyElevenLabsSpeechEngineJwt,
} from "../elevenlabs-speech-engine.js";
import {
  bindManagedVoiceProviderConversation,
  createManagedVoiceSession,
  resetManagedVoiceSessionsForTesting,
} from "../provider-session.js";

const LEASE_ENV_KEYS = [
  "WORKLIN_RUNTIME_MODE",
  "WORKLIN_RUNTIME_WORKER_STACK_ID",
  "WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED",
  "WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED",
] as const;
const originalLeaseEnv = new Map(
  LEASE_ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  resetManagedVoiceSessionsForTesting();
  for (const key of LEASE_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  resetManagedVoiceSessionsForTesting();
  for (const [key, value] of originalLeaseEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function token(
  apiKey: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.elevenlabs.io/convai/speech-engine",
      sub: "convai_speech_engine_upstream",
      iat: 1_000,
      exp: 1_100,
      ...overrides,
    }),
  ).toString("base64url");
  const secret = createHash("sha256").update(apiKey).digest();
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("ElevenLabs Speech Engine authorization", () => {
  test("accepts the documented issuer, subject, signature, and expiry", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "secret", 1_000),
    ).toBe(true);
  });

  test("accepts the provider's optional bearer prefix and surrounding whitespace", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(
        `  Bearer ${token("secret")}  `,
        "  secret  ",
        1_000,
      ),
    ).toBe(true);
  });

  test("rejects a wrong secret, issuer, or expired token", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "other", 1_000),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(
        token("secret", { iss: "https://attacker.invalid" }),
        "secret",
        1_000,
      ),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "secret", 1_161),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(
        token("secret", { iat: 1_061 }),
        "secret",
        1_000,
      ),
    ).toBe(false);
  });
});

describe("ElevenLabs Speech Engine event ordering", () => {
  test.each([
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { label: "fraction", value: 1.5 },
    { label: "negative", value: -1 },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects a $label event id", ({ value }) => {
    expect(isValidElevenLabsEventId(value)).toBe(false);
  });

  test("accepts zero and the largest safe integer", () => {
    expect(isValidElevenLabsEventId(0)).toBe(true);
    expect(isValidElevenLabsEventId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("rejects a second conversation init on the same upstream socket", () => {
    const closes: Array<{ code?: number; reason?: string }> = [];
    const session = new ElevenLabsSpeechEngineSession({
      send: () => {},
      close: (code, reason) => closes.push({ code, reason }),
    });

    session.handleMessage(
      JSON.stringify({
        type: "init",
        conversation_id: "provider-conversation-1",
      }),
    );
    session.handleMessage(
      JSON.stringify({
        type: "init",
        conversation_id: "provider-conversation-2",
      }),
    );

    expect(closes).toEqual([
      { code: 1008, reason: "Conversation is already initialized" },
    ]);
  });

  test("rejects an invalid initial conversation id", () => {
    const closes: Array<{ code?: number; reason?: string }> = [];
    const session = new ElevenLabsSpeechEngineSession({
      send: () => {},
      close: (code, reason) => closes.push({ code, reason }),
    });

    session.handleMessage(
      JSON.stringify({
        type: "init",
        conversation_id: 42,
      }),
    );

    expect(closes).toEqual([{ code: 1008, reason: "Invalid conversation" }]);
  });

  test("keeps event replay state across provider reconnects", async () => {
    const managed = createManagedVoiceSession({
      sessionId: "session-reconnect",
      assistantId: "assistant-1",
      conversationId: "conversation-1",
      actorId: "actor-1",
      organizationId: "org-1",
      engine: "elevenlabs",
    });
    expect(
      bindManagedVoiceProviderConversation({
        token: managed.token,
        sessionId: managed.binding.sessionId,
        actorId: managed.binding.actorId,
        providerConversationId: "provider-conversation-reconnect",
      }),
    ).toBe(true);
    const startTurn = mock(async () => ({
      turnId: "turn-1",
      abort: mock(() => {}),
    }));
    const socket = { send: () => {}, close: () => {} };
    const first = new ElevenLabsSpeechEngineSession(socket, startTurn);
    const second = new ElevenLabsSpeechEngineSession(socket, startTurn);
    const init = JSON.stringify({
      type: "init",
      conversation_id: "provider-conversation-reconnect",
    });
    const transcript = JSON.stringify({
      type: "user_transcript",
      event_id: 41,
      user_transcript: [{ role: "user", content: "Hello" }],
    });

    first.handleMessage(init);
    first.handleMessage(transcript);
    for (
      let attempt = 0;
      attempt < 20 && startTurn.mock.calls.length < 1;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    first.close();
    second.handleMessage(init);
    second.handleMessage(transcript);
    await new Promise((resolve) => setTimeout(resolve, 10));
    second.handleMessage(
      JSON.stringify({
        type: "user_transcript",
        event_id: 40,
        user_transcript: [{ role: "user", content: "Stale" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    second.handleMessage(
      JSON.stringify({
        type: "user_transcript",
        event_id: 42,
        user_transcript: [{ role: "user", content: "New" }],
      }),
    );
    for (
      let attempt = 0;
      attempt < 20 && startTurn.mock.calls.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  test("releases the managed session only on an explicit provider close", () => {
    const managed = createManagedVoiceSession({
      sessionId: "session-provider-close",
      assistantId: "assistant-1",
      conversationId: "conversation-1",
      actorId: "actor-1",
      organizationId: "org-1",
      engine: "elevenlabs",
    });
    expect(
      bindManagedVoiceProviderConversation({
        token: managed.token,
        sessionId: managed.binding.sessionId,
        actorId: managed.binding.actorId,
        providerConversationId: "provider-conversation-close",
      }),
    ).toBe(true);

    const disconnected = new ElevenLabsSpeechEngineSession({
      send: () => {},
      close: () => {},
    });
    disconnected.handleMessage(
      JSON.stringify({
        type: "init",
        conversation_id: "provider-conversation-close",
      }),
    );
    disconnected.close();
    expect(
      bindManagedVoiceProviderConversation({
        token: managed.token,
        sessionId: managed.binding.sessionId,
        actorId: managed.binding.actorId,
        providerConversationId: "provider-conversation-close",
      }),
    ).toBe(true);

    const ended = new ElevenLabsSpeechEngineSession({
      send: () => {},
      close: () => {},
    });
    ended.handleMessage(
      JSON.stringify({
        type: "init",
        conversation_id: "provider-conversation-close",
      }),
    );
    ended.handleMessage(JSON.stringify({ type: "close" }));
    expect(
      bindManagedVoiceProviderConversation({
        token: managed.token,
        sessionId: managed.binding.sessionId,
        actorId: managed.binding.actorId,
        providerConversationId: "provider-conversation-close",
      }),
    ).toBe(false);
  });

  test("discards replayed and stale transcript event ids", async () => {
    const sent: string[] = [];
    const session = new ElevenLabsSpeechEngineSession({
      send: (value) => sent.push(value),
      close: () => {},
    });
    const frame = JSON.stringify({
      type: "user_transcript",
      event_id: 17,
      user_transcript: [{ role: "user", content: "Hello" }],
    });

    for (const invalidEventId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      session.handleMessage(
        JSON.stringify({
          type: "user_transcript",
          event_id: invalidEventId,
          user_transcript: [{ role: "user", content: "Invalid" }],
        }),
      );
    }
    session.handleMessage(frame);
    session.handleMessage(frame);
    session.handleMessage(
      JSON.stringify({
        type: "user_transcript",
        event_id: 16,
        user_transcript: [{ role: "user", content: "Stale" }],
      }),
    );
    for (
      let attempt = 0;
      attempt < 60 &&
      !sent.some((value) => {
        const frame = JSON.parse(value) as Record<string, unknown>;
        return (
          frame.type === "agent_response" &&
          frame.event_id === 17 &&
          frame.is_final === true
        );
      });
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const finalFrames = sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .filter(
        (value) =>
          value.type === "agent_response" &&
          value.event_id === 17 &&
          value.is_final === true,
      );
    expect(finalFrames).toHaveLength(1);
  });
});
