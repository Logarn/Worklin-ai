import type { Database } from "bun:sqlite";

export const RUNTIME_WORKER_POOL_PROVIDER = "pooled_worker";

export interface RuntimeWorkerLeaseAssistant {
  id: string;
  org_id: string;
}

export interface RuntimeWorkerStackRow {
  id: string;
  status: string;
  provider: string;
  gateway_url: string | null;
  public_ingress_url: string | null;
  workspace_volume_ref: string | null;
  service_ref: string | null;
  actor_signing_key_scope: string;
}

export interface RuntimeWorkerLeaseRow {
  runtime_stack_id: string;
  assistant_id: string | null;
  org_id: string | null;
  lease_token: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  acquired_at: number | null;
  released_at: number | null;
  sanitized_at: number | null;
  updated_at: string;
}

export interface RuntimeWorkerLease {
  stack: RuntimeWorkerStackRow;
  lease: RuntimeWorkerLeaseRow;
}

export interface RuntimeWorkerLeaseClaim {
  assignment: RuntimeWorkerLease | null;
  leaseAcquired: boolean;
  reason:
    | "acquired"
    | "assistant_not_found"
    | "assistant_busy"
    | "capacity_exhausted";
  retryAfterMs: number | null;
}

export function ensureRuntimeWorkerLeaseSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_worker_leases (
      runtime_stack_id TEXT PRIMARY KEY,
      assistant_id TEXT,
      org_id TEXT,
      lease_token TEXT UNIQUE,
      lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
      lease_expires_at INTEGER,
      acquired_at INTEGER,
      released_at INTEGER,
      sanitized_at INTEGER,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_stack_id) REFERENCES runtime_stacks(id) ON DELETE RESTRICT,
      CHECK((assistant_id IS NULL) = (org_id IS NULL)),
      CHECK((lease_token IS NULL) = (lease_expires_at IS NULL)),
      CHECK(lease_token IS NULL OR assistant_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_worker_leases_assistant
      ON runtime_worker_leases(assistant_id)
      WHERE assistant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_runtime_worker_leases_expiry
      ON runtime_worker_leases(lease_expires_at)
      WHERE lease_token IS NOT NULL;
  `);
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(runtime_worker_leases)")
      .all()
      .map(({ name }) => name),
  );
  if (!columns.has("lease_generation")) {
    db.exec(
      "ALTER TABLE runtime_worker_leases ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0)",
    );
  }
}

function getWorkerStack(
  db: Database,
  stackId: string,
): RuntimeWorkerStackRow | null {
  return (
    db
      .query<
        RuntimeWorkerStackRow,
        [string, string]
      >(
        `SELECT
           id,
           status,
           provider,
           gateway_url,
           public_ingress_url,
           workspace_volume_ref,
           service_ref,
           actor_signing_key_scope
         FROM runtime_stacks
         WHERE id = ?
           AND provider = ?
           AND status = 'active'
           AND gateway_url IS NOT NULL
           AND service_ref IS NOT NULL`,
      )
      .get(stackId, RUNTIME_WORKER_POOL_PROVIDER) ?? null
  );
}

function getLeaseForStack(
  db: Database,
  stackId: string,
): RuntimeWorkerLeaseRow | null {
  return (
    db
      .query<
        RuntimeWorkerLeaseRow,
        [string]
      >("SELECT * FROM runtime_worker_leases WHERE runtime_stack_id = ?")
      .get(stackId) ?? null
  );
}

function getLeaseForAssistant(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
): RuntimeWorkerLeaseRow | null {
  return (
    db
      .query<
        RuntimeWorkerLeaseRow,
        [string, string]
      >(
        `SELECT *
         FROM runtime_worker_leases
         WHERE assistant_id = ? AND org_id = ?`,
      )
      .get(assistant.id, assistant.org_id) ?? null
  );
}

function assignmentFor(
  db: Database,
  lease: RuntimeWorkerLeaseRow,
): RuntimeWorkerLease | null {
  const stack = getWorkerStack(db, lease.runtime_stack_id);
  return stack ? { stack, lease } : null;
}

function assertClaimInputs(
  candidateStackIds: readonly string[],
  maxConcurrentLeases: number,
  leaseToken: string,
  leaseTtlMs: number,
): string[] {
  if (!leaseToken.trim()) throw new Error("Worker lease token is required.");
  if (!Number.isInteger(maxConcurrentLeases) || maxConcurrentLeases < 1) {
    throw new Error("Worker lease capacity must be a positive integer.");
  }
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new Error("Worker lease TTL must be a positive integer.");
  }
  return [...new Set(candidateStackIds.map((id) => id.trim()).filter(Boolean))];
}

export function claimRuntimeWorkerLease(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  candidateStackIds: readonly string[],
  maxConcurrentLeases: number,
  leaseToken: string,
  nowMs: number,
  leaseTtlMs: number,
  nowIso: () => string,
): RuntimeWorkerLeaseClaim {
  const candidates = assertClaimInputs(
    candidateStackIds,
    maxConcurrentLeases,
    leaseToken,
    leaseTtlMs,
  );

  return db
    .transaction((): RuntimeWorkerLeaseClaim => {
      const assistantExists = db
        .query<
          { found: number },
          [string, string]
        >("SELECT 1 AS found FROM assistants WHERE id = ? AND org_id = ?")
        .get(assistant.id, assistant.org_id);
      if (!assistantExists) {
        return {
          assignment: null,
          leaseAcquired: false,
          reason: "assistant_not_found",
          retryAfterMs: null,
        };
      }

      const existing = getLeaseForAssistant(db, assistant);
      if (existing?.lease_token && (existing.lease_expires_at ?? 0) > nowMs) {
        if (existing.lease_token === leaseToken) {
          const assignment = assignmentFor(db, existing);
          return {
            assignment,
            leaseAcquired: assignment !== null,
            reason: assignment === null ? "capacity_exhausted" : "acquired",
            retryAfterMs: null,
          };
        }
        return {
          assignment: null,
          leaseAcquired: false,
          reason: "assistant_busy",
          retryAfterMs: Math.max(
            1,
            (existing.lease_expires_at ?? nowMs) - nowMs,
          ),
        };
      }
      if (existing && !candidates.includes(existing.runtime_stack_id)) {
        return {
          assignment: null,
          leaseAcquired: false,
          reason: "capacity_exhausted",
          retryAfterMs: null,
        };
      }

      const activeCount =
        db
          .query<
            { count: number },
            [number]
          >(
            `SELECT COUNT(*) AS count
             FROM runtime_worker_leases
             WHERE lease_token IS NOT NULL
               AND lease_expires_at > ?`,
          )
          .get(nowMs)?.count ?? 0;
      if (activeCount >= maxConcurrentLeases) {
        const nextExpiry = db
          .query<
            { lease_expires_at: number },
            [number]
          >(
            `SELECT MIN(lease_expires_at) AS lease_expires_at
             FROM runtime_worker_leases
             WHERE lease_token IS NOT NULL
               AND lease_expires_at > ?`,
          )
          .get(nowMs)?.lease_expires_at;
        return {
          assignment: null,
          leaseAcquired: false,
          reason: "capacity_exhausted",
          retryAfterMs:
            typeof nextExpiry === "number"
              ? Math.max(1, nextExpiry - nowMs)
              : null,
        };
      }

      const boundStackId =
        existing && candidates.includes(existing.runtime_stack_id)
          ? existing.runtime_stack_id
          : null;
      const availableStackId =
        boundStackId ??
        candidates.find((stackId) => {
          if (!getWorkerStack(db, stackId)) return false;
          const lease = getLeaseForStack(db, stackId);
          return lease === null || lease.assistant_id === null;
        });
      if (!availableStackId || !getWorkerStack(db, availableStackId)) {
        return {
          assignment: null,
          leaseAcquired: false,
          reason: "capacity_exhausted",
          retryAfterMs: null,
        };
      }

      const timestamp = nowIso();
      db.query(
        `INSERT INTO runtime_worker_leases (
           runtime_stack_id,
           assistant_id,
           org_id,
           lease_token,
           lease_generation,
           lease_expires_at,
           acquired_at,
           released_at,
           sanitized_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, ?)
         ON CONFLICT(runtime_stack_id) DO UPDATE SET
           assistant_id = excluded.assistant_id,
           org_id = excluded.org_id,
           lease_token = excluded.lease_token,
           lease_generation = runtime_worker_leases.lease_generation + 1,
           lease_expires_at = excluded.lease_expires_at,
           acquired_at = excluded.acquired_at,
           released_at = NULL,
           updated_at = excluded.updated_at
         WHERE (
             (
               runtime_worker_leases.assistant_id IS NULL
               AND runtime_worker_leases.org_id IS NULL
             )
             OR (
               runtime_worker_leases.assistant_id = excluded.assistant_id
               AND runtime_worker_leases.org_id = excluded.org_id
             )
           )
           AND (
             runtime_worker_leases.lease_token IS NULL
             OR runtime_worker_leases.lease_expires_at <= ?
           )`,
      ).run(
        availableStackId,
        assistant.id,
        assistant.org_id,
        leaseToken,
        nowMs + leaseTtlMs,
        nowMs,
        timestamp,
        nowMs,
      );
      const claimed = getLeaseForStack(db, availableStackId);
      const assignment =
        claimed?.assistant_id === assistant.id &&
        claimed.org_id === assistant.org_id &&
        claimed.lease_token === leaseToken
          ? assignmentFor(db, claimed)
          : null;
      return {
        assignment,
        leaseAcquired: assignment !== null,
        reason: assignment ? "acquired" : "capacity_exhausted",
        retryAfterMs: null,
      };
    })
    .immediate();
}

export function getActiveRuntimeWorkerLease(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
): RuntimeWorkerLease | null {
  const lease = getLeaseForAssistant(db, assistant);
  if (
    !lease ||
    lease.lease_token !== leaseToken ||
    (lease.lease_expires_at ?? 0) <= nowMs
  ) {
    return null;
  }
  return assignmentFor(db, lease);
}

export function renewRuntimeWorkerLease(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
  leaseTtlMs: number,
  nowIso: () => string,
): RuntimeWorkerLease {
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new Error("Worker lease TTL must be a positive integer.");
  }
  const result = db
    .query(
      `UPDATE runtime_worker_leases
       SET lease_expires_at = ?, updated_at = ?
       WHERE assistant_id = ?
         AND org_id = ?
         AND lease_token = ?
         AND lease_expires_at > ?`,
    )
    .run(
      nowMs + leaseTtlMs,
      nowIso(),
      assistant.id,
      assistant.org_id,
      leaseToken,
      nowMs,
    );
  if (result.changes !== 1) throw new Error("Runtime worker lease was lost.");
  const lease = getLeaseForAssistant(db, assistant);
  const assignment = lease ? assignmentFor(db, lease) : null;
  if (!assignment) throw new Error("Runtime worker is unavailable.");
  return assignment;
}

export function releaseRuntimeWorkerLease(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
  nowIso: () => string,
): void {
  const result = db
    .query(
      `UPDATE runtime_worker_leases
       SET lease_token = NULL,
           lease_expires_at = NULL,
           released_at = ?,
           updated_at = ?
       WHERE assistant_id = ?
         AND org_id = ?
         AND lease_token = ?`,
    )
    .run(
      nowMs,
      nowIso(),
      assistant.id,
      assistant.org_id,
      leaseToken,
    );
  if (result.changes !== 1) throw new Error("Runtime worker lease was lost.");
}

export function markRuntimeWorkerSanitized(
  db: Database,
  stackId: string,
  expectedAssistant: RuntimeWorkerLeaseAssistant,
  nowMs: number,
  nowIso: () => string,
): void {
  const result = db
    .query(
      `UPDATE runtime_worker_leases
       SET assistant_id = NULL,
           org_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           sanitized_at = ?,
           updated_at = ?
       WHERE runtime_stack_id = ?
         AND assistant_id = ?
         AND org_id = ?
         AND (
           lease_token IS NULL
           OR lease_expires_at <= ?
         )`,
    )
    .run(
      nowMs,
      nowIso(),
      stackId,
      expectedAssistant.id,
      expectedAssistant.org_id,
      nowMs,
    );
  if (result.changes !== 1) {
    throw new Error("Runtime worker cannot be sanitized while leased.");
  }
}
