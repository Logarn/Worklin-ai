import { describe, expect, test } from "bun:test";

import { validateOpenAICompatibleApiKey } from "./validate-api-key.js";

describe("validateOpenAICompatibleApiKey", () => {
  test("accepts a key only when the provider models endpoint succeeds", async () => {
    const result = await validateOpenAICompatibleApiKey("test-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://provider.example.com/v1/models");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-key",
        );
        return new Response("{}", { status: 200 });
      },
    });

    expect(result).toEqual({ valid: true });
  });

  test("rejects invalid credentials without exposing the provider response", async () => {
    const result = await validateOpenAICompatibleApiKey("bad-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      fetchImpl: async () =>
        new Response('{"error":"sensitive upstream detail"}', { status: 401 }),
    });

    expect(result).toEqual({
      valid: false,
      outcome: "invalid_credentials",
      reason: "Example Provider rejected this API key.",
    });
  });

  test("preserves 403 responses as invalid credentials", async () => {
    const result = await validateOpenAICompatibleApiKey("bad-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });

    expect(result).toEqual({
      valid: false,
      outcome: "invalid_credentials",
      reason: "Example Provider rejected this API key.",
    });
  });

  test("supports provider-specific validation paths and rejection statuses", async () => {
    const result = await validateOpenAICompatibleApiKey("bad-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      path: "auth/key",
      rejectionStatuses: [400, 401, 403],
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://provider.example.com/v1/auth/key");
        return new Response("invalid credential", { status: 400 });
      },
    });

    expect(result).toEqual({
      valid: false,
      outcome: "invalid_credentials",
      reason: "Example Provider rejected this API key.",
    });
  });

  test("can require a successful inference request instead of metadata access", async () => {
    const result = await validateOpenAICompatibleApiKey("test-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      method: "POST",
      path: "responses",
      body: {
        model: "example-model",
        input: "Reply with OK.",
        max_output_tokens: 16,
      },
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://provider.example.com/v1/responses");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/json",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "example-model",
          input: "Reply with OK.",
          max_output_tokens: 16,
        });
        return new Response("{}", { status: 200 });
      },
    });

    expect(result).toEqual({ valid: true });
  });

  test("classifies 429 and 5xx responses as temporarily unverifiable", async () => {
    for (const status of [429, 500, 503]) {
      const result = await validateOpenAICompatibleApiKey("test-key", {
        baseUrl: "https://provider.example.com/v1",
        providerLabel: "Example Provider",
        fetchImpl: async () => new Response("busy", { status }),
      });

      expect(result).toEqual({
        valid: false,
        outcome: "verification_unavailable",
        reason: `Example Provider could not verify this connection (${status}). Try again shortly.`,
      });
    }
  });

  test("classifies network failures as temporarily unverifiable", async () => {
    const result = await validateOpenAICompatibleApiKey("test-key", {
      baseUrl: "https://provider.example.com/v1",
      providerLabel: "Example Provider",
      fetchImpl: async () => {
        throw new TypeError("network unavailable");
      },
    });

    expect(result).toEqual({
      valid: false,
      outcome: "verification_unavailable",
      reason:
        "Example Provider could not verify this connection. Check your network and try again.",
    });
  });
});
