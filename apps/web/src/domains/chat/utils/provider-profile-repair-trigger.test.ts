import { describe, expect, test } from "bun:test";

import { shouldAttemptProviderProfileRepair } from "@/domains/chat/utils/provider-profile-repair-trigger";

describe("shouldAttemptProviderProfileRepair", () => {
  test("repairs modern provider-not-configured failures", () => {
    expect(
      shouldAttemptProviderProfileRepair({
        code: "PROVIDER_NOT_CONFIGURED",
      }),
    ).toBe(true);
  });

  test("repairs the provider-missing modal envelope returned as secret_blocked", () => {
    expect(
      shouldAttemptProviderProfileRepair({
        code: "secret_blocked",
        message:
          "Worklin needs an AI provider before it can answer. Choose a provider in Settings -> Models & Services, then connect ChatGPT or add an API key.",
        status: 422,
      }),
    ).toBe(true);
  });

  test("repairs provider-missing copy even if the backend omits a provider code", () => {
    expect(
      shouldAttemptProviderProfileRepair({
        message:
          "Worklin needs an AI provider before it can answer. Choose a provider in Settings -> Models & Services, then connect ChatGPT or add an API key.",
        status: 422,
      }),
    ).toBe(true);
  });

  test("does not repair normal secret-blocked messages", () => {
    expect(
      shouldAttemptProviderProfileRepair({
        code: "secret_blocked",
        message:
          "Your message looks like it contains a secret. Please remove it before sending.",
        status: 422,
      }),
    ).toBe(false);
  });
});
