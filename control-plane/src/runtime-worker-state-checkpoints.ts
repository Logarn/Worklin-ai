import type { Database } from "bun:sqlite";

export const RUNTIME_WORKER_STATE_FORMAT = "vbundle-v1" as const;
export const RUNTIME_WORKER_STATE_PROVIDER = "gcs" as const;

export type RuntimeWorkerStateStatus =
  | "checkpointed"
  | "restoring"
  | "ready"
  | "exporting"
  | "exported"
  | "quarantined";

export type RuntimeWorkerStateFailure =
  | "storage_unavailable"
  | "restore_failed"
  | "checksum_mismatch"
  | "export_failed";

export type RuntimeWorkerStateErrorCode =
  | "invalid_input"
  | "concurrent_operation"
  | "stale_generation"
  | "state_not_ready"
  | "state_not_exported"
  | "quarantined"
  | "cross_tenant_object"
  | "object_replay"
  | "checksum_mismatch";

export interface RuntimeWorkerStateTenant {
  orgId: string;
  assistantId: string;
}

export interface RuntimeWorkerStateObject {
  provider: typeof RUNTIME_WORKER_STATE_PROVIDER;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  byteSize: number;
  format: typeof RUNTIME_WORKER_STATE_FORMAT;
}

export interface RuntimeWorkerStateCheckpointRow {
  org_id: string;
  assistant_id: string;
  generation: number;
  status: RuntimeWorkerStateStatus;
  worker_stack_id: string | null;
  operation_id: string | null;
  restored_generation: number | null;
  object_provider: typeof RUNTIME_WORKER_STATE_PROVIDER | null;
  object_bucket: string | null;
  object_key: string | null;
  checksum_sha256: string | null;
  byte_size: number | null;
  object_format: typeof RUNTIME_WORKER_STATE_FORMAT | null;
  failure_code: RuntimeWorkerStateFailure | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeWorkerStateRestorePlan {
  generation: number;
  object: RuntimeWorkerStateObject | null;
  idempotent: boolean;
}

export interface RuntimeWorkerStateExportPlan {
  currentGeneration: number;
  nextGeneration: number;
  objectKey: string;
  idempotent: boolean;
}

export interface RuntimeWorkerStateStorage {
  restore(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    generation: number;
    object: RuntimeWorkerStateObject | null;
  }): Promise<{ checksumSha256: string | null }>;
  export(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    currentGeneration: number;
    nextGeneration: number;
    objectKey: string;
  }): Promise<RuntimeWorkerStateObject>;
}

export class RuntimeWorkerStateError extends Error {
  constructor(
    readonly code: RuntimeWorkerStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeWorkerStateError";
  }
}

export function ensureRuntimeWorkerStateCheckpointSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_worker_state_checkpoints (
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
      status TEXT NOT NULL CHECK(status IN (
        'checkpointed',
        'restoring',
        'ready',
        'exporting',
        'exported',
        'quarantined'
      )),
      worker_stack_id TEXT,
      operation_id TEXT,
      restored_generation INTEGER CHECK(
        restored_generation IS NULL OR restored_generation >= 0
      ),
      object_provider TEXT CHECK(
        object_provider IS NULL OR object_provider = 'gcs'
      ),
      object_bucket TEXT,
      object_key TEXT,
      checksum_sha256 TEXT,
      byte_size INTEGER CHECK(byte_size IS NULL OR byte_size > 0),
      object_format TEXT CHECK(
        object_format IS NULL OR object_format = 'vbundle-v1'
      ),
      failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
        'storage_unavailable',
        'restore_failed',
        'checksum_mismatch',
        'export_failed'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(org_id, assistant_id),
      CHECK(
        (
          object_provider IS NULL
          AND object_bucket IS NULL
          AND object_key IS NULL
          AND checksum_sha256 IS NULL
          AND byte_size IS NULL
          AND object_format IS NULL
        )
        OR (
          object_provider IS NOT NULL
          AND object_bucket IS NOT NULL
          AND object_key IS NOT NULL
          AND checksum_sha256 IS NOT NULL
          AND byte_size IS NOT NULL
          AND object_format IS NOT NULL
        )
      )
    );

    CREATE TABLE IF NOT EXISTS runtime_worker_state_objects (
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      object_provider TEXT NOT NULL CHECK(object_provider = 'gcs'),
      object_bucket TEXT NOT NULL,
      object_key TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      object_format TEXT NOT NULL CHECK(object_format = 'vbundle-v1'),
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id, assistant_id, generation),
      UNIQUE(object_provider, object_bucket, object_key)
    );
  `);
}

export function buildRuntimeWorkerStateObjectKey(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
): string {
  const normalized = assertTenant(tenant);
  assertGeneration(generation, false);
  return [
    "tenant-state",
    encodeURIComponent(normalized.orgId),
    encodeURIComponent(normalized.assistantId),
    `generation-${generation}.vbundle`,
  ].join("/");
}

export function getRuntimeWorkerStateCheckpoint(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
): RuntimeWorkerStateCheckpointRow | null {
  const normalized = assertTenant(tenant);
  return (
    db
      .query<
        RuntimeWorkerStateCheckpointRow,
        [string, string]
      >(
        `SELECT *
         FROM runtime_worker_state_checkpoints
         WHERE org_id = ? AND assistant_id = ?`,
      )
      .get(normalized.orgId, normalized.assistantId) ?? null
  );
}

export function beginRuntimeWorkerStateRestore(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  expectedGeneration: number,
  operationId: string,
  nowIso: () => string,
): RuntimeWorkerStateRestorePlan {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(expectedGeneration, true);

  return db
    .transaction((): RuntimeWorkerStateRestorePlan => {
      const existing = getRuntimeWorkerStateCheckpoint(db, normalized);
      if (!existing) {
        if (expectedGeneration !== 0) {
          throw stateError(
            "stale_generation",
            "Runtime state generation does not exist.",
          );
        }
        const timestamp = nowIso();
        db.query(
          `INSERT INTO runtime_worker_state_checkpoints (
             org_id,
             assistant_id,
             generation,
             status,
             worker_stack_id,
             operation_id,
             restored_generation,
             failure_code,
             created_at,
             updated_at
           ) VALUES (?, ?, 0, 'restoring', ?, ?, NULL, NULL, ?, ?)`,
        ).run(
          normalized.orgId,
          normalized.assistantId,
          worker,
          operation,
          timestamp,
          timestamp,
        );
        return { generation: 0, object: null, idempotent: false };
      }

      assertNotQuarantined(existing);
      if (existing.generation !== expectedGeneration) {
        throw stateError(
          "stale_generation",
          "Runtime state generation is stale.",
        );
      }
      if (existing.status === "restoring") {
        if (
          existing.worker_stack_id === worker &&
          existing.operation_id === operation
        ) {
          return {
            generation: existing.generation,
            object: objectFromRow(existing),
            idempotent: true,
          };
        }
        throw stateError(
          "concurrent_operation",
          "Runtime state is already being restored.",
        );
      }
      if (
        existing.status !== "checkpointed" &&
        existing.status !== "exported"
      ) {
        throw stateError(
          "concurrent_operation",
          "Runtime state cannot begin a second restore.",
        );
      }
      const object = objectFromRow(existing);
      if (existing.generation > 0 && !object) {
        throw stateError(
          "state_not_ready",
          "Runtime state metadata is incomplete.",
        );
      }
      db.query(
        `UPDATE runtime_worker_state_checkpoints
         SET status = 'restoring',
             worker_stack_id = ?,
             operation_id = ?,
             restored_generation = NULL,
             failure_code = NULL,
             updated_at = ?
         WHERE org_id = ? AND assistant_id = ?`,
      ).run(
        worker,
        operation,
        nowIso(),
        normalized.orgId,
        normalized.assistantId,
      );
      return {
        generation: existing.generation,
        object,
        idempotent: false,
      };
    })
    .immediate();
}

export function completeRuntimeWorkerStateRestore(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  generation: number,
  operationId: string,
  observedChecksumSha256: string | null,
  nowIso: () => string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(generation, true);

  const outcome = db
    .transaction(
      ():
        | { checkpoint: RuntimeWorkerStateCheckpointRow; error: null }
        | { checkpoint: null; error: RuntimeWorkerStateError } => {
      const row = requireCheckpoint(db, normalized);
      assertOperation(row, "restoring", worker, operation, generation);
      const expectedObject = objectFromRow(row);
      if (expectedObject) {
        const observed = assertChecksum(observedChecksumSha256);
        if (observed !== expectedObject.checksumSha256) {
          quarantine(
            db,
            normalized,
            "checksum_mismatch",
            nowIso,
            worker,
            operation,
          );
          return {
            checkpoint: null,
            error: stateError(
              "checksum_mismatch",
              "Restored runtime state checksum does not match.",
            ),
          };
        }
      } else if (observedChecksumSha256 !== null) {
        throw stateError(
          "invalid_input",
          "Empty state restore must not report an object checksum.",
        );
      }
      db.query(
        `UPDATE runtime_worker_state_checkpoints
         SET status = 'ready',
             operation_id = NULL,
             restored_generation = generation,
             failure_code = NULL,
             updated_at = ?
         WHERE org_id = ? AND assistant_id = ?`,
      ).run(nowIso(), normalized.orgId, normalized.assistantId);
      return {
        checkpoint: requireCheckpoint(db, normalized),
        error: null,
      };
    },
    )
    .immediate();
  if (outcome.error) throw outcome.error;
  return outcome.checkpoint;
}

export function failRuntimeWorkerStateRestore(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  generation: number,
  operationId: string,
  failure: Extract<
    RuntimeWorkerStateFailure,
    "storage_unavailable" | "restore_failed" | "checksum_mismatch"
  >,
  nowIso: () => string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(generation, true);
  const row = requireCheckpoint(db, normalized);
  assertOperation(row, "restoring", worker, operation, generation);
  quarantine(db, normalized, failure, nowIso, worker, operation);
  return requireCheckpoint(db, normalized);
}

export function assertRuntimeWorkerStateReadyForLease(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
): RuntimeWorkerStateCheckpointRow {
  const row = requireCheckpoint(db, assertTenant(tenant));
  const worker = assertOpaqueId(workerStackId, "worker stack");
  assertNotQuarantined(row);
  if (
    row.status !== "ready" ||
    row.worker_stack_id !== worker ||
    row.restored_generation !== row.generation
  ) {
    throw stateError(
      "state_not_ready",
      "Runtime state restore has not reached lease readiness.",
    );
  }
  return row;
}

export function beginRuntimeWorkerStateExport(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  expectedGeneration: number,
  operationId: string,
  nowIso: () => string,
): RuntimeWorkerStateExportPlan {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(expectedGeneration, true);

  return db
    .transaction((): RuntimeWorkerStateExportPlan => {
      const row = requireCheckpoint(db, normalized);
      assertNotQuarantined(row);
      if (row.generation !== expectedGeneration) {
        throw stateError(
          "stale_generation",
          "Runtime state generation is stale.",
        );
      }
      if (row.status === "exporting") {
        if (
          row.worker_stack_id === worker &&
          row.operation_id === operation
        ) {
          return {
            currentGeneration: row.generation,
            nextGeneration: row.generation + 1,
            objectKey: buildRuntimeWorkerStateObjectKey(
              normalized,
              row.generation + 1,
            ),
            idempotent: true,
          };
        }
        throw stateError(
          "concurrent_operation",
          "Runtime state is already being exported.",
        );
      }
      assertRuntimeWorkerStateReadyForLease(db, normalized, worker);
      db.query(
        `UPDATE runtime_worker_state_checkpoints
         SET status = 'exporting',
             operation_id = ?,
             failure_code = NULL,
             updated_at = ?
         WHERE org_id = ? AND assistant_id = ?`,
      ).run(operation, nowIso(), normalized.orgId, normalized.assistantId);
      return {
        currentGeneration: row.generation,
        nextGeneration: row.generation + 1,
        objectKey: buildRuntimeWorkerStateObjectKey(
          normalized,
          row.generation + 1,
        ),
        idempotent: false,
      };
    })
    .immediate();
}

export function completeRuntimeWorkerStateExport(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  currentGeneration: number,
  operationId: string,
  object: RuntimeWorkerStateObject,
  nowIso: () => string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(currentGeneration, true);
  const nextGeneration = currentGeneration + 1;
  const validated = assertObject(normalized, nextGeneration, object);

  return db
    .transaction(() => {
      const row = requireCheckpoint(db, normalized);
      assertOperation(
        row,
        "exporting",
        worker,
        operation,
        currentGeneration,
      );
      const existingOwner = db
        .query<
          { org_id: string; assistant_id: string; generation: number },
          [string, string, string]
        >(
          `SELECT org_id, assistant_id, generation
           FROM runtime_worker_state_objects
           WHERE object_provider = ?
             AND object_bucket = ?
             AND object_key = ?`,
        )
        .get(validated.provider, validated.bucket, validated.objectKey);
      if (existingOwner) {
        const sameGeneration =
          existingOwner.org_id === normalized.orgId &&
          existingOwner.assistant_id === normalized.assistantId &&
          existingOwner.generation === nextGeneration;
        throw stateError(
          sameGeneration ? "object_replay" : "cross_tenant_object",
          "Runtime state object has already been claimed.",
        );
      }
      db.query(
        `INSERT INTO runtime_worker_state_objects (
           org_id,
           assistant_id,
           generation,
           object_provider,
           object_bucket,
           object_key,
           checksum_sha256,
           byte_size,
           object_format,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        normalized.orgId,
        normalized.assistantId,
        nextGeneration,
        validated.provider,
        validated.bucket,
        validated.objectKey,
        validated.checksumSha256,
        validated.byteSize,
        validated.format,
        nowIso(),
      );
      db.query(
        `UPDATE runtime_worker_state_checkpoints
         SET generation = ?,
             status = 'exported',
             operation_id = NULL,
             restored_generation = NULL,
             object_provider = ?,
             object_bucket = ?,
             object_key = ?,
             checksum_sha256 = ?,
             byte_size = ?,
             object_format = ?,
             failure_code = NULL,
             updated_at = ?
         WHERE org_id = ? AND assistant_id = ?`,
      ).run(
        nextGeneration,
        validated.provider,
        validated.bucket,
        validated.objectKey,
        validated.checksumSha256,
        validated.byteSize,
        validated.format,
        nowIso(),
        normalized.orgId,
        normalized.assistantId,
      );
      return requireCheckpoint(db, normalized);
    })
    .immediate();
}

