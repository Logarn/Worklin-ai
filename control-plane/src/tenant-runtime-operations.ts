import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";

import type { RuntimeWorkerCapacityTelemetry } from "./runtime-worker-dispatcher.js";
import type { TenantRuntimeIdentity } from "./tenant-runtime-admission.js";

type EnvLike = Record<string, string | undefined>;

export interface TenantRuntimeOperationsConfig {
  enabled: boolean;
  storageQuotaEnforcementEnabled: boolean;
  defaultStorageQuotaBytes: number;
  storageObservationMaxAgeMs: number;
  storageReservationTtlMs: number;
  usageMetricsEnabled: boolean;
  usageBucketMs: number;
  idleSuspensionEnabled: boolean;
  idleAfterMs: number;
  capacityAlertsEnabled: boolean;
  minimumAvailableWorkerCapacity: number;
  capacityAlertDedupWindowMs: number;
}

export type TenantStorageObservationSource =
  | "runtime_workspace_scan"
  | "runtime_state_export";

export interface TrustedTenantStorageObservation {
  observationId: string;
  workerStackId: string;
  leaseToken: string;
  settledReservationToken?: string;
  source: TenantStorageObservationSource;
  observedBytes: number;
  observedAtMs: number;
}

export type TenantStorageObservationResult =
  | { status: "bypassed" }
  | {
      status: "recorded";
      replayed: boolean;
      observedBytes: number;
      quotaBytes: number;
      withinQuota: boolean;
    }
  | {
      status: "rejected";
      reason:
        | "invalid_tenant"
        | "invalid_observation"
        | "untrusted_observation"
        | "observation_conflict";
    };

export type TenantStorageOperation =
  | { effect: "non_increasing" }
  | {
      effect: "may_increase";
      reservationToken: string;
      requestedBytes: number;
    };

export type TenantStorageGuardResult =
  | { status: "bypassed" }
  | { status: "allowed"; reservationExpiresAt?: number }
  | {
      status: "rejected";
      reason:
        | "invalid_tenant"
        | "invalid_request"
        | "storage_observation_missing"
        | "storage_observation_stale"
        | "storage_quota_exceeded"
        | "reservation_token_replay";
      retryAfterMs: number | null;
    };

export type TenantRuntimeUsageMetric =
  | "request_count"
  | "turn_count"
  | "stream_ms"
  | "worker_ms";

export interface TenantRuntimeUsageEvent {
  eventId: string;
  metric: TenantRuntimeUsageMetric;
  value: number;
  observedAtMs: number;
}

export interface TenantRuntimeUsageBucket {
  bucketStartedAt: number;
  requestCount: number;
  turnCount: number;
  streamMs: number;
  workerMs: number;
  sampleCount: number;
}

export type TenantRuntimeUsageResult =
  | { status: "bypassed" }
  | { status: "recorded"; replayed: boolean }
  | {
      status: "rejected";
      reason: "invalid_tenant" | "invalid_event" | "event_conflict";
    };

export type TenantIdleSuspensionEvaluation =
  | { status: "bypassed" }
  | { status: "rejected"; reason: "invalid_tenant" }
  | {
      status: "blocked";
      reason:
        | "activity_unknown"
        | "activity_in_future"
        | "admission_telemetry_unavailable"
        | "worker_telemetry_unavailable"
        | "active_request"
        | "active_worker_lease"
        | "active_storage_reservation";
    }
  | { status: "not_idle"; eligibleAt: number }
  | { status: "candidate"; lastActivityAt: number; eligibleAt: number };

export interface TenantIdleSuspensionAction {
  actionId: string;
  status: "pending" | "cancelled";
  lastActivityAt: number;
  eligibleAt: number;
  createdAt: string;
  cancelledAt: string | null;
}

export type TenantIdleSuspensionPlanResult =
  | { status: "not_planned"; evaluation: TenantIdleSuspensionEvaluation }
  | {
      status: "planned";
      replayed: boolean;
      action: TenantIdleSuspensionAction;
    };

export type RuntimeCapacityAlertCode =
  | "pool_disabled"
  | "capacity_unavailable"
  | "unregistered_active_leases"
  | "sanitization_required"
  | "capacity_saturated"
  | "capacity_degraded"
  | "low_capacity";

/**
 * This payload intentionally contains only pool-level state and counts. It has
 * no tenant, worker, credential, storage-object, or customer-content fields.
 */
export interface RuntimeCapacityAlert {
  severity: "warning" | "critical";
  code: RuntimeCapacityAlertCode;
  observedAt: number;
  state: RuntimeWorkerCapacityTelemetry["state"];
  configuredWorkerCount: number;
  readyWorkerCount: number;
  unhealthyWorkerCount: number;
  missingWorkerCount: number;
  activeLeaseCount: number;
  unregisteredActiveLeaseCount: number;
  boundIdleWorkerCount: number;
  unboundReadyWorkerCount: number;
  maxConcurrentLeases: number;
  availableNewAssistantCapacity: number;
}

export type RuntimeCapacityAlertResult =
  | { status: "bypassed" }
  | { status: "healthy" }
  | { status: "alert"; persisted: boolean; alert: RuntimeCapacityAlert };

interface TenantStorageQuotaRow {
  quota_bytes: number;
}

interface TenantStorageObservationRow {
  observation_digest: string;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  worker_stack_id: string;
  settled_reservation_digest: string | null;
  source: TenantStorageObservationSource;
  observed_bytes: number;
  observed_at: number;
}

interface TenantActivityRow {
  last_activity_at: number;
}

