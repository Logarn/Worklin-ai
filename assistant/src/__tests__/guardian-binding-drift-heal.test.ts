import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { healGuardianBindingDrift } from "../runtime/guardian-vellum-migration.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

describe("healGuardianBindingDrift", () => {
  beforeEach(() => {
    resetTables();
  });

  test("heals drift when both principals have vellum-principal- prefix", () => {
    // Simulate DB reset: new guardian binding with a different UUID
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-new-uuid",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-new-uuid",
      verifiedVia: "startup-migration",
    });

    // Client arrives with the old JWT principal
    const healed = healGuardianBindingDrift("vellum-principal-old-uuid");
    expect(healed).toBe(true);

    // Guardian binding now matches the old JWT
    const guardian = findGuardianForChannel("vellum");
    expect(guardian).not.toBeNull();
    expect(guardian!.contact.principalId).toBe("vellum-principal-old-uuid");
    expect(guardian!.channel.externalUserId).toBe("vellum-principal-old-uuid");
  });

  test("heals a generated guardian to the authenticated platform owner", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-generated-runtime-id",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-generated-runtime-id",
      verifiedVia: "startup-migration",
    });

    const ownerPrincipalId = "vellum-principal-platform-owner-id";
    expect(healGuardianBindingDrift(ownerPrincipalId)).toBe(true);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe(ownerPrincipalId);
    expect(guardian!.channel.externalUserId).toBe(ownerPrincipalId);
  });

  test("heals a legacy bootstrap owner without the principal prefix", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "legacy-platform-owner-id",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "legacy-platform-owner-id",
      verifiedVia: "bootstrap",
    });

    const ownerPrincipalId = "vellum-principal-platform-owner-id";
    expect(healGuardianBindingDrift(ownerPrincipalId)).toBe(true);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe(ownerPrincipalId);
    expect(guardian!.channel.externalUserId).toBe(ownerPrincipalId);
  });

  test("heals a challenge-defaulted guardian imported from the legacy table", () => {
    createGuardianBinding({
      contactId: "legacy-guardian-production-binding",
      channel: "vellum",
      guardianExternalUserId: "legacy-platform-owner-id",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "legacy-platform-owner-id",
      verifiedVia: "challenge",
    });

    const ownerPrincipalId = "vellum-principal-platform-owner-id";
    expect(healGuardianBindingDrift(ownerPrincipalId)).toBe(true);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe(ownerPrincipalId);
    expect(guardian!.channel.externalUserId).toBe(ownerPrincipalId);
  });

  test("no-op when principals already match", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-same",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-same",
      verifiedVia: "startup-migration",
    });

    const healed = healGuardianBindingDrift("vellum-principal-same");
    expect(healed).toBe(false);
  });

  test("refuses to heal when incoming principal lacks vellum-principal- prefix", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-aaa",
      verifiedVia: "startup-migration",
    });

    // External/platform principal — should NOT be adopted
    const healed = healGuardianBindingDrift("platform-user-12345");
    expect(healed).toBe(false);

    // Guardian unchanged
    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("vellum-principal-aaa");
  });

  test("refuses to heal when stored principal lacks vellum-principal- prefix", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "verified-phone-guardian",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "verified-phone-guardian",
      verifiedVia: "challenge",
    });

    // Even with a vellum-principal- incoming, don't overwrite a real binding
    const healed = healGuardianBindingDrift("vellum-principal-attacker");
    expect(healed).toBe(false);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("verified-phone-guardian");
  });

  test("heals a trusted platform owner without rewriting channel verification", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "legacy-owner-binding",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "legacy-owner-binding",
      verifiedVia: "challenge",
    });

    const ownerPrincipalId = "vellum-principal-platform-owner-id";
    expect(
      healGuardianBindingDrift(ownerPrincipalId, {
        platformOwnerBound: true,
      }),
    ).toBe(true);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe(ownerPrincipalId);
    expect(guardian!.channel.verifiedVia).toBe("challenge");
  });

  test("creates the first owner binding from an authenticated Worklin principal", () => {
    const ownerPrincipalId = "vellum-principal-platform-owner";
    expect(
      healGuardianBindingDrift(ownerPrincipalId, {
        platformOwnerBound: true,
      }),
    ).toBe(true);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian).not.toBeNull();
    expect(guardian!.contact.principalId).toBe(ownerPrincipalId);
    expect(guardian!.channel.externalUserId).toBe(ownerPrincipalId);
    expect(guardian!.channel.verifiedVia).toBe("authenticated-owner-bootstrap");
  });

  test("refuses first binding for an unnamespaced principal", () => {
    expect(
      healGuardianBindingDrift("platform-owner", {
        platformOwnerBound: true,
      }),
    ).toBe(false);
    expect(findGuardianForChannel("vellum")).toBeNull();
  });

  test("refuses first binding without the trusted platform owner marker", () => {
    expect(healGuardianBindingDrift("vellum-principal-unbound")).toBe(false);
    expect(findGuardianForChannel("vellum")).toBeNull();
  });

  test("refuses first vellum binding when another owner already exists", () => {
    createGuardianBinding({
      channel: "slack",
      guardianExternalUserId: "U_EXISTING_OWNER",
      guardianDeliveryChatId: "C_OWNER",
      guardianPrincipalId: "existing-owner-principal",
      verifiedVia: "challenge",
    });

    expect(
      healGuardianBindingDrift("vellum-principal-second-owner", {
        platformOwnerBound: true,
      }),
    ).toBe(false);
    expect(findGuardianForChannel("vellum")).toBeNull();
  });
});
