import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const RUNTIME_CUTOVER_PHASES = [
  "export",
  "restore",
  "verify",
  "canary",
  "commit",
  "committed",
  "rollback",
  "rolled_back",
  "failed",
  "retirement_authorized",
] as const;

export type RuntimeCutoverPhase = (typeof RUNTIME_CUTOVER_PHASES)[number];
export type RuntimeHealthGate = "healthy" | "unhealthy";

const TERMINAL_RUNTIME_CUTOVER_PHASES = [
  "rolled_back",
  "failed",
  "retirement_authorized",
] as const satisfies readonly RuntimeCutoverPhase[];

export interface RuntimeCutoverRow {
  id: string;
  org_id: string;
  assistant_id: string;
  sequence: number;
  source_runtime_id: string;
  target_runtime_id: string;
  start_idempotency_key: string;
  phase: RuntimeCutoverPhase;
  version: number;
  checkpoint_checksum: string | null;
  restored_checksum: string | null;
  verification_status: string | null;
  canary_status: string | null;
  source_health_status: string | null;
  target_health_status: string | null;
  cooling_until: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeCutoverAuditEvent {
  id: string;
  cutover_id: string;
  version: number;
  idempotency_key: string;
  event_type: string;
  from_phase: RuntimeCutoverPhase | null;
  to_phase: RuntimeCutoverPhase;
  payload_json: string;
  created_at: string;
}

export type RuntimeCutoverAction =
  | { type: "export_completed"; checkpointChecksum: string }
  | { type: "restore_completed"; checkpointChecksum: string }
  | {
      type: "verification_passed";
      checkpointChecksum: string;
      sourceHealth: RuntimeHealthGate;
      targetHealth: RuntimeHealthGate;
    }
  | {
      type: "canary_passed";
      checkpointChecksum: string;
      sourceHealth: RuntimeHealthGate;
      targetHealth: RuntimeHealthGate;
    }
  | { type: "canary_failed"; error: string }
  | { type: "begin_rollback"; error: string }
  | { type: "rollback_completed"; sourceHealth: RuntimeHealthGate }
  | { type: "rollback_failed"; error: string }
  | { type: "commit"; coolingPeriodMs: number };

export type RuntimeCutoverMutationResult =
  | {
      status: "applied" | "duplicate";
      cutover: RuntimeCutoverRow;
      event: RuntimeCutoverAuditEvent;
    }
  | {
      status: "rejected";
      reason:
        | "assistant_not_found"
        | "runtime_identity_mismatch"
        | "cutover_identity_mismatch"
        | "active_cutover_exists"
        | "idempotency_conflict"
        | "stale_version"
        | "invalid_transition"
        | "checkpoint_mismatch"
        | "health_gate_failed"
        | "cooling_period_active";
      cutover: RuntimeCutoverRow | null;
    };

interface RuntimeIdentityRow {
  id: string;
  org_id: string;
  assistant_id: string;
  status: string;
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<
        { found: number },
        [string]
      >(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== null
  );
}

function createRuntimeCutoverTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_cutovers (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      source_runtime_id TEXT NOT NULL,
      target_runtime_id TEXT NOT NULL,
      start_idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN (
        'export',
        'restore',
        'verify',
        'canary',
        'commit',
        'committed',
        'rollback',
        'rolled_back',
        'failed',
        'retirement_authorized'
      )),
      version INTEGER NOT NULL CHECK(version >= 1),
      checkpoint_checksum TEXT,
      restored_checksum TEXT,
      verification_status TEXT,
      canary_status TEXT,
      source_health_status TEXT,
      target_health_status TEXT,
      cooling_until INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(org_id, assistant_id, sequence),
      UNIQUE(org_id, start_idempotency_key),
      CHECK(source_runtime_id != target_runtime_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_cutover_events (
      id TEXT PRIMARY KEY,
      cutover_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_phase TEXT,
      to_phase TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(cutover_id) REFERENCES runtime_cutovers(id) ON DELETE RESTRICT,
      UNIQUE(cutover_id, version),
      UNIQUE(cutover_id, idempotency_key)
    );
  `);
}

function createRuntimeCutoverIndexes(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_cutovers_phase
      ON runtime_cutovers(phase, updated_at);
    CREATE INDEX IF NOT EXISTS idx_runtime_cutovers_latest
      ON runtime_cutovers(org_id, assistant_id, sequence DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_cutovers_one_nonterminal
      ON runtime_cutovers(org_id, assistant_id)
      WHERE phase NOT IN ('rolled_back', 'failed', 'retirement_authorized');
    CREATE INDEX IF NOT EXISTS idx_runtime_cutover_events_cutover
      ON runtime_cutover_events(cutover_id, version);
  `);
}

