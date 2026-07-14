const VELLUM_PRINCIPAL_PREFIX = "vellum-principal-";

/**
 * Return the runtime guardian principal for an authenticated platform owner.
 * The namespace is intentionally shared with the runtime's constrained
 * guardian-binding migration so an isolated runtime can bind its generated
 * startup guardian to the authenticated owner on first use.
 */
export function platformOwnerPrincipalId(userId: string): string {
  if (!userId) {
    throw new Error("Platform owner user id is required");
  }
  return `${VELLUM_PRINCIPAL_PREFIX}${userId}`;
}
