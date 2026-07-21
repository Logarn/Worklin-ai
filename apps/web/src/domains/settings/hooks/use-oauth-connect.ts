import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchManagedOAuthConnectionBaseline,
  isManagedOAuthProviderUnsupported,
  ManagedOAuthStartError,
  safeManagedOAuthUrl,
  startManagedOAuthAuthorization,
  verifyManagedOAuthConnection,
} from "@/domains/settings/services/managed-oauth-start";
import { useOAuthCompleteDeepLinkListener } from "@/hooks/use-oauth-complete-deep-link-listener";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  getOAuthPopupReadyMessagePayload,
  oauthCompletionStorageKey,
  parseOAuthCompletePayload,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { OAuthCompleteDeepLinkPayload } from "@/runtime/native-deep-link";
import { getProviderConnectionSignatures } from "@/utils/oauth-connection-utils";
import { routes } from "@/utils/routes";
import { toast } from "@vellumai/design-library/components/toast";

interface UseOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  displayName: string;
  managedAvailable: boolean;
  connectionsQueryKey: QueryKey;
}

interface UseOAuthConnectResult {
  handleConnect: () => void;
  oauthInProgress: boolean;
  startOAuthPending: boolean;
  connectError: string | null;
  managedUnsupported: boolean;
}

interface PendingOAuthRequest {
  requestId: string;
  provider: string;
  callbackOrigin: string;
  baselineConnectionSignatures: ReadonlyMap<string, string>;
  completionInFlight: boolean;
  authorizationStarted: boolean;
  startupComplete: boolean;
  bootstrapReady: boolean;
  connectUrl: string | null;
  abortController: AbortController;
  nativeBrowserFinishedUnsubscribe: (() => void) | null;
}

const OAUTH_STARTUP_TIMEOUT_MS = 30_000;
const POPUP_CHECK_INTERVAL_MS = 100;
const POPUP_CLOSE_GRACE_MS = 1_000;

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

function getManagedOAuthCallbackUrl(
  bootstrapUrl: string,
  requestId: string,
  providerKey: string,
  usesDeepLinkHandoff: boolean,
): string {
  const url = new URL(routes.account.oauth.popupComplete, bootstrapUrl);
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("oauth_provider", providerKey);
  if (usesDeepLinkHandoff) {
    url.searchParams.set("handoff", "deep-link");
  }
  return url.toString();
}

/**
 * Orchestrates managed OAuth for web popups, packaged Electron, and
 * Capacitor. External authorization only starts after the bootstrap popup has
 * detached its opener. Completion is always re-verified against the backend.
 */