interface IdleSuspensionActionRow {
  action_id: string;
  status: "pending" | "cancelled";
  last_activity_at: number;
  eligible_at: number;
  created_at: string;
  cancelled_at: string | null;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Boolean environment values must use true or false.");
}

function positiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function nonNegativeIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

export function tenantRuntimeOperationsConfigFromEnv(
  rawEnv: EnvLike,
): TenantRuntimeOperationsConfig {
  return {
    enabled: booleanEnv(
      rawEnv.WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED,
      false,
    ),
    storageQuotaEnforcementEnabled: booleanEnv(
      rawEnv.WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED,
      false,
    ),
    defaultStorageQuotaBytes: positiveIntegerEnv(
      "WORKLIN_TENANT_STORAGE_QUOTA_BYTES",
      rawEnv.WORKLIN_TENANT_STORAGE_QUOTA_BYTES,
      1024 * 1024 * 1024,
    ),
    storageObservationMaxAgeMs: positiveIntegerEnv(
      "WORKLIN_TENANT_STORAGE_OBSERVATION_MAX_AGE_MS",
      rawEnv.WORKLIN_TENANT_STORAGE_OBSERVATION_MAX_AGE_MS,
      15 * 60_000,
    ),
    storageReservationTtlMs: positiveIntegerEnv(
      "WORKLIN_TENANT_STORAGE_RESERVATION_TTL_MS",
      rawEnv.WORKLIN_TENANT_STORAGE_RESERVATION_TTL_MS,
      10 * 60_000,
    ),
    usageMetricsEnabled: booleanEnv(
      rawEnv.WORKLIN_TENANT_USAGE_METRICS_ENABLED,
      false,
    ),
    usageBucketMs: positiveIntegerEnv(
      "WORKLIN_TENANT_USAGE_BUCKET_MS",
      rawEnv.WORKLIN_TENANT_USAGE_BUCKET_MS,
      60 * 60_000,
    ),
    idleSuspensionEnabled: booleanEnv(
      rawEnv.WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED,
      false,
    ),
    idleAfterMs: positiveIntegerEnv(
      "WORKLIN_TENANT_IDLE_AFTER_MS",
      rawEnv.WORKLIN_TENANT_IDLE_AFTER_MS,
      30 * 60_000,
    ),
    capacityAlertsEnabled: booleanEnv(
      rawEnv.WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED,
      false,
    ),
    minimumAvailableWorkerCapacity: nonNegativeIntegerEnv(
      "WORKLIN_RUNTIME_MINIMUM_AVAILABLE_CAPACITY",
      rawEnv.WORKLIN_RUNTIME_MINIMUM_AVAILABLE_CAPACITY,
      1,
    ),
    capacityAlertDedupWindowMs: positiveIntegerEnv(
      "WORKLIN_RUNTIME_CAPACITY_ALERT_DEDUP_WINDOW_MS",
      rawEnv.WORKLIN_RUNTIME_CAPACITY_ALERT_DEDUP_WINDOW_MS,
      5 * 60_000,
    ),
  };
}

export function ensureTenantRuntimeOperationsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_runtime_storage_quotas (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, assistant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_runtime_storage_observations (
      observation_digest TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      worker_stack_id TEXT NOT NULL,
      settled_reservation_digest TEXT,
      source TEXT NOT NULL CHECK(source IN (
        'runtime_workspace_scan',
        'runtime_state_export'
      )),
      observed_bytes INTEGER NOT NULL CHECK(observed_bytes >= 0),
      observed_at INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_storage_observations_latest
      ON tenant_runtime_storage_observations(
        organization_id,
        user_id,
        assistant_id,
        observed_at DESC
      );

    CREATE TABLE IF NOT EXISTS tenant_runtime_storage_reservations (
      reservation_digest TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 0),
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      CHECK(expires_at > acquired_at)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_storage_reservations_active
      ON tenant_runtime_storage_reservations(
        organization_id,
        user_id,
        assistant_id,
        expires_at
      )
      WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS tenant_runtime_usage_events (
      event_digest TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      metric TEXT NOT NULL CHECK(metric IN (
        'request_count',
        'turn_count',
        'stream_ms',
        'worker_ms'
      )),
      metric_value INTEGER NOT NULL CHECK(metric_value > 0),
      observed_at INTEGER NOT NULL,
      bucket_started_at INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_runtime_usage_buckets (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      bucket_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
      turn_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_count >= 0),
      stream_ms INTEGER NOT NULL DEFAULT 0 CHECK(stream_ms >= 0),
      worker_ms INTEGER NOT NULL DEFAULT 0 CHECK(worker_ms >= 0),
      sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(
        organization_id,
        user_id,
        assistant_id,
        bucket_started_at
      )
    );

    CREATE TABLE IF NOT EXISTS tenant_runtime_activity (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      last_activity_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, assistant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_runtime_idle_suspension_actions (
      action_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'cancelled')),
      last_activity_at INTEGER NOT NULL,
      eligible_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      cancelled_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_idle_action_pending
      ON tenant_runtime_idle_suspension_actions(
        organization_id,
        assistant_id
      )
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS runtime_capacity_alerts (
      alert_digest TEXT PRIMARY KEY,
      severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
      code TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      configured_worker_count INTEGER NOT NULL,
      ready_worker_count INTEGER NOT NULL,
      unhealthy_worker_count INTEGER NOT NULL,
      missing_worker_count INTEGER NOT NULL,
      active_lease_count INTEGER NOT NULL,
      unregistered_active_lease_count INTEGER NOT NULL,
      bound_idle_worker_count INTEGER NOT NULL,
      unbound_ready_worker_count INTEGER NOT NULL,
      max_concurrent_leases INTEGER NOT NULL,
      available_new_assistant_capacity INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );
  `);
}

function isTenantIdentity(identity: TenantRuntimeIdentity): boolean {
  return (
    identity.organizationId.trim().length > 0 &&
    identity.userId.trim().length > 0 &&
    identity.assistantId.trim().length > 0
  );
}

function tenantExists(db: Database, identity: TenantRuntimeIdentity): boolean {
  if (!isTenantIdentity(identity)) return false;
  return Boolean(
    db
      .query<{ found: number }, [string, string, string, string]>(
        `SELECT 1 AS found
         FROM assistants AS assistant
         JOIN organizations AS organization
           ON organization.id = assistant.org_id
          AND organization.user_id = assistant.user_id
         WHERE assistant.id = ?
           AND assistant.org_id = ?
           AND assistant.user_id = ?
           AND organization.user_id = ?`,
      )
      .get(
        identity.assistantId,
        identity.organizationId,
        identity.userId,
        identity.userId,
      ),
  );
}

function tableExists(db: Database, tableName: string): boolean {
  return Boolean(
    db
      .query<{ found: number }, [string]>(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(tableName),
  );
}

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isStorageObservationSource(
  source: string,
): source is TenantStorageObservationSource {
  return (
    source === "runtime_workspace_scan" || source === "runtime_state_export"
  );
}

function isUsageMetric(metric: string): metric is TenantRuntimeUsageMetric {
  return (
    metric === "request_count" ||
    metric === "turn_count" ||
    metric === "stream_ms" ||
    metric === "worker_ms"
  );
}

function storageQuotaBytes(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
): number {
  return (
    db
      .query<TenantStorageQuotaRow, [string, string, string]>(
        `SELECT quota_bytes
         FROM tenant_runtime_storage_quotas
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?`,
      )
      .get(identity.organizationId, identity.userId, identity.assistantId)
      ?.quota_bytes ?? config.defaultStorageQuotaBytes
  );
}

export function getTenantRuntimeStorageQuotaBytes(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
): number | null {
  if (!config.enabled || !config.storageQuotaEnforcementEnabled) return null;
  if (!tenantExists(db, identity)) return null;
  const quotaBytes = storageQuotaBytes(db, config, identity);
  return isSafeNonNegativeInteger(quotaBytes) ? quotaBytes : null;
}

export function maximumTenantRuntimeStorageQuotaBytes(
  db: Database,
  config: TenantRuntimeOperationsConfig,
): number {
  if (!tableExists(db, "tenant_runtime_storage_quotas")) {
    return config.defaultStorageQuotaBytes;
  }
  const configured = db
    .query<{ quota_bytes: number | null }, []>(
      `SELECT MAX(quota_bytes) AS quota_bytes
       FROM tenant_runtime_storage_quotas`,
    )
    .get()?.quota_bytes;
  if (
    configured !== null &&
    configured !== undefined &&
    !isSafeNonNegativeInteger(configured)
  ) {
    throw new Error("Tenant runtime storage quota metadata is invalid.");
  }
  return Math.max(config.defaultStorageQuotaBytes, configured ?? 0);
}

export function setTenantRuntimeStorageQuota(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  quotaBytes: number,
  updatedBy: string,
  nowIso: () => string,
): "bypassed" | "updated" | "invalid_tenant" | "invalid_quota" {
  if (!config.enabled) return "bypassed";
  if (!tenantExists(db, identity)) return "invalid_tenant";
  if (!isSafeNonNegativeInteger(quotaBytes) || !updatedBy.trim()) {
    return "invalid_quota";
  }
  db.query(
    `INSERT INTO tenant_runtime_storage_quotas (
       organization_id,
       user_id,
       assistant_id,
       quota_bytes,
       updated_by,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, assistant_id) DO UPDATE SET
       user_id = excluded.user_id,
       quota_bytes = excluded.quota_bytes,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    identity.organizationId,
    identity.userId,
    identity.assistantId,
    quotaBytes,
    updatedBy.trim(),
    nowIso(),
  );
  return "updated";
}

function trustedWorkerLeaseExists(
  db: Database,
  identity: TenantRuntimeIdentity,
  observation: TrustedTenantStorageObservation,
  nowMs: number,
): boolean {
  if (!tableExists(db, "runtime_worker_leases")) return false;
  return Boolean(
    db
      .query<{ found: number }, [string, string, string, string, number]>(
        `SELECT 1 AS found
         FROM runtime_worker_leases
         WHERE runtime_stack_id = ?
           AND org_id = ?
           AND assistant_id = ?
           AND lease_token = ?
           AND released_at IS NULL
           AND lease_expires_at > ?`,
      )
      .get(
        observation.workerStackId,
        identity.organizationId,
        identity.assistantId,
        observation.leaseToken,
        nowMs,
      ),
  );
}

