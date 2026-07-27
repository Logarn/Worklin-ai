import type { Database } from "bun:sqlite";

import type {
  PooledRuntimeWorkerCatalogConfig,
  PooledRuntimeWorkerCatalogEntry,
} from "./runtime-worker-catalog.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";

type EnvLike = Record<string, string | undefined>;

const PROBE_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED";
const PROBE_TIMEOUT_ENV = "WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS";
const POOL_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_POOL_ENABLED";
const CATALOG_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_WORKERS_PER_PROBE = 1_000;

export interface RuntimeWorkerHealthProbeConfig {
  enabled: boolean;
  timeoutMs: number;
}

export interface RuntimeWorkerHealthProbeResult {
  status: "disabled" | "completed";
  registeredWorkerCount: number;
  probedWorkerCount: number;
  healthyWorkerCount: number;
  httpFailureCount: number;
  timeoutCount: number;
  fetchFailureCount: number;
  updatedWorkerCount: number;
  driftedWorkerCount: number;
}

export type RuntimeWorkerHealthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RuntimeWorkerHealthProbeDependencies {
  fetch?: RuntimeWorkerHealthFetch;
  nowIso?: () => string;
}

interface HealthObservation {
  kind: "healthy" | "http_failure" | "timeout" | "fetch_failure";
  healthStatus: string | null;
  errorCode: string | null;
}

function strictBooleanEnv(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace.`);
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean.`);
}

function timeoutEnv(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  if (value !== value.trim()) {
    throw new Error(
      `${PROBE_TIMEOUT_ENV} must not contain surrounding whitespace.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(
      `${PROBE_TIMEOUT_ENV} must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return parsed;
}

export function runtimeWorkerHealthProbeConfigFromServerEnv(
  rawEnv: EnvLike,
): RuntimeWorkerHealthProbeConfig {
  const enabled = strictBooleanEnv(PROBE_ENABLE_ENV, rawEnv[PROBE_ENABLE_ENV]);
  const configuredTimeout = rawEnv[PROBE_TIMEOUT_ENV];
  if (!enabled) {
    if (configuredTimeout !== undefined && configuredTimeout !== "") {
      throw new Error(
        `${PROBE_TIMEOUT_ENV} requires ${PROBE_ENABLE_ENV}=true.`,
      );
    }
    return Object.freeze({
      enabled: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }
  if (!strictBooleanEnv(POOL_ENABLE_ENV, rawEnv[POOL_ENABLE_ENV])) {
    throw new Error(`${PROBE_ENABLE_ENV} requires ${POOL_ENABLE_ENV}=true.`);
  }
  if (!strictBooleanEnv(CATALOG_ENABLE_ENV, rawEnv[CATALOG_ENABLE_ENV])) {
    throw new Error(`${PROBE_ENABLE_ENV} requires ${CATALOG_ENABLE_ENV}=true.`);
  }
  return Object.freeze({
    enabled: true,
    timeoutMs: timeoutEnv(configuredTimeout),
  });
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const firstHextet = unwrapped.split(":", 1)[0]?.toLowerCase() ?? "";
  return /^f[cd][0-9a-f]{2}$/u.test(firstHextet);
}

function isPrivateServiceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const labels = normalized.split(".");
  const isServiceName =
    normalized.length <= 253 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
  return (
    isPrivateIpv4(normalized) ||
    isPrivateIpv6(normalized) ||
    (isServiceName &&
      (normalized.endsWith(".internal") ||
        normalized.endsWith(".svc") ||
        normalized.endsWith(".svc.cluster.local")))
  );
}

function isAllowedPrivateServiceProtocol(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    url.hostname.toLowerCase().endsWith(".railway.internal")
  );
}

function assertPrivateGatewayOrigin(gatewayUrl: string): void {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new Error("Pooled worker health origin is invalid.");
  }
  if (
    gatewayUrl !== url.origin ||
    !isAllowedPrivateServiceProtocol(url) ||
    url.username ||
    url.password ||
    !isPrivateServiceHostname(url.hostname)
  ) {
    throw new Error(
      "Pooled worker health origin must be an exact private service origin using HTTPS or Railway-internal HTTP.",
    );
  }
}

function assertCatalogWorkers(
  catalog: PooledRuntimeWorkerCatalogConfig,
): readonly PooledRuntimeWorkerCatalogEntry[] {
  if (!catalog.enabled) {
    throw new Error("Pooled worker health probe requires an enabled catalog.");
  }
  if (
    catalog.workers.length === 0 ||
    catalog.workers.length > MAX_WORKERS_PER_PROBE
  ) {
    throw new Error(
      `Pooled worker health probe requires between 1 and ${MAX_WORKERS_PER_PROBE} workers.`,
    );
  }
  const workerIds = new Set<string>();
  const gatewayUrls = new Set<string>();
  const serviceRefs = new Set<string>();
  for (const worker of catalog.workers) {
    if (
      !worker.workerId ||
      worker.workerId !== worker.workerId.trim() ||
      !worker.serviceRef ||
      worker.serviceRef !== worker.serviceRef.trim() ||
      worker.capacity.maxConcurrentLeases !== 1
    ) {
      throw new Error("Pooled worker health catalog entry is invalid.");
    }
    assertPrivateGatewayOrigin(worker.gatewayUrl);
    if (
      workerIds.has(worker.workerId) ||
      gatewayUrls.has(worker.gatewayUrl) ||
      serviceRefs.has(worker.serviceRef)
    ) {
      throw new Error(
        "Pooled worker health catalog identities must be unique.",
      );
    }
    workerIds.add(worker.workerId);
    gatewayUrls.add(worker.gatewayUrl);
    serviceRefs.add(worker.serviceRef);
  }
  return catalog.workers;
}

function timestamp(nowIso: () => string): string {
  const value = nowIso();
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Pooled worker health timestamp is invalid.");
  }
  return value;
}

