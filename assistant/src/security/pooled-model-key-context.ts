import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

import {
  getRuntimeWorkerStackId,
  isPooledWorkerRuntime,
} from "../config/env.js";
import type { AuthContext } from "../runtime/auth/types.js";

const CONTROL_PLANE_URL_ENV = "WORKLIN_CONTROL_PLANE_INTERNAL_URL";
const CAPABILITY_HEADER = "x-worklin-pooled-model-key-capability";
const RESOLVE_PATH = "/internal/v1/runtime-workers/model-provider-key";
const MAX_CAPABILITY_LENGTH = 8_192;
const MAX_RESPONSE_BYTES = 70 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export const POOLED_MODEL_KEY_PROVIDERS = Object.freeze([
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openai-compatible",
  "openrouter",
] as const);

export type PooledModelKeyProvider =
  (typeof POOLED_MODEL_KEY_PROVIDERS)[number];

const PROVIDER_SET = new Set<string>(POOLED_MODEL_KEY_PROVIDERS);

interface PooledModelKeyRequestContext {
  active: boolean;
  capability: string | null;
  workerStackId: string;
  leaseGeneration: number;
  inFlightLookups: Set<AbortController>;
}

export type PooledModelKeyLookup =
  | { handled: false }
  | {
      handled: true;
      value: string | undefined;
      unreachable: boolean;
    };

export type PooledModelKeyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PooledModelKeyLookupOptions {
  fetch?: PooledModelKeyFetch;
  controlPlaneUrl?: string;
}

const requestContext = new AsyncLocalStorage<PooledModelKeyRequestContext>();

function releaseRequestContext(scope: PooledModelKeyRequestContext): void {
  if (!scope.active) return;
  scope.active = false;
  scope.capability = null;
  for (const controller of scope.inFlightLookups) {
    if (!controller.signal.aborted) {
      controller.abort(
        new Error("Pooled model key request authority has been released."),
      );
    }
  }
  scope.inFlightLookups.clear();
}

function requestContextIsCurrent(
  scope: PooledModelKeyRequestContext | undefined,
  expected: {
    capability: string;
    workerStackId: string;
    leaseGeneration: number;
  },
): scope is PooledModelKeyRequestContext {
  return Boolean(
    scope?.active &&
    scope.capability === expected.capability &&
    scope.workerStackId === expected.workerStackId &&
    scope.workerStackId === getRuntimeWorkerStackId() &&
    scope.leaseGeneration === expected.leaseGeneration &&
    scope.leaseGeneration >= 1,
  );
}

function responseWithRequestContextRelease(
  response: Response,
  scope: PooledModelKeyRequestContext,
): Response {
  if (!response.body) {
    releaseRequestContext(scope);
    return response;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    releaseRequestContext(scope);
    throw error;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    releaseRequestContext(scope);
  };
  void reader.closed.then(finish, finish);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function canonicalProvider(value: unknown): PooledModelKeyProvider | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !PROVIDER_SET.has(value)
  ) {
    return null;
  }
  return value as PooledModelKeyProvider;
}

function providerFromAccount(account: string): PooledModelKeyProvider | null {
  const match = /^credential\/([^/]+)\/api_key$/u.exec(account);
  return canonicalProvider(match?.[1]);
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const first = Number(normalized.split(".")[0]);
  return first === 127;
}

function isPrivateIp(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  if (isIP(normalized) === 6) {
    return /^(?:fc|fd)[0-9a-f]{2}:/u.test(normalized);
  }
  return false;
}

function isRailwayInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (!normalized.endsWith(".railway.internal")) return false;
  const prefix = normalized.slice(0, -".railway.internal".length);
  return (
    prefix.length > 0 &&
    prefix
      .split(".")
      .every((label) =>
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u.test(label),
      )
  );
}

/**
 * Validate the private control-plane origin used by pooled workers.
 *
 * Plain HTTP is permitted only for an explicitly-ported Railway private
 * service or loopback tests. HTTPS is still restricted to private hosts so a
 * deployment typo cannot send a request capability to an arbitrary origin.
 */
