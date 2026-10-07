import { z } from "zod";

import type { ConnectionModel } from "../inference/auth.js";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const CODEX_CATALOG_CLIENT_VERSION = "0.160.1";
const CODEX_CATALOG_TIMEOUT_MS = 5_000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const CodexModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
      priority: z.number().optional(),
    }),
  ),
});

/**
 * Conservative fallback used only when the account-specific catalog cannot be
 * loaded. The remote Codex catalog remains authoritative whenever available.
 */
export const CODEX_SUBSCRIPTION_FALLBACK_MODELS: readonly ConnectionModel[] = [
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol" },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna" },
];

const CODEX_SUBSCRIPTION_FALLBACK_MODEL_IDS = new Set(
  CODEX_SUBSCRIPTION_FALLBACK_MODELS.map((model) => model.id),
);

export function getChatgptAccountId(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;

  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return null;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : null;
  } catch {
    return null;
  }
}

export async function fetchCodexSubscriptionModels(
  accessToken: string,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  } = {},
): Promise<ConnectionModel[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(CODEX_MODELS_URL);
  url.searchParams.set("client_version", CODEX_CATALOG_CLIENT_VERSION);

  const accountId = getChatgptAccountId(accessToken);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
    },
    signal: options.signal ?? AbortSignal.timeout(CODEX_CATALOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `ChatGPT model catalog request failed with HTTP ${response.status}`,
    );
  }

  const parsed = CodexModelsResponseSchema.parse(await response.json());
  const seen = new Set<string>();
  return parsed.models
    .filter((model) => model.visibility === "list")
    .sort(
      (left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) -
        (right.priority ?? Number.MAX_SAFE_INTEGER),
    )
    .flatMap((model) => {
      if (seen.has(model.slug)) return [];
      seen.add(model.slug);
      return [{ id: model.slug, displayName: model.display_name }];
    });
}

/** True when `model` is available to the subscription connection. */
export function isCodexSubscriptionModel(
  model: string,
  connectionModels?: readonly ConnectionModel[] | null,
): boolean {
  if (connectionModels != null) {
    return connectionModels.some((candidate) => candidate.id === model);
  }
  return CODEX_SUBSCRIPTION_FALLBACK_MODEL_IDS.has(model);
}
