import {
  configGet,
  configPatch,
  inferenceProviderconnectionsByNamePatch,
  inferenceProviderconnectionsPost,
  secretsPost,
} from "@/generated/daemon/sdk.gen";
import { getDefaultModelForProvider } from "@/assistant/llm-model-catalog";
import type {
  OnboardingProviderAuthType,
  OnboardingProviderId,
} from "@/domains/onboarding/provider-catalog";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.

const PENDING_KEY_STORAGE = "onboarding.providerKey";
export const ONBOARDING_PROFILE_NAME = "custom-balanced";
export const CHATGPT_SUBSCRIPTION_CONNECTION_NAME = "chatgpt-subscription";
export const CHATGPT_SUBSCRIPTION_MODEL = "gpt-5.4-mini";

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  authType?: OnboardingProviderAuthType;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
}

export function setPendingProviderKey(value: PendingProviderKey | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return;
    }
    sessionStorage.setItem(PENDING_KEY_STORAGE, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota) — degrade silently.
  }
}

function isPendingProviderKey(value: unknown): value is PendingProviderKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "key" in value &&
    typeof value.key === "string"
  );
}

export function peekPendingProviderKey(): PendingProviderKey | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_STORAGE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingProviderKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function consumePendingProviderKey(): PendingProviderKey | null {
  const value = peekPendingProviderKey();
  try {
    sessionStorage.removeItem(PENDING_KEY_STORAGE);
  } catch {
    // ignore
  }
  return value;
}

export function pendingProviderAuthType(
  value: PendingProviderKey,
): OnboardingProviderAuthType {
  if (value.authType) return value.authType;
  if (value.provider === "ollama" && value.key.trim().length === 0) {
    return "none";
  }
  return "api_key";
}

export function pendingProviderRequiresOAuth(
  value: PendingProviderKey | null,
): boolean {
  return value ? pendingProviderAuthType(value) === "oauth_subscription" : false;
}

// Daemon wrappers via the generated SDK. Duplicated minimally here because
// cross-domain imports are ESLint-gated in apps/web.

async function writeApiKeySecret(
  assistantId: string,
  provider: OnboardingProviderId,
  value: string,
): Promise<void> {
  const { response } = await secretsPost({
    path: { assistant_id: assistantId },
    body: { type: "api_key", name: provider, value },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to write provider secret"), {
      status: response?.status,
    });
  }
}

function connectionNameFor(provider: OnboardingProviderId): string {
  return provider === "ollama" ? "ollama-local" : `${provider}-personal`;
}

function modelForProvider(
  provider: OnboardingProviderId,
  authType: OnboardingProviderAuthType,
): string {
  if (authType === "oauth_subscription") return CHATGPT_SUBSCRIPTION_MODEL;
  return getDefaultModelForProvider(provider) ?? "";
}

async function createOrUpdateProviderConnection(
  assistantId: string,
  provider: OnboardingProviderId,
  authType: OnboardingProviderAuthType,
): Promise<string> {
  const connectionName =
    authType === "oauth_subscription"
      ? CHATGPT_SUBSCRIPTION_CONNECTION_NAME
      : connectionNameFor(provider);
  const auth =
    authType === "api_key"
      ? {
          type: "api_key" as const,
          credential: `credential/${provider}/api_key`,
        }
      : authType === "oauth_subscription"
        ? {
            type: "oauth_subscription" as const,
            credential: "credential/chatgpt/access_token",
          }
        : { type: "none" as const };
  const { response } = await inferenceProviderconnectionsPost({
    path: { assistant_id: assistantId },
    body: {
      name: connectionName,
      provider,
      auth,
      ...(authType === "oauth_subscription"
        ? { label: "ChatGPT Subscription" }
        : {}),
    },
    throwOnError: false,
  });
  if (response?.status === 409) {
    const { response: updateResponse } =
      await inferenceProviderconnectionsByNamePatch({
        path: { assistant_id: assistantId, name: connectionName },
        body: {
          auth,
          label:
            authType === "oauth_subscription"
              ? "ChatGPT Subscription"
              : null,
        },
        throwOnError: false,
      });
    if (!updateResponse?.ok) {
      throw Object.assign(new Error("Failed to update provider connection"), {
        status: updateResponse?.status,
      });
    }
    return connectionName;
  }
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to create provider connection"), {
      status: response?.status,
    });
  }
  return connectionName;
}

export async function configureOnboardingProviderProfile(
  assistantId: string,
  {
    provider,
    authType,
    connectionName,
  }: {
    provider: OnboardingProviderId;
    authType: OnboardingProviderAuthType;
    connectionName: string;
  },
): Promise<void> {
  const model = modelForProvider(provider, authType);
  const profile = {
    source: "user" as const,
    label: "Balanced",
    description: "Default provider selected during onboarding",
    provider,
    provider_connection: connectionName,
    ...(model ? { model } : {}),
  };

  const { data: current } = await configGet({
    path: { assistant_id: assistantId },
    throwOnError: true,
  });
  const currentOrder = current?.llm?.profileOrder ?? [];
  const profileOrder = currentOrder.includes(ONBOARDING_PROFILE_NAME)
    ? currentOrder
    : [...currentOrder, ONBOARDING_PROFILE_NAME];

  await configPatch({
    path: { assistant_id: assistantId },
    body: {
      llm: {
        profiles: {
          [ONBOARDING_PROFILE_NAME]: profile,
        },
        profileOrder,
        activeProfile: ONBOARDING_PROFILE_NAME,
      },
    },
    throwOnError: true,
  });
}

/**
 * Apply the API key collected during onboarding to the freshly hatched local
 * assistant: store the secret (when a key was entered) and create the provider
 * connection so the daemon can use it. Consumes the pending key; no-op when
 * nothing was collected (e.g. Worklin Cloud, which skips the API-key step).
 */
export async function applyPendingProviderKey(
  assistantId: string,
): Promise<void> {
  const pending = consumePendingProviderKey();
  if (!pending) return;
  const authType = pendingProviderAuthType(pending);
  if (authType === "oauth_subscription") {
    throw new Error("ChatGPT subscription sign-in must complete before apply.");
  }
  const trimmed = pending.key.trim();
  if (authType === "api_key") {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
  }
  const connectionName = await createOrUpdateProviderConnection(
    assistantId,
    pending.provider,
    authType,
  );
  await configureOnboardingProviderProfile(assistantId, {
    provider: pending.provider,
    authType,
    connectionName,
  });
}

export async function applyChatgptSubscriptionProvider(
  assistantId: string,
): Promise<void> {
  const pending = consumePendingProviderKey();
  if (!pending || pendingProviderAuthType(pending) !== "oauth_subscription") {
    return;
  }
  await configureOnboardingProviderProfile(assistantId, {
    provider: "openai",
    authType: "oauth_subscription",
    connectionName: CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
  });
}
