import type { ChannelId } from "../channels/types.js";
import type { TrustContext } from "../daemon/trust-context.js";

/**
 * Resolve the authenticated Worklin account owner without consulting the
 * runtime's shared contacts database.
 *
 * The gateway validates the actor JWT and assistant scope, removes any
 * caller-supplied owner marker, then adds `x-vellum-platform-owner: true`.
 * That marker is therefore a transport-level proof that this namespaced
 * principal is the owner for this request, rather than a shared guardian row.
 */
export function resolveAuthenticatedOwnerTrustContext(params: {
  actorPrincipalId: string | undefined;
  platformOwnerBound: boolean;
  sourceChannel: ChannelId;
}): TrustContext | null {
  const { actorPrincipalId, platformOwnerBound, sourceChannel } = params;

  if (
    !platformOwnerBound ||
    !actorPrincipalId ||
    !actorPrincipalId.startsWith("vellum-principal-")
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
    requesterIdentifier: actorPrincipalId,
  };
}
