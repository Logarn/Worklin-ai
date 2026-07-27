import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SecretCall {
  path: { assistant_id: string };
  body: { type: string; name: string; value?: string };
  throwOnError: boolean;
}

let postCalls: SecretCall[] = [];
let deleteCalls: SecretCall[] = [];
let postStatus = 200;
let deleteStatus = 200;

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretsPost: (options: SecretCall) => {
    postCalls.push(options);
    return Promise.resolve({
      response: {
        ok: postStatus >= 200 && postStatus < 300,
        status: postStatus,
      },
    });
  },
  secretsDelete: (options: SecretCall) => {
    deleteCalls.push(options);
    return Promise.resolve({
      response: {
        ok: deleteStatus >= 200 && deleteStatus < 300,
        status: deleteStatus,
      },
    });
  },
}));

const {
  deletePooledProviderKey,
  PooledProviderKeyError,
  savePooledProviderKey,
} = await import("@/domains/settings/ai/pooled-provider-keys");

beforeEach(() => {
  postCalls = [];
  deleteCalls = [];
  postStatus = 200;
  deleteStatus = 200;
});

describe("pooled settings provider keys", () => {
  test("creates and rotates the same supported provider through secrets only", async () => {
    await savePooledProviderKey({
      assistantId: "asst-pool",
      provider: "kimi",
      value: "  first-key  ",
    });
    await savePooledProviderKey({
      assistantId: "asst-pool",
      provider: "kimi",
      value: "replacement-key",
    });

    expect(postCalls).toEqual([
      {
        path: { assistant_id: "asst-pool" },
        body: { type: "api_key", name: "kimi", value: "first-key" },
        throwOnError: false,
      },
      {
        path: { assistant_id: "asst-pool" },
        body: {
          type: "api_key",
          name: "kimi",
          value: "replacement-key",
        },
        throwOnError: false,
      },
    ]);
    expect(deleteCalls).toHaveLength(0);
  });

  test.each([
    "xai",
    "openai-compatible",
    "ollama",
    "chatgpt-subscription",
    "credential/team-key",
  ])("rejects unsupported %s before any secret write", async (provider) => {
    let thrown: unknown = null;
    try {
      await savePooledProviderKey({
        assistantId: "asst-pool",
        provider,
        value: "must-not-be-written",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PooledProviderKeyError);
    expect((thrown as { code?: string }).code).toBe(
      "pooled_provider_unsupported",
    );
    expect(postCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  test("deletes the configured supported provider from the vault", async () => {
    await deletePooledProviderKey({
      assistantId: "asst-pool",
      provider: "openrouter",
    });

    expect(deleteCalls).toEqual([
      {
        path: { assistant_id: "asst-pool" },
        body: { type: "api_key", name: "openrouter" },
        throwOnError: false,
      },
    ]);
    expect(postCalls).toHaveLength(0);
  });

  test("reports a provider switch conflict without a follow-up mutation", async () => {
    postStatus = 409;

    let thrown: unknown = null;
    try {
      await savePooledProviderKey({
        assistantId: "asst-pool",
        provider: "gemini",
        value: "gemini-key",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PooledProviderKeyError);
    expect((thrown as { status?: number }).status).toBe(409);
    expect(postCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
  });
});
