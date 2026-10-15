import { getConcurrentProviderConfig } from "../providers/platform-proxy/concurrent-provider-config.js";
import type { ConcurrentProviderRequestConfig } from "../providers/platform-proxy/concurrent-request-context.js";
import { validateModelKeyControlPlaneUrl } from "../security/pooled-model-key-context.js";

export const CONCURRENT_MODEL_KEY_CAPABILITY_HEADER =
  "x-worklin-concurrent-model-key-capability";
export const CONCURRENT_MODEL_KEY_PROVIDER_HEADER =
  "x-worklin-concurrent-model-provider";
const RESOLVE_PATH = "/internal/v1/concurrent-runtime/model-provider-key";
const MAX_CAPABILITY_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 70 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export type ConcurrentModelKeyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ConcurrentModelKeyResolutionError extends Error {
  constructor(readonly code: "key_missing" | "unavailable") {
    super(
      code === "key_missing"
        ? "Reconnect your model API key, then try again."
        : "Your model provider could not be reached. Try again shortly.",
    );
    this.name = "ConcurrentModelKeyResolutionError";
  }
}

export async function resolveConcurrentProviderConfig(
  providerId: string,
  capability: string | null,
  resolveModelKey: (
    capability: string | null,
    provider: string,
  ) => Promise<string | null> = resolveConcurrentModelKey,
): Promise<ConcurrentProviderRequestConfig> {
  const provider = getConcurrentProviderConfig(providerId);
  if (!provider) throw new ConcurrentModelKeyResolutionError("key_missing");

  let key: string | null;
  try {
    key = await resolveModelKey(capability, provider.provider);
  } catch {
    throw new ConcurrentModelKeyResolutionError("unavailable");
  }
  if (!key) throw new ConcurrentModelKeyResolutionError("key_missing");
  return { ...provider, key };
}

export async function resolveConcurrentModelKey(
  capability: string | null,
  provider: string,
  options: {
    fetch?: ConcurrentModelKeyFetch;
    controlPlaneUrl?: string;
  } = {},
): Promise<string | null> {
  if (
    !capability ||
    capability !== capability.trim() ||
    capability.length > MAX_CAPABILITY_LENGTH ||
    !getConcurrentProviderConfig(provider)
  ) {
    throw new Error("Concurrent model key capability is invalid.");
  }
  const origin = validateModelKeyControlPlaneUrl(
    options.controlPlaneUrl ??
      process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL ??
      "",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL(RESOLVE_PATH, origin),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${capability}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider }),
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Concurrent model key service is unavailable.");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) ||
        Number(declaredLength) > MAX_RESPONSE_BYTES)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Concurrent model key response exceeded its size limit.");
    }
    if (!response.body) {
      throw new Error("Concurrent model key response is empty.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(
            "Concurrent model key response exceeded its size limit.",
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Concurrent model key response is invalid.");
    }
    const value = (parsed as Record<string, unknown>).value;
    if (value === null) return null;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 65_536
    ) {
      throw new Error("Concurrent model key response is invalid.");
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}
