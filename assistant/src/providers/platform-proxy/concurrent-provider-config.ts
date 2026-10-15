import { PROVIDER_CATALOG } from "../model-catalog.js";

export const CONCURRENT_RUNTIME_MODEL_PROVIDERS = Object.freeze([
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openrouter",
] as const);

export type ConcurrentRuntimeModelProvider =
  (typeof CONCURRENT_RUNTIME_MODEL_PROVIDERS)[number];

export interface ConcurrentProviderConfig {
  provider: string;
  model: string;
  displayName: string;
}

export function getConcurrentProviderConfig(
  providerInput: unknown,
  modelInput?: unknown,
): ConcurrentProviderConfig | null {
  if (
    typeof providerInput !== "string" ||
    !CONCURRENT_RUNTIME_MODEL_PROVIDERS.includes(
      providerInput as ConcurrentRuntimeModelProvider,
    )
  ) {
    return null;
  }
  const entry = PROVIDER_CATALOG.find(
    (candidate) => candidate.id === providerInput,
  );
  if (!entry || entry.setupMode !== "api-key" || !entry.envVar) return null;
  const model =
    typeof modelInput === "string" &&
    entry.models.some((m) => m.id === modelInput)
      ? modelInput
      : entry.defaultModel;
  return {
    provider: entry.id,
    model,
    displayName: entry.displayName,
  };
}
