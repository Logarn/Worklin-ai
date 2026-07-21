import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  installInternalPooledVoiceLeaseAuthority,
  type PooledVoiceLeaseIdentity,
  resetPooledVoiceLeaseFenceForTesting,
} from "../../services/pooled-voice-lease-fence.js";
import {
  bindManagedVoiceProviderConversation,
  claimManagedVoiceProviderTurn,
  createManagedVoiceSession,
  getManagedVoiceSessionByProviderConversation,
  MAX_PROVIDER_TURN_KEYS_PER_SESSION,
  releaseManagedVoiceSession,
  resetManagedVoiceSessionsForTesting,
  verifyManagedVoiceSessionToken,
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
const binding = {
  sessionId: "session-1",
  assistantId: "assistant-1",
  conversationId: "conversation-1",
  actorId: "actor-1",
  organizationId: "org-1",
  engine: "hume" as const,
};

beforeEach(() => {
  resetManagedVoiceSessionsForTesting();
  resetPooledVoiceLeaseFenceForTesting();
  for (const key of LEASE_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  resetManagedVoiceSessionsForTesting();
  resetPooledVoiceLeaseFenceForTesting();
  for (const [key, value] of originalLeaseEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function installLeaseAuthority(
  initial: PooledVoiceLeaseIdentity = {
    tenant: { orgId: "org-1", assistantId: "assistant-1" },
    workerStackId: "worker-1",
    generation: 7,
  },
): {
  setCurrent(value: PooledVoiceLeaseIdentity): void;
} {
  process.env.WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED = "true";
  let current = initial;
  installInternalPooledVoiceLeaseAuthority(() => current);
  return {
    setCurrent: (value) => {
      current = value;
    },
  };
}

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

  test("consumes each provider callback key only once", () => {
    const { token } = createManagedVoiceSession(binding);
    expect(
      claimManagedVoiceProviderTurn(token, "provider-turn-1"),
    ).toMatchObject({ status: "accepted", binding });
    expect(claimManagedVoiceProviderTurn(token, "provider-turn-1")).toEqual({
      status: "replayed",
    });
    expect(
      claimManagedVoiceProviderTurn(token, "provider-turn-2"),
    ).toMatchObject({ status: "accepted" });
  });

  test("accepts a Hume callback bound to the current pooled worker generation", () => {
    installLeaseAuthority();
    const { token } = createManagedVoiceSession(binding);

    expect(
      claimManagedVoiceProviderTurn(token, "provider-turn-current"),
    ).toMatchObject({
      status: "accepted",
      binding: {
        pooledWorkerLease: {
          tenant: { orgId: "org-1", assistantId: "assistant-1" },
          workerStackId: "worker-1",
          generation: 7,
        },
      },
    });
  });

  test("does not let a stale authenticated request adopt the current pooled lease", () => {
    installLeaseAuthority();

    expect(() =>
      createManagedVoiceSession({
        ...binding,
        pooledWorkerLease: {
          tenant: { orgId: "org-1", assistantId: "assistant-1" },
          workerStackId: "worker-1",
          generation: 6,
        },
      }),
    ).toThrow("authentication lease is stale or mismatched");
  });

  test("fails closed when pooled voice fencing has no lease authority", () => {
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";

    expect(() => createManagedVoiceSession(binding)).toThrow(
      "Pooled voice lease authority is unavailable",
    );
  });

  test("rejects a Hume callback after the pooled lease generation changes", () => {
    const authority = installLeaseAuthority();
    const { token } = createManagedVoiceSession(binding);
    authority.setCurrent({
      tenant: { orgId: "org-1", assistantId: "assistant-1" },
      workerStackId: "worker-1",
      generation: 8,
    });

    expect(claimManagedVoiceProviderTurn(token, "provider-turn-stale")).toEqual(
      { status: "invalid" },
    );
    expect(verifyManagedVoiceSessionToken(token)).toBeNull();
  });

  test("rejects an ElevenLabs callback after the worker swaps tenants", () => {
    const authority = installLeaseAuthority();
    const eleven = createManagedVoiceSession({
      ...binding,
      engine: "elevenlabs",
    });
    expect(
      bindManagedVoiceProviderConversation({
        token: eleven.token,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
        providerConversationId: "eleven-conversation-current",
      }),
    ).toBe(true);

    authority.setCurrent({
      tenant: { orgId: "org-2", assistantId: "assistant-2" },
      workerStackId: "worker-1",
      generation: 8,
    });

    expect(
      getManagedVoiceSessionByProviderConversation(
        "eleven-conversation-current",
      ),
    ).toBeNull();
    expect(verifyManagedVoiceSessionToken(eleven.token)).toBeNull();
  });

  test("fails closed when a session exhausts its bounded provider replay ledger", () => {
    const { token } = createManagedVoiceSession(binding);
    for (
      let index = 0;
      index < MAX_PROVIDER_TURN_KEYS_PER_SESSION;
      index += 1
    ) {
      expect(
        claimManagedVoiceProviderTurn(token, `provider-turn-${index}`).status,
      ).toBe("accepted");
    }

    expect(
      claimManagedVoiceProviderTurn(token, "provider-turn-overflow"),
    ).toEqual({ status: "limit_exceeded" });
    expect(claimManagedVoiceProviderTurn(token, "provider-turn-0")).toEqual({
      status: "replayed",
    });
    expect(claimManagedVoiceProviderTurn(token, "x".repeat(257))).toEqual({
      status: "invalid",
    });
  });

  test("does not let one session steal another provider conversation id", () => {
    const first = createManagedVoiceSession({
      ...binding,
      engine: "elevenlabs",
    });
    expect(
      bindManagedVoiceProviderConversation({
        token: first.token,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
        providerConversationId: "shared-provider-conversation",
      }),
    ).toBe(true);
    expect(releaseManagedVoiceSession(binding.sessionId, binding.actorId)).toBe(
      true,
    );

    const secondBinding = {
      ...binding,
      sessionId: "session-2",
      actorId: "actor-2",
      engine: "elevenlabs" as const,
    };
    const second = createManagedVoiceSession(secondBinding);
    // Releasing the first session removes its provider binding, so the id can
    // safely be reused after the original lease is gone.
    expect(
      bindManagedVoiceProviderConversation({
        token: second.token,
        sessionId: secondBinding.sessionId,
        actorId: secondBinding.actorId,
        providerConversationId: "shared-provider-conversation",
      }),
    ).toBe(true);
  });

  test("rejects provider conversation rebinding while its first lease is active", () => {
    const first = createManagedVoiceSession({
      ...binding,
      engine: "elevenlabs",
    });
    const secondBinding = {
      ...binding,
      sessionId: "session-2",
      actorId: "actor-2",
      engine: "elevenlabs" as const,
    };
    const second = createManagedVoiceSession(secondBinding);
    expect(
      bindManagedVoiceProviderConversation({
        token: first.token,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
        providerConversationId: "shared-provider-conversation",
      }),
    ).toBe(true);
    expect(
      bindManagedVoiceProviderConversation({
        token: second.token,
        sessionId: secondBinding.sessionId,
        actorId: secondBinding.actorId,
        providerConversationId: "shared-provider-conversation",
      }),
    ).toBe(false);
  });
});