export function failRuntimeWorkerStateExport(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  generation: number,
  operationId: string,
  failure: Extract<
    RuntimeWorkerStateFailure,
    "storage_unavailable" | "export_failed"
  >,
  nowIso: () => string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const operation = assertOpaqueId(operationId, "operation");
  assertGeneration(generation, true);
  const row = requireCheckpoint(db, normalized);
  assertOperation(row, "exporting", worker, operation, generation);
  quarantine(db, normalized, failure, nowIso, worker, operation);
  return requireCheckpoint(db, normalized);
}

export function assertRuntimeWorkerStateExportedForRelease(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  const worker = assertOpaqueId(workerStackId, "worker stack");
  const row = requireCheckpoint(db, normalized);
  assertNotQuarantined(row);
  if (
    row.status !== "exported" ||
    row.worker_stack_id !== worker ||
    row.generation < 1 ||
    !objectFromRow(row)
  ) {
    throw stateError(
      "state_not_exported",
      "Runtime state export must complete before lease release.",
    );
  }
  return row;
}

export function markRuntimeWorkerStateReleased(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  nowIso: () => string,
): RuntimeWorkerStateCheckpointRow {
  const normalized = assertTenant(tenant);
  assertRuntimeWorkerStateExportedForRelease(db, normalized, workerStackId);
  db.query(
    `UPDATE runtime_worker_state_checkpoints
     SET status = 'checkpointed',
         worker_stack_id = NULL,
         operation_id = NULL,
         restored_generation = NULL,
         updated_at = ?
     WHERE org_id = ? AND assistant_id = ?`,
  ).run(nowIso(), normalized.orgId, normalized.assistantId);
  return requireCheckpoint(db, normalized);
}

