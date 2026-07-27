import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";

import {
  claimRuntimeWorkerLease,
  getActiveRuntimeWorkerLease,
  renewRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
  type RuntimeWorkerLease,
  type RuntimeWorkerLeaseAssistant,
  type RuntimeWorkerStackRow,
} from "./runtime-worker-leases.js";
import {
  assertRuntimeWorkerStateExportedForRelease,
  assertRuntimeWorkerStateReadyForLease,
  ensureRuntimeWorkerStateCheckpointSchema,
  exportRuntimeWorkerStateWithStorage,
  getRuntimeWorkerStateCheckpoint,
  restoreRuntimeWorkerStateWithStorage,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  RuntimeWorkerStateError,
  type RuntimeWorkerStateStorage,
} from "./runtime-worker-state-checkpoints.js";

type EnvLike = Record<string, string | undefined>;

export interface RuntimeWorkerPoolConfig {
  enabled: boolean;
  candidateStackIds: readonly string[];
  maxConcurrentLeases: number;
  leaseTtlMs: number;
}

export type RuntimeWorkerCandidateReadiness =
  | "ready"
  | "missing"
  | "wrong_provider"
  | "inactive"
  | "missing_route"
  | "unhealthy";

export interface RuntimeWorkerCandidate {
  stackId: string;
  readiness: RuntimeWorkerCandidateReadiness;
  stack: RuntimeWorkerStackRow | null;
}

export type RuntimeWorkerCapacityState =
  | "disabled"
  | "empty"
  | "unavailable"
  | "available"
  | "degraded"
  | "saturated"
  | "sanitization_required";

