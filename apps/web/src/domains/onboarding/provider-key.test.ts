import { beforeEach, describe, expect, test } from "bun:test";

import {
  consumePendingProviderKey,
  pendingProviderAuthType,
  pendingProviderRequiresOAuth,
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@/domains/onboarding/provider-key";

beforeEach(() => {
  sessionStorage.clear();
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
    expect(consumePendingProviderKey()).toEqual({ provider: "ollama", key: "" });
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
});
