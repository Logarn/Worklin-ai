import type { DrizzleDb } from "../memory/db-connection.js";
import {
  getConnection,
  upsertConnection,
} from "../providers/inference/connections.js";
import { getCatalogProviderForModel } from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import { credentialKey } from "../security/credential-key.js";
import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
import { resolveCallSiteConfig } from "./llm-resolver.js";
import {
  invalidateConfigCache,
  loadConfig,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import { LLMCallSiteEnum } from "./schemas/llm.js";

export const POOLED_BYOK_INFERENCE_PROVIDERS = [
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openrouter",
] as const;

export type PooledByokInferenceProvider =
  (typeof POOLED_BYOK_INFERENCE_PROVIDERS)[number];

const POOLED_BYOK_PROVIDER_SET = new Set<string>(
  POOLED_BYOK_INFERENCE_PROVIDERS,
);

const CUSTOM_PROFILE_TEMPLATES = {
  "custom-balanced": {
    intent: "balanced",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
  },
  "custom-quality-optimized": {
    intent: "quality-optimized",
    label: "Quality",
    description: "Best results with the most capable model",
  },
  "custom-cost-optimized": {
    intent: "latency-optimized",
    label: "Speed",
    description: "Fastest responses at lower cost",
  },
} as const;

const SETUP_REQUIRED_PROFILE = "byok-setup-required";
const SETUP_REQUIRED_CONNECTION = "byok-setup-required";

export type PooledByokBootstrapResult =
  | {
      status: "ready";
      provider: PooledByokInferenceProvider;
      connectionName: string;
      activeProfile: string;
    }
  | { status: "setup_required" };

/**
 * Make one pooled tenant's restored or generation-zero config BYOK-only.
 *
 * This function writes credential references, never credential values. The
 * actual provider key remains request-scoped in the control-plane vault and is
 * resolved only while an authenticated tenant request is active.
 */
export function bootstrapPooledByokInference(
  db: DrizzleDb,
  providerHint?: PooledByokInferenceProvider,
): PooledByokBootstrapResult {
  const raw = loadRawConfig();
  const llm = readObject(raw.llm) ?? {};
  const profiles = readObject(llm.profiles) ?? {};

  const existing = resolveExistingByokProfile(db, llm, profiles);
  const provider = providerHint ?? existing?.provider;
  if (!provider) {
    seedSetupRequiredState(raw, llm, profiles);
    return { status: "setup_required" };
  }

  const connectionName =
    existing?.provider === provider
      ? existing.connectionName
      : `${provider}-personal`;
  const connectionResult = upsertConnection(db, {
    name: connectionName,
    provider,
    auth: {
      type: "api_key",
      credential: credentialKey(provider, "api_key"),
    },
    label: `${providerDisplayName(provider)} (Personal)`,
  });
  if (!connectionResult.ok) {
    throw new Error("Pooled BYOK provider connection could not be created.");
  }

  disableManagedProfiles(profiles);
  const activeProfile = seedPersonalProfiles(
    llm,
    profiles,
    provider,
    connectionName,
    existing?.activeProfile,
  );
  normalizeProfilesForByok(profiles, provider, connectionName);
  normalizeCallSitesForByok(llm, provider, connectionName);
  raw.llm = llm;
  saveRawConfig(raw);
  invalidateConfigCache();
  assertPooledByokInferenceReady(db);
  return { status: "ready", provider, connectionName, activeProfile };
}

/**
 * Validate every built-in call site without resolving a credential. This is a
 * structural readiness check only: all effective profiles must target an
 * API-key connection owned by this workspace and no managed connection may
 * remain reachable.
 */
export function assertPooledByokInferenceReady(db: DrizzleDb): void {
  const config = loadConfig();
  for (const callSite of LLMCallSiteEnum.options) {
    const resolved = resolveCallSiteConfig(callSite, config.llm);
    const connectionName = resolved.provider_connection;
    if (!connectionName || connectionName.endsWith("-managed")) {
      throw new Error("Pooled inference resolved a non-BYOK connection.");
    }
    const connection = getConnection(db, connectionName);
    if (
      !connection ||
      connection.auth.type !== "api_key" ||
      connection.provider !== resolved.provider ||
      connection.auth.credential !==
        credentialKey(connection.provider, "api_key")
    ) {
      throw new Error(
        `Pooled inference BYOK connection is incomplete for ${callSite} (${resolved.provider}/${connectionName}).`,
      );
    }
  }
}

function resolveExistingByokProfile(
  db: DrizzleDb,
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
): {
  provider: PooledByokInferenceProvider;
  connectionName: string;
  activeProfile?: string;
} | null {
  const activeProfile = readString(llm.activeProfile);
  const active = activeProfile ? readObject(profiles[activeProfile]) : null;
  const activeConnectionName = readString(active?.provider_connection);
  const activeProvider = pooledByokProvider(active?.provider);
  if (activeConnectionName && activeProvider) {
    const connection = getConnection(db, activeConnectionName);
    if (
      connection?.provider === activeProvider &&
      connection.auth.type === "api_key"
    ) {
      return {
        provider: activeProvider,
        connectionName: activeConnectionName,
        activeProfile,
      };
    }
  }

  const defaultProfile = readObject(llm.default);
  const defaultProvider = pooledByokProvider(defaultProfile?.provider);
  const defaultConnectionName = readString(defaultProfile?.provider_connection);
  if (defaultProvider && defaultConnectionName) {
    const connection = getConnection(db, defaultConnectionName);
    if (
      connection?.provider === defaultProvider &&
      connection.auth.type === "api_key"
    ) {
      return {
        provider: defaultProvider,
        connectionName: defaultConnectionName,
      };
    }
  }

  if (
    defaultConnectionName === SETUP_REQUIRED_CONNECTION ||
    profiles[SETUP_REQUIRED_PROFILE] !== undefined
  ) {
    return null;
  }
  const activeIsExplicitlyPersonal =
    active?.source === "user" &&
    activeProfile !== SETUP_REQUIRED_PROFILE &&
    !activeConnectionName?.endsWith("-managed");
  return activeIsExplicitlyPersonal && activeProvider
    ? {
        provider: activeProvider,
        connectionName: `${activeProvider}-personal`,
      }
    : null;
}

function seedPersonalProfiles(
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
  provider: PooledByokInferenceProvider,
  connectionName: string,
  preferredActiveProfile?: string,
): string {
  for (const [name, template] of Object.entries(CUSTOM_PROFILE_TEMPLATES)) {
    const previous = readObject(profiles[name]);
    const samePersonalTarget =
      previous?.provider === provider &&
      previous.provider_connection === connectionName;
    profiles[name] = samePersonalTarget
      ? { ...previous, source: "user", status: "active" }
      : {
          source: "user",
          status: "active",
          label: template.label,
          description: template.description,
          provider,
          model: resolveModelIntent(provider, template.intent),
          provider_connection: connectionName,
        };
  }

  const preferred = preferredActiveProfile
    ? readObject(profiles[preferredActiveProfile])
    : null;
  const activeProfile =
    preferred?.provider === provider &&
    preferred.provider_connection === connectionName &&
    preferred.status !== "disabled"
      ? preferredActiveProfile!
      : "custom-balanced";

  const balanced = readObject(profiles["custom-balanced"])!;
  const previousDefault = readObject(llm.default) ?? {};
  llm.default = {
    ...previousDefault,
    provider,
    model: balanced.model,
    provider_connection: connectionName,
  };
  llm.profiles = profiles;
  llm.activeProfile = activeProfile;
  delete profiles[SETUP_REQUIRED_PROFILE];

  const order = Array.isArray(llm.profileOrder)
    ? llm.profileOrder.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  llm.profileOrder = [
    ...new Set([...Object.keys(CUSTOM_PROFILE_TEMPLATES), ...order]),
  ];
  return activeProfile;
}

function seedSetupRequiredState(
  raw: Record<string, unknown>,
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
): void {
  disableManagedProfiles(profiles);
  stripProfileRouting(profiles);
  profiles[SETUP_REQUIRED_PROFILE] = {
    source: "user",
    status: "disabled",
    label: "Connect a model provider",
    description: "Add your API key before starting a conversation",
  };
  llm.profiles = profiles;
  llm.profileOrder = [
    SETUP_REQUIRED_PROFILE,
    ...(Array.isArray(llm.profileOrder)
      ? llm.profileOrder.filter(
          (item): item is string =>
            typeof item === "string" && item !== SETUP_REQUIRED_PROFILE,
        )
      : []),
  ];
  delete llm.activeProfile;
  const callSites = readObject(llm.callSites);
  if (callSites) {
    for (const entry of Object.values(callSites)) {
      const callSite = readObject(entry);
      if (!callSite) continue;
      delete callSite.profile;
      delete callSite.provider;
      delete callSite.model;
      delete callSite.provider_connection;
    }
  }
  const defaultProfile = readObject(llm.default) ?? {};
  // A deliberate missing row is safer than omitting the connection: generic
  // provider resolution auto-selects any compatible connection when the field
  // is absent, which could otherwise select a restored managed connection.
  // The sentinel makes every attempted turn fail closed until the user picks a
  // personal provider; the next successful bootstrap replaces it.
  defaultProfile.provider_connection = SETUP_REQUIRED_CONNECTION;
  llm.default = defaultProfile;
  raw.llm = llm;
  saveRawConfig(raw);
  invalidateConfigCache();
}

function normalizeProfilesForByok(
  profiles: Record<string, unknown>,
  provider: PooledByokInferenceProvider,
  connectionName: string,
): void {
  for (const [name, value] of Object.entries(profiles)) {
    const profile = readObject(value);
    if (!profile || name === SETUP_REQUIRED_PROFILE || profile.mix) continue;
    const configuredProvider = pooledByokProvider(profile.provider);
    const modelProvider =
      typeof profile.model === "string"
        ? getCatalogProviderForModel(profile.model)
        : undefined;
    const configuredConnection = readString(profile.provider_connection);
    const sameTarget =
      (configuredProvider === null || configuredProvider === provider) &&
      (modelProvider === undefined || modelProvider === provider) &&
      (configuredConnection === undefined ||
        configuredConnection === connectionName);

    if (!sameTarget) {
      delete profile.provider;
      delete profile.model;
      delete profile.provider_connection;
      continue;
    }
    profile.provider = provider;
    profile.provider_connection = connectionName;
  }
}

function stripProfileRouting(profiles: Record<string, unknown>): void {
  for (const value of Object.values(profiles)) {
    const profile = readObject(value);
    if (!profile || profile.mix) continue;
    delete profile.provider;
    delete profile.model;
    delete profile.provider_connection;
  }
}

function normalizeCallSitesForByok(
  llm: Record<string, unknown>,
  provider: PooledByokInferenceProvider,
  connectionName: string,
): void {
  const callSites = readObject(llm.callSites) ?? {};
  for (const [callSiteName, value] of Object.entries(callSites)) {
    const entry = readObject(value);
    if (!entry) continue;

    const entryProvider = pooledByokProvider(entry.provider);
    const modelProvider =
      typeof entry.model === "string"
        ? getCatalogProviderForModel(entry.model)
        : undefined;
    const alreadyTargetsProvider =
      entryProvider === provider ||
      (entryProvider === null && modelProvider === provider);

    if (alreadyTargetsProvider) {
      entry.provider = provider;
      entry.provider_connection = connectionName;
      delete entry.profile;
      continue;
    }

    delete entry.provider;
    delete entry.model;
    delete entry.provider_connection;
    const defaultProfile =
      CALL_SITE_DEFAULTS[callSiteName as keyof typeof CALL_SITE_DEFAULTS]
        ?.profile;
    if (defaultProfile) {
      entry.profile = `custom-${defaultProfile}`;
    } else {
      delete entry.profile;
    }
  }
  llm.callSites = callSites;
}

function disableManagedProfiles(profiles: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(profiles)) {
    const profile = readObject(value);
    if (!profile) continue;
    const connectionName = readString(profile.provider_connection);
    if (
      profile.source === "managed" ||
      name === "balanced" ||
      name === "quality-optimized" ||
      name === "cost-optimized" ||
      name === "balanced-economy" ||
      name === "auto" ||
      connectionName?.endsWith("-managed")
    ) {
      profiles[name] = { ...profile, status: "disabled" };
    }
  }
}

function pooledByokProvider(
  value: unknown,
): PooledByokInferenceProvider | null {
  return typeof value === "string" && POOLED_BYOK_PROVIDER_SET.has(value)
    ? (value as PooledByokInferenceProvider)
    : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerDisplayName(provider: string): string {
  return provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
