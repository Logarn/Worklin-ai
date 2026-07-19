import { describe, expect, test } from "bun:test";

import { BadRequestError } from "../errors.js";
import { assertApiKeyAccepted } from "../secret-routes.js";

describe("secret API key validation outcome", () => {
  test("throws a typed client error instead of returning a successful save", () => {
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
});