export function useOAuthConnect({
  assistantId,
  providerKey,
  displayName,
  managedAvailable,
  connectionsQueryKey,
}: UseOAuthConnectOptions): UseOAuthConnectResult {
  const queryClient = useQueryClient();
  const native = useIsNativePlatform();
  const electron = isElectron();
  const usesDeepLinkHandoff = native || electron;

  const popupRef = useRef<Window | null>(null);
  const pendingRequestRef = useRef<PendingOAuthRequest | null>(null);
  const popupCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const popupClosedGraceTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const startupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [managedUnsupported, setManagedUnsupported] = useState(() =>
    isManagedOAuthProviderUnsupported(assistantId, providerKey),
  );

  useEffect(() => {
    setManagedUnsupported(
      isManagedOAuthProviderUnsupported(assistantId, providerKey),
    );
  }, [assistantId, providerKey]);

  const showConnectError = useCallback((message: string) => {
    setConnectError(message);
    toast.error(message);
  }, []);

  const clearStartupTimeout = useCallback(() => {
    if (!startupTimeoutRef.current) return;
    clearTimeout(startupTimeoutRef.current);
    startupTimeoutRef.current = null;
  }, []);

  const closePopupWindow = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;

    if (popupCheckIntervalRef.current) {
      clearInterval(popupCheckIntervalRef.current);
      popupCheckIntervalRef.current = null;
    }
    if (popupClosedGraceTimeoutRef.current) {
      clearTimeout(popupClosedGraceTimeoutRef.current);
      popupClosedGraceTimeoutRef.current = null;
    }
    clearStartupTimeout();
  }, [clearStartupTimeout]);

  const clearPendingRequest = useCallback(() => {
    const pendingRequest = pendingRequestRef.current;
    pendingRequestRef.current = null;
    pendingRequest?.nativeBrowserFinishedUnsubscribe?.();
    if (pendingRequest) {
      pendingRequest.nativeBrowserFinishedUnsubscribe = null;
      pendingRequest.abortController.abort();
      window.localStorage.removeItem(
        oauthCompletionStorageKey(pendingRequest.requestId),
      );
    }
    setOAuthInProgress(false);
  }, []);

  const cancelPendingStartup = useCallback(
    (pendingRequest: PendingOAuthRequest, message: string) => {
      if (pendingRequestRef.current?.requestId !== pendingRequest.requestId) {
        return;
      }
      closePopupWindow();
      clearPendingRequest();
      showConnectError(message);
    },
    [clearPendingRequest, closePopupWindow, showConnectError],
  );

  const finishConnected = useCallback(() => {
    setConnectError(null);
    void queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
    toast.success(`${displayName} account connected.`);
  }, [connectionsQueryKey, displayName, queryClient]);

  const verifyPendingConnection = useCallback(
    async (
      pendingRequest: PendingOAuthRequest,
      absentMessage: string,
    ): Promise<void> => {
      if (
        pendingRequestRef.current?.requestId !== pendingRequest.requestId ||
        pendingRequest.completionInFlight
      ) {
        return;
      }

      pendingRequest.completionInFlight = true;
      closePopupWindow();

      try {
        const result = await verifyManagedOAuthConnection({
          assistantId,
          providerKey,
          providerLabel: displayName,
          baselineConnectionSignatures:
            pendingRequest.baselineConnectionSignatures,
          signal: pendingRequest.abortController.signal,
        });
        if (pendingRequestRef.current?.requestId !== pendingRequest.requestId) {
          return;
        }

        clearPendingRequest();
        if (result.outcome === "connected") {
          finishConnected();
        } else if (result.outcome === "absent") {
          showConnectError(absentMessage);
        } else {
          showConnectError(result.message);
        }
      } catch (error) {
        if (
          pendingRequestRef.current?.requestId !== pendingRequest.requestId ||
          pendingRequest.abortController.signal.aborted
        ) {
          return;
        }
        clearPendingRequest();
        showConnectError(
          error instanceof Error
            ? error.message
            : `Worklin could not verify the ${displayName} account. Refresh the accounts and try again.`,
        );
      }
    },
    [
      assistantId,
      clearPendingRequest,
      closePopupWindow,
      displayName,
      finishConnected,
      providerKey,
      showConnectError,
    ],
  );

  const handleOAuthCompletePayload = useCallback(
    async (payload: OAuthCompletePayload): Promise<boolean> => {
      const pendingRequest = pendingRequestRef.current;
      if (
        payload.type !== "vellum:oauth-complete" ||
        !pendingRequest ||
        payload.requestId !== pendingRequest.requestId ||
        payload.oauthProvider !== pendingRequest.provider ||
        pendingRequest.completionInFlight
      ) {
        return false;
      }

      if (payload.oauthStatus === "connected") {
        await verifyPendingConnection(
          pendingRequest,
          `${displayName} authorization finished, but no new or updated account was found. Try again, or choose Your Own to connect with your OAuth app.`,
        );
        return true;
      }

      pendingRequest.completionInFlight = true;
      closePopupWindow();
      clearPendingRequest();
      const message = payload.oauthCode
        ? `Error: ${payload.oauthCode}`
        : "Authorization failed";
      showConnectError(
        `${displayName} ${message}. Try again, or choose Your Own to connect with your OAuth app.`,
      );
      return true;
    },
    [
      clearPendingRequest,
      closePopupWindow,
      displayName,
      showConnectError,
      verifyPendingConnection,
    ],
  );

  const navigatePopupWhenReady = useCallback(
    (pendingRequest: PendingOAuthRequest) => {
      if (
        pendingRequestRef.current?.requestId !== pendingRequest.requestId ||
        pendingRequest.authorizationStarted ||
        !pendingRequest.bootstrapReady ||
        !pendingRequest.connectUrl
      ) {
        return;
      }

      const popup = popupRef.current;
      if (!popup || popup.closed) {
        cancelPendingStartup(
          pendingRequest,
          `${displayName} authorization popup closed before it could start. Try again, or choose Your Own to connect with your OAuth app.`,
        );
        return;
      }

      pendingRequest.authorizationStarted = true;
      pendingRequest.startupComplete = true;
      clearStartupTimeout();
      popup.location.href = pendingRequest.connectUrl;
    },
    [cancelPendingStartup, clearStartupTimeout, displayName],
  );

  // Web bootstrap and legacy completion messages. Every accepted message is
  // source-, origin-, request-, and provider-scoped before it mutates the flow.
  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest || event.source !== popupRef.current) return;

      const ready = getOAuthPopupReadyMessagePayload(
        event,
        pendingRequest.callbackOrigin,
        pendingRequest.requestId,
        pendingRequest.provider,
      );
      if (ready) {
        pendingRequest.bootstrapReady = true;
        navigatePopupWhenReady(pendingRequest);
        return;
      }

      const payload = getOAuthCompleteMessagePayload(
        event,
        pendingRequest.callbackOrigin,
        pendingRequest.requestId,
      );
      if (payload) void handleOAuthCompletePayload(payload);
    };

    const handleOAuthStorage = (event: StorageEvent) => {
      const pendingRequest = pendingRequestRef.current;
      if (!pendingRequest) return;

      const payload = getOAuthCompleteStoragePayload(
        event,
        pendingRequest.requestId,
      );
      if (payload) {
        void handleOAuthCompletePayload(payload);
        window.localStorage.removeItem(
          oauthCompletionStorageKey(pendingRequest.requestId),
        );
      }
    };

    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleOAuthStorage);
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleOAuthStorage);
    };
  }, [handleOAuthCompletePayload, navigatePopupWhenReady]);

  const handleOAuthDeepLink = useCallback(
    (payload: OAuthCompleteDeepLinkPayload) => {
      const pendingRequest = pendingRequestRef.current;
      if (
        !pendingRequest ||
        payload.requestId !== pendingRequest.requestId ||
        payload.oauthProvider !== pendingRequest.provider
      ) {
        return;
      }
      void handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    },
    [handleOAuthCompletePayload],
  );
  useOAuthCompleteDeepLinkListener(handleOAuthDeepLink);

  const installNativeBrowserFinishedListener = useCallback(
    (pendingRequest: PendingOAuthRequest) => {
      const requestId = pendingRequest.requestId;
      const provider = pendingRequest.provider;
      pendingRequest.nativeBrowserFinishedUnsubscribe = openUrlFinishedListener(
        () => {
          const current = pendingRequestRef.current;
          if (
            !current ||
            current.requestId !== requestId ||
            current.provider !== provider ||
            !current.authorizationStarted ||
            current.completionInFlight
          ) {
            return;
          }

          void verifyPendingConnection(
            current,
            `${displayName} authorization closed before an account connected. Try again, or choose Your Own to connect with your OAuth app.`,
          );
        },
      );
    },
    [displayName, verifyPendingConnection],
  );

  const startPopupMonitoring = useCallback(() => {
    popupCheckIntervalRef.current = setInterval(() => {
      const pendingRequest = pendingRequestRef.current;
      const popup = popupRef.current;
      if (!pendingRequest || (popup && !popup.closed)) return;

      if (!pendingRequest.authorizationStarted) {
        cancelPendingStartup(
          pendingRequest,
          `${displayName} authorization popup closed before it could start. Try again, or choose Your Own to connect with your OAuth app.`,
        );
        return;
      }
      if (popupClosedGraceTimeoutRef.current) return;

      popupClosedGraceTimeoutRef.current = setTimeout(() => {
        popupClosedGraceTimeoutRef.current = null;
        const current = pendingRequestRef.current;
        if (!current || current.completionInFlight) return;

        const storageKey = oauthCompletionStorageKey(current.requestId);
        const storedCompletion = window.localStorage.getItem(storageKey);
        if (storedCompletion) {
          const parsed = parseOAuthCompletePayload(storedCompletion);
          window.localStorage.removeItem(storageKey);
          if (parsed) {
            void handleOAuthCompletePayload(parsed);
            return;
          }
        }

        void verifyPendingConnection(
          current,
          `${displayName} authorization popup closed before an account connected. Try again, or choose Your Own to connect with your OAuth app.`,
        );
      }, POPUP_CLOSE_GRACE_MS);
    }, POPUP_CHECK_INTERVAL_MS);
  }, [
    cancelPendingStartup,
    displayName,
    handleOAuthCompletePayload,
    verifyPendingConnection,
  ]);

  const startStartupDeadline = useCallback(
    (pendingRequest: PendingOAuthRequest) => {
      clearStartupTimeout();
      startupTimeoutRef.current = setTimeout(() => {
        const current = pendingRequestRef.current;
        if (
          !current ||
          current.requestId !== pendingRequest.requestId ||
          current.provider !== pendingRequest.provider ||
          current.startupComplete
        ) {
          return;
        }
        cancelPendingStartup(
          current,
          `${displayName} authorization took too long to start. Try again, or choose Your Own to connect with your OAuth app.`,
        );
      }, OAUTH_STARTUP_TIMEOUT_MS);
    },
    [cancelPendingStartup, clearStartupTimeout, displayName],
  );

  useEffect(() => {
    return () => {
      const pendingRequest = pendingRequestRef.current;
      pendingRequestRef.current = null;
      pendingRequest?.nativeBrowserFinishedUnsubscribe?.();
      pendingRequest?.abortController.abort();
      if (pendingRequest) {
        window.localStorage.removeItem(
          oauthCompletionStorageKey(pendingRequest.requestId),
        );
      }
      closePopupWindow();
    };
  }, [closePopupWindow]);

  const startOAuth = useMutation({
    mutationFn: startManagedOAuthAuthorization,
  });

  const handleConnect = () => {
    if (!managedAvailable || managedUnsupported) {
      showConnectError(
        `Managed ${displayName} connections aren't available in this Worklin environment. Choose Your Own to connect with your OAuth app.`,
      );
      return;
    }
    if (pendingRequestRef.current) return;

    setConnectError(null);
    const requestId = crypto.randomUUID();
    const bootstrapUrl = getManagedOAuthPopupBootstrapUrl({
      requestId,
      providerKey,
    });
    if (!bootstrapUrl) {
      showConnectError(
        `Worklin could not open a secure ${displayName} authorization window. Try again, or choose Your Own to connect with your OAuth app.`,
      );
      return;
    }

    if (!native) {
      const popup = window.open(bootstrapUrl, "_blank", "width=500,height=600");
      if (popup === null) {
        showConnectError(
          "Authorization popup blocked. Enable popups and try again, or choose Your Own to connect with your OAuth app.",
        );
        return;
      }
      popupRef.current = popup;
    }

    const abortController = new AbortController();
    const pendingRequest: PendingOAuthRequest = {
      requestId,
      provider: providerKey,
      callbackOrigin: new URL(bootstrapUrl).origin,
      baselineConnectionSignatures: new Map(),
      completionInFlight: false,
      authorizationStarted: false,
      startupComplete: false,
      bootstrapReady: native,
      connectUrl: null,
      abortController,
      nativeBrowserFinishedUnsubscribe: null,
    };
    pendingRequestRef.current = pendingRequest;
    setOAuthInProgress(true);
    startStartupDeadline(pendingRequest);
    if (!native) startPopupMonitoring();

    void (async () => {
      try {
        const baselineConnections = await fetchManagedOAuthConnectionBaseline({
          assistantId,
          providerKey,
          providerLabel: displayName,
          signal: abortController.signal,
        });
        if (pendingRequestRef.current?.requestId !== requestId) return;

        pendingRequest.baselineConnectionSignatures =
          getProviderConnectionSignatures(baselineConnections, providerKey);

        if (!native && (!popupRef.current || popupRef.current.closed)) {
          cancelPendingStartup(
            pendingRequest,
            `${displayName} authorization popup closed before it could start. Try again, or choose Your Own to connect with your OAuth app.`,
          );
          return;
        }

        const redirectAfterConnect = getManagedOAuthCallbackUrl(
          bootstrapUrl,
          requestId,
          providerKey,
          usesDeepLinkHandoff,
        );
        const connectUrl = await startOAuth.mutateAsync({
          assistantId,
          providerKey,
          providerLabel: displayName,
          redirectAfterConnect,
          signal: abortController.signal,
        });
        if (pendingRequestRef.current?.requestId !== requestId) return;

        if (native) {
          installNativeBrowserFinishedListener(pendingRequest);
          pendingRequest.authorizationStarted = true;
          await openUrl(connectUrl);
          if (pendingRequestRef.current?.requestId !== requestId) return;
          pendingRequest.startupComplete = true;
          clearStartupTimeout();
          return;
        }

        pendingRequest.connectUrl = connectUrl;
        navigatePopupWhenReady(pendingRequest);
      } catch (error) {
        if (pendingRequestRef.current?.requestId !== requestId) return;
        if (
          error instanceof ManagedOAuthStartError &&
          error.reason === "unsupported"
        ) {
          setManagedUnsupported(true);
        }
        closePopupWindow();
        clearPendingRequest();
        showConnectError(
          error instanceof Error
            ? error.message
            : `Worklin could not start ${displayName} authorization. Try again, or choose Your Own to connect with your OAuth app.`,
        );
      }
    })();
  };

  return {
    handleConnect,
    oauthInProgress,
    startOAuthPending: startOAuth.isPending,
    connectError,
    managedUnsupported,
  };
}
