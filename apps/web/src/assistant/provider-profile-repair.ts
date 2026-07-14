import {
  getDefaultModelForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import { isProviderConnectionReady } from "@/assistant/provider-connection-readiness";
import {
  configGet,
  configPatch,
  inferenceProviderconnectionsGet,
  secretsGet,
} from "@/generated/daemon/sdk.gen";
import type {
  ConfigGetResponse,
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

const AUTO_PROFILE_NAME = "custom-balanced";
const CHATGPT_SUBSCRIPTION_MODEL = "gpt-5.4-mini";
const FALLBACK_DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  ollama: "llama3.2",
};

export interface ProviderProfileRepairResult {
  repaired: boolean;
  providerLabel?: string;
  reason?: "no-model" | "no-connections" | "ambiguous" | "already-runnable";
}

export interface EnsureRunnableProfileOptions {
  /** Select the supplied connection even when another user profile is active. */
  activateConnection?: boolean;
}

function profileHasRunnableModel(
  profile:
    | NonNullable<NonNullable<ConfigGetResponse["llm"]>["profiles"]>[string]
    | undefined,
): boolean {
  return (
    profile != null &&
    profile.status !== "disabled" &&
    typeof profile.provider === "string" &&
    profile.provider.trim().length > 0 &&
    typeof profile.model === "string" &&
    profile.model.trim().length > 0
  );
}

function profileUsesManagedProvider(
  profile:
    | NonNullable<NonNullable<ConfigGetResponse["llm"]>["profiles"]>[string]
    | undefined,
): boolean {
  return profile?.source === "managed";
}

function findExistingProfileForConnection(
  profiles: NonNullable<ConfigGetResponse["llm"]>["profiles"] | undefined,
  connection: ProviderConnection,
  model: string,
): string | null {
  if (!profiles) return null;
  for (const [name, profile] of Object.entries(profiles)) {
    if (
      profileHasRunnableModel(profile) &&
      profile.provider === connection.provider &&
      profile.provider_connection === connection.name &&
      profile.model === model
    ) {
      return name;
    }
  }
  return null;
}

function nextProfileName(
  profiles: NonNullable<ConfigGetResponse["llm"]>["profiles"] | undefined,
): string {
  if (!profiles || !(AUTO_PROFILE_NAME in profiles)) return AUTO_PROFILE_NAME;
  let suffix = 2;
  let candidate = `${AUTO_PROFILE_NAME}-${suffix}`;
  while (candidate in profiles) {
    suffix += 1;
    candidate = `${AUTO_PROFILE_NAME}-${suffix}`;
  }
  return candidate;
}

function defaultModelForConnection(connection: ProviderConnection): string {
  if (
    connection.provider === "openai" &&
    connection.auth.type === "oauth_subscription"
  ) {
    return CHATGPT_SUBSCRIPTION_MODEL;
  }
  return (
    getDefaultModelForProvider(connection.provider) ??
    FALLBACK_DEFAULT_MODEL_BY_PROVIDER[connection.provider] ??
    connection.models?.[0]?.id ??
    ""
  );
}

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

function connectionLastChangedAt(connection: ProviderConnection): number {
  return Math.max(connection.updatedAt, connection.createdAt);
}

function selectRepairConnection(
  connections: readonly ProviderConnection[],
  secrets: readonly SecretsGetResponse["secrets"][number][],
): ProviderConnection | null {
  const runnable = connections.filter(
    (connection) =>
      isProviderConnectionReady(connection, secrets) &&
      Boolean(defaultModelForConnection(connection)),
  );
  if (runnable.length === 1) return runnable[0];

  const byMostRecent = [...runnable].sort(
    (a, b) => connectionLastChangedAt(b) - connectionLastChangedAt(a),
  );
  const [candidate, runnerUp] = byMostRecent;
  if (
    candidate &&
    runnerUp &&
    connectionLastChangedAt(candidate) > connectionLastChangedAt(runnerUp)
  ) {
    return candidate;
  }

  return null;
}

export async function ensureRunnableProfileForConnection(
  assistantId: string,
  connection: ProviderConnection,
  options: EnsureRunnableProfileOptions = {},
): Promise<ProviderProfileRepairResult> {
  const model = defaultModelForConnection(connection);
  if (!model) {
    return {
      repaired: false,
      providerLabel: providerLabel(connection.provider),
      reason: "no-model",
    };
  }

  const { data: config } = await configGet({
    path: { assistant_id: assistantId },
    throwOnError: true,
  });
  const llm = config?.llm;
  const profiles = llm?.profiles ?? {};
  const activeProfile =
    typeof llm?.activeProfile === "string" ? llm.activeProfile : null;
  const currentActiveProfile = activeProfile
    ? profiles[activeProfile]
    : undefined;

  if (
    !options.activateConnection &&
    activeProfile &&
    profileHasRunnableModel(currentActiveProfile) &&
    !profileUsesManagedProvider(currentActiveProfile)
  ) {
    return {
      repaired: false,
      providerLabel: providerLabel(connection.provider),
      reason: "already-runnable",
    };
  }

  const existingProfileName = findExistingProfileForConnection(
    profiles,
    connection,
    model,
  );
  const profileName = existingProfileName ?? nextProfileName(profiles);
  const currentOrder = llm?.profileOrder ?? [];
  const profileOrder = currentOrder.includes(profileName)
    ? currentOrder
    : [...currentOrder, profileName];
  const profilePatch = existingProfileName
    ? {}
    : {
        profiles: {
          [profileName]: {
            source: "user" as const,
            label: "Balanced",
            description: "Default provider profile",
            provider: connection.provider,
            provider_connection: connection.name,
            model,
          },
        },
      };

  await configPatch({
    path: { assistant_id: assistantId },
    body: {
      llm: {
        ...profilePatch,
        profileOrder,
        activeProfile: profileName,
      },
    },
    throwOnError: true,
  });

  return {
    repaired: true,
    providerLabel: providerLabel(connection.provider),
  };
}

export async function ensureRunnableProfileFromStoredConnection(
  assistantId: string,
): Promise<ProviderProfileRepairResult> {
  const [{ data: connectionsData }, { data: secretsData }] = await Promise.all([
    inferenceProviderconnectionsGet({
      path: { assistant_id: assistantId },
      throwOnError: true,
    }),
    secretsGet({
      path: { assistant_id: assistantId },
      throwOnError: true,
    }),
  ]);
  const connections = connectionsData?.connections ?? [];
  if (connections.length === 0) {
    return { repaired: false, reason: "no-connections" };
  }

  const connection = selectRepairConnection(
    connections,
    secretsData?.secrets ?? [],
  );
  if (!connection) {
    return { repaired: false, reason: "ambiguous" };
  }

  return ensureRunnableProfileForConnection(assistantId, connection);
}
