import { describe, expect, test } from "bun:test";

import { validateOpenAIApiKey } from "./client.js";
import type { ValidationFetch } from "./validate-api-key.js";

describe("validateOpenAIApiKey", () => {
  test("validates authentication without requiring a specific model", async () => {
    const fetchImpl: ValidationFetch = async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer restricted-key",
      );
      return new Response('{"data":[]}', { status: 200 });
    };

    await expect(
      validateOpenAIApiKey("restricted-key", fetchImpl),
    ).resolves.toEqual({ valid: true });
  });

  test("accepts a restricted key when model listing is forbidden", async () => {
    const fetchImpl: ValidationFetch = async () =>
      new Response("forbidden", { status: 403 });

    await expect(
      validateOpenAIApiKey("restricted-key", fetchImpl),
    ).resolves.toEqual({ valid: true });
  });

  test("rejects a key when OpenAI reports invalid authentication", async () => {
    const fetchImpl: ValidationFetch = async () =>
      new Response("unauthorized", { status: 401 });

    await expect(
      validateOpenAIApiKey("invalid-key", fetchImpl),
    ).resolves.toEqual({
      valid: false,
      outcome: "invalid_credentials",
      reason: "OpenAI rejected this API key.",
    });
  });
});