export async function restoreRuntimeWorkerStateWithStorage(
  db: Database,
  storage: RuntimeWorkerStateStorage,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  expectedGeneration: number,
  operationId: string,
  nowIso: () => string,
): Promise<RuntimeWorkerStateCheckpointRow> {
  const plan = beginRuntimeWorkerStateRestore(
    db,
    tenant,
    workerStackId,
    expectedGeneration,
    operationId,
    nowIso,
  );
  try {
    const result = await storage.restore({
      tenant: assertTenant(tenant),
      workerStackId,
      generation: plan.generation,
      object: plan.object,
    });
    return completeRuntimeWorkerStateRestore(
      db,
      tenant,
      workerStackId,
      plan.generation,
      operationId,
      result.checksumSha256,
      nowIso,
    );
  } catch (error) {
    if (
      error instanceof RuntimeWorkerStateError &&
      error.code === "checksum_mismatch"
    ) {
      throw error;
    }
    failRuntimeWorkerStateRestore(
      db,
      tenant,
      workerStackId,
      plan.generation,
      operationId,
      "storage_unavailable",
      nowIso,
    );
    throw stateError(
      "quarantined",
      "Runtime state storage was unavailable during restore.",
    );
  }
}

export async function exportRuntimeWorkerStateWithStorage(
  db: Database,
  storage: RuntimeWorkerStateStorage,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  expectedGeneration: number,
  operationId: string,
  nowIso: () => string,
): Promise<RuntimeWorkerStateCheckpointRow> {
  const plan = beginRuntimeWorkerStateExport(
    db,
    tenant,
    workerStackId,
    expectedGeneration,
    operationId,
    nowIso,
  );
  try {
    const object = await storage.export({
      tenant: assertTenant(tenant),
      workerStackId,
      currentGeneration: plan.currentGeneration,
      nextGeneration: plan.nextGeneration,
      objectKey: plan.objectKey,
    });
    return completeRuntimeWorkerStateExport(
      db,
      tenant,
      workerStackId,
      plan.currentGeneration,
      operationId,
      object,
      nowIso,
    );
  } catch (error) {
    if (error instanceof RuntimeWorkerStateError) throw error;
    failRuntimeWorkerStateExport(
      db,
      tenant,
      workerStackId,
      plan.currentGeneration,
      operationId,
      "storage_unavailable",
      nowIso,
    );
    throw stateError(
      "quarantined",
      "Runtime state storage was unavailable during export.",
    );
  }
}

