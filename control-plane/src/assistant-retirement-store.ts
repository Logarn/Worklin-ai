import type { Database } from "bun:sqlite";

import type { AssistantRow } from "./assistant-store.js";
import {
  getRuntimeStackById,
  type RuntimeStackRow,
} from "./runtime-stacks.js";

export interface AssistantRetirementRow {
  runtime_stack_id: string;
  assistant_id: string;
  org_id: string;
  owner_user_id: string;
  requested_by_user_id: string;
  provider: string;
  service_ref: string | null;
  workspace_volume_ref: string | null;
  service_cleanup_confirmed: number;
  volume_cleanup_confirmed: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  requested_at: string;
  updated_at: string;
}

export type AssistantRetirementLeaseBlock =
  | "provisioning"
  | "retirement";

export interface AssistantRetirementLeaseClaim {
  retirement: AssistantRetirementRow | null;
  stack: RuntimeStackRow | null;
  leaseAcquired: boolean;
  blockedBy: AssistantRetirementLeaseBlock | null;
  retryAfterMs: number | null;
}

const initializedDatabases = new WeakSet<Database>();

export function ensureAssistantRetirementSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS assistant_retirements (
      runtime_stack_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      service_ref TEXT,
      workspace_volume_ref TEXT,
      service_cleanup_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK(service_cleanup_confirmed IN (0, 1)),
      volume_cleanup_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK(volume_cleanup_confirmed IN (0, 1)),
      lease_token TEXT,
      lease_expires_at INTEGER,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_retirements_org
      ON assistant_retirements(org_id, updated_at);
  `);
  initializedDatabases.add(db);
}

export function getAssistantRetirement(
  db: Database,
  stackId: string,
): AssistantRetirementRow | null {
  ensureAssistantRetirementSchema(db);
  return (
    db
      .query<AssistantRetirementRow, [string]>(
        "SELECT * FROM assistant_retirements WHERE runtime_stack_id = ?",
      )
      .get(stackId) ?? null
  );
}

export function suspendAssistantForRetirement(
  db: Database,
  assistant: AssistantRow,
  stack: RuntimeStackRow,
  requestedByUserId: string,
  nowIso: () => string,
): AssistantRetirementRow {
  ensureAssistantRetirementSchema(db);
  return db
    .transaction(() => {
      const currentAssistant = db
        .query<AssistantRow, [string, string]>(
          "SELECT * FROM assistants WHERE id = ? AND org_id = ?",
        )
        .get(assistant.id, assistant.org_id);
      const currentStack = getRuntimeStackById(db, stack.id);
      if (
        !currentAssistant ||
        currentAssistant.user_id !== assistant.user_id ||
        !currentStack ||
        currentStack.assistant_id !== assistant.id ||
        currentStack.org_id !== assistant.org_id ||
        currentStack.status === "deleted"
      ) {
        throw new Error("Assistant retirement target no longer exists.");
      }

      const timestamp = nowIso();
      const suspended = db
        .query(
          `UPDATE runtime_stacks
           SET status = 'suspended',
               gateway_url = NULL,
               public_ingress_url = NULL,
               last_health_status = NULL,
               last_error = 'Assistant retirement cleanup is pending.',
               updated_at = ?
           WHERE id = ? AND status != 'deleted'`,
        )
        .run(timestamp, currentStack.id);
      if (suspended.changes !== 1) {
        throw new Error("Assistant runtime could not be suspended.");
      }

      const serviceCleanupConfirmed =
        currentStack.service_ref === null &&
        currentStack.service_create_attempted_at === null
          ? 1
          : 0;
      const volumeCleanupConfirmed =
        currentStack.workspace_volume_ref === null &&
        currentStack.volume_create_attempted_at === null
          ? 1
          : 0;
      db.query(
        `INSERT INTO assistant_retirements (
           runtime_stack_id, assistant_id, org_id, owner_user_id,
           requested_by_user_id, provider, service_ref,
           workspace_volume_ref, service_cleanup_confirmed,
           volume_cleanup_confirmed, lease_token, lease_expires_at,
           requested_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(runtime_stack_id) DO UPDATE SET
           service_ref = COALESCE(
             excluded.service_ref,
             assistant_retirements.service_ref
           ),
           workspace_volume_ref = COALESCE(
             excluded.workspace_volume_ref,
             assistant_retirements.workspace_volume_ref
           ),
           service_cleanup_confirmed = MAX(
             assistant_retirements.service_cleanup_confirmed,
             excluded.service_cleanup_confirmed
           ),
           volume_cleanup_confirmed = MAX(
             assistant_retirements.volume_cleanup_confirmed,
             excluded.volume_cleanup_confirmed
           ),
           updated_at = excluded.updated_at`,
      ).run(
        currentStack.id,
        assistant.id,
        assistant.org_id,
        assistant.user_id,
        requestedByUserId,
        currentStack.provider,
        currentStack.service_ref,
        currentStack.workspace_volume_ref,
        serviceCleanupConfirmed,
        volumeCleanupConfirmed,
        timestamp,
        timestamp,
      );

      const retirement = getAssistantRetirement(db, currentStack.id);
      if (!retirement) {
        throw new Error("Assistant retirement state was not persisted.");
      }
      return retirement;
    })
    .immediate();
}

export function claimAssistantRetirementLease(
  db: Database,
  stackId: string,
  leaseToken: string,
  nowMs: number,
  leaseTtlMs: number,
  nowIso: () => string,
): AssistantRetirementLeaseClaim {
  ensureAssistantRetirementSchema(db);
  if (!leaseToken) throw new Error("Retirement lease token is required.");
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new Error("Retirement lease TTL must be a positive integer.");
  }

  return db
    .transaction((): AssistantRetirementLeaseClaim => {
      let retirement = getAssistantRetirement(db, stackId);
      let stack = getRuntimeStackById(db, stackId);
      if (!retirement || !stack || stack.status !== "suspended") {
        return {
          retirement,
          stack,
          leaseAcquired: false,
          blockedBy: null,
          retryAfterMs: null,
        };
      }

      db.query(
        `UPDATE assistant_retirements
         SET service_ref = COALESCE(service_ref, ?),
             workspace_volume_ref = COALESCE(workspace_volume_ref, ?),
             updated_at = ?
         WHERE runtime_stack_id = ?`,
      ).run(
        stack.service_ref,
        stack.workspace_volume_ref,
        nowIso(),
        stackId,
      );
      retirement = getAssistantRetirement(db, stackId);

      if (stack.provisioning_lease_token) {
        const expiresAt = stack.provisioning_lease_expires_at;
        if (expiresAt === null || expiresAt > nowMs) {
          return {
            retirement,
            stack,
            leaseAcquired: false,
            blockedBy: "provisioning",
            retryAfterMs:
              expiresAt === null ? null : Math.max(1, expiresAt - nowMs),
          };
        }
        db.query(
          `UPDATE runtime_stacks
           SET provisioning_lease_token = NULL,
               provisioning_lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ?
             AND status = 'suspended'
             AND provisioning_lease_token = ?
             AND provisioning_lease_expires_at <= ?`,
        ).run(
          nowIso(),
          stackId,
          stack.provisioning_lease_token,
          nowMs,
        );
        stack = getRuntimeStackById(db, stackId);
      }

      if (
        retirement?.lease_token &&
        retirement.lease_token !== leaseToken &&
        (retirement.lease_expires_at === null ||
          retirement.lease_expires_at > nowMs)
      ) {
        return {
          retirement,
          stack,
          leaseAcquired: false,
          blockedBy: "retirement",
          retryAfterMs:
            retirement.lease_expires_at === null
              ? null
              : Math.max(1, retirement.lease_expires_at - nowMs),
        };
      }

      db.query(
        `UPDATE assistant_retirements
         SET lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE runtime_stack_id = ?
           AND (
             lease_token IS NULL
             OR lease_token = ?
             OR lease_expires_at <= ?
           )`,
      ).run(
        leaseToken,
        nowMs + leaseTtlMs,
        nowIso(),
        stackId,
        leaseToken,
        nowMs,
      );
      retirement = getAssistantRetirement(db, stackId);
      return {
        retirement,
        stack,
        leaseAcquired: retirement?.lease_token === leaseToken,
        blockedBy:
          retirement?.lease_token === leaseToken ? null : "retirement",
        retryAfterMs: null,
      };
    })
    .immediate();
}

export function renewAssistantRetirementLease(
  db: Database,
  stackId: string,
  leaseToken: string,
  nowMs: number,
  leaseTtlMs: number,
  nowIso: () => string,
): void {
  ensureAssistantRetirementSchema(db);
  const result = db
    .query(
      `UPDATE assistant_retirements
       SET lease_expires_at = ?, updated_at = ?
       WHERE runtime_stack_id = ?
         AND lease_token = ?
         AND EXISTS (
           SELECT 1 FROM runtime_stacks
           WHERE id = ? AND status = 'suspended'
         )`,
    )
    .run(
      nowMs + leaseTtlMs,
      nowIso(),
      stackId,
      leaseToken,
      stackId,
    );
  if (result.changes !== 1) {
    throw new Error("Assistant retirement lease was lost.");
  }
}

export function releaseAssistantRetirementLease(
  db: Database,
  stackId: string,
  leaseToken: string,
  nowIso: () => string,
): void {
  ensureAssistantRetirementSchema(db);
  db.query(
    `UPDATE assistant_retirements
     SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE runtime_stack_id = ? AND lease_token = ?`,
  ).run(nowIso(), stackId, leaseToken);
}

export function confirmAssistantRetirementResourceCleanup(
  db: Database,
  stackId: string,
  resource: "service" | "volume",
  leaseToken: string,
  nowIso: () => string,
): void {
  ensureAssistantRetirementSchema(db);
  const column =
    resource === "service"
      ? "service_cleanup_confirmed"
      : "volume_cleanup_confirmed";
  const result = db
    .query(
      `UPDATE assistant_retirements
       SET ${column} = 1, updated_at = ?
       WHERE runtime_stack_id = ? AND lease_token = ?`,
    )
    .run(nowIso(), stackId, leaseToken);
  if (result.changes !== 1) {
    throw new Error("Assistant retirement lease was lost.");
  }
}

export function finalizeAssistantRetirement(
  db: Database,
  stackId: string,
  leaseToken: string,
  nowIso: () => string,
): void {
  ensureAssistantRetirementSchema(db);
  db.transaction(() => {
    const retirement = getAssistantRetirement(db, stackId);
    const stack = getRuntimeStackById(db, stackId);
    if (
      !retirement ||
      !stack ||
      stack.status !== "suspended" ||
      retirement.lease_token !== leaseToken
    ) {
      throw new Error("Assistant retirement lease was lost.");
    }
    if (
      retirement.service_cleanup_confirmed !== 1 ||
      retirement.volume_cleanup_confirmed !== 1
    ) {
      throw new Error("Assistant runtime cleanup is not confirmed.");
    }

    db.query("DELETE FROM assistant_assignments WHERE assistant_id = ?").run(
      retirement.assistant_id,
    );
    db.query("DELETE FROM artifact_invitations WHERE assistant_id = ?").run(
      retirement.assistant_id,
    );
    db.query("DELETE FROM artifact_grants WHERE assistant_id = ?").run(
      retirement.assistant_id,
    );
    db.query("DELETE FROM brand_research_runs WHERE assistant_id = ?").run(
      retirement.assistant_id,
    );

    const deletedAssistant = db
      .query("DELETE FROM assistants WHERE id = ? AND org_id = ?")
      .run(retirement.assistant_id, retirement.org_id);
    if (deletedAssistant.changes !== 1) {
      throw new Error("Assistant retirement target no longer exists.");
    }

    const timestamp = nowIso();
    const deletedStack = db
      .query(
        `UPDATE runtime_stacks
         SET status = 'deleted',
             gateway_url = NULL,
             public_ingress_url = NULL,
             service_capacity_reserved = 0,
             service_create_attempted_at = NULL,
             volume_create_attempted_at = NULL,
             provisioning_lease_token = NULL,
             provisioning_lease_expires_at = NULL,
             last_health_status = NULL,
             last_error = 'Assistant retired.',
             updated_at = ?
         WHERE id = ? AND status = 'suspended'`,
      )
      .run(timestamp, stackId);
    if (deletedStack.changes !== 1) {
      throw new Error("Assistant runtime could not be marked deleted.");
    }
    db.query(
      "DELETE FROM assistant_retirements WHERE runtime_stack_id = ? AND lease_token = ?",
    ).run(stackId, leaseToken);
  }).immediate();
}
