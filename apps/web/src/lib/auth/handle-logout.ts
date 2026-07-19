import type { NavigateFunction } from "react-router";

import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { isElectron } from "@/runtime/is-electron";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const HOSTED_LOGOUT_PATH = "/logout";

export async function handleLogout(navigate: NavigateFunction): Promise<void> {
  if (isLocalMode()) {
    const active = getActiveAssistant();
    if (active && isLocalAssistant(active)) {
      await setMenuPlatformSession(false);
      useAuthStore.setState({ platformSession: "absent" });
      return;
    }

    await setMenuPlatformSession(false);
    await useAuthStore.getState().logout();
    navigate(getOnboardingEntrypoint());
  } else {
    try {
      await useAuthStore.getState().logout();
    } catch (error) {
      console.warn("[auth] Worklin session cleanup failed during logout", error);
    } finally {
      hardNavigate(isElectron() ? routes.account.login : HOSTED_LOGOUT_PATH);
    }
  }
}
