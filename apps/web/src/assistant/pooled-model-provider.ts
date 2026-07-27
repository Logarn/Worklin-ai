import type { ConnectionProvider } from "@/generated/daemon/types.gen";

/**
 * Model providers whose first-class API-key contract can be bootstrapped by a
 * pooled worker. Keep this list in lockstep with the control-plane vault and
 * the worker's pooled BYOK bootstrap. Providers that need a custom base URL,
 * OAuth, a local daemon, or an aliased credential are deliberately excluded.
 */
export const POOLED_API_KEY_PROVIDERS = Object.freeze([
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openrouter",
] as const satisfies readonly ConnectionProvider[]);

export type PooledApiKeyProvider =
  (typeof POOLED_API_KEY_PROVIDERS)[number];

const POOLED_API_KEY_PROVIDER_SET = new Set<string>(POOLED_API_KEY_PROVIDERS);

export function isPooledApiKeyProvider(
  value: unknown,
): value is PooledApiKeyProvider {
  return typeof value === "string" && POOLED_API_KEY_PROVIDER_SET.has(value);
}

export function isPooledRuntimeProvider(
  runtimeProvider: string | null | undefined,
): boolean {
  return runtimeProvider === "pooled_worker";
}
