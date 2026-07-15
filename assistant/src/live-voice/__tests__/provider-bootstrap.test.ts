import { describe, expect, test } from "bun:test";

import { isVoicePilotAllowed } from "../provider-bootstrap.js";

describe("managed voice pilot allowlist", () => {
  test("accepts wildcard and exact canonical principals", () => {
    expect(isVoicePilotAllowed(["*"], "vellum-principal-user-1")).toBe(true);
    expect(
      isVoicePilotAllowed(
        ["vellum-principal-user-1"],
        "vellum-principal-user-1",
      ),
    ).toBe(true);
  });

  test("accepts a legacy raw user ID for its canonical platform principal", () => {
    expect(isVoicePilotAllowed(["user-1"], "vellum-principal-user-1")).toBe(
      true,
    );
  });

  test("does not broaden unrelated or noncanonical actors", () => {
    expect(isVoicePilotAllowed(["user-2"], "vellum-principal-user-1")).toBe(
      false,
    );
    expect(isVoicePilotAllowed(["vellum-principal-user-1"], "user-1")).toBe(
      false,
    );
  });
});