export interface RuntimeWorkerCapacityTelemetry {
  state: RuntimeWorkerCapacityState;
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

export type RuntimeWorkerDispatchResult =
  | {
      status: "disabled";
      telemetry: RuntimeWorkerCapacityTelemetry;
    }
  | {
      status: "unavailable";
      reason:
        | "empty_capacity"
        | "no_ready_workers"
        | "capacity_exhausted"
        | "assistant_not_found"
        | "assistant_busy"
        | "state_lifecycle_unavailable"
        | "state_restore_failed"
        | "state_quarantined"
        | "worker_unavailable"
        | "lease_lost";
      retryAfterMs: number | null;
      telemetry: RuntimeWorkerCapacityTelemetry;
    }
  | {
      status: "leased";
      assignment: RuntimeWorkerLease;
      telemetry: RuntimeWorkerCapacityTelemetry;
    };

export type RuntimeWorkerRenewResult =
  | { status: "disabled" }
  | { status: "lease_lost" }
  | { status: "worker_unavailable" }
  | { status: "renewed"; assignment: RuntimeWorkerLease };

export type RuntimeWorkerReleaseResult =
  | { status: "lease_lost" }
  | { status: "worker_unavailable" }
  | { status: "state_lifecycle_unavailable" }
  | { status: "state_export_failed" }
  | { status: "state_quarantined" }
  | { status: "sanitization_failed" }
  | { status: "authority_revocation_failed" }
  | { status: "released" };

export type RuntimeWorkerQuarantineDiscardResult =
  | RuntimeWorkerReleaseResult
  | { status: "not_quarantined" }
  | { status: "binding_mismatch" };

export interface RuntimeWorkerLifecycleAdapter {
  storage: RuntimeWorkerStateStorage;
  /**
   * Deletes tenant files and process-local state from the worker. Credentials
   * are never part of pooled state: CES remains their only source of truth.
   * Implementations must be idempotent so a release can safely retry.
   */
  sanitize(input: {
    assistant: RuntimeWorkerLeaseAssistant;
    workerStackId: string;
    leaseGeneration: number;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<void>;
  /**
   * Revokes the worker's current generation after state export and workspace
   * sanitization, but before the durable lease row is released.
   */
  revokeAuthority(input: {
    assistant: RuntimeWorkerLeaseAssistant;
    workerStackId: string;
    leaseGeneration: number;
  }): Promise<void>;
}

export interface RuntimeWorkerLifecycleLeaseTimer {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * Keeps the exact durable worker generation authorized while restore, export,
 * sanitization, or revocation is waiting on an external service.
 *
 * Ordinary request renewal cannot be reused here because restore intentionally
 * runs before the checkpoint reaches `ready`, while recovery cleanup can run
 * from `quarantined`.
 */
export interface RuntimeWorkerLifecycleLeaseHeartbeatOptions {
  timer: RuntimeWorkerLifecycleLeaseTimer;
  nowMs: () => number;
  nowIso: () => string;
  intervalMs: number;
}

interface CandidateStackRecord extends RuntimeWorkerStackRow {
  last_health_status: string | null;
}

interface WorkerLeaseState {
  runtime_stack_id: string;
  assistant_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function nonNegativeIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function positiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function runtimeWorkerPoolConfigFromEnv(
  rawEnv: EnvLike,
): RuntimeWorkerPoolConfig {
  const enabled = boolEnv(rawEnv.WORKLIN_RUNTIME_WORKER_POOL_ENABLED, false);
  if (!enabled) {
    return {
      enabled: false,
      candidateStackIds: [],
      maxConcurrentLeases: 0,
      leaseTtlMs: 60_000,
    };
  }

  return {
    enabled: true,
    candidateStackIds: [
      ...new Set(
        (rawEnv.WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    maxConcurrentLeases: nonNegativeIntegerEnv(
      "WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY",
      rawEnv.WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY,
      0,
    ),
    leaseTtlMs: positiveIntegerEnv(
      "WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS",
      rawEnv.WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS,
      60_000,
    ),
  };
}

function getCandidateStackRecord(
  db: Database,
  stackId: string,
): CandidateStackRecord | null {
  return (
    db
      .query<CandidateStackRecord, [string]>(
        `SELECT
           id,
           status,
           provider,
           gateway_url,
           public_ingress_url,
           workspace_volume_ref,
           service_ref,
           actor_signing_key_scope,
           last_health_status
         FROM runtime_stacks
         WHERE id = ?`,
      )
      .get(stackId) ?? null
  );
}

function stackWithoutHealth(
  record: CandidateStackRecord,
): RuntimeWorkerStackRow {
  return {
    id: record.id,
    status: record.status,
    provider: record.provider,
    gateway_url: record.gateway_url,
    public_ingress_url: record.public_ingress_url,
    workspace_volume_ref: record.workspace_volume_ref,
    service_ref: record.service_ref,
    actor_signing_key_scope: record.actor_signing_key_scope,
  };
}

function readinessFor(
  record: CandidateStackRecord | null,
): RuntimeWorkerCandidateReadiness {
  if (!record) return "missing";
  if (record.provider !== RUNTIME_WORKER_POOL_PROVIDER) return "wrong_provider";
  if (record.status !== "active") return "inactive";
  if (!record.gateway_url || !record.service_ref) return "missing_route";
  if (
    !record.last_health_status ||
    !/^2\d\d$/.test(record.last_health_status)
  ) {
    return "unhealthy";
  }
  return "ready";
}

export function inspectRuntimeWorkerCandidates(
  db: Database,
  config: RuntimeWorkerPoolConfig,
): RuntimeWorkerCandidate[] {
  if (!config.enabled) return [];
  return config.candidateStackIds.map((stackId) => {
    const record = getCandidateStackRecord(db, stackId);
    const readiness = readinessFor(record);
    return {
      stackId,
      readiness,
      stack:
        record && readiness === "ready" ? stackWithoutHealth(record) : null,
    };
  });
}

function getWorkerLeaseStates(db: Database): WorkerLeaseState[] {
  return db
    .query<WorkerLeaseState, []>(
      `SELECT
         runtime_stack_id,
         assistant_id,
         lease_token,
         lease_expires_at
       FROM runtime_worker_leases`,
    )
    .all();
}

export function getRuntimeWorkerCapacityTelemetry(
  db: Database,
  config: RuntimeWorkerPoolConfig,
  nowMs: number,
): RuntimeWorkerCapacityTelemetry {
  if (!config.enabled) {
    return {
      state: "disabled",
      configuredWorkerCount: 0,
      readyWorkerCount: 0,
      unhealthyWorkerCount: 0,
      missingWorkerCount: 0,
      activeLeaseCount: 0,
      unregisteredActiveLeaseCount: 0,
      boundIdleWorkerCount: 0,
      unboundReadyWorkerCount: 0,
      maxConcurrentLeases: 0,
      availableNewAssistantCapacity: 0,
    };
  }

  const candidates = inspectRuntimeWorkerCandidates(db, config);
  const candidateIds = new Set(candidates.map(({ stackId }) => stackId));
  const readyIds = new Set(
    candidates
      .filter(({ readiness }) => readiness === "ready")
      .map(({ stackId }) => stackId),
  );
  const allLeases = getWorkerLeaseStates(db);
  const leases = allLeases.filter(({ runtime_stack_id }) =>
    candidateIds.has(runtime_stack_id),
  );
  const leaseByStack = new Map(
    leases.map((lease) => [lease.runtime_stack_id, lease]),
  );
  const activeLeaseCount = allLeases.filter(
    ({ lease_token, lease_expires_at }) =>
      lease_token !== null && (lease_expires_at ?? 0) > nowMs,
  ).length;
  const unregisteredActiveLeaseCount = allLeases.filter(
    ({ runtime_stack_id, lease_token, lease_expires_at }) =>
      !candidateIds.has(runtime_stack_id) &&
      lease_token !== null &&
      (lease_expires_at ?? 0) > nowMs,
  ).length;
  const boundIdleWorkerCount = leases.filter(
    ({ assistant_id, lease_token, lease_expires_at }) =>
      assistant_id !== null &&
      (lease_token === null || (lease_expires_at ?? 0) <= nowMs),
  ).length;
  const unboundReadyWorkerCount = [...readyIds].filter((stackId) => {
    const lease = leaseByStack.get(stackId);
    return !lease || lease.assistant_id === null;
  }).length;
  const availableNewAssistantCapacity = Math.max(
    0,
    Math.min(
      config.maxConcurrentLeases - activeLeaseCount,
      unboundReadyWorkerCount,
    ),
  );
  const unhealthyWorkerCount = candidates.filter(
    ({ readiness }) =>
      readiness === "unhealthy" ||
      readiness === "inactive" ||
      readiness === "missing_route" ||
      readiness === "wrong_provider",
  ).length;
  const missingWorkerCount = candidates.filter(
    ({ readiness }) => readiness === "missing",
  ).length;

  let state: RuntimeWorkerCapacityState;
  if (
    config.maxConcurrentLeases === 0 ||
    config.candidateStackIds.length === 0
  ) {
    state = "empty";
  } else if (readyIds.size === 0) {
    state = "unavailable";
  } else if (
    availableNewAssistantCapacity === 0 &&
    boundIdleWorkerCount > 0 &&
    activeLeaseCount < config.maxConcurrentLeases
  ) {
    state = "sanitization_required";
  } else if (availableNewAssistantCapacity === 0) {
    state = "saturated";
  } else if (unhealthyWorkerCount > 0 || missingWorkerCount > 0) {
    state = "degraded";
  } else {
    state = "available";
  }

  return {
    state,
    configuredWorkerCount: candidates.length,
    readyWorkerCount: readyIds.size,
    unhealthyWorkerCount,
    missingWorkerCount,
    activeLeaseCount,
    unregisteredActiveLeaseCount,
    boundIdleWorkerCount,
    unboundReadyWorkerCount,
    maxConcurrentLeases: config.maxConcurrentLeases,
    availableNewAssistantCapacity,
  };
}

function stateTenant(assistant: RuntimeWorkerLeaseAssistant): {
  orgId: string;
  assistantId: string;
} {
  return { orgId: assistant.org_id, assistantId: assistant.id };
}

function stateOperationId(
  kind: "restore" | "export",
  assistant: RuntimeWorkerLeaseAssistant,
  workerStackId: string,
  generation: number,
): string {
  const digest = createHash("sha256")
    .update(
      [
        kind,
        assistant.org_id,
        assistant.id,
        workerStackId,
        String(generation),
      ].join("\u0000"),
    )
    .digest("hex");
  return `${kind}-${digest}`;
}

type RuntimeWorkerLifecycleLeaseRenewResult =
  | { status: "renewed"; assignment: RuntimeWorkerLease }
  | { status: "lease_lost" }
  | { status: "worker_unavailable" };

interface RuntimeWorkerLifecycleLeaseGuard {
  renewNow(): RuntimeWorkerLifecycleLeaseRenewResult;
  failure(): Exclude<
    RuntimeWorkerLifecycleLeaseRenewResult["status"],
    "renewed"
  > | null;
  stop(): void;
}

function startRuntimeWorkerLifecycleLeaseGuard(input: {
  db: Database;
  assistant: RuntimeWorkerLeaseAssistant;
  config: RuntimeWorkerPoolConfig;
  leaseToken: string;
  heartbeat: RuntimeWorkerLifecycleLeaseHeartbeatOptions;
}): RuntimeWorkerLifecycleLeaseGuard {
  if (
    !Number.isSafeInteger(input.heartbeat.intervalMs) ||
    input.heartbeat.intervalMs < 1 ||
    input.heartbeat.intervalMs >= input.config.leaseTtlMs
  ) {
    throw new Error("Runtime worker lifecycle heartbeat is invalid.");
  }

  let stopped = false;
  let timerHandle: unknown | null = null;
  let failed: "lease_lost" | "worker_unavailable" | null = null;

  const renewNow = (): RuntimeWorkerLifecycleLeaseRenewResult => {
    if (failed) return { status: failed };
    const nowMs = input.heartbeat.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      failed = "worker_unavailable";
      return { status: failed };
    }
    try {
      const assignment = renewRuntimeWorkerLease(
        input.db,
        input.assistant,
        input.leaseToken,
        nowMs,
        input.config.leaseTtlMs,
        input.heartbeat.nowIso,
      );
      return { status: "renewed", assignment };
    } catch (error) {
      failed =
        error instanceof Error &&
        error.message === "Runtime worker lease was lost."
          ? "lease_lost"
          : "worker_unavailable";
      return { status: failed };
    }
  };

  const schedule = (): void => {
    if (stopped || failed || timerHandle !== null) return;
    try {
      timerHandle = input.heartbeat.timer.schedule(async () => {
        timerHandle = null;
        if (stopped || failed) return;
        if (renewNow().status === "renewed") schedule();
      }, input.heartbeat.intervalMs);
    } catch {
      failed = "worker_unavailable";
    }
  };

  if (renewNow().status === "renewed") schedule();

  return {
    renewNow,
    failure: () => failed,
    stop() {
      stopped = true;
      if (timerHandle !== null) {
        input.heartbeat.timer.cancel(timerHandle);
        timerHandle = null;
      }
    },
  };
}

/**
 * A lifecycle call may have already changed the physical worker by the time an
 * exact lease renewal fails. Keep that worker bound and mark its checkpoint
 * quarantined before returning control. Ordinary routing cannot clear this
 * marker; only the explicit sanitize/revoke operator recovery path can.
 */
function quarantineRuntimeWorkerLifecycleAmbiguity(input: {
  db: Database;
  assistant: RuntimeWorkerLeaseAssistant;
  workerStackId: string;
  leaseToken: string;
  leaseGeneration: number;
  failureCode: "restore_failed" | "export_failed";
  nowIso: () => string;
}): boolean {
  return input.db
    .transaction((): boolean => {
      const exactLease = input.db
        .query<
          { found: number },
          [string, string, string, string, number]
        >(
          `SELECT 1 AS found
           FROM runtime_worker_leases
           WHERE runtime_stack_id = ?
             AND assistant_id = ?
             AND org_id = ?
             AND lease_token = ?
             AND lease_generation = ?`,
        )
        .get(
          input.workerStackId,
          input.assistant.id,
          input.assistant.org_id,
          input.leaseToken,
          input.leaseGeneration,
        );
      if (!exactLease) return false;

      const checkpoint = input.db
        .query<
          { status: string; worker_stack_id: string | null },
          [string, string]
        >(
          `SELECT status, worker_stack_id
           FROM runtime_worker_state_checkpoints
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get(input.assistant.org_id, input.assistant.id);
      if (!checkpoint || checkpoint.worker_stack_id !== input.workerStackId) {
        return false;
      }
      if (checkpoint.status === "quarantined") return true;
      if (
        checkpoint.status !== "restoring" &&
        checkpoint.status !== "ready" &&
        checkpoint.status !== "exporting" &&
        checkpoint.status !== "exported"
      ) {
        return false;
      }

      const quarantined = input.db
        .query(
          `UPDATE runtime_worker_state_checkpoints
           SET status = 'quarantined',
               failure_code = ?,
               updated_at = ?
           WHERE org_id = ?
             AND assistant_id = ?
             AND worker_stack_id = ?
             AND status = ?`,
        )
        .run(
          input.failureCode,
          input.nowIso(),
          input.assistant.org_id,
          input.assistant.id,
          input.workerStackId,
          checkpoint.status,
        );
      return quarantined.changes === 1;
    })
    .immediate();
}

export async function dispatchRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  config: RuntimeWorkerPoolConfig,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
  lifecycle?: RuntimeWorkerLifecycleAdapter,
  lifecycleHeartbeat?: RuntimeWorkerLifecycleLeaseHeartbeatOptions,
): Promise<RuntimeWorkerDispatchResult> {
  const telemetry = getRuntimeWorkerCapacityTelemetry(db, config, nowMs);
  if (!config.enabled) return { status: "disabled", telemetry };
  if (
    config.maxConcurrentLeases === 0 ||
    config.candidateStackIds.length === 0
  ) {
    return {
      status: "unavailable",
      reason: "empty_capacity",
      retryAfterMs: null,
      telemetry,
    };
  }
  const readyStackIds = inspectRuntimeWorkerCandidates(db, config)
    .filter(({ readiness }) => readiness === "ready")
    .map(({ stackId }) => stackId);
  if (readyStackIds.length === 0) {
    return {
      status: "unavailable",
      reason: "no_ready_workers",
      retryAfterMs: null,
      telemetry,
    };
  }
  if (!lifecycle) {
    return {
      status: "unavailable",
      reason: "state_lifecycle_unavailable",
      retryAfterMs: null,
      telemetry,
    };
  }

  ensureRuntimeWorkerStateCheckpointSchema(db);
  const tenant = stateTenant(assistant);
  const checkpointBeforeClaim = getRuntimeWorkerStateCheckpoint(db, tenant);
  if (checkpointBeforeClaim?.status === "quarantined") {
    return {
      status: "unavailable",
      reason: "state_quarantined",
      retryAfterMs: null,
      telemetry,
    };
  }

  const activeBeforeClaim = getActiveRuntimeWorkerLease(
    db,
    assistant,
    leaseToken,
    nowMs,
  );
  const claim = claimRuntimeWorkerLease(
    db,
    assistant,
    readyStackIds,
    config.maxConcurrentLeases,
    leaseToken,
    nowMs,
    config.leaseTtlMs,
    nowIso,
  );
  const updatedTelemetry = getRuntimeWorkerCapacityTelemetry(db, config, nowMs);
  if (claim.leaseAcquired && claim.assignment) {
    let lifecycleLeaseGuard: RuntimeWorkerLifecycleLeaseGuard | null = null;
    if (lifecycleHeartbeat) {
      try {
        lifecycleLeaseGuard = startRuntimeWorkerLifecycleLeaseGuard({
          db,
          assistant,
          config,
          leaseToken,
          heartbeat: lifecycleHeartbeat,
        });
      } catch {
        return {
          status: "unavailable",
          reason: "worker_unavailable",
          retryAfterMs: null,
          telemetry: getRuntimeWorkerCapacityTelemetry(
            db,
            config,
            lifecycleHeartbeat.nowMs(),
          ),
        };
      }
      const heartbeatFailure = lifecycleLeaseGuard.failure();
      if (heartbeatFailure) {
        lifecycleLeaseGuard.stop();
        return {
          status: "unavailable",
          reason: heartbeatFailure,
          retryAfterMs: null,
          telemetry: getRuntimeWorkerCapacityTelemetry(
            db,
            config,
            lifecycleHeartbeat.nowMs(),
          ),
        };
      }
    }

    const checkpoint = getRuntimeWorkerStateCheckpoint(db, tenant);
    let stateFailure: "state_quarantined" | "state_restore_failed" | null =
      null;
    let finalRenewal: RuntimeWorkerLifecycleLeaseRenewResult | null = null;
    try {
      const isIdempotentRoute =
        activeBeforeClaim?.stack.id === claim.assignment.stack.id &&
        checkpoint?.status === "ready";
      if (isIdempotentRoute) {
        assertRuntimeWorkerStateReadyForLease(
          db,
          tenant,
          claim.assignment.stack.id,
        );
      } else {
        if (checkpoint?.status === "ready") {
          throw new RuntimeWorkerStateError(
            "state_not_ready",
            "A new lease cannot reuse unexported worker state.",
          );
        }
        const expectedGeneration = checkpoint?.generation ?? 0;
        await restoreRuntimeWorkerStateWithStorage(
          db,
          lifecycle.storage,
          tenant,
          claim.assignment.stack.id,
          claim.assignment.lease.lease_generation,
          expectedGeneration,
          stateOperationId(
            "restore",
            assistant,
            claim.assignment.stack.id,
            expectedGeneration,
          ),
          nowIso,
        );
        assertRuntimeWorkerStateReadyForLease(
          db,
          tenant,
          claim.assignment.stack.id,
        );
      }
    } catch (error) {
      const failedCheckpoint = getRuntimeWorkerStateCheckpoint(db, tenant);
      stateFailure =
        failedCheckpoint?.status === "quarantined" ||
        (error instanceof RuntimeWorkerStateError &&
          error.code === "quarantined")
          ? "state_quarantined"
          : "state_restore_failed";
    } finally {
      if (lifecycleLeaseGuard) {
        finalRenewal = lifecycleLeaseGuard.renewNow();
        lifecycleLeaseGuard.stop();
      }
    }
    if (finalRenewal && finalRenewal.status !== "renewed") {
      const quarantined = quarantineRuntimeWorkerLifecycleAmbiguity({
        db,
        assistant,
        workerStackId: claim.assignment.stack.id,
        leaseToken,
        leaseGeneration: claim.assignment.lease.lease_generation,
        failureCode: "restore_failed",
        nowIso,
      });
      return {
        status: "unavailable",
        reason: quarantined ? "state_quarantined" : finalRenewal.status,
        retryAfterMs: null,
        telemetry: getRuntimeWorkerCapacityTelemetry(
          db,
          config,
          lifecycleHeartbeat!.nowMs(),
        ),
      };
    }
    if (stateFailure) {
      return {
        status: "unavailable",
        reason: stateFailure,
        retryAfterMs: null,
        telemetry: getRuntimeWorkerCapacityTelemetry(
          db,
          config,
          lifecycleHeartbeat?.nowMs() ?? nowMs,
        ),
      };
    }
    return {
      status: "leased",
      assignment:
        finalRenewal?.status === "renewed"
          ? finalRenewal.assignment
          : claim.assignment,
      telemetry: updatedTelemetry,
    };
  }
  return {
    status: "unavailable",
    reason: claim.reason === "acquired" ? "capacity_exhausted" : claim.reason,
    retryAfterMs: claim.retryAfterMs,
    telemetry: updatedTelemetry,
  };
}

export function renewDispatchedRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  config: RuntimeWorkerPoolConfig,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
  lifecycle?: RuntimeWorkerLifecycleAdapter,
): RuntimeWorkerRenewResult {
  if (!config.enabled) return { status: "disabled" };
  if (!lifecycle) return { status: "worker_unavailable" };
  const current = getActiveRuntimeWorkerLease(db, assistant, leaseToken, nowMs);
  if (!current) return { status: "lease_lost" };
  const candidate = inspectRuntimeWorkerCandidates(db, config).find(
    ({ stackId }) => stackId === current.stack.id,
  );
  if (!candidate || candidate.readiness !== "ready") {
    return { status: "worker_unavailable" };
  }
  try {
    ensureRuntimeWorkerStateCheckpointSchema(db);
    assertRuntimeWorkerStateReadyForLease(
      db,
      stateTenant(assistant),
      current.stack.id,
    );
  } catch {
    return { status: "worker_unavailable" };
  }
  try {
    return {
      status: "renewed",
      assignment: renewRuntimeWorkerLease(
        db,
        assistant,
        leaseToken,
        nowMs,
        config.leaseTtlMs,
        nowIso,
      ),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Runtime worker lease was lost." ||
        error.message === "Runtime worker is unavailable.")
    ) {
      return { status: "lease_lost" };
    }
    throw error;
  }
}

export async function releaseDispatchedRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
  lifecycle?: RuntimeWorkerLifecycleAdapter,
  lifecycleHeartbeat?: RuntimeWorkerLifecycleLeaseHeartbeatOptions & {
    config: RuntimeWorkerPoolConfig;
  },
): Promise<RuntimeWorkerReleaseResult> {
  if (!lifecycle) return { status: "state_lifecycle_unavailable" };
  const current = getActiveRuntimeWorkerLease(db, assistant, leaseToken, nowMs);
  if (!current) return { status: "lease_lost" };
  let lifecycleLeaseGuard: RuntimeWorkerLifecycleLeaseGuard | null = null;
  if (lifecycleHeartbeat) {
    try {
      lifecycleLeaseGuard = startRuntimeWorkerLifecycleLeaseGuard({
        db,
        assistant,
        config: lifecycleHeartbeat.config,
        leaseToken,
        heartbeat: lifecycleHeartbeat,
      });
    } catch {
      return { status: "worker_unavailable" };
    }
    const heartbeatFailure = lifecycleLeaseGuard.failure();
    if (heartbeatFailure) {
      lifecycleLeaseGuard.stop();
      return { status: heartbeatFailure };
    }
  }
  const verifyLifecycleLease = ():
    | { status: "renewed"; assignment: RuntimeWorkerLease }
    | RuntimeWorkerReleaseResult => {
    if (!lifecycleLeaseGuard) {
      return { status: "renewed", assignment: current };
    }
    const renewed = lifecycleLeaseGuard.renewNow();
    if (renewed.status === "renewed") return renewed;
    const quarantined = quarantineRuntimeWorkerLifecycleAmbiguity({
      db,
      assistant,
      workerStackId: current.stack.id,
      leaseToken,
      leaseGeneration: current.lease.lease_generation,
      failureCode: "export_failed",
      nowIso,
    });
    return {
      status: quarantined ? "state_quarantined" : renewed.status,
    };
  };

  try {
    ensureRuntimeWorkerStateCheckpointSchema(db);
    const tenant = stateTenant(assistant);
    const checkpoint = getRuntimeWorkerStateCheckpoint(db, tenant);
    if (!checkpoint) return { status: "state_export_failed" };

    let exportedGeneration: number;
    try {
      if (checkpoint.status !== "exported") {
        await exportRuntimeWorkerStateWithStorage(
          db,
          lifecycle.storage,
          tenant,
          current.stack.id,
          current.lease.lease_generation,
          checkpoint.generation,
          stateOperationId(
            "export",
            assistant,
            current.stack.id,
            checkpoint.generation,
          ),
          nowIso,
        );
      }
      const leaseStatus = verifyLifecycleLease();
      if (leaseStatus.status !== "renewed") return leaseStatus;
      exportedGeneration = assertRuntimeWorkerStateExportedForRelease(
        db,
        tenant,
        current.stack.id,
      ).generation;
    } catch (error) {
      const failedCheckpoint = getRuntimeWorkerStateCheckpoint(db, tenant);
      return {
        status:
          failedCheckpoint?.status === "quarantined" ||
          (error instanceof RuntimeWorkerStateError &&
            error.code === "quarantined")
            ? "state_quarantined"
            : "state_export_failed",
      };
    }

    try {
      await lifecycle.sanitize({
        assistant,
        workerStackId: current.stack.id,
        leaseGeneration: current.lease.lease_generation,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      });
    } catch {
      return { status: "sanitization_failed" };
    }
    {
      const leaseStatus = verifyLifecycleLease();
      if (leaseStatus.status !== "renewed") return leaseStatus;
    }

    try {
      await lifecycle.revokeAuthority({
        assistant,
        workerStackId: current.stack.id,
        leaseGeneration: current.lease.lease_generation,
      });
    } catch {
      return { status: "authority_revocation_failed" };
    }
    {
      const leaseStatus = verifyLifecycleLease();
      if (leaseStatus.status !== "renewed") return leaseStatus;
    }

    try {
      const releaseNowMs = lifecycleHeartbeat?.nowMs() ?? nowMs;
      finalizeRuntimeWorkerReleaseCas({
        db,
        assistant,
        workerStackId: current.stack.id,
        leaseToken,
        leaseGeneration: current.lease.lease_generation,
        stateGeneration: exportedGeneration,
        nowMs: releaseNowMs,
        nowIso,
      });
      return { status: "released" };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Runtime worker lease was lost."
      ) {
        const quarantined = quarantineRuntimeWorkerLifecycleAmbiguity({
          db,
          assistant,
          workerStackId: current.stack.id,
          leaseToken,
          leaseGeneration: current.lease.lease_generation,
          failureCode: "export_failed",
          nowIso,
        });
        return {
          status: quarantined ? "state_quarantined" : "lease_lost",
        };
      }
      throw error;
    }
  } finally {
    lifecycleLeaseGuard?.stop();
  }
}

/**
 * Explicitly discards only the uncheckpointed live state of an exact
 * quarantined worker generation.
 *
 * The last durable object metadata and generation are preserved. The physical
 * worker is sanitized and its authority revoked before one transaction clears
 * both the quarantine marker and the exact lease binding.
 */
export async function discardQuarantinedDispatchedRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  expected: {
    workerStackId: string;
    leaseGeneration: number;
  },
  nowMs: number,
  nowIso: () => string,
  lifecycle?: RuntimeWorkerLifecycleAdapter,
  lifecycleHeartbeat?: RuntimeWorkerLifecycleLeaseHeartbeatOptions & {
    config: RuntimeWorkerPoolConfig;
  },
): Promise<RuntimeWorkerQuarantineDiscardResult> {
  if (!lifecycle) return { status: "state_lifecycle_unavailable" };
  const current = getActiveRuntimeWorkerLease(db, assistant, leaseToken, nowMs);
  if (!current) return { status: "lease_lost" };
  if (
    current.stack.id !== expected.workerStackId ||
    current.lease.lease_generation !== expected.leaseGeneration
  ) {
    return { status: "binding_mismatch" };
  }

  ensureRuntimeWorkerStateCheckpointSchema(db);
  const checkpoint = getRuntimeWorkerStateCheckpoint(
    db,
    stateTenant(assistant),
  );
  if (!checkpoint || checkpoint.status !== "quarantined") {
    return { status: "not_quarantined" };
  }
  if (
    checkpoint.worker_stack_id !== expected.workerStackId ||
    checkpoint.failure_code === null
  ) {
    return { status: "binding_mismatch" };
  }

  let lifecycleLeaseGuard: RuntimeWorkerLifecycleLeaseGuard | null = null;
  if (lifecycleHeartbeat) {
    try {
      lifecycleLeaseGuard = startRuntimeWorkerLifecycleLeaseGuard({
        db,
        assistant,
        config: lifecycleHeartbeat.config,
        leaseToken,
        heartbeat: lifecycleHeartbeat,
      });
    } catch {
      return { status: "worker_unavailable" };
    }
    const heartbeatFailure = lifecycleLeaseGuard.failure();
    if (heartbeatFailure) {
      lifecycleLeaseGuard.stop();
      return { status: heartbeatFailure };
    }
  }
  const verifyLifecycleLease = ():
    | { status: "renewed"; assignment: RuntimeWorkerLease }
    | RuntimeWorkerReleaseResult => {
    if (!lifecycleLeaseGuard) {
      return { status: "renewed", assignment: current };
    }
    const renewed = lifecycleLeaseGuard.renewNow();
    return renewed.status === "renewed"
      ? renewed
      : { status: renewed.status };
  };

  try {
    try {
      await lifecycle.sanitize({
        assistant,
        workerStackId: expected.workerStackId,
        leaseGeneration: expected.leaseGeneration,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      });
    } catch {
      return { status: "sanitization_failed" };
    }
    {
      const leaseStatus = verifyLifecycleLease();
      if (leaseStatus.status !== "renewed") return leaseStatus;
    }

    try {
      await lifecycle.revokeAuthority({
        assistant,
        workerStackId: expected.workerStackId,
        leaseGeneration: expected.leaseGeneration,
      });
    } catch {
      return { status: "authority_revocation_failed" };
    }
    {
      const leaseStatus = verifyLifecycleLease();
      if (leaseStatus.status !== "renewed") return leaseStatus;
    }

    const releaseNowMs = lifecycleHeartbeat?.nowMs() ?? nowMs;
    try {
      finalizeRuntimeWorkerQuarantineDiscardCas({
        db,
        assistant,
        workerStackId: expected.workerStackId,
        leaseToken,
        leaseGeneration: expected.leaseGeneration,
        stateGeneration: checkpoint.generation,
        failureCode: checkpoint.failure_code,
        operationId: checkpoint.operation_id,
        nowMs: releaseNowMs,
        nowIso,
      });
      return { status: "released" };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Runtime worker quarantine recovery was lost."
      ) {
        return { status: "lease_lost" };
      }
      throw error;
    }
  } finally {
    lifecycleLeaseGuard?.stop();
  }
}

/**
 * Atomically releases an exact worker generation, advances its exported state
 * checkpoint, and marks the physical worker unbound/sanitized.
 *
 * The external drain/export/sanitize/revoke sequence runs before this point.
 * This final CAS prevents a stale coordinator from clearing a newer lease if
 * ownership changes between those network operations and the DB write.
 */
function finalizeRuntimeWorkerReleaseCas(input: {
  db: Database;
  assistant: RuntimeWorkerLeaseAssistant;
  workerStackId: string;
  leaseToken: string;
  leaseGeneration: number;
  stateGeneration: number;
  nowMs: number;
  nowIso: () => string;
}): void {
  const timestamp = input.nowIso();
  input.db
    .transaction(() => {
      const checkpoint = input.db
        .query(
          `UPDATE runtime_worker_state_checkpoints
           SET status = 'checkpointed',
               worker_stack_id = NULL,
               operation_id = NULL,
               restored_generation = NULL,
               updated_at = ?
           WHERE org_id = ?
             AND assistant_id = ?
             AND status = 'exported'
             AND worker_stack_id = ?
             AND generation = ?`,
        )
        .run(
          timestamp,
          input.assistant.org_id,
          input.assistant.id,
          input.workerStackId,
          input.stateGeneration,
        );
      if (checkpoint.changes !== 1) {
        throw new Error("Runtime worker lease was lost.");
      }

      const lease = input.db
        .query(
          `UPDATE runtime_worker_leases
           SET assistant_id = NULL,
               org_id = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               released_at = ?,
               sanitized_at = ?,
               updated_at = ?
           WHERE runtime_stack_id = ?
             AND assistant_id = ?
             AND org_id = ?
             AND lease_token = ?
             AND lease_generation = ?`,
        )
        .run(
          input.nowMs,
          input.nowMs,
          timestamp,
          input.workerStackId,
          input.assistant.id,
          input.assistant.org_id,
          input.leaseToken,
          input.leaseGeneration,
        );
      if (lease.changes !== 1) {
        throw new Error("Runtime worker lease was lost.");
      }
    })
    .immediate();
}

function finalizeRuntimeWorkerQuarantineDiscardCas(input: {
  db: Database;
  assistant: RuntimeWorkerLeaseAssistant;
  workerStackId: string;
  leaseToken: string;
  leaseGeneration: number;
  stateGeneration: number;
  failureCode: string;
  operationId: string | null;
  nowMs: number;
  nowIso: () => string;
}): void {
  const timestamp = input.nowIso();
  input.db
    .transaction(() => {
      const checkpoint = input.db
        .query(
          `UPDATE runtime_worker_state_checkpoints
           SET status = 'checkpointed',
               worker_stack_id = NULL,
               operation_id = NULL,
               restored_generation = NULL,
               failure_code = NULL,
               updated_at = ?
           WHERE org_id = ?
             AND assistant_id = ?
             AND generation = ?
             AND status = 'quarantined'
             AND worker_stack_id = ?
             AND failure_code = ?
             AND (
               (operation_id IS NULL AND ? IS NULL)
               OR operation_id = ?
             )`,
        )
        .run(
          timestamp,
          input.assistant.org_id,
          input.assistant.id,
          input.stateGeneration,
          input.workerStackId,
          input.failureCode,
          input.operationId,
          input.operationId,
        );
      if (checkpoint.changes !== 1) {
        throw new Error("Runtime worker quarantine recovery was lost.");
      }

      const lease = input.db
        .query(
          `UPDATE runtime_worker_leases
           SET assistant_id = NULL,
               org_id = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               released_at = ?,
               sanitized_at = ?,
               updated_at = ?
           WHERE runtime_stack_id = ?
             AND assistant_id = ?
             AND org_id = ?
             AND lease_token = ?
             AND lease_generation = ?
             AND lease_expires_at > ?`,
        )
        .run(
          input.nowMs,
          input.nowMs,
          timestamp,
          input.workerStackId,
          input.assistant.id,
          input.assistant.org_id,
          input.leaseToken,
          input.leaseGeneration,
          input.nowMs,
        );
      if (lease.changes !== 1) {
        throw new Error("Runtime worker quarantine recovery was lost.");
      }
    })
    .immediate();
}
