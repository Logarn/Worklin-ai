import { describe, expect, test } from "bun:test";

import { BadRequestError, ServiceUnavailableError } from "../errors.js";
import { assertApiKeyAccepted } from "../secret-routes.js";

describe("secret API key validation outcome", () => {
  test("rejects typed invalid credentials as a client error", () => {
    expect(() =>
      assertApiKeyAccepted("OpenAI", {
        valid: false,
        outcome: "invalid_credentials",
        reason: "OpenAI rejected this API key.",
      }),
    ).toThrow(BadRequestError);
  });

  test("keeps legacy provider rejections fail-closed", () => {
    expect(() =>
      assertApiKeyAccepted("Kimi", {
        valid: false,
        reason: "Kimi rejected this API key.",
      }),
    ).toThrow(BadRequestError);
  });

  test("allows a verified key to continue to secure storage", () => {
    expect(() => assertApiKeyAccepted("Kimi", { valid: true })).not.toThrow();
  });

  test("surfaces transient validation failures as service unavailable", () => {
    expect(() =>
      assertApiKeyAccepted("OpenAI", {
        valid: false,
        outcome: "verification_unavailable",
        reason: "OpenAI could not verify this connection (503).",
      }),
    ).toThrow(ServiceUnavailableError);
  });
});