function assertTenant(
  tenant: RuntimeWorkerStateTenant,
): RuntimeWorkerStateTenant {
  return {
    orgId: assertOpaqueId(tenant.orgId, "organization"),
    assistantId: assertOpaqueId(tenant.assistantId, "assistant"),
  };
}

function assertOpaqueId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f]/u.test(normalized)) {
    throw stateError("invalid_input", `A valid ${label} id is required.`);
  }
  return normalized;
}

function assertGeneration(generation: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(generation) || generation < minimum) {
    throw stateError("invalid_input", "Runtime state generation is invalid.");
  }
}

function assertChecksum(value: string | null): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw stateError("invalid_input", "A SHA-256 object checksum is required.");
  }
  return normalized;
}

function assertObject(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
  object: RuntimeWorkerStateObject,
): RuntimeWorkerStateObject {
  if (
    object.provider !== RUNTIME_WORKER_STATE_PROVIDER ||
    object.format !== RUNTIME_WORKER_STATE_FORMAT
  ) {
    throw stateError(
      "invalid_input",
      "Runtime state object provider or format is unsupported.",
    );
  }
  const bucket = object.bucket.trim();
  if (
    !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/u.test(bucket) ||
    containsSecretTransport(bucket)
  ) {
    throw stateError("invalid_input", "Runtime state bucket is invalid.");
  }
  const expectedKey = buildRuntimeWorkerStateObjectKey(tenant, generation);
  if (
    object.objectKey !== expectedKey ||
    object.objectKey.length > 1024 ||
    containsSecretTransport(object.objectKey)
  ) {
    throw stateError(
      "cross_tenant_object",
      "Runtime state object is outside the tenant generation namespace.",
    );
  }
  if (!Number.isSafeInteger(object.byteSize) || object.byteSize < 1) {
    throw stateError("invalid_input", "Runtime state object size is invalid.");
  }
  return {
    provider: RUNTIME_WORKER_STATE_PROVIDER,
    bucket,
    objectKey: expectedKey,
    checksumSha256: assertChecksum(object.checksumSha256),
    byteSize: object.byteSize,
    format: RUNTIME_WORKER_STATE_FORMAT,
  };
}

