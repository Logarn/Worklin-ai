import type { ChannelId } from "../channels/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { AuthContext } from "./auth/types.js";

/**
 * Resolve the authenticated Worklin account owner without consulting the
 * runtime's shared contacts database.
 *
 * The control plane signs the tenant context and derives actor IDs as
 * `vellum-principal-<userId>`. Runtime auth validates that envelope before
 * route handlers run, so this works for pooled runtimes without making one
 * user's guardian binding the owner for every user.
 */
export function resolveAuthenticatedOwnerTrustContext(
  authContext: AuthContext | undefined,
  sourceChannel: ChannelId,
): TrustContext | null {
  const tenant = authContext?.tenantContext;
  const actorPrincipalId = authContext?.actorPrincipalId;

  if (
    authContext?.principalType !== "actor" ||
    !tenant ||
    !actorPrincipalId ||
    actorPrincipalId !== tenant.actorId ||
    actorPrincipalId !== `vellum-principal-${tenant.userId}`
  ) {
    return null;
  }

  return {
    sourceChannel,
    trustClass: "guardian",
    guardianChatId: "local",
    guardianExternalUserId: actorPrincipalId,
    guardianPrincipalId: actorPrincipalId,
    requesterExternalUserId: actorPrincipalId,
    requesterIdentifier: tenant.userId,
  };
}
