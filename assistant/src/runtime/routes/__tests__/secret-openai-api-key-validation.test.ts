import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let secureWrites: Record<string, string> = {};
const originalFetch = globalThis.fetch;

function fetchReturning(status: number): typeof fetch {
  return Object.assign(async () => new Response("", { status }), {
    preconnect: () => {},
  });
}

mock.module("../../../config/loader.js", () => ({
  API_KEY_PROVIDERS: ["openai"],
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../../../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../../../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../../../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: async () => "not_found",
  getActiveBackendName: () => "test-backend",
  getSecureKeyAsync: async () => null,
  getSecureKeyResultAsync: async () => ({ status: "not_found" }),
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: false }),
  setSecureKeyAsync: async (account: string, value: string) => {
    secureWrites[account] = value;
    return true;
  },
}));

mock.module("../secrets-deps.js", () => ({
  getSecretsDeps: () => undefined,
}));

import { BadRequestError } from "../errors.js";
import { ROUTES } from "../secret-routes.js";

const addSecret = ROUTES.find(
  (route) => route.operationId === "secrets_add",
)!.handler;

beforeEach(() => {
  secureWrites = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI API key secret route", () => {
  test("saves a restricted key when OpenAI model listing returns 403", async () => {
    globalThis.fetch = fetchReturning(403);

    await expect(
      addSecret({
        body: {
          type: "api_key",
          name: "openai",
          value: "restricted-test-key",
        },
      }),
    ).resolves.toEqual({
      success: true,
      type: "api_key",
      name: "openai",
    });
    expect(secureWrites).toEqual({
      "credential/openai/api_key": "restricted-test-key",
    });
  });

  test("rejects a 401 OpenAI key without storing it", async () => {
    globalThis.fetch = fetchReturning(401);

    await expect(
      addSecret({
        body: {
          type: "api_key",
          name: "openai",
          value: "invalid-test-key",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(secureWrites).toEqual({});
  });
});
