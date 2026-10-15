import { describe, expect, test } from "bun:test";

import { getConcurrentProviderConfig } from "./concurrent-provider-config.js";

describe("concurrent provider configuration", () => {
  test("uses the catalog default for a supported tenant provider", () => {
    expect(getConcurrentProviderConfig("kimi")).toEqual({
      provider: "kimi",
      model: "kimi-k2.6",
      displayName: "Kimi",
    });
  });

  test("uses a catalog model and falls back from an invalid model", () => {
    expect(getConcurrentProviderConfig("kimi", "kimi-k2.5")?.model).toBe(
      "kimi-k2.5",
    );
    expect(
      getConcurrentProviderConfig("kimi", "claude-sonnet-4-6")?.model,
    ).toBe("kimi-k2.6");
  });

  test("rejects unsupported providers", () => {
    expect(getConcurrentProviderConfig("unknown-provider")).toBeNull();
    expect(getConcurrentProviderConfig("ollama")).toBeNull();
    expect(getConcurrentProviderConfig("openai-compatible")).toBeNull();
  });
});
