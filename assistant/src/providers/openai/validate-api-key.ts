import { getLogger } from "../../util/logger.js";

const log = getLogger("openai-compatible-key-validation");
const VALIDATION_TIMEOUT_MS = 10_000;

export type ApiKeyValidationResult =
  | { valid: true }
  | {
      valid: false;
      outcome: "invalid_credentials";
      reason: string;
    }
  | {
      valid: false;
      outcome: "verification_unavailable";
      reason: string;
    };

type ValidationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function validateOpenAICompatibleApiKey(
  apiKey: string,
  options: {
    baseUrl: string;
    providerLabel: string;
    fetchImpl?: ValidationFetch;
    method?: "GET" | "POST";
    path?: string;
    body?: Record<string, unknown>;
    rejectionStatuses?: readonly number[];
  },
): Promise<ApiKeyValidationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(
    options.path ?? "models",
    `${options.baseUrl.replace(/\/+$/, "")}/`,
  );
  const rejectionStatuses = options.rejectionStatuses ?? [401, 403];
  try {
    const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) return { valid: true };

    log.warn(
      { provider: options.providerLabel, status: response.status },
      "Provider API key validation failed",
    );
    if (rejectionStatuses.includes(response.status)) {
      return {
        valid: false,
        outcome: "invalid_credentials",
        reason: `${options.providerLabel} rejected this API key.`,
      };
    }
    return {
      valid: false,
      outcome: "verification_unavailable",
      reason: `${options.providerLabel} could not verify this connection (${response.status}). Try again shortly.`,
    };
  } catch (error) {
    log.warn(
      {
        provider: options.providerLabel,
        error: error instanceof Error ? error.message : String(error),
      },
      "Provider API key validation request failed",
    );
    return {
      valid: false,
      outcome: "verification_unavailable",
      reason: `${options.providerLabel} could not verify this connection. Check your network and try again.`,
    };
  }
}
