import {
  getDefaultModelForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import { isManagedInferenceProfile } from "@/assistant/managed-inference";
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
  reason?:
    | "no-model"
    | "no-connections"
    | "ambiguous"
    | "already-runnable"
    | "selection-changed";
}

export interface EnsureRunnableProfileOptions {
  /** Select the supplied connection even when another user profile is active. */
  activateConnection?: boolean;
  /** Abort if the active profile changed after the caller inspected it. */
  expectedActiveProfile?: string | null;
}

const unavailableManagedRepairInFlight = new Map<
  string,
  Promise<ProviderProfileRepairResult>
>();

export function canSendAfterManagedProfileRepair(
  result: ProviderProfileRepairResult,
): boolean {
  return result.repaired || result.reason === "already-runnable";
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

function profileHasReadyPersonalConnection(
  profile:
    | NonNullable<NonNullable<ConfigGetResponse["llm"]>["profiles"]>[string]
    | undefined,
  connections: readonly ProviderConnection[],
  secrets: readonly SecretsGetResponse["secrets"][number][],
): boolean {
  if (
    !profile ||
    !profileHasRunnableModel(profile) ||
    isManagedInferenceProfile(profile, connections) ||
    !profile.provider_connection
  ) {
    return false;
  }

  const connection = connections.find(
    (candidate) => candidate.name === profile.provider_connection,
  );
  if (!connection || connection.provider !== profile.provider) return false;
  return isProviderConnectionReady(connection, secrets);
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
  const catalogDefault = getDefaultModelForProvider(connection.provider);
  if (catalogDefault) return catalogDefault;

  const fallbackDefault =
    FALLBACK_DEFAULT_MODEL_BY_PROVIDER[connection.provider];
  if (fallbackDefault) return fallbackDefault;

  return connection.models?.[0]?.id ?? "";
}

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
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
  return runnable.length === 1 ? runnable[0] : null;
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
    options.expectedActiveProfile !== undefined &&
    activeProfile !== options.expectedActiveProfile
  ) {
    return {
      repaired: false,
      providerLabel: providerLabel(connection.provider),
      reason: "selection-changed",
    };
  }

  if (
    !options.activateConnection &&
    activeProfile &&
    currentActiveProfile &&
    profileHasRunnableModel(currentActiveProfile) &&
    !isManagedInferenceProfile(currentActiveProfile)
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

/**
 * Replace an active managed profile only when managed proxy auth has already
 * been confirmed unavailable by the caller. Existing personal profiles are
 * left alone, and ambiguous/missing personal connections never cause a
 * speculative selection.
 */
async function performUnavailableManagedProfileRepair(
  assistantId: string,
): Promise<ProviderProfileRepairResult> {
  const [{ data: config }, { data: connectionsData }, { data: secretsData }] =
    await Promise.all([
      configGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      }),
      inferenceProviderconnectionsGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      }),
      secretsGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      }),
    ]);

  const profiles = config?.llm?.profiles ?? {};
  const activeProfileName = config?.llm?.activeProfile;
  const activeProfile =
    typeof activeProfileName === "string"
      ? profiles[activeProfileName]
      : undefined;
  const connections = connectionsData?.connections ?? [];
  const secrets = secretsData?.secrets ?? [];

  if (profileHasReadyPersonalConnection(activeProfile, connections, secrets)) {
    return { repaired: false, reason: "already-runnable" };
  }

  if (
    !activeProfile ||
    !isManagedInferenceProfile(activeProfile, connections)
  ) {
    return { repaired: false, reason: "selection-changed" };
  }

  if (connections.length === 0) {
    return { repaired: false, reason: "no-connections" };
  }

  const connection = selectRepairConnection(connections, secrets);
  if (!connection) {
    return { repaired: false, reason: "ambiguous" };
  }

  return ensureRunnableProfileForConnection(assistantId, connection, {
    activateConnection: true,
    expectedActiveProfile:
      typeof activeProfileName === "string" ? activeProfileName : null,
  });
}

export function repairUnavailableManagedProfile(
  assistantId: string,
): Promise<ProviderProfileRepairResult> {
  const current = unavailableManagedRepairInFlight.get(assistantId);
  if (current) return current;

  const repair = performUnavailableManagedProfileRepair(assistantId);
  unavailableManagedRepairInFlight.set(assistantId, repair);
  void repair.then(
    () => unavailableManagedRepairInFlight.delete(assistantId),
    () => unavailableManagedRepairInFlight.delete(assistantId),
  );
  return repair;
}
