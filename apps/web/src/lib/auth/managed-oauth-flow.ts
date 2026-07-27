import type { OAuthConnection } from "@/generated/api/types.gen";
import { subscribe } from "@/lib/event-bus";
import {
  fetchManagedOAuthConnectionBaseline,
  ManagedOAuthStartError,
  type ManagedOAuthStartErrorReason,
  type ManagedOAuthVerificationPolicy,
  startManagedOAuthAuthorization,
  verifyManagedOAuthConnection,
} from "@/lib/auth/managed-oauth-api";
import {
  getOAuthCompleteMessagePayload,
  getOAuthCompleteStoragePayload,
  getOAuthPopupReadyMessagePayload,
  oauthCompletionStorageKey,
  parseOAuthCompletePayload,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";
import { getManagedOAuthPopupBootstrapUrl } from "@/lib/auth/oauth-popup-launcher";
import { openUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  type OAuthCompleteDeepLinkPayload,
} from "@/runtime/native-deep-link";
import { getProviderConnectionSignatures } from "@/utils/oauth-connection-utils";

export interface ManagedOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  signal?: AbortSignal;
  policy?: Partial<ManagedOAuthFlowPolicy>;
}

export type ManagedOAuthConnectResult =
  | { status: "connected"; connection: OAuthConnection }
  | { status: "cancelled"; message?: string }
  | {
      status: "error";
      message: string;
      reason?: ManagedOAuthStartErrorReason | "timeout" | "popup_blocked";
    };

export interface ManagedOAuthFlowPolicy {
  startupTimeoutMs: number;
  authorizationTimeoutMs: number;
  bootstrapCheckIntervalMs: number;
  storagePollIntervalMs: number;
  nativeCompletionGraceMs: number;
  verification: ManagedOAuthVerificationPolicy;
}

const DEFAULT_FLOW_POLICY: ManagedOAuthFlowPolicy = {
  startupTimeoutMs: 30_000,
  authorizationTimeoutMs: 5 * 60_000,
  bootstrapCheckIntervalMs: 100,
  storagePollIntervalMs: 250,
  nativeCompletionGraceMs: 500,
  verification: {
    attempts: 8,
    delayMs: 750,
    timeoutMs: 10_000,
  },
};

function getManagedOAuthCallbackUrl(
  bootstrapUrl: string,
  requestId: string,
  providerKey: string,
  usesDeepLinkHandoff: boolean,
): string {
  const url = new URL(bootstrapUrl);
  url.searchParams.delete("oauth_pending");
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("oauth_provider", providerKey);
  if (usesDeepLinkHandoff) {
    url.searchParams.set("handoff", "deep-link");
  }
  return url.toString();
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The managed OAuth request was aborted.", "AbortError")
  );
}

function denialMessage(
  providerLabel: string,
  oauthCode: string | null | undefined,
): string {
  return oauthCode
    ? `${providerLabel} authorization failed: ${oauthCode}`
    : `${providerLabel} authorization failed.`;
}

