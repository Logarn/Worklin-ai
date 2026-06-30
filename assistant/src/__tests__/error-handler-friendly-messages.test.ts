import { describe, expect, test } from "bun:test";

import { withErrorHandling } from "../runtime/middleware/error-handler.js";
import { ConfigError, ProviderNotConfiguredError } from "../util/errors.js";

describe("withErrorHandling – friendly error messages", () => {
  test("ProviderNotConfiguredError returns provider-neutral setup guidance", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("anthropic", []);
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.error.message).toContain("Worklin needs an AI provider");
    expect(body.error.message).toContain("connect ChatGPT");
    expect(body.error.message).toContain("add an API key");
    expect(body.error.message).not.toContain("keys set");
    expect(body.error.message).not.toContain("anthropic");
  });

  test("ProviderNotConfiguredError does not hard-code a single provider", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("openai", []);
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("Choose a provider");
    expect(body.error.message).toContain("Settings → Models & Services");
    expect(body.error.message).not.toContain("keys set anthropic");
  });

  test("generic ConfigError still returns its own message", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ConfigError("Twilio phone number not configured.");
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toBe("Twilio phone number not configured.");
  });
});
