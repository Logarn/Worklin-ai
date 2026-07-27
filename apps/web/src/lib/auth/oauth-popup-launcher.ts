import { safeManagedOAuthUrl } from "@/lib/auth/managed-oauth-api";
import { getOAuthPopupReadyMessagePayload } from "@/lib/auth/oauth-popup";
import { routes } from "@/utils/routes";

interface OAuthPopupUrlOptions {
  requestId: string;
  providerKey: string;
  currentOrigin?: string;
  configuredWebUrl?: string | null;
}

function configuredWebUrl(): string | null {
  return (
    (
      window as unknown as {
        __VELLUM_CONFIG__?: { webUrl?: string };
      }
    ).__VELLUM_CONFIG__?.webUrl ?? null
  );
}

function resolveOAuthWebBaseUrl(
  currentOrigin: string,
  configuredUrl: string | null,
): string | null {
  for (const candidate of [currentOrigin, configuredUrl]) {
    if (!candidate) continue;
    const safe = safeManagedOAuthUrl(candidate);
    if (safe) return safe;
  }
  return null;
}

export function getManagedOAuthPopupBootstrapUrl({
  requestId,
  providerKey,
  currentOrigin = window.location.origin,
  configuredWebUrl: configuredUrl = configuredWebUrl(),
}: OAuthPopupUrlOptions): string | null {
  const baseUrl = resolveOAuthWebBaseUrl(currentOrigin, configuredUrl);
  if (!baseUrl) return null;

  const url = new URL(routes.account.oauth.popupComplete, baseUrl);
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("oauth_provider", providerKey);
  url.searchParams.set("oauth_pending", "1");
  return url.toString();
}

/** Opens an OAuth URL only after a same-origin bootstrap severs its opener. */
export function openDetachedOAuthPopup(
  externalUrl: string,
  features = "width=500,height=600",
): boolean {
  const safeExternalUrl = safeManagedOAuthUrl(externalUrl);
  if (!safeExternalUrl) return false;

  const requestId = crypto.randomUUID();
  const providerKey = "external-oauth";
  const bootstrapUrl = getManagedOAuthPopupBootstrapUrl({
    requestId,
    providerKey,
  });
  if (!bootstrapUrl) return false;

  const openedPopup = window.open(bootstrapUrl, "_blank", features);
  if (!openedPopup) return false;
  const popup: Window = openedPopup;
  const targetUrl: string = safeExternalUrl;

  const callbackOrigin = new URL(bootstrapUrl).origin;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    window.removeEventListener("message", handleReady);
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  };
  function handleReady(event: MessageEvent) {
    if (event.source !== popup) return;
    const ready = getOAuthPopupReadyMessagePayload(
      event,
      callbackOrigin,
      requestId,
      providerKey,
    );
    if (!ready) return;

    cleanup();
    if (popup.closed) return;
    try {
      popup.location.href = targetUrl;
      popup.focus();
    } catch {
      try {
        popup.close();
      } catch {
        // The popup may have been closed between the ready signal and launch.
      }
    }
  }

  window.addEventListener("message", handleReady);
  timeout = setTimeout(cleanup, 30_000);
  return true;
}
