import { describe, expect, test } from "bun:test";

import type { AuthContext } from "./auth/types.js";
import { resolveAuthenticatedOwnerTrustContext } from "./platform-owner-trust.js";

const baseContext: AuthContext = {
  subject: "actor:self:vellum-principal-user-1",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "vellum-principal-user-1",
  scopeProfile: "actor_client_v1",
  scopes: new Set(),
  policyEpoch: 1,
  tenantContext: {
    version: 1,
    organizationId: "org-1",
    userId: "user-1",
    assistantId: "assistant-1",
    actorId: "vellum-principal-user-1",
    requestId: "request-1",
  },
};

describe("resolveAuthenticatedOwnerTrustContext", () => {
  test("trusts the signed tenant owner independently of shared contacts", () => {
    expect(
      resolveAuthenticatedOwnerTrustContext(baseContext, "vellum"),
    ).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
      guardianChatId: "local",
      guardianExternalUserId: "vellum-principal-user-1",
      guardianPrincipalId: "vellum-principal-user-1",
      requesterExternalUserId: "vellum-principal-user-1",
      requesterIdentifier: "user-1",
    });
  });

  test("rejects an actor without a signed tenant context", () => {
    const { tenantContext: _tenantContext, ...withoutTenant } = baseContext;
    expect(
      resolveAuthenticatedOwnerTrustContext(withoutTenant, "vellum"),
    ).toBeNull();
  });

  test("rejects a tenant context whose actor is not the deterministic owner", () => {
    expect(
      resolveAuthenticatedOwnerTrustContext(
        {
          ...baseContext,
          actorPrincipalId: "vellum-principal-other-user",
          tenantContext: {
            ...baseContext.tenantContext!,
            actorId: "vellum-principal-other-user",
          },
        },
        "vellum",
      ),
    ).toBeNull();
  });

  test("does not elevate service principals", () => {
    expect(
      resolveAuthenticatedOwnerTrustContext(
        {
          ...baseContext,
          principalType: "svc_gateway",
          actorPrincipalId: undefined,
        },
        "vellum",
      ),
    ).toBeNull();
  });
});