function containsSecretTransport(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("://") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.includes("x-goog-signature") ||
    normalized.includes("googleaccessid") ||
    normalized.includes("credential=") ||
    normalized.includes("token=") ||
    normalized.includes("secret=")
  );
}

function objectFromRow(
  row: RuntimeWorkerStateCheckpointRow,
): RuntimeWorkerStateObject | null {
  if (
    row.object_provider === null ||
    row.object_bucket === null ||
    row.object_key === null ||
    row.checksum_sha256 === null ||
    row.byte_size === null ||
    row.object_format === null
  ) {
    return null;
  }
  return {
    provider: row.object_provider,
    bucket: row.object_bucket,
    objectKey: row.object_key,
    checksumSha256: row.checksum_sha256,
    byteSize: row.byte_size,
    format: row.object_format,
  };
}

function requireCheckpoint(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
): RuntimeWorkerStateCheckpointRow {
  const row = getRuntimeWorkerStateCheckpoint(db, tenant);
  if (!row) {
    throw stateError(
      "state_not_ready",
      "Runtime state checkpoint has not been initialized.",
    );
  }
  return row;
}

function assertNotQuarantined(row: RuntimeWorkerStateCheckpointRow): void {
  if (row.status === "quarantined") {
    throw stateError(
      "quarantined",
      "Runtime state is quarantined and requires operator recovery.",
    );
  }
}

function assertOperation(
  row: RuntimeWorkerStateCheckpointRow,
  status: "restoring" | "exporting",
  workerStackId: string,
  operationId: string,
  generation: number,
): void {
  assertNotQuarantined(row);
  if (row.generation !== generation) {
    throw stateError("stale_generation", "Runtime state generation is stale.");
  }
  if (
    row.status !== status ||
    row.worker_stack_id !== workerStackId ||
    row.operation_id !== operationId
  ) {
    throw stateError(
      "concurrent_operation",
      "Runtime state operation ownership was lost.",
    );
  }
}

function quarantine(
  db: Database,
  tenant: RuntimeWorkerStateTenant,
  failure: RuntimeWorkerStateFailure,
  nowIso: () => string,
  workerStackId: string,
  operationId: string,
): void {
  const result = db
    .query(
      `UPDATE runtime_worker_state_checkpoints
       SET status = 'quarantined',
           failure_code = ?,
           operation_id = NULL,
           restored_generation = NULL,
           updated_at = ?
       WHERE org_id = ?
         AND assistant_id = ?
         AND worker_stack_id = ?
         AND operation_id = ?`,
    )
    .run(
      failure,
      nowIso(),
      tenant.orgId,
      tenant.assistantId,
      workerStackId,
      operationId,
    );
  if (result.changes !== 1) {
    throw stateError(
      "concurrent_operation",
      "Runtime state operation ownership was lost.",
    );
  }
}

function stateError(
  code: RuntimeWorkerStateErrorCode,
  message: string,
): RuntimeWorkerStateError {
  return new RuntimeWorkerStateError(code, message);
}
