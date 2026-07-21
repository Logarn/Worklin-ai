import type { Database } from "bun:sqlite";

type EnvLike = Record<string, string | undefined>;

export const CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV =
  "WORKLIN_CONTROL_PLANE_EXPECTED_REPLICA_COUNT";
export const RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV =
  "RAILWAY_DEPLOYMENT_ID";
export const RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV =
  "RAILWAY_REPLICA_ID";
export const RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV =
  "WORKLIN_RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS";
export const RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV =
  "WORKLIN_RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS";

const DEFAULT_OWNERSHIP_TTL_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

export interface RuntimeWorkerCoordinatorOwnershipConfig {
  enabled: boolean;
  deploymentId: string;
  replicaId: string;
  ownershipTtlMs: number;
  heartbeatMs: number;
}

export interface RuntimeWorkerCoordinatorOwnerIdentity {
  ownerId: string;
  deploymentId: string;
  replicaId: string;
}

export interface RuntimeWorkerCoordinatorOwnershipBinding
  extends RuntimeWorkerCoordinatorOwnerIdentity {
  epoch: number;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

export interface RuntimeWorkerCoordinatorOwnershipLiveness {
  readonly binding: RuntimeWorkerCoordinatorOwnershipBinding;
  isLive(): boolean;
}

export type RuntimeWorkerCoordinatorOwnershipAcquireResult =
  | {
      status: "acquired";
      binding: RuntimeWorkerCoordinatorOwnershipBinding;
      takeover: boolean;
    }
  | {
      status: "unavailable";
      reason: "active_owner" | "contended";
      retryAfterMs: number | null;
    };

export type RuntimeWorkerCoordinatorOwnershipRenewResult =
  | {
      status: "renewed";
      binding: RuntimeWorkerCoordinatorOwnershipBinding;
    }
  | { status: "lost" };

export type RuntimeWorkerCoordinatorOwnershipReleaseResult =
  | { status: "released"; epoch: number }
  | { status: "lost" };

interface RuntimeWorkerCoordinatorOwnershipRow {
  owner_id: string | null;
  deployment_id: string | null;
  replica_id: string | null;
  epoch: number;
  acquired_at: number | null;
  heartbeat_at: number | null;
  expires_at: number | null;
  released_at: number | null;
  updated_at: string;
}

export function ensureRuntimeWorkerCoordinatorOwnershipSchema(
  db: Database,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_worker_coordinator_ownership (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      owner_id TEXT,
      deployment_id TEXT,
      replica_id TEXT,
      epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
      acquired_at INTEGER,
      heartbeat_at INTEGER,
      expires_at INTEGER,
      released_at INTEGER,
      updated_at TEXT NOT NULL,
      CHECK(
        (
          owner_id IS NULL
          AND deployment_id IS NULL
          AND replica_id IS NULL
          AND acquired_at IS NULL
          AND heartbeat_at IS NULL
          AND expires_at IS NULL
        )
        OR (
          owner_id IS NOT NULL
          AND deployment_id IS NOT NULL
          AND replica_id IS NOT NULL
          AND acquired_at IS NOT NULL
          AND heartbeat_at IS NOT NULL
          AND expires_at IS NOT NULL
          AND epoch > 0
          AND acquired_at <= heartbeat_at
          AND heartbeat_at < expires_at
        )
      )
    );
  `);
}

export function runtimeWorkerCoordinatorOwnershipConfigFromEnv(
  rawEnv: EnvLike,
  poolEnabled: boolean,
): RuntimeWorkerCoordinatorOwnershipConfig {
  if (!poolEnabled) {
    return Object.freeze({
      enabled: false,
      deploymentId: "",
      replicaId: "",
      ownershipTtlMs: DEFAULT_OWNERSHIP_TTL_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
    });
  }

  const expectedReplicaCount = strictPositiveIntegerEnv(
    CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV,
    rawEnv[CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV],
  );
  if (expectedReplicaCount !== 1) {
    throw new Error(
      `${CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV} must be exactly 1 when the runtime worker pool is enabled.`,
    );
  }

  const deploymentId = requiredOpaqueEnv(
    RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV,
    rawEnv[RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV],
  );
  const replicaId = requiredOpaqueEnv(
    RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV,
    rawEnv[RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV],
  );
  const ownershipTtlMs = optionalPositiveIntegerEnv(
    RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV,
    rawEnv[RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV],
    DEFAULT_OWNERSHIP_TTL_MS,
  );
  const heartbeatMs = optionalPositiveIntegerEnv(
    RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV,
    rawEnv[RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV],
    DEFAULT_HEARTBEAT_MS,
  );
  if (heartbeatMs * 3 > ownershipTtlMs) {
    throw new Error(
      `${RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV} must be at most one third of ${RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV}.`,
    );
  }

  return Object.freeze({
    enabled: true,
    deploymentId,
    replicaId,
    ownershipTtlMs,
    heartbeatMs,
  });
}

export function acquireRuntimeWorkerCoordinatorOwnership(
  db: Database,
  identity: RuntimeWorkerCoordinatorOwnerIdentity,
  nowMs: number,
  ownershipTtlMs: number,
  nowIso: () => string,
): RuntimeWorkerCoordinatorOwnershipAcquireResult {
  assertOwnerIdentity(identity);
  const expiresAtMs = checkedExpiry(nowMs, ownershipTtlMs);
  try {
    ensureRuntimeWorkerCoordinatorOwnershipSchema(db);
  } catch (error) {
    if (sqliteBusy(error)) {
      return Object.freeze({
        status: "unavailable",
        reason: "contended",
        retryAfterMs: null,
      });
    }
    throw error;
  }

  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const existing = getOwnershipRow(db);
    const timestamp = nowIso();
    assertIsoTimestamp(timestamp);

    if (!existing) {
      db.query(
        `INSERT INTO runtime_worker_coordinator_ownership (
           singleton,
           owner_id,
           deployment_id,
           replica_id,
           epoch,
           acquired_at,
           heartbeat_at,
           expires_at,
           released_at,
           updated_at
         ) VALUES (1, ?, ?, ?, 1, ?, ?, ?, NULL, ?)`,
      ).run(
        identity.ownerId,
        identity.deploymentId,
        identity.replicaId,
        nowMs,
        nowMs,
        expiresAtMs,
        timestamp,
      );
      const binding = bindingFromRow(getRequiredOwnershipRow(db));
      db.exec("COMMIT");
      began = false;
      return Object.freeze({
        status: "acquired",
        binding,
        takeover: false,
      });
    }

    if (
      existing.owner_id !== null &&
      existing.expires_at !== null &&
      existing.expires_at > nowMs
    ) {
      if (!rowHasIdentity(existing, identity)) {
        const retryAfterMs = Math.max(1, existing.expires_at - nowMs);
        db.exec("COMMIT");
        began = false;
        return Object.freeze({
          status: "unavailable",
          reason: "active_owner",
          retryAfterMs,
        });
      }
      const renewed = updateExactOwnershipHeartbeat(
        db,
        identity,
        existing.epoch,
        nowMs,
        expiresAtMs,
        timestamp,
      );
      if (renewed !== 1) {
        throw new Error("Runtime worker coordinator ownership changed.");
      }
      const binding = bindingFromRow(getRequiredOwnershipRow(db));
      db.exec("COMMIT");
      began = false;
      return Object.freeze({
        status: "acquired",
        binding,
        takeover: false,
      });
    }

    const nextEpoch = checkedNextEpoch(existing.epoch);
    const takeover = existing.owner_id !== null;
    const updated = db
      .query(
        `UPDATE runtime_worker_coordinator_ownership
         SET owner_id = ?,
             deployment_id = ?,
             replica_id = ?,
             epoch = ?,
             acquired_at = ?,
             heartbeat_at = ?,
             expires_at = ?,
             released_at = NULL,
             updated_at = ?
         WHERE singleton = 1
           AND epoch = ?
           AND (owner_id IS NULL OR expires_at <= ?)`,
      )
      .run(
        identity.ownerId,
        identity.deploymentId,
        identity.replicaId,
        nextEpoch,
        nowMs,
        nowMs,
        expiresAtMs,
        timestamp,
        existing.epoch,
        nowMs,
      ).changes;
    if (updated !== 1) {
      throw new Error("Runtime worker coordinator ownership changed.");
    }
    const binding = bindingFromRow(getRequiredOwnershipRow(db));
    db.exec("COMMIT");
    began = false;
    return Object.freeze({ status: "acquired", binding, takeover });
  } catch (error) {
    if (began) rollback(db);
    if (sqliteBusy(error)) {
      return Object.freeze({
        status: "unavailable",
        reason: "contended",
        retryAfterMs: null,
      });
    }
    throw error;
  }
}

export function renewRuntimeWorkerCoordinatorOwnership(
  db: Database,
  binding: RuntimeWorkerCoordinatorOwnershipBinding,
  nowMs: number,
  ownershipTtlMs: number,
  nowIso: () => string,
): RuntimeWorkerCoordinatorOwnershipRenewResult {
  assertBinding(binding);
  const expiresAtMs = checkedExpiry(nowMs, ownershipTtlMs);
  const timestamp = nowIso();
  assertIsoTimestamp(timestamp);
  const changed = updateExactOwnershipHeartbeat(
    db,
    binding,
    binding.epoch,
    nowMs,
    expiresAtMs,
    timestamp,
  );
  if (changed !== 1) return Object.freeze({ status: "lost" });
  const row = getOwnershipRow(db);
  if (!row || !rowMatchesBinding(row, binding)) {
    return Object.freeze({ status: "lost" });
  }
  return Object.freeze({
    status: "renewed",
    binding: bindingFromRow(row),
  });
}

export function releaseRuntimeWorkerCoordinatorOwnership(
  db: Database,
  binding: RuntimeWorkerCoordinatorOwnershipBinding,
  nowMs: number,
  nowIso: () => string,
): RuntimeWorkerCoordinatorOwnershipReleaseResult {
  assertBinding(binding);
  assertTimestamp(nowMs);
  const timestamp = nowIso();
  assertIsoTimestamp(timestamp);
  const changed = db
    .query(
      `UPDATE runtime_worker_coordinator_ownership
       SET owner_id = NULL,
           deployment_id = NULL,
           replica_id = NULL,
           acquired_at = NULL,
           heartbeat_at = NULL,
           expires_at = NULL,
           released_at = ?,
           updated_at = ?
       WHERE singleton = 1
         AND owner_id = ?
         AND deployment_id = ?
         AND replica_id = ?
         AND epoch = ?`,
    )
    .run(
      nowMs,
      timestamp,
      binding.ownerId,
      binding.deploymentId,
      binding.replicaId,
      binding.epoch,
    ).changes;
  return changed === 1
    ? Object.freeze({ status: "released", epoch: binding.epoch })
    : Object.freeze({ status: "lost" });
}

export function runtimeWorkerCoordinatorOwnershipIsLive(
  db: Database,
  binding: RuntimeWorkerCoordinatorOwnershipBinding,
  nowMs: number,
): boolean {
  assertBinding(binding);
  assertTimestamp(nowMs);
  return (
    db
      .query<
        { found: number },
        [string, string, string, number, number]
      >(
        `SELECT 1 AS found
         FROM runtime_worker_coordinator_ownership
         WHERE singleton = 1
           AND owner_id = ?
           AND deployment_id = ?
           AND replica_id = ?
           AND epoch = ?
           AND expires_at > ?`,
      )
      .get(
        binding.ownerId,
        binding.deploymentId,
        binding.replicaId,
        binding.epoch,
        nowMs,
      ) !== null
  );
}

export class RuntimeWorkerCoordinatorOwnershipGuard
  implements RuntimeWorkerCoordinatorOwnershipLiveness
{
  private live = true;
  private currentBinding: RuntimeWorkerCoordinatorOwnershipBinding;

  constructor(
    private readonly db: Database,
    binding: RuntimeWorkerCoordinatorOwnershipBinding,
    private readonly nowMs: () => number = Date.now,
  ) {
    assertBinding(binding);
    this.currentBinding = binding;
  }

  get binding(): RuntimeWorkerCoordinatorOwnershipBinding {
    return this.currentBinding;
  }

  isLive(): boolean {
    if (!this.live) return false;
    try {
      if (
        runtimeWorkerCoordinatorOwnershipIsLive(
          this.db,
          this.currentBinding,
          this.nowMs(),
        )
      ) {
        return true;
      }
    } catch {
      // Database uncertainty is ownership loss for routing purposes.
    }
    this.live = false;
    return false;
  }

  renew(
    ownershipTtlMs: number,
    nowIso: () => string,
  ): RuntimeWorkerCoordinatorOwnershipRenewResult {
    if (!this.live) return Object.freeze({ status: "lost" });
    let result: RuntimeWorkerCoordinatorOwnershipRenewResult;
    try {
      result = renewRuntimeWorkerCoordinatorOwnership(
        this.db,
        this.currentBinding,
        this.nowMs(),
        ownershipTtlMs,
        nowIso,
      );
    } catch {
      this.live = false;
      return Object.freeze({ status: "lost" });
    }
    if (result.status === "renewed") {
      this.currentBinding = result.binding;
      return result;
    }
    this.live = false;
    return result;
  }

  fence(): void {
    this.live = false;
  }

  release(
    nowIso: () => string,
  ): RuntimeWorkerCoordinatorOwnershipReleaseResult {
    this.live = false;
    try {
      return releaseRuntimeWorkerCoordinatorOwnership(
        this.db,
        this.currentBinding,
        this.nowMs(),
        nowIso,
      );
    } catch {
      return Object.freeze({ status: "lost" });
    }
  }
}

export class RuntimeWorkerCoordinatorRequestAbortRegistry {
  private readonly controllers = new Set<AbortController>();

  register(controller: AbortController): () => void {
    if (controller.signal.aborted) {
      throw new Error("Pooled runtime request abort controller is inactive.");
    }
    this.controllers.add(controller);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.controllers.delete(controller);
    };
  }

  abortAll(reason: Error): number {
    const controllers = [...this.controllers];
    this.controllers.clear();
    for (const controller of controllers) controller.abort(reason);
    return controllers.length;
  }

  get activeCount(): number {
    return this.controllers.size;
  }
}

function updateExactOwnershipHeartbeat(
  db: Database,
  identity: RuntimeWorkerCoordinatorOwnerIdentity,
  epoch: number,
  nowMs: number,
  expiresAtMs: number,
  timestamp: string,
): number {
  return db
    .query(
      `UPDATE runtime_worker_coordinator_ownership
       SET heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE singleton = 1
         AND owner_id = ?
         AND deployment_id = ?
         AND replica_id = ?
         AND epoch = ?
         AND heartbeat_at <= ?
         AND expires_at > ?`,
    )
    .run(
      nowMs,
      expiresAtMs,
      timestamp,
      identity.ownerId,
      identity.deploymentId,
      identity.replicaId,
      epoch,
      nowMs,
      nowMs,
    ).changes;
}

function getOwnershipRow(
  db: Database,
): RuntimeWorkerCoordinatorOwnershipRow | null {
  return (
    db
      .query<RuntimeWorkerCoordinatorOwnershipRow, []>(
        `SELECT
           owner_id,
           deployment_id,
           replica_id,
           epoch,
           acquired_at,
           heartbeat_at,
           expires_at,
           released_at,
           updated_at
         FROM runtime_worker_coordinator_ownership
         WHERE singleton = 1`,
      )
      .get() ?? null
  );
}

function getRequiredOwnershipRow(
  db: Database,
): RuntimeWorkerCoordinatorOwnershipRow {
  const row = getOwnershipRow(db);
  if (!row) throw new Error("Runtime worker coordinator ownership is missing.");
  return row;
}

function bindingFromRow(
  row: RuntimeWorkerCoordinatorOwnershipRow,
): RuntimeWorkerCoordinatorOwnershipBinding {
  if (
    row.owner_id === null ||
    row.deployment_id === null ||
    row.replica_id === null ||
    row.acquired_at === null ||
    row.heartbeat_at === null ||
    row.expires_at === null
  ) {
    throw new Error("Runtime worker coordinator ownership is inactive.");
  }
  return Object.freeze({
    ownerId: row.owner_id,
    deploymentId: row.deployment_id,
    replicaId: row.replica_id,
    epoch: row.epoch,
    acquiredAtMs: row.acquired_at,
    heartbeatAtMs: row.heartbeat_at,
    expiresAtMs: row.expires_at,
  });
}

function rowHasIdentity(
  row: RuntimeWorkerCoordinatorOwnershipRow,
  identity: RuntimeWorkerCoordinatorOwnerIdentity,
): boolean {
  return (
    row.owner_id === identity.ownerId &&
    row.deployment_id === identity.deploymentId &&
    row.replica_id === identity.replicaId
  );
}

function rowMatchesBinding(
  row: RuntimeWorkerCoordinatorOwnershipRow,
  binding: RuntimeWorkerCoordinatorOwnershipBinding,
): boolean {
  return rowHasIdentity(row, binding) && row.epoch === binding.epoch;
}

function assertOwnerIdentity(
  identity: RuntimeWorkerCoordinatorOwnerIdentity,
): void {
  for (const [name, value] of [
    ["owner ID", identity.ownerId],
    ["deployment ID", identity.deploymentId],
    ["replica ID", identity.replicaId],
  ] as const) {
    if (!validOpaqueId(value)) {
      throw new Error(`Runtime worker coordinator ${name} is invalid.`);
    }
  }
}

function assertBinding(
  binding: RuntimeWorkerCoordinatorOwnershipBinding,
): void {
  assertOwnerIdentity(binding);
  if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1) {
    throw new Error("Runtime worker coordinator epoch is invalid.");
  }
  for (const value of [
    binding.acquiredAtMs,
    binding.heartbeatAtMs,
    binding.expiresAtMs,
  ]) {
    assertTimestamp(value);
  }
}

function validOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function requiredOpaqueEnv(name: string, value: string | undefined): string {
  if (!value || !validOpaqueId(value)) {
    throw new Error(`${name} must be a non-empty opaque identifier.`);
  }
  return value;
}

function strictPositiveIntegerEnv(
  name: string,
  value: string | undefined,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return parsed;
}

function optionalPositiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  return value === undefined || value === ""
    ? fallback
    : strictPositiveIntegerEnv(name, value);
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Runtime worker coordinator timestamp is invalid.");
  }
}

function checkedExpiry(nowMs: number, ownershipTtlMs: number): number {
  assertTimestamp(nowMs);
  if (!Number.isSafeInteger(ownershipTtlMs) || ownershipTtlMs < 1) {
    throw new Error("Runtime worker coordinator ownership TTL is invalid.");
  }
  const expiresAtMs = nowMs + ownershipTtlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new Error("Runtime worker coordinator ownership expiry is invalid.");
  }
  return expiresAtMs;
}

function checkedNextEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Runtime worker coordinator epoch is invalid.");
  }
  const next = epoch + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Runtime worker coordinator epoch is exhausted.");
  }
  return next;
}

function assertIsoTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error("Runtime worker coordinator ISO timestamp is invalid.");
  }
}

function rollback(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function sqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
