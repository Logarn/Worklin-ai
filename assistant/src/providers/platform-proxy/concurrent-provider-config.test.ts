import { describe, expect, test } from "bun:test";

import {
  assertConcurrentManagedProviderConfiguration,
  getConcurrentManagedProviderConfig,
} from "./concurrent-provider-config.js";

describe("concurrent managed provider configuration", () => {
  test("accepts Kimi with its catalog default model", () => {
    expect(
      assertConcurrentManagedProviderConfiguration({
        CONCURRENT_RUNTIME_MANAGED_PROVIDER: "kimi",
        MOONSHOT_API_KEY: "test-key",
      }),
    ).toEqual({
      provider: "kimi",
      model: "kimi-k2.6",
      displayName: "Kimi",
      credentialEnvVar: "MOONSHOT_API_KEY",
    });
  });

  test("accepts an explicit model owned by the provider", () => {
    expect(
      assertConcurrentManagedProviderConfiguration({
        CONCURRENT_RUNTIME_MANAGED_PROVIDER: "kimi",
        CONCURRENT_RUNTIME_MANAGED_MODEL: "kimi-k2.5",
        MOONSHOT_API_KEY: "test-key",
      }).model,
    ).toBe("kimi-k2.5");
  });

  test("rejects missing credentials and cross-provider models", () => {
    expect(
      getConcurrentManagedProviderConfig({
        CONCURRENT_RUNTIME_MANAGED_PROVIDER: "kimi",
      }),
    ).toBeNull();
    expect(() =>
      assertConcurrentManagedProviderConfiguration({
        CONCURRENT_RUNTIME_MANAGED_PROVIDER: "kimi",
        CONCURRENT_RUNTIME_MANAGED_MODEL: "claude-sonnet-4-6",
        MOONSHOT_API_KEY: "test-key",
      }),
    ).toThrow("not supported by Kimi");
  });
});
