import type { PooledModelKeyProvider } from "./pooled-model-key-vault.js";

const VALIDATION_TIMEOUT_MS = 10_000;

type SupportedProvider = Exclude<
  PooledModelKeyProvider,
  "openai-compatible"
>;

export type PooledModelKeyValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

type ValidationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ValidationRequest {
  url: string;
  headers: Record<string, string>;
}

const PROVIDER_LABELS: Record<SupportedProvider, string> = Object.freeze({
  anthropic: "Anthropic",
  fireworks: "Fireworks",
  gemini: "Gemini",
  kimi: "Kimi",
  minimax: "MiniMax",
  openai: "OpenAI",
  openrouter: "OpenRouter",
});

function validationRequest(
  provider: SupportedProvider,
  apiKey: string,
): ValidationRequest {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
      };
    case "fireworks":
      return {
        url: "https://api.fireworks.ai/inference/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "gemini":
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        headers: { "x-goog-api-key": apiKey },
      };
    case "kimi":
      return {
        url: "https://api.moonshot.ai/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "minimax":
      return {
        // This must match the endpoint used by the pooled runtime. Do not
        // silently fall back to a different regional host after validation.
        url: "https://api.minimax.io/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/auth/key",
        headers: { Authorization: `Bearer ${apiKey}` },
      };
  }
}

/**
 * Positively verifies a pooled tenant's model-provider key before persistence.
 *
 * Any provider rejection, transient upstream failure, timeout, malformed
 * response, or local network error fails closed. This prevents onboarding from
 * reporting success for a key that has never been accepted by its provider.
 */
export async function validatePooledModelProviderKey(
  provider: SupportedProvider,
  apiKey: string,
  options: { fetchImpl?: ValidationFetch } = {},
): Promise<PooledModelKeyValidationResult> {
  const label = PROVIDER_LABELS[provider];
  if (typeof apiKey !== "string" || apiKey.length < 1) {
    return { valid: false, reason: `${label} API key is required.` };
  }

  const request = validationRequest(provider, apiKey);
  try {
    const response = await (options.fetchImpl ?? fetch)(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) return { valid: true };

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        reason: `${label} rejected this API key.`,
      };
    }
    return {
      valid: false,
      reason: `${label} could not verify this connection (${response.status}). Try again shortly.`,
    };
  } catch {
    return {
      valid: false,
      reason: `${label} could not verify this connection. Check your network and try again.`,
    };
  }
}
