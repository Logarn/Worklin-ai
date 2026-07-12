import { beforeEach, describe, expect, test } from "bun:test";

import {
  bindManagedVoiceProviderConversation,
  createManagedVoiceSession,
  getManagedVoiceSessionByProviderConversation,
  releaseManagedVoiceSession,
  resetManagedVoiceSessionsForTesting,
  verifyManagedVoiceSessionToken,
} from "../provider-session.js";

const binding = {
  sessionId: "session-1",
  assistantId: "assistant-1",
  conversationId: "conversation-1",
  actorId: "actor-1",
  organizationId: "org-1",
  engine: "hume" as const,
};

beforeEach(resetManagedVoiceSessionsForTesting);

describe("managed voice session tokens", () => {
  test("binds the signed token to the complete active session", () => {
    const { token } = createManagedVoiceSession(binding);
    expect(verifyManagedVoiceSessionToken(token)).toMatchObject(binding);
  });

  test("rejects tampering, expiry, and replay after release", () => {
    const active = createManagedVoiceSession(binding);
    expect(
      verifyManagedVoiceSessionToken(`${active.token.slice(0, -1)}x`),
    ).toBeNull();
    expect(releaseManagedVoiceSession(binding.sessionId, binding.actorId)).toBe(
      true,
    );
    expect(verifyManagedVoiceSessionToken(active.token)).toBeNull();

    const expired = createManagedVoiceSession({
      ...binding,
      sessionId: "session-expired",
      ttlMs: -1,
    });
    expect(verifyManagedVoiceSessionToken(expired.token)).toBeNull();
  });

  test("rejects a second active session for the same actor", () => {
    createManagedVoiceSession(binding);
    expect(() =>
      createManagedVoiceSession({ ...binding, sessionId: "session-2" }),
    ).toThrow("voice_session_busy:session-1");
  });

  test("does not let a different actor release the lease", () => {
    const { token } = createManagedVoiceSession(binding);
    expect(releaseManagedVoiceSession(binding.sessionId, "actor-2")).toBe(
      false,
    );
    expect(verifyManagedVoiceSessionToken(token)).not.toBeNull();
  });

  test("binds an ElevenLabs conversation only to its signed actor session", () => {
    const eleven = createManagedVoiceSession({
      ...binding,
      engine: "elevenlabs",
    });
    expect(
      bindManagedVoiceProviderConversation({
        token: eleven.token,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
        providerConversationId: "eleven-conversation-1",
      }),
    ).toBe(true);
    expect(
      getManagedVoiceSessionByProviderConversation("eleven-conversation-1"),
    ).toMatchObject({ engine: "elevenlabs", actorId: binding.actorId });
  });
});
