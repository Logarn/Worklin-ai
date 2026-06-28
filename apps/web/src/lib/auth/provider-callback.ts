import type { Authenticated } from "@/generated/auth/types.gen";
import { classifyCallbackFlows, type CallbackOutcome } from "@/domains/account/social-auth";
import type { AllauthResult } from "@/lib/auth/allauth-client";

export interface WaitForProviderCallbackOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auth0 can redirect back to the SPA before the backend session probe settles.
 * Retry the callback probe briefly so we do not show a terminal auth error
 * for a session that is still becoming visible to cross-origin fetches.
 */
export async function waitForProviderCallbackOutcome(
  probe: () => Promise<AllauthResult<Authenticated>>,
  {
    maxAttempts = 6,
    initialDelayMs = 75,
  }: WaitForProviderCallbackOptions = {},
): Promise<CallbackOutcome> {
  let lastOutcome: CallbackOutcome = {
    kind: "error",
    message: "Unexpected authentication state.",
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await probe();
      const isAuthenticated = result.ok && !!result.data.user;
      const pendingFlows = result.ok ? [] : (result.flows ?? []);
      const outcome = classifyCallbackFlows(isAuthenticated, pendingFlows);
      if (outcome.kind !== "error") {
        return outcome;
      }
      lastOutcome = outcome;
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        throw error;
      }
    }

    if (attempt < maxAttempts - 1) {
      await delay(initialDelayMs * (attempt + 1));
    }
  }

  return lastOutcome;
}
