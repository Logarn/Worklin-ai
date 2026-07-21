import {
  getDefaultModelForProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import {
  isManagedInferenceConnection,
  isManagedInferenceProfile,
} from "@/assistant/managed-inference";
import {
  isProviderConnectionCompatibleWithModel,
  isProviderConnectionReady,
} from "@/assistant/provider-connection-readiness";
import {
  configGet,
  configPatch,
  inferenceProviderconnectionsGet,
  secretsGet,
} from "@/generated/daemon/sdk.gen";
import type {
  ConfigPatchRequest,
  ConfigGetResponse,
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

const AUTO_PROFILE_NAME = "custom-balanced";
const CHATGPT_SUBSCRIPTION_MODEL = "gpt-5.4-mini";
const FALLBACK_DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  ollama: "llama3.2",
};

const STANDARD_INTERACTIVE_CALL_SITES = [
  "subagentSpawn",
  "callAgent",
  "workflowLeaf",
  "filingAgent",
  "compactionAgent",
  "analyzeConversation",
  "memoryExtraction",
  "memoryRetrieval",
  "memoryRouter",
  "memoryV3SelectL2",
  "recall",
  "conversationSummarization",
  "commitMessage",
  "conversationStarters",
  "replySuggestion",
  "conversationTitle",
  "identityIntro",
  "emptyStateGreeting",
  "guardianQuestionCopy",
  "approvalCopy",
  "approvalConversation",
  "interactionClassifier",
  "styleAnalyzer",
  "preferenceExtraction",
  "inviteInstructionGenerator",
  "skillCategoryInference",
  "meetConsentMonitor",
  "meetChatOpportunity",
  "homeGreeting",
  "homeSuggestedPrompts",
  "inference",
  "trustRuleSuggestion",
] as const;

type WireProfile =
  NonNullable<NonNullable<ConfigGetResponse["llm"]>["profiles"]>[string];
type SecretMetadata = SecretsGetResponse["secrets"][number];
type ActiveProfileDecision = {
  profile: string | null;
  provider: string | null;
  model: string | null;
  provider_connection: string | null;
};
type ConfigPatchRequestWithDecision = ConfigPatchRequest & {
  expectedActiveProfileDecision: ActiveProfileDecision;
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
  /** Route standard user-driven call sites through the selected profile. */
  routeInteractiveCallSites?: boolean;
  /** Connections used to identify explicit managed call-site profiles. */
  connections?: readonly ProviderConnection[];
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
  profile: WireProfile | undefined,
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

export function resolveReadyPersonalConnectionForProfile(
  profile: WireProfile | undefined,
  connections: readonly ProviderConnection[],
  secrets: readonly SecretMetadata[],
): ProviderConnection | null {
  if (!profile || !profileHasRunnableModel(profile)) return null;
  if (isManagedInferenceProfile(profile, connections)) return null;

  const candidates = readyPersonalConnectionsForProfile(
    profile,
    connections,
    secrets,
  );
  return candidates[0] ?? null;
}

function readyPersonalConnectionsForProfile(
  profile: WireProfile,
  connections: readonly ProviderConnection[],
  secrets: readonly SecretMetadata[],
): ProviderConnection[] {
  return connections.filter(
    (candidate) =>
      (profile.provider_connection == null ||
        candidate.name === profile.provider_connection) &&
      candidate.provider === profile.provider &&
      isProviderConnectionCompatibleWithModel(candidate, profile.model) &&
      isProviderConnectionReady(candidate, secrets),
  );
}

function activeProfileDecision(
  llm: ConfigGetResponse["llm"],
  profileName: string | null,
): ActiveProfileDecision {
  const profile = profileName ? llm?.profiles?.[profileName] : undefined;
  return {
    profile: profileName,
    provider: typeof profile?.provider === "string" ? profile.provider : null,
    model: typeof profile?.model === "string" ? profile.model : null,
    provider_connection:
      typeof profile?.provider_connection === "string"
        ? profile.provider_connection
        : null,
  };
}

function profileClearsInheritedConnection(profile: WireProfile): boolean {
  return (
    profile.source === "user" &&
    profile.provider_connection == null &&
    (profile.provider != null || profile.model != null)
  );
}

function connectionIsManagedOrUnresolved(
  connectionName: string,
  connections: readonly ProviderConnection[],
): boolean {
  const connection = connections.find(
    (candidate) => candidate.name === connectionName,
  );
  return connection ? isManagedInferenceConnection(connection) : true;
}

function directCallSiteUsesManagedTransport(
  llm: ConfigGetResponse["llm"],
  configuredProfileName: string | undefined,
  connections: readonly ProviderConnection[],
): boolean {
  const profiles = llm?.profiles ?? {};
  if (configuredProfileName) {
    const configuredProfile = profiles[configuredProfileName];
    if (!configuredProfile) return true;
    if (isManagedInferenceProfile(configuredProfile, connections)) return true;
    if (profileClearsInheritedConnection(configuredProfile)) return false;
    if (configuredProfile.provider_connection) {
      return connectionIsManagedOrUnresolved(
        configuredProfile.provider_connection,
        connections,
      );
    }
  }

  const activeProfileName = llm?.activeProfile;
  const activeProfile = activeProfileName
    ? profiles[activeProfileName]
    : undefined;
  if (activeProfile) {
    if (isManagedInferenceProfile(activeProfile, connections)) return true;
    if (profileClearsInheritedConnection(activeProfile)) return false;
    if (activeProfile.provider_connection) {
      return connectionIsManagedOrUnresolved(
        activeProfile.provider_connection,
        connections,
      );
    }
  }

  const defaultConnection = llm?.default?.provider_connection;
  return typeof defaultConnection === "string"
    ? connectionIsManagedOrUnresolved(defaultConnection, connections)
    : false;
}

export function canSafelyResolveUnpinnedPersonalProfile(
  profile: WireProfile | undefined,
  connections: readonly ProviderConnection[],
  secrets: readonly SecretMetadata[],
): boolean {
  if (
    !profile ||
    profile.provider_connection != null ||
    !profileHasRunnableModel(profile) ||
    profile.source === "managed"
  ) {
    return false;
  }

  const compatibleConnections = connections.filter(
    (candidate) =>
      candidate.provider === profile.provider &&
      isProviderConnectionCompatibleWithModel(candidate, profile.model),
  );
  return (
    compatibleConnections.length > 0 &&
    compatibleConnections.every((candidate) =>
      isProviderConnectionReady(candidate, secrets),
    )
  );
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
  secrets: readonly SecretMetadata[],
): ProviderConnection | null {
  const runnable = connections.filter(
    (connection) =>
      isProviderConnectionReady(connection, secrets) &&
      Boolean(defaultModelForConnection(connection)),
  );
  return runnable.length === 1 ? runnable[0] : null;
}

export function buildInteractivePersonalCallSitePatch(
  llm: ConfigGetResponse["llm"],
  profileName: string,
  connections: readonly ProviderConnection[],
  options: { replaceProfileName?: string | null } = {},
): NonNullable<NonNullable<ConfigPatchRequest["llm"]>["callSites"]> {
  const profiles = llm?.profiles ?? {};
  const callSites = llm?.callSites ?? {};
  const patch: NonNullable<
    NonNullable<ConfigPatchRequest["llm"]>["callSites"]
  > = {};

  for (const callSite of STANDARD_INTERACTIVE_CALL_SITES) {
    const configured = callSites[callSite];
    const hasDirectModelSelection =
      configured?.provider != null || configured?.model != null;

    if (configured?.profile) {
      const configuredProfile = profiles[configured.profile];
      if (
        configured.profile !== options.replaceProfileName &&
        (!configuredProfile ||
          !isManagedInferenceProfile(configuredProfile, connections))
      ) {
        if (
          !hasDirectModelSelection ||
          !directCallSiteUsesManagedTransport(
            llm,
            configured.profile,
            connections,
          )
        ) {
          continue;
        }
      }
    } else if (
      hasDirectModelSelection &&
      !directCallSiteUsesManagedTransport(llm, undefined, connections)
    ) {
      continue;
    }

    if (configured?.profile !== profileName) {
      patch[callSite] = {
        profile: profileName,
        ...(hasDirectModelSelection ? { provider: null, model: null } : {}),
      };
    } else if (hasDirectModelSelection) {
      patch[callSite] = {
        profile: profileName,
        provider: null,
        model: null,
      };
    }
  }

  return patch;
}

export function buildInteractiveProfileSelectionPatch(
  llm: ConfigGetResponse["llm"],
  profileName: string,
  expectedActiveProfile: string | null,
  connections: readonly ProviderConnection[],
  routeInteractiveCallSites: boolean,
): ConfigPatchRequestWithDecision {
  const callSites = routeInteractiveCallSites
    ? buildInteractivePersonalCallSitePatch(
        llm,
        profileName,
        connections,
        { replaceProfileName: expectedActiveProfile },
      )
    : {};

  return {
    expectedActiveProfile,
    expectedActiveProfileDecision: activeProfileDecision(
      llm,
      expectedActiveProfile,
    ),
    llm: {
      activeProfile: profileName,
      ...(Object.keys(callSites).length > 0 ? { callSites } : {}),
    },
  };
}

export function isConfigSelectionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    code?: unknown;
    error?: { code?: unknown };
  };
  return record.code === "CONFLICT" || record.error?.code === "CONFLICT";
}

