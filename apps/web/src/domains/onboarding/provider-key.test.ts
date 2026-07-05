import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SdkCall {
  path: { assistant_id: string };
  body?: Record<string, unknown>;
}

let secretsPostCalls: SdkCall[] = [];
let connectionPostCalls: SdkCall[] = [];
let configPatchCalls: SdkCall[] = [];
let secretsPostOk = true;
let secretsPostStatus = 200;
let connectionPostStatus = 200;

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: (_opts: SdkCall) =>
    Promise.resolve({
      data: { llm: { activeProfile: null, profileOrder: [], profiles: {} } },
      response: { ok: true, status: 200 },
    }),
  configPatch: (opts: SdkCall) => {
    configPatchCalls.push(opts);
    return Promise.resolve({ data: undefined, response: { ok: true, status: 200 } });
  },
  inferenceProviderconnectionsByNamePatch: (_opts: SdkCall) =>
    Promise.resolve({ data: undefined, response: { ok: true, status: 200 } }),
  inferenceProviderconnectionsPost: (opts: SdkCall) => {
    connectionPostCalls.push(opts);
    return Promise.resolve({
      data: undefined,
      response: {
        ok: connectionPostStatus >= 200 && connectionPostStatus < 300,
        status: connectionPostStatus,
      },
    });
  },
  secretsPost: (opts: SdkCall) => {
    secretsPostCalls.push(opts);
    return Promise.resolve({
      data: undefined,
      response: { ok: secretsPostOk, status: secretsPostStatus },
    });
  },
}));

const {
  applyPendingProviderKey,
  consumePendingProviderKey,
  pendingProviderAuthType,
  pendingProviderRequiresOAuth,
  peekPendingProviderKey,
  providerApiKeySecretBody,
  setPendingProviderKey,
} = await import("@/domains/onboarding/provider-key");

beforeEach(() => {
  sessionStorage.clear();
  secretsPostCalls = [];
  connectionPostCalls = [];
  configPatchCalls = [];
  secretsPostOk = true;
  secretsPostStatus = 200;
  connectionPostStatus = 200;
});

describe("pending provider key", () => {
  test("round-trips provider + key through sessionStorage", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    expect(peekPendingProviderKey()).toEqual({
      provider: "anthropic",
      key: "sk-ant-test",
    });
  });

  test("peek is non-destructive, consume clears it (consume-once)", () => {
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    expect(peekPendingProviderKey()?.provider).toBe("openai");
    // Still present after peek.
    expect(peekPendingProviderKey()?.provider).toBe("openai");

    expect(consumePendingProviderKey()?.provider).toBe("openai");
    // Gone after consume.
    expect(peekPendingProviderKey()).toBeNull();
    expect(consumePendingProviderKey()).toBeNull();
  });

  test("setting null clears any pending key", () => {
    setPendingProviderKey({ provider: "gemini", key: "AIza-test" });
    setPendingProviderKey(null);
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("keyless providers store an empty key", () => {
    setPendingProviderKey({ provider: "ollama", key: "" });
    expect(consumePendingProviderKey()).toEqual({
      provider: "ollama",
      key: "",
    });
  });

  test("ChatGPT subscription stores OAuth intent without an API key", () => {
    setPendingProviderKey({
      provider: "openai",
      authType: "oauth_subscription",
      key: "",
    });

    const pending = peekPendingProviderKey();
    expect(pending).toEqual({
      provider: "openai",
      authType: "oauth_subscription",
      key: "",
    });
    expect(pendingProviderRequiresOAuth(pending)).toBe(true);
    expect(pending ? pendingProviderAuthType(pending) : null).toBe(
      "oauth_subscription",
    );
  });

  test("OpenAI-compatible presets keep provider-specific routing metadata", () => {
    setPendingProviderKey({
      provider: "openai-compatible",
      providerOptionId: "xai",
      authType: "api_key",
      key: "xai-test",
      connectionName: "xai-personal",
      credentialName: "xai",
      connectionLabel: "xAI",
      baseUrl: "https://api.x.ai/v1",
      models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
      defaultModel: "grok-4.3",
    });

    const pending = peekPendingProviderKey();
    expect(pending).toEqual({
      provider: "openai-compatible",
      providerOptionId: "xai",
      authType: "api_key",
      key: "xai-test",
      connectionName: "xai-personal",
      credentialName: "xai",
      connectionLabel: "xAI",
      baseUrl: "https://api.x.ai/v1",
      models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
      defaultModel: "grok-4.3",
    });
    expect(pending ? pendingProviderAuthType(pending) : null).toBe("api_key");
  });

  test("first-class providers use the daemon api_key secret route", () => {
    expect(providerApiKeySecretBody("kimi", "kimi", "sk-test")).toEqual({
      type: "api_key",
      name: "kimi",
      value: "sk-test",
    });
  });

  test("OpenAI-compatible presets store their custom credential namespace", () => {
    expect(
      providerApiKeySecretBody("openai-compatible", "xai", "xai-test"),
    ).toEqual({
      type: "credential",
      name: "xai:api_key",
      value: "xai-test",
    });
  });

  test("provider apply keeps the pending key when secret storage fails", async () => {
    secretsPostOk = false;
    secretsPostStatus = 401;
    setPendingProviderKey({ provider: "kimi", key: "provider-key-value" });

    let thrown: unknown = null;
    try {
      await applyPendingProviderKey("asst-1");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { status?: number }).status).toBe(401);
    expect(peekPendingProviderKey()).toMatchObject({
      provider: "kimi",
      key: "provider-key-value",
    });
    expect(connectionPostCalls.length).toBe(0);
    expect(configPatchCalls.length).toBe(0);
  });

  test("provider apply clears the pending key after connection and profile setup succeed", async () => {
    setPendingProviderKey({
      provider: "kimi",
      providerOptionId: "kimi",
      key: "provider-key-value",
      defaultModel: "kimi-k2.6",
    });

    await applyPendingProviderKey("asst-1");

    expect(peekPendingProviderKey()).toBeNull();
    expect(secretsPostCalls[0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: {
        type: "api_key",
        name: "kimi",
        value: "provider-key-value",
      },
    });
    expect(connectionPostCalls[0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: {
        name: "kimi-personal",
        provider: "kimi",
        auth: { type: "api_key", credential: "credential/kimi/api_key" },
      },
    });
    expect(configPatchCalls[0]).toMatchObject({
      path: { assistant_id: "asst-1" },
      body: {
        llm: {
          activeProfile: "custom-balanced",
          profiles: {
            "custom-balanced": {
              provider: "kimi",
              provider_connection: "kimi-personal",
              model: "kimi-k2.6",
            },
          },
        },
      },
    });
  });
});
