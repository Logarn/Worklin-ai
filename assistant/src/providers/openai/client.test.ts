import { describe, expect, test } from "bun:test";

import { validateOpenAIApiKey } from "./client.js";

describe("validateOpenAIApiKey", () => {
  test("validates authentication without requiring a specific model", async () => {
    const fetchImpl = (async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer restricted-key",
      );
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch;

    await expect(
      validateOpenAIApiKey("restricted-key", fetchImpl),
    ).resolves.toEqual({ valid: true });
  });
});
