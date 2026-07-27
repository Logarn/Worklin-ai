/**
 * The onboarding provider key is the only raw secret temporarily held by the
 * renderer. Bind it to the authenticated user that entered it so a session
 * refresh or account switch cannot carry the key into another user's hatch.
 *
 * This low-level helper lives in lib/auth so the auth store can enforce the
 * boundary without importing the onboarding domain (which would introduce a
 * store/domain dependency cycle).
 */
export const PENDING_PROVIDER_KEY_STORAGE = "onboarding.providerKey";

function removePendingProviderSecret(): void {
  try {
    sessionStorage.removeItem(PENDING_PROVIDER_KEY_STORAGE);
  } catch {
    // Storage may be unavailable in private mode. There is nothing else to do.
  }
}

/**
 * Remove legacy, malformed, signed-out, or differently-owned pending secrets.
 * A missing owner is intentionally rejected: older releases stored an
 * unscoped raw key, and retaining it would preserve the account-switch bug.
 */
export function clearPendingProviderSecretUnlessOwnedBy(
  userId: string | null,
): void {
  try {
    const raw = sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    const ownerUserId =
      parsed !== null &&
      typeof parsed === "object" &&
      "ownerUserId" in parsed &&
      typeof parsed.ownerUserId === "string"
        ? parsed.ownerUserId
        : null;
    if (!userId || ownerUserId !== userId) {
      removePendingProviderSecret();
    }
  } catch {
    removePendingProviderSecret();
  }
}