export function validatePooledModelKeyControlPlaneUrl(raw: string): URL {
  if (!raw || raw !== raw.trim()) {
    throw new Error(`${CONTROL_PLANE_URL_ENV} must be a private origin.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${CONTROL_PLANE_URL_ENV} must be a valid absolute URL.`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${CONTROL_PLANE_URL_ENV} must contain only a private origin.`,
    );
  }

  const loopback = isLoopbackHostname(url.hostname);
  const railway = isRailwayInternalHostname(url.hostname);
  const privateIp = isPrivateIp(url.hostname);
  if (url.protocol === "http:") {
    if (!(loopback || (railway && url.port.length > 0))) {
      throw new Error(
        `${CONTROL_PLANE_URL_ENV} plain HTTP is restricted to loopback or an explicitly-ported Railway private service.`,
      );
    }
  } else if (url.protocol === "https:") {
    if (!(loopback || railway || privateIp)) {
      throw new Error(`${CONTROL_PLANE_URL_ENV} must use a private host.`);
    }
  } else {
    throw new Error(`${CONTROL_PLANE_URL_ENV} must use HTTP or HTTPS.`);
  }
  return new URL(url.origin);
}

export function assertPooledModelKeyRuntimeConfiguration(): void {
  if (!isPooledWorkerRuntime()) return;
  validatePooledModelKeyControlPlaneUrl(
    process.env[CONTROL_PLANE_URL_ENV] ?? "",
  );
}

function sanitizedRequest(req: Request): Request {
  if (!req.headers.has(CAPABILITY_HEADER)) return req;
  const clone = req.clone();
  clone.headers.delete(CAPABILITY_HEADER);
  return clone;
}

function identityMatches(authContext: AuthContext): boolean {
  const lease = authContext.pooledWorkerLease;
  if (!lease) return false;
  const actor = authContext.tenantContext;
  if (
    actor &&
    (actor.organizationId !== lease.organizationId ||
      actor.userId !== lease.userId ||
      actor.assistantId !== lease.assistantId)
  ) {
    return false;
  }
  const service = authContext.serviceTenantContext;
  if (
    service &&
    (service.assistantId !== lease.assistantId ||
      (service.organizationId !== undefined &&
        service.organizationId !== lease.organizationId))
  ) {
    return false;
  }
  return Boolean(actor || service);
}

/**
 * Make the control-plane capability available only to work started by the
 * authenticated pooled HTTP request. The route handler receives a cloned
 * Request with the private header removed.
 */
export async function runWithPooledModelKeyRequestContext<T>(
  req: Request,
  authContext: AuthContext,
  handler: (sanitized: Request) => Promise<T> | T,
): Promise<T> {
  const sanitized = sanitizedRequest(req);
  if (!isPooledWorkerRuntime()) return handler(sanitized);

  const lease = authContext.pooledWorkerLease;
  const runtimeWorkerStackId = getRuntimeWorkerStackId();
  const rawCapability = req.headers.get(CAPABILITY_HEADER);
  const validCapability =
    typeof rawCapability === "string" &&
    rawCapability.length > 0 &&
    rawCapability.length <= MAX_CAPABILITY_LENGTH &&
    rawCapability === rawCapability.trim()
      ? rawCapability
      : null;
  const validBinding =
    lease !== undefined &&
    runtimeWorkerStackId.length > 0 &&
    lease.workerStackId === runtimeWorkerStackId &&
    identityMatches(authContext);

  const scope: PooledModelKeyRequestContext = {
    active: true,
    capability: validBinding ? validCapability : null,
    workerStackId: validBinding ? lease.workerStackId : "",
    leaseGeneration: validBinding ? lease.leaseGeneration : 0,
    inFlightLookups: new Set(),
  };
  try {
    const result = await requestContext.run(scope, () => handler(sanitized));
    if (result instanceof Response) {
      return responseWithRequestContextRelease(result, scope) as T;
    }
    releaseRequestContext(scope);
    return result;
  } catch (error) {
    releaseRequestContext(scope);
    throw error;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Pooled model key response exceeded its size limit.");
  }
  if (!response.body) return null;
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
        throw new Error("Pooled model key response exceeded its size limit.");
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function resolveProviderKey(
  provider: PooledModelKeyProvider,
  options: PooledModelKeyLookupOptions,
): Promise<PooledModelKeyLookup> {
  const scope = requestContext.getStore();
  const expected = {
    capability: scope?.capability ?? "",
    workerStackId: scope?.workerStackId ?? "",
    leaseGeneration: scope?.leaseGeneration ?? 0,
  };
  if (!requestContextIsCurrent(scope, expected)) {
    return { handled: true, value: undefined, unreachable: true };
  }

  let origin: URL;
  try {
    origin = validatePooledModelKeyControlPlaneUrl(
      options.controlPlaneUrl ?? process.env[CONTROL_PLANE_URL_ENV] ?? "",
    );
  } catch {
    return { handled: true, value: undefined, unreachable: true };
  }
  const target = new URL(RESOLVE_PATH, origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  scope.inFlightLookups.add(controller);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${expected.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!requestContextIsCurrent(scope, expected)) {
      await response.body?.cancel().catch(() => {});
      return { handled: true, value: undefined, unreachable: true };
    }
    if (response.status === 404) {
      return { handled: true, value: undefined, unreachable: false };
    }
    if (!response.ok) {
      return { handled: true, value: undefined, unreachable: true };
    }
    const parsed = await boundedJson(response);
    if (!requestContextIsCurrent(scope, expected)) {
      return { handled: true, value: undefined, unreachable: true };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { handled: true, value: undefined, unreachable: true };
    }
    const value = (parsed as Record<string, unknown>).value;
    if (value === null) {
      return { handled: true, value: undefined, unreachable: false };
    }
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 65_536
    ) {
      return { handled: true, value: undefined, unreachable: true };
    }
    return { handled: true, value, unreachable: false };
  } catch {
    return { handled: true, value: undefined, unreachable: true };
  } finally {
    clearTimeout(timer);
    scope.inFlightLookups.delete(controller);
  }
}

export function resolvePooledModelProviderKey(
  providerInput: unknown,
  options: PooledModelKeyLookupOptions = {},
): Promise<PooledModelKeyLookup> {
  if (!isPooledWorkerRuntime()) {
    return Promise.resolve({ handled: false });
  }
  const provider = canonicalProvider(providerInput);
  if (!provider) {
    return Promise.resolve({
      handled: true,
      value: undefined,
      unreachable: false,
    });
  }
  return resolveProviderKey(provider, options);
}

export function resolvePooledModelProviderKeyForAccount(
  account: string,
  options: PooledModelKeyLookupOptions = {},
): Promise<PooledModelKeyLookup> {
  if (!isPooledWorkerRuntime()) {
    return Promise.resolve({ handled: false });
  }
  const provider = providerFromAccount(account);
  if (!provider) {
    return Promise.resolve({
      handled: true,
      value: undefined,
      unreachable: false,
    });
  }
  return resolveProviderKey(provider, options);
}