function readStoredCompletion(requestId: string): OAuthCompletePayload | null {
  const storageKey = oauthCompletionStorageKey(requestId);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const payload = parseOAuthCompletePayload(raw);
    if (!payload) window.localStorage.removeItem(storageKey);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Runs one request-scoped managed OAuth flow across web, Electron, and
 * Capacitor. The assistant and provider are captured for the lifetime of the
 * request, and a successful callback is always verified against that exact
 * assistant's connection inventory.
 */
export function connectManagedOAuth({
  assistantId,
  providerKey,
  providerLabel,
  signal: parentSignal,
  policy: policyOverrides,
}: ManagedOAuthConnectOptions): Promise<ManagedOAuthConnectResult> {
  if (parentSignal?.aborted) {
    return Promise.resolve({ status: "cancelled" });
  }

  const policy: ManagedOAuthFlowPolicy = {
    ...DEFAULT_FLOW_POLICY,
    ...policyOverrides,
    verification:
      policyOverrides?.verification ?? DEFAULT_FLOW_POLICY.verification,
  };
  const requestId = crypto.randomUUID();
  const native = isNativePlatform();
  const electron = isElectron();
  const usesDeepLinkHandoff = native || electron;
  const bootstrapUrl = getManagedOAuthPopupBootstrapUrl({
    requestId,
    providerKey,
  });

  if (!bootstrapUrl) {
    return Promise.resolve({
      status: "error",
      message: `Worklin could not open a secure ${providerLabel} authorization window. Try again.`,
    });
  }

  let popup: Window | null = null;
  if (!native) {
    popup = window.open(bootstrapUrl, "_blank", "width=500,height=600");
    if (popup === null) {
      return Promise.resolve({
        status: "error",
        reason: "popup_blocked",
        message: "Authorization popup blocked. Enable popups and try again.",
      });
    }
  }

  return new Promise((resolve) => {
    const abortController = new AbortController();
    let settled = false;
    let authorizationStarted = false;
    let completionInFlight = false;
    let bootstrapReady = native;
    let connectUrl: string | null = null;
    let baselineConnectionSignatures: ReadonlyMap<string, string> = new Map();
    let startupTimeout: ReturnType<typeof setTimeout> | null = null;
    let authorizationTimeout: ReturnType<typeof setTimeout> | null = null;
    let bootstrapCheckInterval: ReturnType<typeof setInterval> | null = null;
    let storagePollInterval: ReturnType<typeof setInterval> | null = null;
    let nativeCompletionGraceTimeout: ReturnType<typeof setTimeout> | null =
      null;
    let nativeBrowserFinishedUnsubscribe: (() => void) | null = null;
    let busUnsubscribe: (() => void) | null = null;

    const callbackOrigin = new URL(bootstrapUrl).origin;
    const storageKey = oauthCompletionStorageKey(requestId);

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };

    const clearIntervalTimer = (
      timer: ReturnType<typeof setInterval> | null,
    ): null => {
      if (timer !== null) clearInterval(timer);
      return null;
    };

    const cleanup = () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleOAuthStorage);
      window.removeEventListener(
        OAUTH_COMPLETE_DEEP_LINK_EVENT,
        handleLegacyOAuthDeepLink,
      );
      parentSignal?.removeEventListener("abort", handleParentAbort);
      busUnsubscribe?.();
      busUnsubscribe = null;
      nativeBrowserFinishedUnsubscribe?.();
      nativeBrowserFinishedUnsubscribe = null;
      startupTimeout = clearTimer(startupTimeout);
      authorizationTimeout = clearTimer(authorizationTimeout);
      nativeCompletionGraceTimeout = clearTimer(nativeCompletionGraceTimeout);
      bootstrapCheckInterval = clearIntervalTimer(bootstrapCheckInterval);
      storagePollInterval = clearIntervalTimer(storagePollInterval);
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Storage is best-effort; native completion uses the typed event bus.
      }
      try {
        popup?.close();
      } catch {
        // A COOP-detached popup handle may reject cross-window operations.
      }
      popup = null;
    };

    const finish = (result: ManagedOAuthConnectResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      resolve(result);
    };

    function handleParentAbort() {
      if (!abortController.signal.aborted) {
        abortController.abort(
          parentSignal ? abortReason(parentSignal) : undefined,
        );
      }
      finish({ status: "cancelled" });
    }

    const isScopedPayload = (payload: OAuthCompletePayload): boolean =>
      payload.type === "vellum:oauth-complete" &&
      payload.requestId === requestId &&
      payload.oauthProvider === providerKey;

    const verifyConnection = async (
      absentResult: ManagedOAuthConnectResult,
    ): Promise<void> => {
      if (settled || completionInFlight) return;
      completionInFlight = true;

      try {
        const result = await verifyManagedOAuthConnection(
          {
            assistantId,
            providerKey,
            providerLabel,
            baselineConnectionSignatures,
            signal: abortController.signal,
          },
          policy.verification,
        );
        if (settled) return;

        if (result.outcome === "connected") {
          finish({ status: "connected", connection: result.connection });
          return;
        }
        if (result.outcome === "failed") {
          finish({
            status: "error",
            message: result.message,
            reason: result.reason,
          });
          return;
        }
        finish(absentResult);
      } catch (error) {
        if (settled || abortController.signal.aborted) return;
        finish({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : `Worklin could not verify the ${providerLabel} account. Refresh the accounts and try again.`,
        });
      }
    };

    const handleOAuthCompletePayload = (
      payload: OAuthCompletePayload,
    ): boolean => {
      if (settled || !isScopedPayload(payload)) return false;

      if (payload.oauthStatus === "connected") {
        void verifyConnection({
          status: "error",
          message: `${providerLabel} authorization finished, but no new or updated account was found. Try again.`,
        });
        return true;
      }

      // A provider denial outranks a browser-dismissal verification already in
      // flight so native callbacks retain the provider's exact error detail.
      finish({
        status: "error",
        message: denialMessage(providerLabel, payload.oauthCode),
      });
      return true;
    };

    function handleOAuthMessage(event: MessageEvent) {
      if (settled || event.source !== popup) return;

      if (!authorizationStarted) {
        const ready = getOAuthPopupReadyMessagePayload(
          event,
          callbackOrigin,
          requestId,
          providerKey,
        );
        if (ready) {
          bootstrapReady = true;
          navigatePopupWhenReady();
        }
        return;
      }

      const payload = getOAuthCompleteMessagePayload(
        event,
        callbackOrigin,
        requestId,
      );
      if (payload) handleOAuthCompletePayload(payload);
    }

    function handleOAuthStorage(event: StorageEvent) {
      if (settled) return;
      const payload = getOAuthCompleteStoragePayload(event, requestId);
      if (payload && handleOAuthCompletePayload(payload)) {
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          // Cleanup also removes the request-scoped key when storage is usable.
        }
      }
    }

    function handleLegacyOAuthDeepLink(
      event: CustomEvent<OAuthCompleteDeepLinkPayload>,
    ) {
      const payload = event.detail;
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    }

    const handleBusOAuthComplete = (payload: OAuthCompleteDeepLinkPayload) => {
      handleOAuthCompletePayload({
        type: "vellum:oauth-complete",
        requestId: payload.requestId,
        oauthStatus: payload.oauthStatus,
        oauthProvider: payload.oauthProvider,
        oauthCode: payload.oauthCode,
      });
    };

    const startAuthorizationDeadline = () => {
      authorizationTimeout = setTimeout(() => {
        void verifyConnection({
          status: "error",
          reason: "timeout",
          message: `${providerLabel} authorization timed out before a connected account was found. Try again.`,
        });
      }, policy.authorizationTimeoutMs);
    };

    const startStoragePolling = () => {
      if (usesDeepLinkHandoff) return;
      storagePollInterval = setInterval(() => {
        const payload = readStoredCompletion(requestId);
        if (payload && handleOAuthCompletePayload(payload)) {
          try {
            window.localStorage.removeItem(storageKey);
          } catch {
            // Cleanup handles storage availability changes.
          }
        }
      }, policy.storagePollIntervalMs);
    };

    const markAuthorizationStarted = () => {
      authorizationStarted = true;
      startupTimeout = clearTimer(startupTimeout);
      bootstrapCheckInterval = clearIntervalTimer(bootstrapCheckInterval);
      startAuthorizationDeadline();
      startStoragePolling();
    };

    function navigatePopupWhenReady() {
      if (settled || authorizationStarted || !bootstrapReady || !connectUrl) {
        return;
      }

      if (!popup || popup.closed) {
        finish({
          status: "cancelled",
          message: `${providerLabel} authorization popup closed before it could start. Try again.`,
        });
        return;
      }

      markAuthorizationStarted();
      try {
        popup.location.href = connectUrl;
      } catch {
        finish({
          status: "error",
          message: `Worklin could not open ${providerLabel} authorization. Try again.`,
        });
      }
    }

    const installNativeBrowserFinishedListener = () => {
      nativeBrowserFinishedUnsubscribe = openUrlFinishedListener(() => {
        if (
          settled ||
          !authorizationStarted ||
          completionInFlight ||
          nativeCompletionGraceTimeout
        ) {
          return;
        }

        nativeCompletionGraceTimeout = setTimeout(() => {
          nativeCompletionGraceTimeout = null;
          void verifyConnection({
            status: "cancelled",
            message: `${providerLabel} authorization closed before an account connected. Try again.`,
          });
        }, policy.nativeCompletionGraceMs);
      });
    };

    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleOAuthStorage);
    window.addEventListener(
      OAUTH_COMPLETE_DEEP_LINK_EVENT,
      handleLegacyOAuthDeepLink,
    );
    busUnsubscribe = subscribe("oauth.complete", handleBusOAuthComplete);
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });

    startupTimeout = setTimeout(() => {
      if (settled || authorizationStarted) return;
      finish({
        status: "error",
        reason: "timeout",
        message: `${providerLabel} authorization took too long to start. Try again.`,
      });
    }, policy.startupTimeoutMs);

    if (!native) {
      bootstrapCheckInterval = setInterval(() => {
        // `closed` is reliable only while the popup remains on the same-origin
        // bootstrap page. External COOP navigation can detach the handle while
        // authorization is still open, so monitoring stops before navigation.
        if (!settled && !authorizationStarted && (!popup || popup.closed)) {
          finish({
            status: "cancelled",
            message: `${providerLabel} authorization popup closed before it could start. Try again.`,
          });
        }
      }, policy.bootstrapCheckIntervalMs);
    }

    void (async () => {
      try {
        const baselineConnections = await fetchManagedOAuthConnectionBaseline({
          assistantId,
          providerKey,
          providerLabel,
          signal: abortController.signal,
        });
        if (settled) return;
        baselineConnectionSignatures = getProviderConnectionSignatures(
          baselineConnections,
          providerKey,
        );

        if (!native && (!popup || popup.closed)) {
          finish({
            status: "cancelled",
            message: `${providerLabel} authorization popup closed before it could start. Try again.`,
          });
          return;
        }

        const redirectAfterConnect = getManagedOAuthCallbackUrl(
          bootstrapUrl,
          requestId,
          providerKey,
          usesDeepLinkHandoff,
        );
        connectUrl = await startManagedOAuthAuthorization({
          assistantId,
          providerKey,
          providerLabel,
          redirectAfterConnect,
          signal: abortController.signal,
        });
        if (settled) return;

        if (native) {
          installNativeBrowserFinishedListener();
          markAuthorizationStarted();
          await openUrl(connectUrl);
          return;
        }

        navigatePopupWhenReady();
      } catch (error) {
        if (settled || abortController.signal.aborted) return;
        finish({
          status: "error",
          reason:
            error instanceof ManagedOAuthStartError ? error.reason : undefined,
          message:
            error instanceof Error
              ? error.message
              : `Worklin could not start ${providerLabel} authorization. Try again.`,
        });
      }
    })();
  });
}
