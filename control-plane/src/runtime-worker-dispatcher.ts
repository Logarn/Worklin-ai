import type { Database } from "bun:sqlite";

import {
  claimRuntimeWorkerLease,
  getActiveRuntimeWorkerLease,
  releaseRuntimeWorkerLease,
  renewRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
  type RuntimeWorkerLease,
  type RuntimeWorkerLeaseAssistant,
  type RuntimeWorkerStackRow,
} from "./runtime-worker-leases.js";

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
        | "assistant_busy";
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
  | { status: "released" };

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
      .query<
        CandidateStackRecord,
        [string]
      >(
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
  if (!record.last_health_status || !/^2\d\d$/.test(record.last_health_status)) {
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
    .query<
      WorkerLeaseState,
      []
    >(
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

export function dispatchRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  config: RuntimeWorkerPoolConfig,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
): RuntimeWorkerDispatchResult {
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
    return {
      status: "leased",
      assignment: claim.assignment,
      telemetry: updatedTelemetry,
    };
  }
  return {
    status: "unavailable",
    reason:
      claim.reason === "acquired" ? "capacity_exhausted" : claim.reason,
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
): RuntimeWorkerRenewResult {
  if (!config.enabled) return { status: "disabled" };
  const current = getActiveRuntimeWorkerLease(
    db,
    assistant,
    leaseToken,
    nowMs,
  );
  if (!current) return { status: "lease_lost" };
  const candidate = inspectRuntimeWorkerCandidates(db, config).find(
    ({ stackId }) => stackId === current.stack.id,
  );
  if (!candidate || candidate.readiness !== "ready") {
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

export function releaseDispatchedRuntimeWorker(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
): RuntimeWorkerReleaseResult {
  try {
    releaseRuntimeWorkerLease(
      db,
      assistant,
      leaseToken,
      nowMs,
      nowIso,
    );
    return { status: "released" };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Runtime worker lease was lost."
    ) {
      return { status: "lease_lost" };
    }
    throw error;
  }
}
