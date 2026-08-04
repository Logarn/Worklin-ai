import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createGuardianBinding } from "../../../__tests__/helpers/create-guardian-binding.js";
import { findGuardianForChannel } from "../../../contacts/contact-store.js";
import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { requireBoundGuardian } from "../require-bound-guardian.js";
import type { AuthContext } from "../types.js";

initializeDb();

function resetGuardian(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function platformOwnerContext(principalId: string): AuthContext {
  return {
    subject: `actor:assistant-1:${principalId}`,
    principalType: "actor",
    assistantId: "assistant-1",
    actorPrincipalId: principalId,
    scopeProfile: "actor_client_v1",
    scopes: new Set(["approval.write"]),
    policyEpoch: 0,
    tenantContext: {
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      actorId: principalId,
      requestId: "request-1",
    },
  };
}

describe("requireBoundGuardian", () => {
  beforeEach(resetGuardian);

  test("heals a bootstrap binding for the signed isolated platform owner", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-stale",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-stale",
      verifiedVia: "bootstrap",
    });

    const currentOwner = "vellum-principal-current-owner";
    expect(requireBoundGuardian(platformOwnerContext(currentOwner))).toBeNull();

    const guardian = findGuardianForChannel("vellum");
    expect(guardian?.contact.principalId).toBe(currentOwner);
    expect(guardian?.channel.externalUserId).toBe(currentOwner);
  });

  test("does not heal without signed tenant context", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-stale",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-stale",
      verifiedVia: "bootstrap",
    });

    const context = platformOwnerContext("vellum-principal-untrusted");
    delete context.tenantContext;

    expect(requireBoundGuardian(context)?.status).toBe(403);
    expect(findGuardianForChannel("vellum")?.contact.principalId).toBe(
      "vellum-principal-stale",
    );
  });

  test("does not rewrite an authenticated owner binding", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-owner-a",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-owner-a",
      verifiedVia: "authenticated-owner-bootstrap",
    });

    expect(
      requireBoundGuardian(platformOwnerContext("vellum-principal-owner-b"))
        ?.status,
    ).toBe(403);
    expect(findGuardianForChannel("vellum")?.contact.principalId).toBe(
      "vellum-principal-owner-a",
    );
  });
});
