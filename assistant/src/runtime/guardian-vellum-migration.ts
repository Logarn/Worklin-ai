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
  updateContactPrincipalAndChannel,
} from "../contacts/contact-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-vellum-migration");

const MIGRATABLE_BOOTSTRAP_METHODS = new Set([
  "bootstrap",
  "startup-migration",
]);

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
 * JWT's principal. The incoming principal must use the platform-owner
 * namespace. The stored vellum binding must either use that same generated
 * namespace or carry bootstrap provenance, which covers legacy Worklin web
 * owners created before the namespace was introduced. Challenge-verified and
 * other external bindings are never rewritten. The JWT's signature proves the
 * incoming principal was minted by this deployment's trusted control plane.
 *
 * Returns true if healing occurred, false otherwise.
 */
export function healGuardianBindingDrift(incomingPrincipalId: string): boolean {
  if (!incomingPrincipalId.startsWith("vellum-principal-")) {
    return false;
  }

  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) return false;

  const currentPrincipalId = guardianResult.contact.principalId;
  const wasBootstrapped =
    guardianResult.channel.verifiedVia !== null &&
    MIGRATABLE_BOOTSTRAP_METHODS.has(guardianResult.channel.verifiedVia);
  if (
    !currentPrincipalId?.startsWith("vellum-principal-") &&
    !wasBootstrapped
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