function latestStorageObservation(
  db: Database,
  identity: TenantRuntimeIdentity,
): TenantStorageObservationRow | null {
  return (
    db
      .query<TenantStorageObservationRow, [string, string, string]>(
        `SELECT
           observation_digest,
           organization_id,
           user_id,
           assistant_id,
           worker_stack_id,
           settled_reservation_digest,
           source,
           observed_bytes,
           observed_at
         FROM tenant_runtime_storage_observations
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?
         ORDER BY observed_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(identity.organizationId, identity.userId, identity.assistantId) ??
    null
  );
}

export function recordTrustedTenantStorageObservation(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  observation: TrustedTenantStorageObservation,
  nowMs: number,
  nowIso: () => string,
): TenantStorageObservationResult {
  if (!config.enabled || !config.storageQuotaEnforcementEnabled) {
    return { status: "bypassed" };
  }
  if (!tenantExists(db, identity)) {
    return { status: "rejected", reason: "invalid_tenant" };
  }
  if (
    !observation.observationId.trim() ||
    !observation.workerStackId.trim() ||
    !observation.leaseToken.trim() ||
    (observation.settledReservationToken !== undefined &&
      !observation.settledReservationToken.trim()) ||
    !isStorageObservationSource(observation.source) ||
    !isSafeNonNegativeInteger(observation.observedBytes) ||
    !isSafeNonNegativeInteger(observation.observedAtMs) ||
    observation.observedAtMs > nowMs
  ) {
    return { status: "rejected", reason: "invalid_observation" };
  }
  if (!trustedWorkerLeaseExists(db, identity, observation, nowMs)) {
    return { status: "rejected", reason: "untrusted_observation" };
  }

  const observationDigest = digest([
    "tenant-storage-observation-v1",
    identity.organizationId,
    identity.userId,
    identity.assistantId,
    observation.observationId,
  ]);
  const settledReservationDigest = observation.settledReservationToken
    ? digest([
        "tenant-storage-reservation-v1",
        observation.settledReservationToken,
      ])
    : null;
  return db
    .transaction((): TenantStorageObservationResult => {
      if (settledReservationDigest) {
        const reservation = db
          .query<
            {
              organization_id: string;
              user_id: string;
              assistant_id: string;
              acquired_at: number;
            },
            [string]
          >(
            `SELECT
               organization_id,
               user_id,
               assistant_id,
               acquired_at
             FROM tenant_runtime_storage_reservations
             WHERE reservation_digest = ?`,
          )
          .get(settledReservationDigest);
        if (
          !reservation ||
          reservation.organization_id !== identity.organizationId ||
          reservation.user_id !== identity.userId ||
          reservation.assistant_id !== identity.assistantId ||
          reservation.acquired_at > observation.observedAtMs
        ) {
          return { status: "rejected", reason: "untrusted_observation" };
        }
      }
      const existing = db
        .query<TenantStorageObservationRow, [string]>(
          `SELECT
             observation_digest,
             organization_id,
             user_id,
             assistant_id,
             worker_stack_id,
             settled_reservation_digest,
             source,
             observed_bytes,
             observed_at
           FROM tenant_runtime_storage_observations
           WHERE observation_digest = ?`,
        )
        .get(observationDigest);
      if (existing) {
        const matches =
          existing.organization_id === identity.organizationId &&
          existing.user_id === identity.userId &&
          existing.assistant_id === identity.assistantId &&
          existing.worker_stack_id === observation.workerStackId &&
          existing.settled_reservation_digest === settledReservationDigest &&
          existing.source === observation.source &&
          existing.observed_bytes === observation.observedBytes &&
          existing.observed_at === observation.observedAtMs;
        if (!matches) {
          return { status: "rejected", reason: "observation_conflict" };
        }
      } else {
        db.query(
          `INSERT INTO tenant_runtime_storage_observations (
             observation_digest,
             organization_id,
             user_id,
             assistant_id,
             worker_stack_id,
             settled_reservation_digest,
             source,
             observed_bytes,
             observed_at,
             recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          observationDigest,
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          observation.workerStackId,
          settledReservationDigest,
          observation.source,
          observation.observedBytes,
          observation.observedAtMs,
          nowIso(),
        );
      }

      if (settledReservationDigest) {
        // Preserve explicit settlement-token validation for callers that bind
        // a particular write to this measurement.
        db.query(
          `UPDATE tenant_runtime_storage_reservations
           SET released_at = COALESCE(released_at, ?)
           WHERE reservation_digest = ?
             AND organization_id = ?
             AND user_id = ?
             AND assistant_id = ?`,
        ).run(
          nowMs,
          settledReservationDigest,
          identity.organizationId,
          identity.userId,
          identity.assistantId,
        );
      }
      // Every accepted observation is a full trusted workspace measurement,
      // not a delta. It therefore reconciles every reservation acquired no
      // later than that measurement; keeping those reservations active would
      // double-count bytes already included in observed_bytes. Reservations
      // started after the measurement remain charged.
      db.query(
        `UPDATE tenant_runtime_storage_reservations
         SET released_at = COALESCE(released_at, ?)
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?
           AND acquired_at <= ?`,
      ).run(
        nowMs,
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        observation.observedAtMs,
      );

      const quotaBytes = storageQuotaBytes(db, config, identity);
      const observedBytes =
        existing?.observed_bytes ?? observation.observedBytes;
      return {
        status: "recorded",
        replayed: existing != null,
        observedBytes,
        quotaBytes,
        withinQuota: observedBytes <= quotaBytes,
      };
    })
    .immediate();
}

function activeStorageReservationBytes(
  db: Database,
  identity: TenantRuntimeIdentity,
): number {
  return (
    db
      .query<{ reserved_bytes: number }, [string, string, string]>(
        `SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes
         FROM tenant_runtime_storage_reservations
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?
           AND released_at IS NULL`,
      )
      .get(identity.organizationId, identity.userId, identity.assistantId)
      ?.reserved_bytes ?? 0
  );
}

