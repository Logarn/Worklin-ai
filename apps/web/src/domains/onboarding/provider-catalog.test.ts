import { describe, expect, test } from "bun:test";

import {
  BYOK_ONBOARDING_PROVIDERS,
  DEFAULT_BYOK_ONBOARDING_PROVIDER,
} from "./provider-catalog";

describe("BYOK onboarding providers", () => {
  test("offers API-key providers without subscription or hosted-credit modes", () => {
    expect(BYOK_ONBOARDING_PROVIDERS.length).toBeGreaterThan(0);
    expect(
      BYOK_ONBOARDING_PROVIDERS.every(
        (provider) => provider.authType === "api_key" && provider.requiresKey,
      ),
    ).toBe(true);
    expect(
      BYOK_ONBOARDING_PROVIDERS.some(
        (provider) => provider.id === "chatgpt-subscription",
      ),
    ).toBe(false);
  });

  test("defaults to OpenAI API rather than ChatGPT subscription", () => {
    expect(DEFAULT_BYOK_ONBOARDING_PROVIDER.id).toBe("openai");
  });
});
