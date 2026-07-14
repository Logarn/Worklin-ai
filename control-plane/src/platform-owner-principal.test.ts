import { describe, expect, test } from "bun:test";

import { platformOwnerPrincipalId } from "./platform-owner-principal.js";

describe("platformOwnerPrincipalId", () => {
  test("maps the authenticated owner into the constrained vellum namespace", () => {
    expect(platformOwnerPrincipalId("user_123")).toBe(
      "vellum-principal-user_123",
    );
  });

  test("rejects an empty owner id", () => {
    expect(() => platformOwnerPrincipalId("")).toThrow(
      "Platform owner user id is required",
    );
  });
});
