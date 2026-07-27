import type { PluginListenerHandle } from "@capacitor/core";

import { publish } from "@/lib/event-bus";
import { captureError } from "@/lib/sentry/capture-error";
import { isNativePlatform } from "@/runtime/native-auth";
import { parseOAuthCompleteDeepLink } from "@/runtime/native-deep-link";

/** Route Capacitor custom-scheme OAuth callbacks onto the typed event bus. */
export function publishCapacitorDeepLinksSource(): () => void {
  if (!isNativePlatform()) return () => undefined;

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  import("@capacitor/app")
    .then(({ App }) =>
      App.addListener("appUrlOpen", ({ url }) => {
        const payload = parseOAuthCompleteDeepLink(url);
        if (payload?.oauthProvider) {
          publish("oauth.complete", {
            ...payload,
            oauthProvider: payload.oauthProvider,
          });
        }
      }),
    )
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((error) => {
      captureError(error, {
        context: "oauth_complete_deep_link_init",
        level: "warning",
      });
    });

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