function runtimeCutoverSchemaNeedsMigration(db: Database): boolean {
  if (!tableExists(db, "runtime_cutovers")) return false;
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runtime_cutovers)")
    .all();
  if (!columns.some((column) => column.name === "sequence")) return true;
  const table = db
    .query<{ sql: string | null }, []>(
      `SELECT sql
       FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_cutovers'`,
    )
    .get();
  return /UNIQUE\s*\(\s*org_id\s*,\s*assistant_id\s*\)/i.test(
    table?.sql ?? "",
  );
}

function migrateRuntimeCutoverSchema(db: Database): void {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE runtime_cutover_events
        RENAME TO runtime_cutover_events_before_sequence;
      ALTER TABLE runtime_cutovers
        RENAME TO runtime_cutovers_before_sequence;
    `);
    createRuntimeCutoverTables(db);
    db.exec(`
      INSERT INTO runtime_cutovers (
        id,
        org_id,
        assistant_id,
        sequence,
        source_runtime_id,
        target_runtime_id,
        start_idempotency_key,
        phase,
        version,
        checkpoint_checksum,
        restored_checksum,
        verification_status,
        canary_status,
        source_health_status,
        target_health_status,
        cooling_until,
        last_error,
        created_at,
        updated_at
      )
      SELECT
        id,
        org_id,
        assistant_id,
        ROW_NUMBER() OVER (
          PARTITION BY org_id, assistant_id
          ORDER BY created_at ASC, id ASC
        ),
        source_runtime_id,
        target_runtime_id,
        start_idempotency_key,
        phase,
        version,
        checkpoint_checksum,
        restored_checksum,
        verification_status,
        canary_status,
        source_health_status,
        target_health_status,
        cooling_until,
        last_error,
        created_at,
        updated_at
      FROM runtime_cutovers_before_sequence;

      INSERT INTO runtime_cutover_events
      SELECT *
      FROM runtime_cutover_events_before_sequence;

      DROP TABLE runtime_cutover_events_before_sequence;
      DROP TABLE runtime_cutovers_before_sequence;
    `);
  }).immediate();
}

export function ensureRuntimeCutoverSchema(db: Database): void {
  if (runtimeCutoverSchemaNeedsMigration(db)) {
    migrateRuntimeCutoverSchema(db);
  } else {
    createRuntimeCutoverTables(db);
  }
  createRuntimeCutoverIndexes(db);
}

export function getLatestRuntimeCutover(
  db: Database,
  orgId: string,
  assistantId: string,
): RuntimeCutoverRow | null {
  return (
    db
      .query<
        RuntimeCutoverRow,
        [string, string]
      >(
        `SELECT *
         FROM runtime_cutovers
         WHERE org_id = ? AND assistant_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(orgId, assistantId) ?? null
  );
}