function disabledResult(): RuntimeWorkerHealthProbeResult {
  return Object.freeze({
    status: "disabled",
    registeredWorkerCount: 0,
    probedWorkerCount: 0,
    healthyWorkerCount: 0,
    httpFailureCount: 0,
    timeoutCount: 0,
    fetchFailureCount: 0,
    updatedWorkerCount: 0,
    driftedWorkerCount: 0,
  });
}

async function observeWorkerHealth(
  worker: PooledRuntimeWorkerCatalogEntry,
  config: RuntimeWorkerHealthProbeConfig,
  fetchImpl: RuntimeWorkerHealthFetch,
): Promise<HealthObservation> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetchImpl(`${worker.gatewayUrl}/readyz`, {
      method: "GET",
      redirect: "error",
      signal,
    });
    const healthStatus = String(response.status);
    if (response.status >= 200 && response.status < 300) {
      return {
        kind: "healthy",
        healthStatus,
        errorCode: null,
      };
    }
    return {
      kind: "http_failure",
      healthStatus,
      errorCode: `health_http_${healthStatus}`,
    };
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      return {
        kind: "timeout",
        healthStatus: null,
        errorCode: "health_probe_timeout",
      };
    }
    return {
      kind: "fetch_failure",
      healthStatus: null,
      errorCode: "health_probe_fetch_failed",
    };
  }
}

export async function probePooledRuntimeWorkerCatalog(
  db: Database,
  config: RuntimeWorkerHealthProbeConfig,
  catalog: PooledRuntimeWorkerCatalogConfig,
  dependencies: RuntimeWorkerHealthProbeDependencies = {},
): Promise<RuntimeWorkerHealthProbeResult> {
  if (!config.enabled) return disabledResult();
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("Pooled worker health timeout is invalid.");
  }
  const workers = assertCatalogWorkers(catalog);
  const fetchImpl: RuntimeWorkerHealthFetch = dependencies.fetch ?? fetch;
  const settled = await Promise.allSettled(
    workers.map((worker) => observeWorkerHealth(worker, config, fetchImpl)),
  );
  const observations = settled.map((result): HealthObservation =>
    result.status === "fulfilled"
      ? result.value
      : {
          kind: "fetch_failure",
          healthStatus: null,
          errorCode: "health_probe_fetch_failed",
        },
  );
  const updatedAt = timestamp(
    dependencies.nowIso ?? (() => new Date().toISOString()),
  );

  let healthyWorkerCount = 0;
  let httpFailureCount = 0;
  let timeoutCount = 0;
  let fetchFailureCount = 0;
  let updatedWorkerCount = 0;
  let driftedWorkerCount = 0;

  for (let index = 0; index < workers.length; index += 1) {
    const worker = workers[index]!;
    const observation = observations[index]!;
    if (observation.kind === "healthy") healthyWorkerCount += 1;
    if (observation.kind === "http_failure") httpFailureCount += 1;
    if (observation.kind === "timeout") timeoutCount += 1;
    if (observation.kind === "fetch_failure") fetchFailureCount += 1;

    const result = db
      .query(
        `UPDATE runtime_stacks
         SET last_health_status = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?
           AND provider = ?
           AND gateway_url = ?
           AND service_ref = ?`,
      )
      .run(
        observation.healthStatus,
        observation.errorCode,
        updatedAt,
        worker.workerId,
        RUNTIME_WORKER_POOL_PROVIDER,
        worker.gatewayUrl,
        worker.serviceRef,
      );
    if (result.changes === 1) {
      updatedWorkerCount += 1;
    } else {
      driftedWorkerCount += 1;
    }
  }

  return Object.freeze({
    status: "completed",
    registeredWorkerCount: workers.length,
    probedWorkerCount: workers.length,
    healthyWorkerCount,
    httpFailureCount,
    timeoutCount,
    fetchFailureCount,
    updatedWorkerCount,
    driftedWorkerCount,
  });
}
