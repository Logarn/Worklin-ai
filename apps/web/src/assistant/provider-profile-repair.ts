import {
  getDefaultModelForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import {
  configGet,
  configPatch,
  inferenceProviderconnectionsGet,
} from "@/generated/daemon/sdk.gen";
import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

const AUTO_PROFILE_NAME = "custom-balanced";

export interface ProviderProfileRepairResult {
  repaired: boolean;
  providerLabel?: string;
  reason?: "no-model" | "no-connections" | "ambiguous" | "already-runnable";
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
  return (
    getDefaultModelForProvider(connection.provider) ??
    connection.models?.[0]?.id ??
    ""
  );
}

function providerLabel(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

function selectRepairConnection(
  connections: readonly ProviderConnection[],
): ProviderConnection | null {
  const runnable = connections.filter((connection) =>
    Boolean(defaultModelForConnection(connection)),
  );
  if (runnable.length === 1) return runnable[0];

  const kimiConnections = runnable.filter(
    (connection) => connection.provider === "kimi",
  );
  if (kimiConnections.length === 1) return kimiConnections[0];

  return null;
}

export async function ensureRunnableProfileForConnection(
  assistantId: string,
  connection: ProviderConnection,
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

  if (activeProfile && profileHasRunnableModel(profiles[activeProfile])) {
    return {
      repaired: false,
      providerLabel: providerLabel(connection.provider),
      reason: "already-runnable",
    };
  }

  const profileName = nextProfileName(profiles);
  const currentOrder = llm?.profileOrder ?? [];
  const profileOrder = currentOrder.includes(profileName)
    ? currentOrder
    : [...currentOrder, profileName];

  await configPatch({
    path: { assistant_id: assistantId },
    body: {
      llm: {
        profiles: {
          [profileName]: {
            source: "user",
            label: "Balanced",
            description: "Default provider profile",
            provider: connection.provider,
            provider_connection: connection.name,
            model,
          },
        },
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
  const { data } = await inferenceProviderconnectionsGet({
    path: { assistant_id: assistantId },
    throwOnError: true,
  });
  const connections = data?.connections ?? [];
  if (connections.length === 0) {
    return { repaired: false, reason: "no-connections" };
  }

  const connection = selectRepairConnection(connections);
  if (!connection) {
    return { repaired: false, reason: "ambiguous" };
  }

  return ensureRunnableProfileForConnection(assistantId, connection);
}
