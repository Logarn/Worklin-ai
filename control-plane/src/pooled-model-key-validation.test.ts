import { describe, expect, mock, test } from "bun:test";

import { validatePooledModelProviderKey } from "./pooled-model-key-validation.js";

describe("pooled model-provider key validation", () => {
  test.each([
    [
      "anthropic",
      "https://api.anthropic.com/v1/models?limit=1",
      "x-api-key",
    ],
    [
      "fireworks",
      "https://api.fireworks.ai/inference/v1/models",
      "Authorization",
    ],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      "x-goog-api-key",
    ],
    ["kimi", "https://api.moonshot.ai/v1/models", "Authorization"],
    ["minimax", "https://api.minimax.io/v1/models", "Authorization"],
    ["openai", "https://api.openai.com/v1/models", "Authorization"],
    [
      "openrouter",
      "https://openrouter.ai/api/v1/auth/key",
      "Authorization",
    ],
  ] as const)(
    "positively verifies %s against the runtime provider endpoint",
    async (provider, expectedUrl, credentialHeader) => {
      const fetchImpl = mock(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response("{}", { status: 200 }),
      );

      await expect(
        validatePooledModelProviderKey(provider, "secret-value", {
          fetchImpl,
        }),
      ).resolves.toEqual({ valid: true });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [input, init] = fetchImpl.mock.calls[0]!;
      expect(String(input)).toBe(expectedUrl);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(
        new Headers(init?.headers).get(credentialHeader),
      ).toContain("secret-value");
    },
  );

  test("fails closed when a provider rejects the key", async () => {
    const fetchImpl = mock(
      async () => new Response("unauthorized", { status: 401 }),
    );

    await expect(
      validatePooledModelProviderKey("openai", "bad-key", { fetchImpl }),
    ).resolves.toEqual({
      valid: false,
      reason: "OpenAI rejected this API key.",
    });
  });

  test("fails closed on transient provider responses", async () => {
    const fetchImpl = mock(
      async () => new Response("unavailable", { status: 503 }),
    );

    const result = await validatePooledModelProviderKey(
      "anthropic",
      "unverified-key",
      { fetchImpl },
    );

    expect(result.valid).toBe(false);
    expect(result).toEqual({
      valid: false,
      reason:
        "Anthropic could not verify this connection (503). Try again shortly.",
    });
  });

  test("fails closed on network errors without exposing the key", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("network failed while using secret-value");
    });

    const result = await validatePooledModelProviderKey(
      "gemini",
      "secret-value",
      { fetchImpl },
    );

    expect(result).toEqual({
      valid: false,
      reason:
        "Gemini could not verify this connection. Check your network and try again.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