async function patchInteractiveCallSitesForProfile(
  assistantId: string,
  config: ConfigGetResponse,
  profileName: string,
  connections: readonly ProviderConnection[],
  connectionName?: string,
): Promise<ProviderProfileRepairResult> {
  const callSites = buildInteractivePersonalCallSitePatch(
    config.llm,
    profileName,
    connections,
  );
  if (Object.keys(callSites).length === 0 && !connectionName) {
    return { repaired: false, reason: "already-runnable" };
  }

  try {
    const expectedDecision = activeProfileDecision(config.llm, profileName);
    await configPatch({
      path: { assistant_id: assistantId },
      body: {
        expectedActiveProfile: profileName,
        expectedActiveProfileDecision: expectedDecision,
        llm: {
          ...(connectionName
            ? {
                profiles: {
                  [profileName]: { provider_connection: connectionName },
                },
              }
            : {}),
          ...(Object.keys(callSites).length > 0 ? { callSites } : {}),
        },
      },
      throwOnError: true,
    });
  } catch (error) {
    if (isConfigSelectionConflict(error)) {
      return { repaired: false, reason: "selection-changed" };
    }
    throw error;
  }

  return { repaired: true };
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
    !isManagedInferenceProfile(
      currentActiveProfile,
      options.connections ?? [],
    )
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
  const callSites = options.routeInteractiveCallSites
    ? buildInteractivePersonalCallSitePatch(
        llm,
        profileName,
        options.connections ?? [],
      )
    : {};
  const body: ConfigPatchRequestWithDecision = {
    expectedActiveProfile: activeProfile,
    expectedActiveProfileDecision: activeProfileDecision(llm, activeProfile),
    llm: {
      ...profilePatch,
      profileOrder,
      activeProfile: profileName,
      ...(Object.keys(callSites).length > 0 ? { callSites } : {}),
    },
  };

  try {
    await configPatch({
      path: { assistant_id: assistantId },
      body,
      throwOnError: true,
    });
  } catch (error) {
    if (isConfigSelectionConflict(error)) {
      return {
        repaired: false,
        providerLabel: providerLabel(connection.provider),
        reason: "selection-changed",
      };
    }
    throw error;
  }

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

  return ensureRunnableProfileForConnection(assistantId, connection, {
    connections,
  });
}

