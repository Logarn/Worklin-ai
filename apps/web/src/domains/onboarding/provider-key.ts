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
  OnboardingProviderOptionId,
} from "@/domains/onboarding/provider-catalog";
import {
  isPooledApiKeyProvider,
  isPooledRuntimeProvider,
} from "@/assistant/pooled-model-provider";
import { PENDING_PROVIDER_KEY_STORAGE } from "@/lib/auth/pending-provider-secret";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.

export const ONBOARDING_PROFILE_NAME = "custom-balanced";
export const CHATGPT_SUBSCRIPTION_CONNECTION_NAME = "chatgpt-subscription";
export const CHATGPT_SUBSCRIPTION_MODEL = "gpt-5.4-mini";

export interface PendingProviderKey {
  /** Authenticated user that entered this raw key. */
  ownerUserId?: string;
  provider: OnboardingProviderId;
  providerOptionId?: OnboardingProviderOptionId;
  authType?: OnboardingProviderAuthType;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
  connectionName?: string;
  credentialName?: string;
  connectionLabel?: string;
  baseUrl?: string | null;
  models?: { id: string; displayName?: string }[] | null;
  defaultModel?: string;
}

export interface PendingProviderKeyScope {
  userId: string | null;
}

export class PooledProviderSetupError extends Error {
  readonly status = 409;

  constructor(
    readonly code:
      | "pooled_provider_api_key_required"
      | "pooled_provider_credential_alias_unsupported"
      | "pooled_provider_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "PooledProviderSetupError";
  }
}

export function setPendingProviderKey(
  value: PendingProviderKey | null,
  scope?: PendingProviderKeyScope,
): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(PENDING_PROVIDER_KEY_STORAGE);
      return;
    }
    sessionStorage.setItem(
      PENDING_PROVIDER_KEY_STORAGE,
      JSON.stringify(
        scope ? { ...value, ownerUserId: scope.userId ?? undefined } : value,
      ),
    );
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

