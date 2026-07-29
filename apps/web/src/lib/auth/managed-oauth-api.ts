import {
  assistantsOauthConnectionsList,
  assistantsOauthStartCreate,
} from "@/generated/api/sdk.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { extractErrorMessage } from "@/utils/api-errors";
import { findNewOrChangedProviderConnection } from "@/utils/oauth-connection-utils";

export type ManagedOAuthStartErrorReason =
  | "unsupported"
  | "unauthenticated"
  | "forbidden"
  | "assistant_missing"
  | "server_error"
  | "request_failed";

export class ManagedOAuthStartError extends Error {
  constructor(
    readonly reason: ManagedOAuthStartErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ManagedOAuthStartError";
  }
}

interface StartManagedOAuthAuthorizationOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  redirectAfterConnect: string;
  signal?: AbortSignal;
}

interface FetchManagedOAuthConnectionBaselineOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  signal?: AbortSignal;
}

interface VerifyManagedOAuthConnectionOptions extends FetchManagedOAuthConnectionBaselineOptions {
  baselineConnectionSignatures: ReadonlyMap<string, string>;
}

export interface ManagedOAuthVerificationPolicy {
  attempts: number;
  delayMs: number;
  timeoutMs: number;
}

export type ManagedOAuthVerificationResult =
  | { outcome: "connected"; connection: OAuthConnection }
  | { outcome: "absent" }
  | {
      outcome: "failed";
      reason: ManagedOAuthStartErrorReason | "timeout";
      message: string;
    };

const DEFAULT_VERIFICATION_POLICY: ManagedOAuthVerificationPolicy = {
  attempts: 8,
  delayMs: 750,
  timeoutMs: 10_000,
};

const unsupportedManagedProviders = new Set<string>();

function providerCapabilityKey(
  assistantId: string,
  providerKey: string,
): string {
  return `${assistantId}:${providerKey}`;
}

export function isManagedOAuthProviderUnsupported(
  assistantId: string,
  providerKey: string,
): boolean {
  return unsupportedManagedProviders.has(
    providerCapabilityKey(assistantId, providerKey),
  );
}

function rememberUnsupportedManagedProvider(
  assistantId: string,
  providerKey: string,
): void {
  unsupportedManagedProviders.add(
    providerCapabilityKey(assistantId, providerKey),
  );
}

function withYourOwnFallback(message: string): string {
  const trimmed = message.trim();
  const punctuated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${punctuated} Try again, or choose Your Own to connect with your OAuth app.`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function safeManagedOAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function isAssistantMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const record = error as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  const values = [
    record.code,
    record.detail,
    record.message,
    nested?.code,
    nested?.detail,
    nested?.message,
  ];

  return values.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/g, "_");
    return (
      normalized === "assistant_not_found" ||
      normalized.includes("assistant_not_found")
    );
  });
}

function classifyStartFailure(
  error: unknown,
  response: Response | undefined,
): ManagedOAuthStartErrorReason {
  switch (response?.status) {
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return isAssistantMissingError(error)
        ? "assistant_missing"
        : "request_failed";
    case 405:
    case 501:
      return "unsupported";
    default:
      return response && response.status >= 500
        ? "server_error"
        : "request_failed";
  }
}

function startFailureMessage(
  reason: ManagedOAuthStartErrorReason,
  providerLabel: string,
  detail: string,
): string {
  switch (reason) {
    case "unsupported":
      return `Managed ${providerLabel} connections aren't available in this Worklin environment. Choose Your Own to connect with your OAuth app.`;
    case "unauthenticated":
      return `Your Worklin session has expired. Sign in again before connecting ${providerLabel}.`;
    case "forbidden":
      return `You don't have permission to connect ${providerLabel} for this assistant.`;
    case "assistant_missing":
      return `Worklin could not find this assistant. Refresh the page before connecting ${providerLabel}.`;
    case "server_error":
    case "request_failed":
      return withYourOwnFallback(detail);
  }
}

function managedOAuthRequestError({
  assistantId,
  providerKey,
  providerLabel,
  error,
  response,
  fallbackMessage,
}: {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  error: unknown;
  response: Response | undefined;
  fallbackMessage: string;
}): ManagedOAuthStartError {
  const reason = classifyStartFailure(error, response);
  const detail = extractErrorMessage(error, response, fallbackMessage);
  if (reason === "unsupported") {
    rememberUnsupportedManagedProvider(assistantId, providerKey);
  }
  return new ManagedOAuthStartError(
    reason,
    startFailureMessage(reason, providerLabel, detail),
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The managed OAuth request was aborted.", "AbortError")
  );
}

function createDeadlineSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const handleParentAbort = () => {
    controller.abort(parentSignal ? abortReason(parentSignal) : undefined);
  };

  if (parentSignal?.aborted) {
    handleParentAbort();
  } else {
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException(
        "Managed OAuth connection verification timed out.",
        "TimeoutError",
      ),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", handleParentAbort);
    },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function verificationTimeoutMessage(providerLabel: string): string {
  return `Worklin timed out while verifying the ${providerLabel} account. The connection result is unknown. Refresh the accounts and try again.`;
}

export async function fetchManagedOAuthConnectionBaseline({
  assistantId,
  providerKey,
  providerLabel,
  signal,
}: FetchManagedOAuthConnectionBaselineOptions): Promise<OAuthConnection[]> {
  let result: Awaited<ReturnType<typeof assistantsOauthConnectionsList>>;
  try {
    result = await assistantsOauthConnectionsList({
      path: { assistant_id: assistantId },
      throwOnError: false,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw managedOAuthRequestError({
      assistantId,
      providerKey,
      providerLabel,
      error,
      response: undefined,
      fallbackMessage: `Worklin could not check existing ${providerLabel} accounts.`,
    });
  }

  const { data, error, response } = result;

  if (data) return data;

  throw managedOAuthRequestError({
    assistantId,
    providerKey,
    providerLabel,
    error,
    response,
    fallbackMessage: `Worklin could not check existing ${providerLabel} accounts.`,
  });
}

export async function verifyManagedOAuthConnection(
  {
    assistantId,
    providerKey,
    providerLabel,
    baselineConnectionSignatures,
    signal: parentSignal,
  }: VerifyManagedOAuthConnectionOptions,
  policy: ManagedOAuthVerificationPolicy = DEFAULT_VERIFICATION_POLICY,
): Promise<ManagedOAuthVerificationResult> {
  const deadline = createDeadlineSignal(parentSignal, policy.timeoutMs);

  try {
    for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
      if (attempt > 0) {
        await abortableDelay(policy.delayMs, deadline.signal);
      }

      let connections: OAuthConnection[];
      try {
        connections = await fetchManagedOAuthConnectionBaseline({
          assistantId,
          providerKey,
          providerLabel,
          signal: deadline.signal,
        });
      } catch (error) {
        if (parentSignal?.aborted) throw error;
        if (deadline.didTimeout()) {
          return {
            outcome: "failed",
            reason: "timeout",
            message: verificationTimeoutMessage(providerLabel),
          };
        }

        const managedError =
          error instanceof ManagedOAuthStartError
            ? error
            : managedOAuthRequestError({
                assistantId,
                providerKey,
                providerLabel,
                error,
                response: undefined,
                fallbackMessage: `Worklin could not verify the ${providerLabel} account.`,
              });
        return {
          outcome: "failed",
          reason: managedError.reason,
          message: managedError.message,
        };
      }

      const connected = findNewOrChangedProviderConnection(
        connections,
        providerKey,
        baselineConnectionSignatures,
      );
      if (connected) {
        return { outcome: "connected", connection: connected };
      }
    }

    return { outcome: "absent" };
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    if (deadline.didTimeout()) {
      return {
        outcome: "failed",
        reason: "timeout",
        message: verificationTimeoutMessage(providerLabel),
      };
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}

export async function startManagedOAuthAuthorization({
  assistantId,
  providerKey,
  providerLabel,
  redirectAfterConnect,
  signal,
}: StartManagedOAuthAuthorizationOptions): Promise<string> {
  let result: Awaited<ReturnType<typeof assistantsOauthStartCreate>>;
  try {
    result = await assistantsOauthStartCreate({
      path: {
        assistant_id: assistantId,
        provider: providerKey,
      },
      body: {
        requested_scopes: [],
        redirect_after_connect: redirectAfterConnect,
      },
      throwOnError: false,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw managedOAuthRequestError({
      assistantId,
      providerKey,
      providerLabel,
      error,
      response: undefined,
      fallbackMessage: `Worklin could not start ${providerLabel} authorization.`,
    });
  }

  const { data, error, response } = result;

  if (data?.connect_url) {
    const connectUrl = safeManagedOAuthUrl(data.connect_url);
    if (connectUrl) return connectUrl;
    throw new ManagedOAuthStartError(
      "request_failed",
      `Worklin received an invalid ${providerLabel} authorization link. Try again, or choose Your Own to connect with your OAuth app.`,
    );
  }

  throw managedOAuthRequestError({
    assistantId,
    providerKey,
    providerLabel,
    error,
    response,
    fallbackMessage: `Worklin could not start ${providerLabel} authorization.`,
  });
}

export const __TEST_ONLY__ = {
  resetUnsupportedManagedProviders(): void {
    unsupportedManagedProviders.clear();
  },
};
