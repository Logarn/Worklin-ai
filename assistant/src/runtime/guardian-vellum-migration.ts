/**
 * Guardian binding drift healing for the vellum channel.
 *
 * The gateway owns guardian binding creation at startup
 * (`ensureVellumGuardianBinding` in gateway/src/auth/guardian-bootstrap.ts).
 * This module provides drift-healing logic which must remain
 * assistant-side since it reacts to incoming JWT principals.
 */

import {
  findGuardianForChannel,
  listContacts,
  updateContactPrincipalAndChannel,
  upsertContact,
} from "../contacts/contact-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-vellum-migration");

const MIGRATABLE_BOOTSTRAP_METHODS = new Set([
  "bootstrap",
  "startup-migration",
]);

function bootstrapAuthenticatedOwner(incomingPrincipalId: string): boolean {
  // A missing vellum channel must not let a second identity claim an existing
  // owner. First binding is permitted only for a completely ownerless store.
  if (listContacts(1, "guardian").length > 0) return false;

  const now = Date.now();
  const owner = upsertContact({
    displayName: "Worklin owner",
    notes: "Authenticated Worklin account owner",
    role: "guardian",
    principalId: incomingPrincipalId,
    channels: [
      {
        type: "vellum",
        address: incomingPrincipalId,
        isPrimary: true,
        externalUserId: incomingPrincipalId,
        externalChatId: "local",
        status: "active",
        policy: "allow",
        verifiedAt: now,
        verifiedVia: "authenticated-owner-bootstrap",
      },
    ],
  });

  const bound = owner.channels.some(
    (channel) =>
      channel.type === "vellum" &&
      channel.status === "active" &&
      channel.externalUserId === incomingPrincipalId,
  );
  if (bound) {
    log.info(
      { ownerContactId: owner.id, ownerCreated: owner.created },
      "Created missing owner binding from authenticated Worklin principal",
    );
  }
  return bound;
}

/**
 * Heal guardian binding drift for the vellum channel.
 *
 * After a DB reset, the daemon creates a new guardian binding with a fresh
 * `vellum-principal-<uuid>`, but the client may still hold a valid JWT
 * signed with the surviving signing key containing the old principal.
 * The JWT passes signature validation but trust resolution returns
 * `unknown` because the principals don't match.
 *
 * This function detects that scenario and updates the binding to match the
 * JWT's principal. If startup backfill did not create any owner, it also
 * establishes the first owner from a gateway-bound platform owner. The
 * incoming principal must use the platform-owner namespace. The stored vellum
 * binding must use that same generated namespace,
 * carry bootstrap provenance, or be explicitly marked as an import from the
 * retired guardian table. Challenge-verified and other external bindings are
 * never rewritten. The JWT's signature proves the incoming principal was
 * minted by this deployment's trusted control plane.
 *
 * Returns true if healing or first-owner binding occurred, false otherwise.
 */
export function healGuardianBindingDrift(
  incomingPrincipalId: string,
  options: { platformOwnerBound?: boolean } = {},
): boolean {
  if (!incomingPrincipalId.startsWith("vellum-principal-")) {
    return false;
  }

  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) {
    return options.platformOwnerBound === true
      ? bootstrapAuthenticatedOwner(incomingPrincipalId)
      : false;
  }

  const currentPrincipalId = guardianResult.contact.principalId;
  if (
    currentPrincipalId !== incomingPrincipalId &&
    guardianResult.channel.verifiedVia === "authenticated-owner-bootstrap"
  ) {
    return false;
  }

  const wasBootstrapped =
    guardianResult.channel.verifiedVia !== null &&
    MIGRATABLE_BOOTSTRAP_METHODS.has(guardianResult.channel.verifiedVia);
  const wasLegacyGuardianImport =
    guardianResult.contact.id.startsWith("legacy-guardian-");
  if (
    !currentPrincipalId?.startsWith("vellum-principal-") &&
    !wasBootstrapped &&
    !wasLegacyGuardianImport &&
    options.platformOwnerBound !== true
  ) {
    return false;
  }
  if (currentPrincipalId === incomingPrincipalId) return false;

  const updated = updateContactPrincipalAndChannel(
    guardianResult.contact.id,
    guardianResult.channel.id,
    incomingPrincipalId,
  );

  if (!updated) {
    log.warn(
      {
        oldPrincipalId: currentPrincipalId,
        newPrincipalId: incomingPrincipalId,
      },
      "Skipped guardian binding drift heal — address collision on contact_channels",
    );
    return false;
  }

  log.info(
    {
      oldPrincipalId: currentPrincipalId,
      newPrincipalId: incomingPrincipalId,
    },
    "Healed vellum guardian binding drift — updated principalId to match JWT actor",
  );

  return true;
}
