import { describe, expect, test } from "bun:test";

import { resolveAuthenticatedOwnerTrustContext } from "./platform-owner-trust.js";

describe("resolveAuthenticatedOwnerTrustContext", () => {
  test("trusts each gateway-bound account owner independently", () => {
    const ownerA = resolveAuthenticatedOwnerTrustContext({
      actorPrincipalId: "vellum-principal-user-a",
      platformOwnerBound: true,
      sourceChannel: "vellum",
    });
    const ownerB = resolveAuthenticatedOwnerTrustContext({
      actorPrincipalId: "vellum-principal-user-b",
      platformOwnerBound: true,
      sourceChannel: "vellum",
    });

    expect(ownerA?.trustClass).toBe("guardian");
    expect(ownerA?.guardianPrincipalId).toBe("vellum-principal-user-a");
    expect(ownerB?.trustClass).toBe("guardian");
    expect(ownerB?.guardianPrincipalId).toBe("vellum-principal-user-b");
    expect(ownerA?.guardianPrincipalId).not.toBe(ownerB?.guardianPrincipalId);
  });

  test("rejects an unbound or non-platform principal", () => {
    expect(
      resolveAuthenticatedOwnerTrustContext({
        actorPrincipalId: "vellum-principal-user-a",
        platformOwnerBound: false,
        sourceChannel: "vellum",
      }),
    ).toBeNull();
    expect(
      resolveAuthenticatedOwnerTrustContext({
        actorPrincipalId: "user-a",
        platformOwnerBound: true,
        sourceChannel: "vellum",
      }),
    ).toBeNull();
    expect(
      resolveAuthenticatedOwnerTrustContext({
        actorPrincipalId: undefined,
        platformOwnerBound: true,
        sourceChannel: "vellum",
      }),
    ).toBeNull();
  });
});
