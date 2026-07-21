import { useEffect } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";

/**
 * Subscribes to the typed Electron/Capacitor deep-link bus event and the
 * legacy window event used by older native shells.
 *
 * `onPayload` should be wrapped in `useCallback` — re-renders that change
 * the callback re-register the listener. Both producers no-op on web.
 */
export function useOAuthCompleteDeepLinkListener(
  onPayload: (payload: OAuthCompleteDeepLinkPayload) => void,
): void {
  useBusSubscription("oauth.complete", onPayload);

  useEffect(() => {
    const handler = (event: CustomEvent<OAuthCompleteDeepLinkPayload>) => {
      onPayload(event.detail);
    };
    window.addEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, handler);
    return () => {
      window.removeEventListener(OAUTH_COMPLETE_DEEP_LINK_EVENT, handler);
    };
  }, [onPayload]);
}