export function guardTenantStorageOperation(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  operation: TenantStorageOperation,
  nowMs: number,
): TenantStorageGuardResult {
  if (!config.enabled || !config.storageQuotaEnforcementEnabled) {
    return { status: "bypassed" };
  }
  if (!tenantExists(db, identity)) {
    return {
      status: "rejected",
      reason: "invalid_tenant",
      retryAfterMs: null,
    };
  }
  if (operation.effect === "non_increasing") {
    return { status: "allowed" };
  }
  if (
    !operation.reservationToken.trim() ||
    !isSafeNonNegativeInteger(operation.requestedBytes)
  ) {
    return {
      status: "rejected",
      reason: "invalid_request",
      retryAfterMs: null,
    };
  }

  return db
    .transaction((): TenantStorageGuardResult => {
      const reservationDigest = digest([
        "tenant-storage-reservation-v1",
        operation.reservationToken,
      ]);
      const replay = db
        .query<{ found: number }, [string]>(
          `SELECT 1 AS found
           FROM tenant_runtime_storage_reservations
           WHERE reservation_digest = ?`,
        )
        .get(reservationDigest);
      if (replay) {
        return {
          status: "rejected",
          reason: "reservation_token_replay",
          retryAfterMs: null,
        };
      }

      const latest = latestStorageObservation(db, identity);
      if (!latest) {
        return {
          status: "rejected",
          reason: "storage_observation_missing",
          retryAfterMs: null,
        };
      }
      const observationAge = nowMs - latest.observed_at;
      if (
        observationAge < 0 ||
        observationAge > config.storageObservationMaxAgeMs
      ) {
        return {
          status: "rejected",
          reason: "storage_observation_stale",
          retryAfterMs: null,
        };
      }

      const quotaBytes = storageQuotaBytes(db, config, identity);
      const activeReservedBytes = activeStorageReservationBytes(db, identity);
      const projectedBytes =
        latest.observed_bytes + activeReservedBytes + operation.requestedBytes;
      if (
        !Number.isSafeInteger(projectedBytes) ||
        projectedBytes > quotaBytes
      ) {
        return {
          status: "rejected",
          reason: "storage_quota_exceeded",
          retryAfterMs: null,
        };
      }

      const expiresAt = nowMs + config.storageReservationTtlMs;
      db.query(
        `INSERT INTO tenant_runtime_storage_reservations (
           reservation_digest,
           organization_id,
           user_id,
           assistant_id,
           reserved_bytes,
           acquired_at,
           expires_at,
           released_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        reservationDigest,
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        operation.requestedBytes,
        nowMs,
        expiresAt,
      );
      return { status: "allowed", reservationExpiresAt: expiresAt };
    })
    .immediate();
}

/**
 * Cancels a reservation only when its write did not commit. Successful writes
 * remain reserved until a newer trusted full-workspace observation reconciles
 * them, even after their caller-facing TTL, so stale measurements cannot
 * silently undercount storage.
 */
export function releaseTenantStorageReservation(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  reservationToken: string,
  nowMs: number,
): "bypassed" | "released" | "not_found" | "identity_mismatch" {
  if (!config.enabled || !config.storageQuotaEnforcementEnabled) {
    return "bypassed";
  }
  if (!isTenantIdentity(identity) || !reservationToken.trim()) {
    return "not_found";
  }
  if (!tenantExists(db, identity)) return "identity_mismatch";
  const reservationDigest = digest([
    "tenant-storage-reservation-v1",
    reservationToken,
  ]);
  const row = db
    .query<
      {
        organization_id: string;
        user_id: string;
        assistant_id: string;
      },
      [string]
    >(
      `SELECT organization_id, user_id, assistant_id
       FROM tenant_runtime_storage_reservations
       WHERE reservation_digest = ?`,
    )
    .get(reservationDigest);
  if (!row) return "not_found";
  if (
    row.organization_id !== identity.organizationId ||
    row.user_id !== identity.userId ||
    row.assistant_id !== identity.assistantId
  ) {
    return "identity_mismatch";
  }
  db.query(
    `UPDATE tenant_runtime_storage_reservations
     SET released_at = COALESCE(released_at, ?)
     WHERE reservation_digest = ?`,
  ).run(nowMs, reservationDigest);
  return "released";
}

const USAGE_COLUMN: Record<TenantRuntimeUsageMetric, string> = {
  request_count: "request_count",
  turn_count: "turn_count",
  stream_ms: "stream_ms",
  worker_ms: "worker_ms",
};

function usageEventDigest(
  identity: TenantRuntimeIdentity,
  eventId: string,
): string {
  return digest([
    "tenant-runtime-usage-v1",
    identity.organizationId,
    identity.userId,
    identity.assistantId,
    eventId,
  ]);
}

function usageCountsAsActivity(metric: TenantRuntimeUsageMetric): boolean {
  return metric !== "worker_ms";
}

export function recordTenantRuntimeUsage(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  event: TenantRuntimeUsageEvent,
  nowIso: () => string,
): TenantRuntimeUsageResult {
  if (!config.enabled || !config.usageMetricsEnabled) {
    return { status: "bypassed" };
  }
  if (!tenantExists(db, identity)) {
    return { status: "rejected", reason: "invalid_tenant" };
  }
  if (
    !event.eventId.trim() ||
    !isUsageMetric(event.metric) ||
    !Number.isSafeInteger(event.value) ||
    event.value < 1 ||
    !isSafeNonNegativeInteger(event.observedAtMs)
  ) {
    return { status: "rejected", reason: "invalid_event" };
  }

  return db
    .transaction((): TenantRuntimeUsageResult => {
      const eventDigest = usageEventDigest(identity, event.eventId);
      const existing = db
        .query<
          {
            metric: TenantRuntimeUsageMetric;
            metric_value: number;
            observed_at: number;
          },
          [string]
        >(
          `SELECT metric, metric_value, observed_at
           FROM tenant_runtime_usage_events
           WHERE event_digest = ?`,
        )
        .get(eventDigest);
      if (existing) {
        if (
          existing.metric !== event.metric ||
          existing.metric_value !== event.value ||
          existing.observed_at !== event.observedAtMs
        ) {
          return { status: "rejected", reason: "event_conflict" };
        }
        return { status: "recorded", replayed: true };
      }

      const bucketStartedAt =
        Math.floor(event.observedAtMs / config.usageBucketMs) *
        config.usageBucketMs;
      const metricColumn = USAGE_COLUMN[event.metric];
      const currentBucket = db
        .query<
          { metric_value: number; sample_count: number },
          [string, string, string, number]
        >(
          `SELECT ${metricColumn} AS metric_value, sample_count
           FROM tenant_runtime_usage_buckets
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND bucket_started_at = ?`,
        )
        .get(
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          bucketStartedAt,
        );
      if (
        !Number.isSafeInteger(
          (currentBucket?.metric_value ?? 0) + event.value,
        ) ||
        !Number.isSafeInteger((currentBucket?.sample_count ?? 0) + 1)
      ) {
        return { status: "rejected", reason: "invalid_event" };
      }
      const timestamp = nowIso();
      db.query(
        `INSERT INTO tenant_runtime_usage_events (
           event_digest,
           organization_id,
           user_id,
           assistant_id,
           metric,
           metric_value,
           observed_at,
           bucket_started_at,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventDigest,
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        event.metric,
        event.value,
        event.observedAtMs,
        bucketStartedAt,
        timestamp,
      );

      db.query(
        `INSERT INTO tenant_runtime_usage_buckets (
           organization_id,
           user_id,
           assistant_id,
           bucket_started_at,
           ${metricColumn},
           sample_count,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(
           organization_id,
           user_id,
           assistant_id,
           bucket_started_at
         ) DO UPDATE SET
           ${metricColumn} = ${metricColumn} + excluded.${metricColumn},
           sample_count = sample_count + 1,
           updated_at = excluded.updated_at`,
      ).run(
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        bucketStartedAt,
        event.value,
        timestamp,
      );

      if (usageCountsAsActivity(event.metric)) {
        db.query(
          `INSERT INTO tenant_runtime_activity (
             organization_id,
             user_id,
             assistant_id,
             last_activity_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, assistant_id) DO UPDATE SET
             user_id = excluded.user_id,
             last_activity_at = MAX(
               tenant_runtime_activity.last_activity_at,
               excluded.last_activity_at
             ),
             updated_at = excluded.updated_at`,
        ).run(
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          event.observedAtMs,
          timestamp,
        );
        db.query(
          `UPDATE tenant_runtime_idle_suspension_actions
           SET status = 'cancelled', cancelled_at = ?
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND status = 'pending'
             AND last_activity_at < ?`,
        ).run(
          timestamp,
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          event.observedAtMs,
        );
      }
      return { status: "recorded", replayed: false };
    })
    .immediate();
}

export function readTenantRuntimeUsage(
  db: Database,
  identity: TenantRuntimeIdentity,
  fromMs: number,
): TenantRuntimeUsageBucket[] | null {
  if (!tenantExists(db, identity) || !isSafeNonNegativeInteger(fromMs)) {
    return null;
  }
  return db
    .query<
      {
        bucket_started_at: number;
        request_count: number;
        turn_count: number;
        stream_ms: number;
        worker_ms: number;
        sample_count: number;
      },
      [string, string, string, number]
    >(
      `SELECT
         bucket_started_at,
         request_count,
         turn_count,
         stream_ms,
         worker_ms,
         sample_count
       FROM tenant_runtime_usage_buckets
       WHERE organization_id = ?
         AND user_id = ?
         AND assistant_id = ?
         AND bucket_started_at >= ?
       ORDER BY bucket_started_at ASC`,
    )
    .all(identity.organizationId, identity.userId, identity.assistantId, fromMs)
    .map((row) => ({
      bucketStartedAt: row.bucket_started_at,
      requestCount: row.request_count,
      turnCount: row.turn_count,
      streamMs: row.stream_ms,
      workerMs: row.worker_ms,
      sampleCount: row.sample_count,
    }));
}

function currentActivity(
  db: Database,
  identity: TenantRuntimeIdentity,
): TenantActivityRow | null {
  return (
    db
      .query<TenantActivityRow, [string, string, string]>(
        `SELECT last_activity_at
         FROM tenant_runtime_activity
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?`,
      )
      .get(identity.organizationId, identity.userId, identity.assistantId) ??
    null
  );
}

export function evaluateTenantIdleSuspension(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  nowMs: number,
): TenantIdleSuspensionEvaluation {
  if (!config.enabled || !config.idleSuspensionEnabled) {
    return { status: "bypassed" };
  }
  if (!tenantExists(db, identity)) {
    return { status: "rejected", reason: "invalid_tenant" };
  }
  const activity = currentActivity(db, identity);
  if (!activity) return { status: "blocked", reason: "activity_unknown" };
  if (activity.last_activity_at > nowMs) {
    return { status: "blocked", reason: "activity_in_future" };
  }
  const eligibleAt = activity.last_activity_at + config.idleAfterMs;
  if (eligibleAt > nowMs) return { status: "not_idle", eligibleAt };

  if (!tableExists(db, "tenant_runtime_admissions")) {
    return {
      status: "blocked",
      reason: "admission_telemetry_unavailable",
    };
  }
  const activeRequest = db
    .query<{ found: number }, [string, string, string, number]>(
      `SELECT 1 AS found
       FROM tenant_runtime_admissions
       WHERE organization_id = ?
         AND user_id = ?
         AND assistant_id = ?
         AND released_at IS NULL
         AND expires_at > ?
       LIMIT 1`,
    )
    .get(identity.organizationId, identity.userId, identity.assistantId, nowMs);
  if (activeRequest) return { status: "blocked", reason: "active_request" };

  if (!tableExists(db, "runtime_worker_leases")) {
    return {
      status: "blocked",
      reason: "worker_telemetry_unavailable",
    };
  }
  const activeWorkerLease = db
    .query<{ found: number }, [string, string, number]>(
      `SELECT 1 AS found
       FROM runtime_worker_leases
       WHERE org_id = ?
         AND assistant_id = ?
         AND lease_token IS NOT NULL
         AND released_at IS NULL
         AND lease_expires_at > ?
       LIMIT 1`,
    )
    .get(identity.organizationId, identity.assistantId, nowMs);
  if (activeWorkerLease) {
    return { status: "blocked", reason: "active_worker_lease" };
  }

  const activeStorageReservation = db
    .query<{ found: number }, [string, string, string]>(
      `SELECT 1 AS found
       FROM tenant_runtime_storage_reservations
       WHERE organization_id = ?
         AND user_id = ?
         AND assistant_id = ?
         AND released_at IS NULL
       LIMIT 1`,
    )
    .get(identity.organizationId, identity.userId, identity.assistantId);
  if (activeStorageReservation) {
    return {
      status: "blocked",
      reason: "active_storage_reservation",
    };
  }
  return {
    status: "candidate",
    lastActivityAt: activity.last_activity_at,
    eligibleAt,
  };
}

function idleAction(row: IdleSuspensionActionRow): TenantIdleSuspensionAction {
  return {
    actionId: row.action_id,
    status: row.status,
    lastActivityAt: row.last_activity_at,
    eligibleAt: row.eligible_at,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

export function planTenantIdleSuspension(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  identity: TenantRuntimeIdentity,
  nowMs: number,
  nowIso: () => string,
): TenantIdleSuspensionPlanResult {
  return db
    .transaction((): TenantIdleSuspensionPlanResult => {
      const evaluation = evaluateTenantIdleSuspension(
        db,
        config,
        identity,
        nowMs,
      );
      if (evaluation.status !== "candidate") {
        return { status: "not_planned", evaluation };
      }

      const actionId = `idle-${digest([
        "tenant-idle-suspension-v1",
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        evaluation.lastActivityAt,
      ])}`;
      const existing = db
        .query<IdleSuspensionActionRow, [string, string, string]>(
          `SELECT
             action_id,
             status,
             last_activity_at,
             eligible_at,
             created_at,
             cancelled_at
           FROM tenant_runtime_idle_suspension_actions
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND status = 'pending'`,
        )
        .get(identity.organizationId, identity.userId, identity.assistantId);
      if (existing) {
        return {
          status: "planned",
          replayed: true,
          action: idleAction(existing),
        };
      }

      const timestamp = nowIso();
      db.query(
        `INSERT INTO tenant_runtime_idle_suspension_actions (
           action_id,
           organization_id,
           user_id,
           assistant_id,
           status,
           last_activity_at,
           eligible_at,
           created_at,
           cancelled_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)`,
      ).run(
        actionId,
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        evaluation.lastActivityAt,
        evaluation.eligibleAt,
        timestamp,
      );
      return {
        status: "planned",
        replayed: false,
        action: {
          actionId,
          status: "pending",
          lastActivityAt: evaluation.lastActivityAt,
          eligibleAt: evaluation.eligibleAt,
          createdAt: timestamp,
          cancelledAt: null,
        },
      };
    })
    .immediate();
}

export function readTenantIdleSuspensionActions(
  db: Database,
  identity: TenantRuntimeIdentity,
): TenantIdleSuspensionAction[] | null {
  if (!tenantExists(db, identity)) return null;
  return db
    .query<IdleSuspensionActionRow, [string, string, string]>(
      `SELECT
         action_id,
         status,
         last_activity_at,
         eligible_at,
         created_at,
         cancelled_at
       FROM tenant_runtime_idle_suspension_actions
       WHERE organization_id = ?
         AND user_id = ?
         AND assistant_id = ?
       ORDER BY created_at DESC`,
    )
    .all(identity.organizationId, identity.userId, identity.assistantId)
    .map(idleAction);
}

function capacityAlertCode(
  telemetry: RuntimeWorkerCapacityTelemetry,
  minimumAvailableCapacity: number,
): Pick<RuntimeCapacityAlert, "severity" | "code"> | null {
  if (telemetry.unregisteredActiveLeaseCount > 0) {
    return { severity: "critical", code: "unregistered_active_leases" };
  }
  if (telemetry.state === "disabled") {
    return { severity: "critical", code: "pool_disabled" };
  }
  if (
    telemetry.state === "empty" ||
    telemetry.state === "unavailable" ||
    telemetry.readyWorkerCount === 0
  ) {
    return { severity: "critical", code: "capacity_unavailable" };
  }
  if (telemetry.state === "sanitization_required") {
    return { severity: "warning", code: "sanitization_required" };
  }
  if (telemetry.state === "saturated") {
    return { severity: "warning", code: "capacity_saturated" };
  }
  if (telemetry.state === "degraded") {
    return { severity: "warning", code: "capacity_degraded" };
  }
  if (telemetry.availableNewAssistantCapacity <= minimumAvailableCapacity) {
    return { severity: "warning", code: "low_capacity" };
  }
  return null;
}

function alertFromTelemetry(
  alertType: Pick<RuntimeCapacityAlert, "severity" | "code">,
  telemetry: RuntimeWorkerCapacityTelemetry,
  observedAt: number,
): RuntimeCapacityAlert {
  return {
    ...alertType,
    observedAt,
    state: telemetry.state,
    configuredWorkerCount: telemetry.configuredWorkerCount,
    readyWorkerCount: telemetry.readyWorkerCount,
    unhealthyWorkerCount: telemetry.unhealthyWorkerCount,
    missingWorkerCount: telemetry.missingWorkerCount,
    activeLeaseCount: telemetry.activeLeaseCount,
    unregisteredActiveLeaseCount: telemetry.unregisteredActiveLeaseCount,
    boundIdleWorkerCount: telemetry.boundIdleWorkerCount,
    unboundReadyWorkerCount: telemetry.unboundReadyWorkerCount,
    maxConcurrentLeases: telemetry.maxConcurrentLeases,
    availableNewAssistantCapacity: telemetry.availableNewAssistantCapacity,
  };
}

export function persistRuntimeCapacityAlert(
  db: Database,
  config: TenantRuntimeOperationsConfig,
  telemetry: RuntimeWorkerCapacityTelemetry,
  nowMs: number,
  nowIso: () => string,
): RuntimeCapacityAlertResult {
  if (!config.enabled || !config.capacityAlertsEnabled) {
    return { status: "bypassed" };
  }
  const alertType = capacityAlertCode(
    telemetry,
    config.minimumAvailableWorkerCapacity,
  );
  if (!alertType) return { status: "healthy" };

  const alert = alertFromTelemetry(alertType, telemetry, nowMs);
  const dedupWindow =
    Math.floor(nowMs / config.capacityAlertDedupWindowMs) *
    config.capacityAlertDedupWindowMs;
  const alertDigest = digest([
    "runtime-capacity-alert-v1",
    alert.code,
    dedupWindow,
    alert.state,
    alert.configuredWorkerCount,
    alert.readyWorkerCount,
    alert.unhealthyWorkerCount,
    alert.missingWorkerCount,
    alert.activeLeaseCount,
    alert.unregisteredActiveLeaseCount,
    alert.boundIdleWorkerCount,
    alert.unboundReadyWorkerCount,
    alert.maxConcurrentLeases,
    alert.availableNewAssistantCapacity,
  ]);
  const result = db
    .query(
      `INSERT OR IGNORE INTO runtime_capacity_alerts (
       alert_digest,
       severity,
       code,
       observed_at,
       state,
       configured_worker_count,
       ready_worker_count,
       unhealthy_worker_count,
       missing_worker_count,
       active_lease_count,
       unregistered_active_lease_count,
       bound_idle_worker_count,
       unbound_ready_worker_count,
       max_concurrent_leases,
       available_new_assistant_capacity,
       recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      alertDigest,
      alert.severity,
      alert.code,
      alert.observedAt,
      alert.state,
      alert.configuredWorkerCount,
      alert.readyWorkerCount,
      alert.unhealthyWorkerCount,
      alert.missingWorkerCount,
      alert.activeLeaseCount,
      alert.unregisteredActiveLeaseCount,
      alert.boundIdleWorkerCount,
      alert.unboundReadyWorkerCount,
      alert.maxConcurrentLeases,
      alert.availableNewAssistantCapacity,
      nowIso(),
    );
  return {
    status: "alert",
    persisted: result.changes === 1,
    alert,
  };
}

export function readRuntimeCapacityAlerts(
  db: Database,
  limit = 20,
): RuntimeCapacityAlert[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Capacity alert limit must be between 1 and 100.");
  }
  return db
    .query<
      {
        severity: "warning" | "critical";
        code: RuntimeCapacityAlertCode;
        observed_at: number;
        state: RuntimeWorkerCapacityTelemetry["state"];
        configured_worker_count: number;
        ready_worker_count: number;
        unhealthy_worker_count: number;
        missing_worker_count: number;
        active_lease_count: number;
        unregistered_active_lease_count: number;
        bound_idle_worker_count: number;
        unbound_ready_worker_count: number;
        max_concurrent_leases: number;
        available_new_assistant_capacity: number;
      },
      [number]
    >(
      `SELECT
         severity,
         code,
         observed_at,
         state,
         configured_worker_count,
         ready_worker_count,
         unhealthy_worker_count,
         missing_worker_count,
         active_lease_count,
         unregistered_active_lease_count,
         bound_idle_worker_count,
         unbound_ready_worker_count,
         max_concurrent_leases,
         available_new_assistant_capacity
       FROM runtime_capacity_alerts
       ORDER BY observed_at DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      severity: row.severity,
      code: row.code,
      observedAt: row.observed_at,
      state: row.state,
      configuredWorkerCount: row.configured_worker_count,
      readyWorkerCount: row.ready_worker_count,
      unhealthyWorkerCount: row.unhealthy_worker_count,
      missingWorkerCount: row.missing_worker_count,
      activeLeaseCount: row.active_lease_count,
      unregisteredActiveLeaseCount: row.unregistered_active_lease_count,
      boundIdleWorkerCount: row.bound_idle_worker_count,
      unboundReadyWorkerCount: row.unbound_ready_worker_count,
      maxConcurrentLeases: row.max_concurrent_leases,
      availableNewAssistantCapacity: row.available_new_assistant_capacity,
    }));
}
