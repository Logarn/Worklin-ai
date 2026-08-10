import { PROVIDER_CATALOG } from "../model-catalog.js";

export interface ConcurrentManagedProviderConfig {
  provider: string;
  model: string;
  displayName: string;
  credentialEnvVar: string;
}

type EnvLike = Record<string, string | undefined>;

function parseConcurrentManagedProviderConfig(
  rawEnv: EnvLike,
): ConcurrentManagedProviderConfig {
  const provider =
    rawEnv.CONCURRENT_RUNTIME_MANAGED_PROVIDER?.trim().toLowerCase() || "";
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (!entry || entry.setupMode !== "api-key" || !entry.envVar) {
    throw new Error(
      "CONCURRENT_RUNTIME_MANAGED_PROVIDER must name an API-key LLM provider.",
    );
  }

  const model =
    rawEnv.CONCURRENT_RUNTIME_MANAGED_MODEL?.trim() || entry.defaultModel;
  if (!entry.models.some((candidate) => candidate.id === model)) {
    throw new Error(
      `CONCURRENT_RUNTIME_MANAGED_MODEL is not supported by ${entry.displayName}.`,
    );
  }
  if (!rawEnv[entry.envVar]?.trim()) {
    throw new Error(
      `${entry.envVar} is required for concurrent managed inference.`,
    );
  }

  return {
    provider: entry.id,
    model,
    displayName: entry.displayName,
    credentialEnvVar: entry.envVar,
  };
}

export function getConcurrentManagedProviderConfig(
  rawEnv: EnvLike = process.env,
): ConcurrentManagedProviderConfig | null {
  try {
    return parseConcurrentManagedProviderConfig(rawEnv);
  } catch {
    return null;
  }
}

export function assertConcurrentManagedProviderConfiguration(
  rawEnv: EnvLike = process.env,
): ConcurrentManagedProviderConfig {
  return parseConcurrentManagedProviderConfig(rawEnv);
}
