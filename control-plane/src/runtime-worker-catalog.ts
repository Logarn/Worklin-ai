import type { Database } from "bun:sqlite";

import {
  ensureRuntimeStackSchema,
  runtimeActorSigningKeyScope,
  type RuntimeStackRow,
} from "./runtime-stacks.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";

const CATALOG_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED";
const CATALOG_JSON_ENV = "WORKLIN_RUNTIME_WORKER_CATALOG_JSON";
const MAX_CATALOG_BYTES = 64 * 1_024;
const MAX_CATALOG_WORKERS = 1_000;
const POOL_ORGANIZATION_ID = "__worklin_runtime_worker_pool__";
const POOL_ASSISTANT_PREFIX = "__worklin_pooled_worker__:";

type EnvLike = Record<string, string | undefined>;

export interface PooledRuntimeWorkerCatalogEntry {
  workerId: string;
  gatewayUrl: string;
  serviceRef: string;
  capacity: {
    maxConcurrentLeases: 1;
  };
}

export interface PooledRuntimeWorkerCatalogConfig {
  enabled: boolean;
  workers: readonly PooledRuntimeWorkerCatalogEntry[];
}

export interface PooledRuntimeWorkerCatalogRegistration {
  status: "disabled" | "registered";
  workerIds: readonly string[];
  insertedWorkerIds: readonly string[];
  updatedWorkerIds: readonly string[];
  unchangedWorkerIds: readonly string[];
  totalMaxConcurrentLeases: number;
}