export function peekPendingProviderKey(
  scope?: PendingProviderKeyScope,
): PendingProviderKey | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingProviderKey(parsed)) {
      sessionStorage.removeItem(PENDING_PROVIDER_KEY_STORAGE);
      return null;
    }
    if (
      scope &&
      (!scope.userId || parsed.ownerUserId !== scope.userId)
    ) {
      sessionStorage.removeItem(PENDING_PROVIDER_KEY_STORAGE);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function consumePendingProviderKey(
  scope?: PendingProviderKeyScope,
): PendingProviderKey | null {
  const value = peekPendingProviderKey(scope);
  try {
    sessionStorage.removeItem(PENDING_PROVIDER_KEY_STORAGE);
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
  return value
    ? pendingProviderAuthType(value) === "oauth_subscription"
    : false;
}

// Daemon wrappers via the generated SDK. Duplicated minimally here because
// cross-domain imports are ESLint-gated in apps/web.

async function writeApiKeySecret(
  assistantId: string,
  provider: OnboardingProviderId,
  credentialName: string,
  value: string,
): Promise<void> {
  const body = providerApiKeySecretBody(provider, credentialName, value);
  const { response } = await secretsPost({
    path: { assistant_id: assistantId },
    body,
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to write provider secret"), {
      status: response?.status,
    });
  }
}

type ApiKeySecretBody =
  | { type: "api_key"; name: string; value: string }
  | { type: "credential"; name: string; value: string };

export function providerApiKeySecretBody(
  provider: OnboardingProviderId,
  credentialName: string,
  value: string,
): ApiKeySecretBody {
  return credentialName === provider
    ? { type: "api_key", name: credentialName, value }
    : { type: "credential", name: `${credentialName}:api_key`, value };
}

function connectionNameFor(provider: OnboardingProviderId): string {
  return provider === "ollama" ? "ollama-local" : `${provider}-personal`;
}

function modelForProvider(
  provider: OnboardingProviderId,
  authType: OnboardingProviderAuthType,
  defaultModel?: string,
): string {
  if (defaultModel) return defaultModel;
  if (authType === "oauth_subscription") return CHATGPT_SUBSCRIPTION_MODEL;
  return getDefaultModelForProvider(provider) ?? "";
}

function credentialNameFor(
  provider: OnboardingProviderId,
  credentialName?: string,
): string {
  return credentialName?.trim() || provider;
}

async function createOrUpdateProviderConnection(
  assistantId: string,
  pending: PendingProviderKey,
): Promise<string> {
  const { provider } = pending;
  const authType = pendingProviderAuthType(pending);
  const credentialName = credentialNameFor(provider, pending.credentialName);
  const connectionName =
    authType === "oauth_subscription"
      ? CHATGPT_SUBSCRIPTION_CONNECTION_NAME
      : pending.connectionName?.trim() || connectionNameFor(provider);
  const label =
    authType === "oauth_subscription"
      ? "ChatGPT Subscription"
      : pending.connectionLabel?.trim() || null;
  const auth =
    authType === "api_key"
      ? {
          type: "api_key" as const,
          credential: `credential/${credentialName}/api_key`,
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
      ...(label !== null ? { label } : {}),
      ...(provider === "openai-compatible" && {
        base_url: pending.baseUrl ?? null,
        models: pending.models ?? null,
      }),
    },
    throwOnError: false,
  });
  if (response?.status === 409) {
    const { response: updateResponse } =
      await inferenceProviderconnectionsByNamePatch({
        path: { assistant_id: assistantId, name: connectionName },
        body: {
          auth,
          label,
          ...(provider === "openai-compatible" && {
            base_url: pending.baseUrl ?? null,
            models: pending.models ?? null,
          }),
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
    defaultModel,
  }: {
    provider: OnboardingProviderId;
    authType: OnboardingProviderAuthType;
    connectionName: string;
    defaultModel?: string;
  },
): Promise<void> {
  const model = modelForProvider(provider, authType, defaultModel);
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
 * connection so the daemon can use it. The pending key is only cleared after
 * all writes succeed so a transient gateway/auth error can be retried.
 */
export async function applyPendingProviderKey(
  assistantId: string,
  runtimeProvider?: string | null,
  scope?: PendingProviderKeyScope,
): Promise<void> {
  const pending = peekPendingProviderKey(scope);
  if (!pending) return;
  const authType = pendingProviderAuthType(pending);
  if (isPooledRuntimeProvider(runtimeProvider)) {
    if (!isPooledApiKeyProvider(pending.provider)) {
      throw new PooledProviderSetupError(
        "pooled_provider_unsupported",
        pending.provider === "openai-compatible" ||
          pending.providerOptionId === "xai"
          ? "xAI and custom OpenAI-compatible providers are not available on pooled assistants yet. Choose Anthropic, Fireworks, Gemini, Kimi, MiniMax, OpenAI API, or OpenRouter."
          : pending.provider === "ollama"
            ? "Ollama runs on your own computer and is not available on a pooled cloud assistant. Choose a supported API-key provider."
            : "This provider is not available on pooled assistants yet. Choose a supported API-key provider.",
      );
    }
    if (authType !== "api_key") {
      throw new PooledProviderSetupError(
        "pooled_provider_api_key_required",
        authType === "oauth_subscription"
          ? "ChatGPT subscription sign-in is not available on pooled assistants yet. Choose OpenAI API and enter an API key instead."
          : "Pooled assistants currently require a supported provider API key.",
      );
    }
    const credentialName = credentialNameFor(
      pending.provider,
      pending.credentialName,
    );
    if (credentialName !== pending.provider) {
      throw new PooledProviderSetupError(
        "pooled_provider_credential_alias_unsupported",
        "Custom credential names are not available on pooled assistants. Save this key under the selected provider instead.",
      );
    }
    const trimmed = pending.key.trim();
    if (!trimmed) {
      throw new PooledProviderSetupError(
        "pooled_provider_api_key_required",
        "Enter an API key for the selected provider.",
      );
    }
    await writeApiKeySecret(
      assistantId,
      pending.provider,
      pending.provider,
      trimmed,
    );
    // The assignment bootstrap creates the provider connection and active
    // profile from this tenant-scoped vault entry. Mutating worker-local
    // connection/config routes here would be partial and non-durable.
    setPendingProviderKey(null);
    return;
  }
  if (authType === "oauth_subscription") {
    throw new Error("ChatGPT subscription sign-in must complete before apply.");
  }
  const trimmed = pending.key.trim();
  const credentialName = credentialNameFor(
    pending.provider,
    pending.credentialName,
  );
  if (authType === "api_key") {
    await writeApiKeySecret(
      assistantId,
      pending.provider,
      credentialName,
      trimmed,
    );
  }
  const connectionName = await createOrUpdateProviderConnection(
    assistantId,
    pending,
  );
  await configureOnboardingProviderProfile(assistantId, {
    provider: pending.provider,
    authType,
    connectionName,
    defaultModel: pending.defaultModel,
  });
  setPendingProviderKey(null);
}

export async function applyChatgptSubscriptionProvider(
  assistantId: string,
  scope?: PendingProviderKeyScope,
): Promise<void> {
  const pending = peekPendingProviderKey(scope);
  if (!pending || pendingProviderAuthType(pending) !== "oauth_subscription") {
    return;
  }
  await configureOnboardingProviderProfile(assistantId, {
    provider: "openai",
    authType: "oauth_subscription",
    connectionName: CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
  });
  setPendingProviderKey(null);
}