/**
 * Repair the exact active profile inspected by the caller. A managed profile
 * is replaced only after the caller confirms managed auth is unavailable; an
 * already-personal profile is kept and, when needed, pinned to its verified
 * connection. Ambiguous or missing personal connections never cause a
 * speculative selection.
 */
async function performUnavailableManagedProfileRepair(
  assistantId: string,
  expectedActiveProfile?: string,
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
  if (
    expectedActiveProfile !== undefined &&
    activeProfileName !== expectedActiveProfile
  ) {
    return { repaired: false, reason: "selection-changed" };
  }
  const activeProfile =
    typeof activeProfileName === "string"
      ? profiles[activeProfileName]
      : undefined;
  const connections = connectionsData?.connections ?? [];
  const secrets = secretsData?.secrets ?? [];

  if (
    activeProfile &&
    activeProfile.provider_connection == null &&
    profileHasRunnableModel(activeProfile) &&
    activeProfile.source !== "managed" &&
    readyPersonalConnectionsForProfile(activeProfile, connections, secrets)
      .length > 1
  ) {
    return { repaired: false, reason: "ambiguous" };
  }

  const activePersonalConnection = resolveReadyPersonalConnectionForProfile(
    activeProfile,
    connections,
    secrets,
  );
  if (activeProfileName && activePersonalConnection) {
    const result = await patchInteractiveCallSitesForProfile(
      assistantId,
      config,
      activeProfileName,
      connections,
      activeProfile?.provider_connection
        ? undefined
        : activePersonalConnection.name,
    );
    return {
      ...result,
      providerLabel: providerLabel(activePersonalConnection.provider),
    };
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
    connections,
    expectedActiveProfile:
      typeof activeProfileName === "string" ? activeProfileName : null,
    routeInteractiveCallSites: true,
  });
}

export function repairUnavailableManagedProfile(
  assistantId: string,
  expectedActiveProfile?: string,
): Promise<ProviderProfileRepairResult> {
  const repairKey = `${assistantId}\u0000${expectedActiveProfile ?? ""}`;
  const current = unavailableManagedRepairInFlight.get(repairKey);
  if (current) return current;

  const repair = performUnavailableManagedProfileRepair(
    assistantId,
    expectedActiveProfile,
  );
  unavailableManagedRepairInFlight.set(repairKey, repair);
  void repair.then(
    () => unavailableManagedRepairInFlight.delete(repairKey),
    () => unavailableManagedRepairInFlight.delete(repairKey),
  );
  return repair;
}