export function getActiveRuntimeCutover(
  db: Database,
  orgId: string,
  assistantId: string,
): RuntimeCutoverRow | null {
  return (
    db
      .query<
        RuntimeCutoverRow,
        [string, string]
      >(
        `SELECT *
         FROM runtime_cutovers
         WHERE org_id = ?
           AND assistant_id = ?
           AND phase NOT IN ('rolled_back', 'failed', 'retirement_authorized')
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(orgId, assistantId) ?? null
  );
}

export function getRuntimeCutover(
  db: Database,
  orgId: string,
  assistantId: string,
): RuntimeCutoverRow | null {
  return getLatestRuntimeCutover(db, orgId, assistantId);
}

function getRuntimeCutoverByStartKey(
  db: Database,
  orgId: string,
  idempotencyKey: string,
): RuntimeCutoverRow | null {
  return (
    db
      .query<
        RuntimeCutoverRow,
        [string, string]
      >(
        `SELECT *
         FROM runtime_cutovers
         WHERE org_id = ? AND start_idempotency_key = ?`,
      )
      .get(orgId, idempotencyKey) ?? null
  );
}

export function listRuntimeCutoverAuditEvents(
  db: Database,
  cutoverId: string,
): RuntimeCutoverAuditEvent[] {
  return db
    .query<
      RuntimeCutoverAuditEvent,
      [string]
    >(
      `SELECT *
       FROM runtime_cutover_events
       WHERE cutover_id = ?
       ORDER BY version ASC`,
    )
    .all(cutoverId);
}

function getAuditEventByIdempotencyKey(
  db: Database,
  cutoverId: string,
  idempotencyKey: string,
): RuntimeCutoverAuditEvent | null {
  return (
    db
      .query<
        RuntimeCutoverAuditEvent,
        [string, string]
      >(
        `SELECT *
         FROM runtime_cutover_events
         WHERE cutover_id = ? AND idempotency_key = ?`,
      )
      .get(cutoverId, idempotencyKey) ?? null
  );
}

function assistantExists(
  db: Database,
  orgId: string,
  assistantId: string,
): boolean {
  return (
    db
      .query<
        { found: number },
        [string, string]
      >("SELECT 1 AS found FROM assistants WHERE id = ? AND org_id = ?")
      .get(assistantId, orgId) !== null
  );
}

function runtimeIdentityMatches(
  db: Database,
  runtimeId: string,
  orgId: string,
  assistantId: string,
  nowMs: number,
): boolean {
  const runtime = db
    .query<
      RuntimeIdentityRow,
      [string]
    >(
      `SELECT id, org_id, assistant_id, status
       FROM runtime_stacks
       WHERE id = ?`,
    )
    .get(runtimeId);
  if (!runtime || runtime.status !== "active") return false;
  if (runtime.org_id === orgId && runtime.assistant_id === assistantId) {
    return true;
  }
  if (!tableExists(db, "runtime_worker_leases")) return false;
  return (
    db
      .query<
        { found: number },
        [string, string, string, number]
      >(
        `SELECT 1 AS found
         FROM runtime_worker_leases
         WHERE runtime_stack_id = ?
           AND org_id = ?
           AND assistant_id = ?
           AND lease_token IS NOT NULL
           AND lease_expires_at > ?`,
      )
      .get(runtimeId, orgId, assistantId, nowMs) !== null
  );
}

function cutoverRuntimeIdentitiesMatch(
  db: Database,
  cutover: RuntimeCutoverRow,
  nowMs: number,
): boolean {
  return (
    runtimeIdentityMatches(
      db,
      cutover.source_runtime_id,
      cutover.org_id,
      cutover.assistant_id,
      nowMs,
    ) &&
    runtimeIdentityMatches(
      db,
      cutover.target_runtime_id,
      cutover.org_id,
      cutover.assistant_id,
      nowMs,
    )
  );
}

function validChecksum(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function eventPayload(action: RuntimeCutoverAction | object): string {
  return JSON.stringify(canonicalJsonValue(action));
}

function insertAuditEvent(
  db: Database,
  cutover: RuntimeCutoverRow,
  version: number,
  idempotencyKey: string,
  eventType: string,
  fromPhase: RuntimeCutoverPhase | null,
  toPhase: RuntimeCutoverPhase,
  payloadJson: string,
  nowIso: string,
): RuntimeCutoverAuditEvent {
  const event: RuntimeCutoverAuditEvent = {
    id: "cutover-event-" + randomUUID(),
    cutover_id: cutover.id,
    version,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    from_phase: fromPhase,
    to_phase: toPhase,
    payload_json: payloadJson,
    created_at: nowIso,
  };
  db.query(
    `INSERT INTO runtime_cutover_events (
       id,
       cutover_id,
       version,
       idempotency_key,
       event_type,
       from_phase,
       to_phase,
       payload_json,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.cutover_id,
    event.version,
    event.idempotency_key,
    event.event_type,
    event.from_phase,
    event.to_phase,
    event.payload_json,
    event.created_at,
  );
  return event;
}

export function startRuntimeCutover(
  db: Database,
  input: {
    orgId: string;
    assistantId: string;
    sourceRuntimeId: string;
    targetRuntimeId: string;
    idempotencyKey: string;
    nowMs: number;
    nowIso: string;
  },
): RuntimeCutoverMutationResult {
  if (!input.idempotencyKey.trim()) {
    throw new Error("Cutover idempotency key is required.");
  }
  ensureRuntimeCutoverSchema(db);
  return db
    .transaction((): RuntimeCutoverMutationResult => {
      if (!assistantExists(db, input.orgId, input.assistantId)) {
        return {
          status: "rejected",
          reason: "assistant_not_found",
          cutover: null,
        };
      }
      const replayedStart = getRuntimeCutoverByStartKey(
        db,
        input.orgId,
        input.idempotencyKey,
      );
      if (replayedStart) {
        const event = getAuditEventByIdempotencyKey(
          db,
          replayedStart.id,
          input.idempotencyKey,
        );
        if (
          event?.event_type === "cutover_started" &&
          replayedStart.assistant_id === input.assistantId &&
          replayedStart.source_runtime_id === input.sourceRuntimeId &&
          replayedStart.target_runtime_id === input.targetRuntimeId
        ) {
          return { status: "duplicate", cutover: replayedStart, event };
        }
        return {
          status: "rejected",
          reason: "idempotency_conflict",
          cutover: replayedStart,
        };
      }
      const active = getActiveRuntimeCutover(
        db,
        input.orgId,
        input.assistantId,
      );
      if (active) {
        return {
          status: "rejected",
          reason: "active_cutover_exists",
          cutover: active,
        };
      }
      if (
        !runtimeIdentityMatches(
          db,
          input.sourceRuntimeId,
          input.orgId,
          input.assistantId,
          input.nowMs,
        ) ||
        !runtimeIdentityMatches(
          db,
          input.targetRuntimeId,
          input.orgId,
          input.assistantId,
          input.nowMs,
        )
      ) {
        return {
          status: "rejected",
          reason: "runtime_identity_mismatch",
          cutover: null,
        };
      }

      const latest = getLatestRuntimeCutover(
        db,
        input.orgId,
        input.assistantId,
      );
      if (
        latest &&
        !TERMINAL_RUNTIME_CUTOVER_PHASES.includes(
          latest.phase as (typeof TERMINAL_RUNTIME_CUTOVER_PHASES)[number],
        )
      ) {
        return {
          status: "rejected",
          reason: "active_cutover_exists",
          cutover: latest,
        };
      }
      const cutover: RuntimeCutoverRow = {
        id: "cutover-" + randomUUID(),
        org_id: input.orgId,
        assistant_id: input.assistantId,
        sequence: (latest?.sequence ?? 0) + 1,
        source_runtime_id: input.sourceRuntimeId,
        target_runtime_id: input.targetRuntimeId,
        start_idempotency_key: input.idempotencyKey,
        phase: "export",
        version: 1,
        checkpoint_checksum: null,
        restored_checksum: null,
        verification_status: null,
        canary_status: null,
        source_health_status: null,
        target_health_status: null,
        cooling_until: null,
        last_error: null,
        created_at: input.nowIso,
        updated_at: input.nowIso,
      };
      db.query(
        `INSERT INTO runtime_cutovers (
           id,
           org_id,
           assistant_id,
           sequence,
           source_runtime_id,
           target_runtime_id,
           start_idempotency_key,
           phase,
           version,
           checkpoint_checksum,
           restored_checksum,
           verification_status,
           canary_status,
           source_health_status,
           target_health_status,
           cooling_until,
           last_error,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        cutover.id,
        cutover.org_id,
        cutover.assistant_id,
        cutover.sequence,
        cutover.source_runtime_id,
        cutover.target_runtime_id,
        cutover.start_idempotency_key,
        cutover.phase,
        cutover.version,
        cutover.created_at,
        cutover.updated_at,
      );
      const event = insertAuditEvent(
        db,
        cutover,
        1,
        input.idempotencyKey,
        "cutover_started",
        null,
        "export",
        eventPayload({
          sourceRuntimeId: input.sourceRuntimeId,
          targetRuntimeId: input.targetRuntimeId,
        }),
        input.nowIso,
      );
      return { status: "applied", cutover, event };
    })
    .immediate();
}

interface TransitionPlan {
  toPhase: RuntimeCutoverPhase;
  changes: Record<string, string | number | null>;
}

function planTransition(
  cutover: RuntimeCutoverRow,
  action: RuntimeCutoverAction,
  nowMs: number,
): TransitionPlan | RuntimeCutoverMutationResult {
  const reject = (
    reason: Extract<
      RuntimeCutoverMutationResult,
      { status: "rejected" }
    >["reason"],
  ): RuntimeCutoverMutationResult => ({
    status: "rejected",
    reason,
    cutover,
  });

  switch (action.type) {
    case "export_completed":
      if (cutover.phase !== "export") return reject("invalid_transition");
      if (!validChecksum(action.checkpointChecksum)) {
        return reject("checkpoint_mismatch");
      }
      return {
        toPhase: "restore",
        changes: {
          checkpoint_checksum: action.checkpointChecksum.toLowerCase(),
          last_error: null,
        },
      };
    case "restore_completed":
      if (cutover.phase !== "restore") return reject("invalid_transition");
      if (
        !validChecksum(action.checkpointChecksum) ||
        action.checkpointChecksum.toLowerCase() !== cutover.checkpoint_checksum
      ) {
        return reject("checkpoint_mismatch");
      }
      return {
        toPhase: "verify",
        changes: {
          restored_checksum: action.checkpointChecksum.toLowerCase(),
          last_error: null,
        },
      };
    case "verification_passed":
      if (cutover.phase !== "verify") return reject("invalid_transition");
      if (
        action.checkpointChecksum.toLowerCase() !==
          cutover.checkpoint_checksum ||
        cutover.restored_checksum !== cutover.checkpoint_checksum
      ) {
        return reject("checkpoint_mismatch");
      }
      if (
        action.sourceHealth !== "healthy" ||
        action.targetHealth !== "healthy"
      ) {
        return reject("health_gate_failed");
      }
      return {
        toPhase: "canary",
        changes: {
          verification_status: "passed",
          source_health_status: action.sourceHealth,
          target_health_status: action.targetHealth,
          last_error: null,
        },
      };
    case "canary_passed":
      if (cutover.phase !== "canary") return reject("invalid_transition");
      if (
        cutover.verification_status !== "passed" ||
        action.checkpointChecksum.toLowerCase() !==
          cutover.checkpoint_checksum
      ) {
        return reject("checkpoint_mismatch");
      }
      if (
        action.sourceHealth !== "healthy" ||
        action.targetHealth !== "healthy"
      ) {
        return reject("health_gate_failed");
      }
      return {
        toPhase: "commit",
        changes: {
          canary_status: "passed",
          source_health_status: action.sourceHealth,
          target_health_status: action.targetHealth,
          last_error: null,
        },
      };
    case "canary_failed":
      if (cutover.phase !== "canary") return reject("invalid_transition");
      return {
        toPhase: "rollback",
        changes: {
          canary_status: "failed",
          last_error: action.error.slice(0, 2_000),
        },
      };
    case "begin_rollback":
      if (
        !["export", "restore", "verify", "canary", "commit", "failed"].includes(
          cutover.phase,
        )
      ) {
        return reject("invalid_transition");
      }
      return {
        toPhase: "rollback",
        changes: { last_error: action.error.slice(0, 2_000) },
      };
    case "rollback_completed":
      if (cutover.phase !== "rollback") return reject("invalid_transition");
      if (action.sourceHealth !== "healthy") {
        return reject("health_gate_failed");
      }
      return {
        toPhase: "rolled_back",
        changes: {
          source_health_status: action.sourceHealth,
          last_error: null,
        },
      };
    case "rollback_failed":
      if (cutover.phase !== "rollback") return reject("invalid_transition");
      return {
        toPhase: "failed",
        changes: { last_error: action.error.slice(0, 2_000) },
      };
    case "commit":
      if (cutover.phase !== "commit") return reject("invalid_transition");
      if (
        cutover.verification_status !== "passed" ||
        cutover.canary_status !== "passed" ||
        cutover.source_health_status !== "healthy" ||
        cutover.target_health_status !== "healthy" ||
        !cutover.checkpoint_checksum ||
        cutover.restored_checksum !== cutover.checkpoint_checksum
      ) {
        return reject("health_gate_failed");
      }
      if (
        !Number.isInteger(action.coolingPeriodMs) ||
        action.coolingPeriodMs < 1
      ) {
        return reject("cooling_period_active");
      }
      return {
        toPhase: "committed",
        changes: {
          cooling_until: nowMs + action.coolingPeriodMs,
          last_error: null,
        },
      };
  }
}

function applyTransitionPlan(
  db: Database,
  cutover: RuntimeCutoverRow,
  plan: TransitionPlan,
  expectedVersion: number,
  nowIso: string,
): RuntimeCutoverRow | null {
  const allowedColumns = new Set([
    "checkpoint_checksum",
    "restored_checksum",
    "verification_status",
    "canary_status",
    "source_health_status",
    "target_health_status",
    "cooling_until",
    "last_error",
  ]);
  const entries = Object.entries(plan.changes);
  for (const [column] of entries) {
    if (!allowedColumns.has(column)) {
      throw new Error(`Unsupported cutover mutation column: ${column}`);
    }
  }
  const assignments = entries.map(([column]) => `${column} = ?`);
  const values = entries.map(([, value]) => value);
  const result = db
    .query(
      `UPDATE runtime_cutovers
       SET phase = ?,
           version = version + 1,
           ${assignments.join(",\n           ")},
           updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      plan.toPhase,
      ...values,
      nowIso,
      cutover.id,
      expectedVersion,
    );
  if (result.changes !== 1) return null;
  return getRuntimeCutover(db, cutover.org_id, cutover.assistant_id);
}

export function transitionRuntimeCutover(
  db: Database,
  input: {
    orgId: string;
    assistantId: string;
    cutoverId: string;
    expectedVersion: number;
    idempotencyKey: string;
    action: RuntimeCutoverAction;
    nowMs: number;
    nowIso: string;
  },
): RuntimeCutoverMutationResult {
  if (!input.idempotencyKey.trim()) {
    throw new Error("Cutover idempotency key is required.");
  }
  return db
    .transaction((): RuntimeCutoverMutationResult => {
      const cutover = getRuntimeCutover(db, input.orgId, input.assistantId);
      if (!cutover) {
        return {
          status: "rejected",
          reason: "assistant_not_found",
          cutover: null,
        };
      }
      if (cutover.id !== input.cutoverId) {
        return {
          status: "rejected",
          reason: "cutover_identity_mismatch",
          cutover,
        };
      }
      const payloadJson = eventPayload(input.action);
      const duplicate = getAuditEventByIdempotencyKey(
        db,
        cutover.id,
        input.idempotencyKey,
      );
      if (duplicate) {
        if (
          duplicate.event_type === input.action.type &&
          duplicate.payload_json === payloadJson
        ) {
          return { status: "duplicate", cutover, event: duplicate };
        }
        return {
          status: "rejected",
          reason: "idempotency_conflict",
          cutover,
        };
      }
      if (cutover.version !== input.expectedVersion) {
        return {
          status: "rejected",
          reason: "stale_version",
          cutover,
        };
      }
      if (!cutoverRuntimeIdentitiesMatch(db, cutover, input.nowMs)) {
        return {
          status: "rejected",
          reason: "runtime_identity_mismatch",
          cutover,
        };
      }
      const plan = planTransition(cutover, input.action, input.nowMs);
      if ("status" in plan) return plan;
      const updated = applyTransitionPlan(
        db,
        cutover,
        plan,
        input.expectedVersion,
        input.nowIso,
      );
      if (!updated) {
        return {
          status: "rejected",
          reason: "stale_version",
          cutover:
            getRuntimeCutover(db, input.orgId, input.assistantId) ?? cutover,
        };
      }
      const event = insertAuditEvent(
        db,
        updated,
        updated.version,
        input.idempotencyKey,
        input.action.type,
        cutover.phase,
        updated.phase,
        payloadJson,
        input.nowIso,
      );
      return { status: "applied", cutover: updated, event };
    })
    .immediate();
}

export function authorizeRuntimeCutoverSourceRetirement(
  db: Database,
  input: {
    orgId: string;
    assistantId: string;
    cutoverId: string;
    expectedVersion: number;
    idempotencyKey: string;
    checkpointChecksum: string;
    targetHealth: RuntimeHealthGate;
    nowMs: number;
    nowIso: string;
  },
): RuntimeCutoverMutationResult {
  if (!input.idempotencyKey.trim()) {
    throw new Error("Cutover idempotency key is required.");
  }
  return db
    .transaction((): RuntimeCutoverMutationResult => {
      const cutover = getRuntimeCutover(db, input.orgId, input.assistantId);
      if (!cutover) {
        return {
          status: "rejected",
          reason: "assistant_not_found",
          cutover: null,
        };
      }
      if (cutover.id !== input.cutoverId) {
        return {
          status: "rejected",
          reason: "cutover_identity_mismatch",
          cutover,
        };
      }
      const payloadJson = eventPayload({
        checkpointChecksum: input.checkpointChecksum,
        targetHealth: input.targetHealth,
      });
      const duplicate = getAuditEventByIdempotencyKey(
        db,
        cutover.id,
        input.idempotencyKey,
      );
      if (duplicate) {
        if (
          duplicate.event_type === "source_retirement_authorized" &&
          duplicate.payload_json === payloadJson
        ) {
          return { status: "duplicate", cutover, event: duplicate };
        }
        return {
          status: "rejected",
          reason: "idempotency_conflict",
          cutover,
        };
      }
      if (cutover.version !== input.expectedVersion) {
        return {
          status: "rejected",
          reason: "stale_version",
          cutover,
        };
      }
      if (
        cutover.phase !== "committed" ||
        cutover.cooling_until === null ||
        input.nowMs < cutover.cooling_until
      ) {
        return {
          status: "rejected",
          reason:
            cutover.phase === "committed"
              ? "cooling_period_active"
              : "invalid_transition",
          cutover,
        };
      }
      if (
        input.targetHealth !== "healthy" ||
        input.checkpointChecksum.toLowerCase() !==
          cutover.checkpoint_checksum
      ) {
        return {
          status: "rejected",
          reason:
            input.targetHealth !== "healthy"
              ? "health_gate_failed"
              : "checkpoint_mismatch",
          cutover,
        };
      }
      if (!cutoverRuntimeIdentitiesMatch(db, cutover, input.nowMs)) {
        return {
          status: "rejected",
          reason: "runtime_identity_mismatch",
          cutover,
        };
      }
      const updated = applyTransitionPlan(
        db,
        cutover,
        {
          toPhase: "retirement_authorized",
          changes: { target_health_status: "healthy" },
        },
        input.expectedVersion,
        input.nowIso,
      );
      if (!updated) {
        return {
          status: "rejected",
          reason: "stale_version",
          cutover:
            getRuntimeCutover(db, input.orgId, input.assistantId) ?? cutover,
        };
      }
      const event = insertAuditEvent(
        db,
        updated,
        updated.version,
        input.idempotencyKey,
        "source_retirement_authorized",
        cutover.phase,
        updated.phase,
        payloadJson,
        input.nowIso,
      );
      return { status: "applied", cutover: updated, event };
    })
    .immediate();
}

export function routedRuntimeIdForCutover(
  cutover: RuntimeCutoverRow,
): string {
  return cutover.phase === "committed" ||
    cutover.phase === "retirement_authorized"
    ? cutover.target_runtime_id
    : cutover.source_runtime_id;
}

export interface RuntimeCutoverRoutingResolution {
  runtimeId: string;
  cutoverId: string;
  cutoverSequence: number;
  cutoverVersion: number;
  phase: RuntimeCutoverPhase;
}

/**
 * Read-only routing decision derived exclusively from durable cutover state.
 * The source remains selected through export, restore, verification, canary,
 * and the pre-commit phase. Only a verified committed cutover selects the
 * target; failed and rolled-back migrations continue selecting their source.
 */
export function resolveRuntimeCutoverRouting(
  db: Database,
  orgId: string,
  assistantId: string,
): RuntimeCutoverRoutingResolution | null {
  const cutover = getLatestRuntimeCutover(db, orgId, assistantId);
  if (!cutover) return null;
  return {
    runtimeId: routedRuntimeIdForCutover(cutover),
    cutoverId: cutover.id,
    cutoverSequence: cutover.sequence,
    cutoverVersion: cutover.version,
    phase: cutover.phase,
  };
}
