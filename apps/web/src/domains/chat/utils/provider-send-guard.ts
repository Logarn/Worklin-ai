import { isManagedInferenceProfile } from "@/assistant/managed-inference";
import {
  canSafelyResolveUnpinnedPersonalProfile,
  canSendAfterManagedProfileRepair,
  resolveReadyPersonalConnectionForProfile,
  type ProviderProfileRepairResult,
} from "@/assistant/provider-profile-repair";
import type {
  AuthInfoGetResponse,
  ConfigGetResponse,
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

export type ProviderSendSelection =
  | { kind: "workspace-active" }
  | { kind: "conversation-override"; profileName: string }
  | { kind: "unverified"; error?: unknown };

export type ProviderSendGuardAllowedReason =
  | "personal-configured"
  | "personal-repaired"
  | "managed-configured"
  | "managed-repaired";

export type ProviderSendGuardBlockedReason =
  | "config-unverified"
  | "selection-unverified"
  | "connection-unverified"
  | "personal-unavailable"
  | "personal-connection-required"
  | "managed-unavailable"
  | "managed-status-unverified";

export type ProviderSendGuardResult =
  | {
      allowed: true;
      reason: ProviderSendGuardAllowedReason;
      profileName: string;
    }
  | {
      allowed: false;
      reason: ProviderSendGuardBlockedReason;
      message: string;
      action: "open-model-settings";
      error?: unknown;
    };

interface ProviderSendGuardDependencies {
  selection: ProviderSendSelection;
  loadConfig: () => Promise<ConfigGetResponse | undefined>;
  loadConnections: () => Promise<readonly ProviderConnection[]>;
  loadSecrets: () => Promise<readonly SecretsGetResponse["secrets"][number][]>;
  loadManagedStatus: () => Promise<AuthInfoGetResponse>;
  repairActiveSelection: (
    expectedActiveProfile: string,
  ) => Promise<ProviderProfileRepairResult>;
}

const BLOCKED_MESSAGES: Record<ProviderSendGuardBlockedReason, string> = {
  "config-unverified":
    "Worklin couldn't verify your model settings. Open Models & Services, confirm a provider, and try again.",
  "selection-unverified":
    "Worklin couldn't verify which model this conversation will use. Open Models & Services, confirm a provider, and try again.",
  "connection-unverified":
    "Worklin couldn't verify the selected provider connection. Open Models & Services, confirm the connection, and try again.",
  "personal-unavailable":
    "The selected personal provider isn't ready. Check its connection in Models & Services and try again.",
  "personal-connection-required":
    "This model setup needs a specific personal connection. Choose one in Models & Services and try again.",
  "managed-unavailable":
    "Worklin credits aren't available for this model. Choose a personal provider in Models & Services and try again.",
  "managed-status-unverified":
    "Worklin credits could not be checked. Try again in a moment or choose a personal provider in Models & Services.",
};

function blocked(
  reason: ProviderSendGuardBlockedReason,
  error?: unknown,
): ProviderSendGuardResult {
  return {
    allowed: false,
    reason,
    message: BLOCKED_MESSAGES[reason],
    action: "open-model-settings",
    ...(error === undefined ? {} : { error }),
  };
}

export async function checkProviderReadyForSend({
  selection,
  loadConfig,
  loadConnections,
  loadSecrets,
  loadManagedStatus,
  repairActiveSelection,
}: ProviderSendGuardDependencies): Promise<ProviderSendGuardResult> {
  if (selection.kind === "unverified") {
    return blocked("selection-unverified", selection.error);
  }

  let config: ConfigGetResponse | undefined;
  try {
    config = await loadConfig();
  } catch (error) {
    return blocked("config-unverified", error);
  }

  const profileName =
    selection.kind === "conversation-override"
      ? selection.profileName
      : config?.llm?.activeProfile;
  if (!profileName) {
    return blocked("selection-unverified");
  }
  const profile = config?.llm?.profiles?.[profileName];
  if (
    !profile ||
    profile.status === "disabled" ||
    !profile.provider ||
    !profile.model
  ) {
    return blocked("selection-unverified");
  }

  let connections: readonly ProviderConnection[] = [];
  if (profile.source !== "managed" || profile.provider_connection) {
    try {
      connections = await loadConnections();
    } catch (error) {
      return blocked("connection-unverified", error);
    }
  }

  if (
    profile.provider_connection &&
    !connections.some(
      (candidate) => candidate.name === profile.provider_connection,
    )
  ) {
    return blocked("connection-unverified");
  }

  const managedSelection = isManagedInferenceProfile(profile, connections);
  if (!managedSelection) {
    let secrets: readonly SecretsGetResponse["secrets"][number][];
    try {
      secrets = await loadSecrets();
    } catch (error) {
      return blocked("connection-unverified", error);
    }

    const readyConnection = resolveReadyPersonalConnectionForProfile(
      profile,
      connections,
      secrets,
    );
    if (!readyConnection) {
      return blocked("personal-unavailable");
    }

    if (profile.provider_connection) {
      return {
        allowed: true,
        reason: "personal-configured",
        profileName,
      };
    }

    const inheritedConnectionName = config?.llm?.default?.provider_connection;
    const inheritedConnection = inheritedConnectionName
      ? connections.find(
          (candidate) => candidate.name === inheritedConnectionName,
        )
      : undefined;
    if (inheritedConnectionName && !inheritedConnection) {
      return blocked("connection-unverified");
    }
    const unpinnedResolutionSafe =
      inheritedConnection?.provider === profile.provider
        ? resolveReadyPersonalConnectionForProfile(
            {
              ...profile,
              provider_connection: inheritedConnection.name,
            },
            connections,
            secrets,
          ) != null
        : canSafelyResolveUnpinnedPersonalProfile(
            profile,
            connections,
            secrets,
          );
    if (unpinnedResolutionSafe) {
      return {
        allowed: true,
        reason: "personal-configured",
        profileName,
      };
    }

    if (selection.kind === "conversation-override") {
      return blocked("personal-connection-required");
    }

    try {
      const repair = await repairActiveSelection(profileName);
      if (
        canSendAfterManagedProfileRepair(repair) &&
        repair.verifiedProfileName
      ) {
        return {
          allowed: true,
          reason: "personal-repaired",
          profileName: repair.verifiedProfileName,
        };
      }
    } catch (error) {
      return blocked("personal-unavailable", error);
    }
    return blocked("personal-connection-required");
  }

  let managedStatus: AuthInfoGetResponse;
  try {
    managedStatus = await loadManagedStatus();
  } catch (error) {
    return blocked("managed-status-unverified", error);
  }

  if (managedStatus.authenticated === true) {
    return { allowed: true, reason: "managed-configured", profileName };
  }

  if (selection.kind === "conversation-override") {
    return blocked("managed-unavailable");
  }

  try {
    const repair = await repairActiveSelection(profileName);
    if (
      canSendAfterManagedProfileRepair(repair) &&
      repair.verifiedProfileName
    ) {
      return {
        allowed: true,
        reason: "managed-repaired",
        profileName: repair.verifiedProfileName,
      };
    }
  } catch (error) {
    return blocked("managed-unavailable", error);
  }

  return blocked("managed-unavailable");
}