interface RuntimeStackLeaseIdentity {
  assistant_id: string | null;
  org_id: string | null;
  lease_token: string | null;
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

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedKeys = new Set(expected);
  const unexpected = Object.keys(record).filter(
    (key) => !expectedKeys.has(key),
  );
  const missing = expected.filter((key) => !Object.hasOwn(record, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
}

function opaqueId(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
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

function isServiceDnsName(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  );
}

function isPrivateServiceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    isPrivateIpv4(normalized) ||
    isPrivateIpv6(normalized) ||
    (isServiceDnsName(normalized) &&
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

function privateGatewayUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim()
  ) {
    throw new Error("Pooled worker gatewayUrl is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pooled worker gatewayUrl is invalid.");
  }
  if (
    !isAllowedPrivateServiceProtocol(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !isPrivateServiceHostname(url.hostname)
  ) {
    throw new Error(
      "Pooled worker gatewayUrl must be a private service origin using HTTPS or Railway-internal HTTP.",
    );
  }
  return url.origin;
}

function normalizeWorkerEntries(
  rawWorkers: unknown,
): PooledRuntimeWorkerCatalogEntry[] {
  if (!Array.isArray(rawWorkers)) {
    throw new Error(`${CATALOG_JSON_ENV} must be a JSON array.`);
  }
  if (rawWorkers.length === 0 || rawWorkers.length > MAX_CATALOG_WORKERS) {
    throw new Error(
      `${CATALOG_JSON_ENV} must contain between 1 and ${MAX_CATALOG_WORKERS} workers.`,
    );
  }

  const workers: PooledRuntimeWorkerCatalogEntry[] = [];
  const workerIds = new Set<string>();
  const gatewayUrls = new Set<string>();
  const serviceRefs = new Set<string>();
  for (const rawWorker of rawWorkers) {
    if (
      !rawWorker ||
      typeof rawWorker !== "object" ||
      Array.isArray(rawWorker)
    ) {
      throw new Error("Each pooled worker catalog entry must be an object.");
    }
    const record = rawWorker as Record<string, unknown>;
    assertExactKeys(
      record,
      ["workerId", "gatewayUrl", "serviceRef", "capacity"],
      "Pooled worker catalog entry",
    );
    const workerId = opaqueId(record.workerId, "Pooled worker workerId", 128);
    const gatewayUrl = privateGatewayUrl(record.gatewayUrl);
    const serviceRef = opaqueId(
      record.serviceRef,
      "Pooled worker serviceRef",
      256,
    );
    if (
      !record.capacity ||
      typeof record.capacity !== "object" ||
      Array.isArray(record.capacity)
    ) {
      throw new Error("Pooled worker capacity metadata is invalid.");
    }
    const capacity = record.capacity as Record<string, unknown>;
    assertExactKeys(
      capacity,
      ["maxConcurrentLeases"],
      "Pooled worker capacity",
    );
    if (capacity.maxConcurrentLeases !== 1) {
      throw new Error("Pooled worker maxConcurrentLeases must be exactly 1.");
    }
    if (workerIds.has(workerId)) {
      throw new Error("Pooled worker workerIds must be unique.");
    }
    if (gatewayUrls.has(gatewayUrl)) {
      throw new Error("Pooled worker gatewayUrls must be unique.");
    }
    if (serviceRefs.has(serviceRef)) {
      throw new Error("Pooled worker serviceRefs must be unique.");
    }
    workerIds.add(workerId);
    gatewayUrls.add(gatewayUrl);
    serviceRefs.add(serviceRef);
    workers.push(
      Object.freeze({
        workerId,
        gatewayUrl,
        serviceRef,
        capacity: Object.freeze({ maxConcurrentLeases: 1 as const }),
      }),
    );
  }
  return workers;
}

export function pooledRuntimeWorkerCatalogConfigFromServerEnv(
  rawEnv: EnvLike,
): PooledRuntimeWorkerCatalogConfig {
  const enabled = strictBooleanEnv(
    CATALOG_ENABLE_ENV,
    rawEnv[CATALOG_ENABLE_ENV],
  );
  const rawCatalog = rawEnv[CATALOG_JSON_ENV];
  if (!enabled) {
    if (rawCatalog !== undefined && rawCatalog.trim() !== "") {
      throw new Error(
        `${CATALOG_JSON_ENV} requires ${CATALOG_ENABLE_ENV}=true.`,
      );
    }
    return Object.freeze({
      enabled: false,
      workers: Object.freeze([]),
    });
  }
  if (!rawCatalog || rawCatalog.length > MAX_CATALOG_BYTES) {
    throw new Error(
      `${CATALOG_JSON_ENV} is required and must not exceed ${MAX_CATALOG_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCatalog);
  } catch {
    throw new Error(`${CATALOG_JSON_ENV} must be valid JSON.`);
  }
  return Object.freeze({
    enabled: true,
    workers: Object.freeze(normalizeWorkerEntries(parsed)),
  });
}

function poolAssistantId(workerId: string): string {
  return `${POOL_ASSISTANT_PREFIX}${workerId}`;
}

function existingGatewayOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function assertNoExistingIdentityCollision(
  rows: readonly RuntimeStackRow[],
  worker: PooledRuntimeWorkerCatalogEntry,
): RuntimeStackRow | null {
  const current = rows.find((row) => row.id === worker.workerId) ?? null;
  if (current && current.provider !== RUNTIME_WORKER_POOL_PROVIDER) {
    throw new Error(
      `Runtime stack ${worker.workerId} belongs to provider ${current.provider}.`,
    );
  }
  const assistantId = poolAssistantId(worker.workerId);
  const collision = rows.find(
    (row) =>
      row.id !== worker.workerId &&
      (row.assistant_id === assistantId ||
        existingGatewayOrigin(row.gateway_url) === worker.gatewayUrl ||
        row.service_ref === worker.serviceRef),
  );
  if (collision) {
    throw new Error(
      `Pooled worker ${worker.workerId} collides with runtime stack ${collision.id}.`,
    );
  }
  return current;
}

function pooledStackNeedsUpdate(
  current: RuntimeStackRow,
  worker: PooledRuntimeWorkerCatalogEntry,
): boolean {
  return (
    current.status !== "active" ||
    current.gateway_url !== worker.gatewayUrl ||
    current.public_ingress_url !== null ||
    current.workspace_volume_ref !== null ||
    current.service_ref !== worker.serviceRef ||
    current.service_capacity_reserved !== 0 ||
    current.service_create_attempted_at !== null ||
    current.volume_create_attempted_at !== null ||
    current.provisioning_lease_token !== null ||
    current.provisioning_lease_expires_at !== null ||
    current.actor_signing_key_scope !==
      runtimeActorSigningKeyScope(worker.workerId)
  );
}

function assertWorkerIsUnassigned(db: Database, workerId: string): void {
  const lease = db
    .query<RuntimeStackLeaseIdentity, [string]>(
      `SELECT assistant_id, org_id, lease_token
       FROM runtime_worker_leases
       WHERE runtime_stack_id = ?`,
    )
    .get(workerId);
  if (lease?.assistant_id || lease?.org_id || lease?.lease_token) {
    throw new Error(
      `Pooled worker ${workerId} cannot be changed while assigned.`,
    );
  }
}

function registrationTimestamp(nowIso: () => string): string {
  const value = nowIso();
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Pooled worker registration timestamp is invalid.");
  }
  return value;
}

export function registerPooledRuntimeWorkerCatalog(
  db: Database,
  config: PooledRuntimeWorkerCatalogConfig,
  nowIso: () => string,
): PooledRuntimeWorkerCatalogRegistration {
  if (!config.enabled) {
    if (config.workers.length !== 0) {
      throw new Error("Disabled pooled worker catalog must be empty.");
    }
    return Object.freeze({
      status: "disabled",
      workerIds: Object.freeze([]),
      insertedWorkerIds: Object.freeze([]),
      updatedWorkerIds: Object.freeze([]),
      unchangedWorkerIds: Object.freeze([]),
      totalMaxConcurrentLeases: 0,
    });
  }

  const workers = normalizeWorkerEntries(config.workers);
  ensureRuntimeStackSchema(db);
  return db
    .transaction((): PooledRuntimeWorkerCatalogRegistration => {
      const rows = db
        .query<RuntimeStackRow, []>("SELECT * FROM runtime_stacks")
        .all();
      const currentByWorker = new Map<string, RuntimeStackRow | null>();
      for (const worker of workers) {
        const current = assertNoExistingIdentityCollision(rows, worker);
        currentByWorker.set(worker.workerId, current);
        if (current && pooledStackNeedsUpdate(current, worker)) {
          assertWorkerIsUnassigned(db, worker.workerId);
        }
      }

      const timestamp = registrationTimestamp(nowIso);
      const insertedWorkerIds: string[] = [];
      const updatedWorkerIds: string[] = [];
      const unchangedWorkerIds: string[] = [];
      for (const worker of workers) {
        const current = currentByWorker.get(worker.workerId) ?? null;
        if (!current) {
          db.query(
            `INSERT INTO runtime_stacks (
               id,
               org_id,
               assistant_id,
               status,
               provider,
               gateway_url,
               public_ingress_url,
               workspace_volume_ref,
               service_ref,
               service_capacity_reserved,
               service_create_attempted_at,
               volume_create_attempted_at,
               provisioning_lease_token,
               provisioning_lease_expires_at,
               actor_signing_key_scope,
               last_health_status,
               last_error,
               created_at,
               updated_at
             ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, 0, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`,
          ).run(
            worker.workerId,
            POOL_ORGANIZATION_ID,
            poolAssistantId(worker.workerId),
            RUNTIME_WORKER_POOL_PROVIDER,
            worker.gatewayUrl,
            worker.serviceRef,
            runtimeActorSigningKeyScope(worker.workerId),
            timestamp,
            timestamp,
          );
          insertedWorkerIds.push(worker.workerId);
          continue;
        }
        if (!pooledStackNeedsUpdate(current, worker)) {
          unchangedWorkerIds.push(worker.workerId);
          continue;
        }
        const result = db
          .query(
            `UPDATE runtime_stacks
             SET status = 'active',
                 gateway_url = ?,
                 public_ingress_url = NULL,
                 workspace_volume_ref = NULL,
                 service_ref = ?,
                 service_capacity_reserved = 0,
                 service_create_attempted_at = NULL,
                 volume_create_attempted_at = NULL,
                 provisioning_lease_token = NULL,
                 provisioning_lease_expires_at = NULL,
                 actor_signing_key_scope = ?,
                 last_health_status = NULL,
                 last_error = NULL,
                 updated_at = ?
             WHERE id = ?
               AND provider = ?`,
          )
          .run(
            worker.gatewayUrl,
            worker.serviceRef,
            runtimeActorSigningKeyScope(worker.workerId),
            timestamp,
            worker.workerId,
            RUNTIME_WORKER_POOL_PROVIDER,
          );
        if (result.changes !== 1) {
          throw new Error(
            `Pooled worker ${worker.workerId} changed during registration.`,
          );
        }
        updatedWorkerIds.push(worker.workerId);
      }

      return Object.freeze({
        status: "registered",
        workerIds: Object.freeze(workers.map(({ workerId }) => workerId)),
        insertedWorkerIds: Object.freeze(insertedWorkerIds),
        updatedWorkerIds: Object.freeze(updatedWorkerIds),
        unchangedWorkerIds: Object.freeze(unchangedWorkerIds),
        totalMaxConcurrentLeases: workers.length,
      });
    })
    .immediate();
}
