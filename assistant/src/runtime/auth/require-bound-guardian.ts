import { isHttpAuthDisabled } from "../../config/env.js";
import { findGuardianForChannel } from "../../contacts/contact-store.js";
import { healGuardianBindingDrift } from "../guardian-vellum-migration.js";
import { httpError } from "../http-errors.js";
import type { AuthContext } from "./types.js";

function isAuthenticatedIsolatedPlatformOwner(
  authContext: AuthContext,
): boolean {
  const tenant = authContext.tenantContext;
  return (
    authContext.principalType === "actor" &&
    tenant !== undefined &&
    authContext.pooledWorkerLease === undefined &&
    tenant.assistantId === authContext.assistantId &&
    tenant.actorId === authContext.actorPrincipalId
  );
}

/**
 * Verify the actor from AuthContext is the bound guardian for the vellum channel.
 * Returns an error Response if not, or null if allowed.
 */
export function requireBoundGuardian(
  authContext: AuthContext,
): Response | null {
  // Dev bypass: when auth is disabled, skip guardian binding check
  // (mirrors enforcePolicy dev bypass in route-policy.ts)
  if (isHttpAuthDisabled()) {
    return null;
  }
  if (!authContext.actorPrincipalId) {
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }

  if (isAuthenticatedIsolatedPlatformOwner(authContext)) {
    healGuardianBindingDrift(authContext.actorPrincipalId, {
      platformOwnerBound: true,
    });
  }

  const guardianResult = findGuardianForChannel("vellum");
  if (!guardianResult) {
    // No guardian yet — in pre-bootstrap state, allow through
    return null;
  }
  if (
    (guardianResult.channel.externalUserId ??
      guardianResult.contact.principalId) !== authContext.actorPrincipalId
  ) {
    return httpError(
      "FORBIDDEN",
      "Actor is not the bound guardian for this channel",
      403,
    );
  }
  return null;
}
