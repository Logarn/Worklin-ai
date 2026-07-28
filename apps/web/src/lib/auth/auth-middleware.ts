import {
  redirect,
  createContext as createRouterContext,
  type MiddlewareFunction,
} from "react-router";

import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { isSessionSettled } from "@/stores/session-status";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { whenStoreState } from "@/utils/when-store-state";

export const authUserContext = createRouterContext<AuthUser | null>(null);

const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;

async function waitForRouteGuardPrerequisite(
  state: ReturnType<typeof buildNavigationState>,
): Promise<void> {
  if (!state.sessionSettled) {
    await whenStoreState(useAuthStore, (s) => isSessionSettled(s.sessionStatus));
    return;
  }

  if (state.isLocalMode && !state.hasAssistants && state.platformSession === "unknown") {
    await whenStoreState(
      useAuthStore,
      (s) => s.platformSession !== "unknown",
      { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
    );
    return;
  }

}

export const authMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const url = new URL(request.url);
  while (true) {
    const state = buildNavigationState();

    const decision = resolveNavigation(state, {
      kind: "route-guard",
      pathname: url.pathname + url.search,
    });

    if (decision.action === "wait") {
      await waitForRouteGuardPrerequisite(state);
      continue;
    }

    if (decision.action === "redirect") {
      throw redirect(decision.to);
    }

    context.set(authUserContext, useAuthStore.getState().user);
    return next();
  }
};
