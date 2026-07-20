import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  authorizeRuntimeCutoverSourceRetirement,
  ensureRuntimeCutoverSchema,
  getActiveRuntimeCutover,
  getLatestRuntimeCutover,
  getRuntimeCutover,
  listRuntimeCutoverAuditEvents,
  resolveRuntimeCutoverRouting,
  routedRuntimeIdForCutover,
  startRuntimeCutover,
  transitionRuntimeCutover,
  type RuntimeCutoverAction,
  type RuntimeCutoverMutationResult,
  type RuntimeCutoverRow,
} from "./runtime-cutovers.js";

const CHECKSUM = "a".repeat(64);
const OTHER_CHECKSUM = "b".repeat(64);
const BASE_TIME = 2_000_000_000_000;

function expectApplied(
  result: RuntimeCutoverMutationResult,
): RuntimeCutoverRow {
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("Expected applied result");
  return result.cutover;
}

function expectRejected(
  result: RuntimeCutoverMutationResult,
  reason: Extract<
    RuntimeCutoverMutationResult,
    { status: "rejected" }
  >["reason"],
): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("Expected rejected result");
  expect(result.reason).toBe(reason);
}

describe("runtime cutover controller", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE assistants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL
      );
      CREATE TABLE runtime_stacks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE runtime_worker_leases (
        runtime_stack_id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER NOT NULL
      );
    `);
    db.query(
      "INSERT INTO assistants (id, user_id, org_id) VALUES (?, ?, ?)",
    ).run("assistant-1", "user-1", "org-1");
    db.query(
      "INSERT INTO assistants (id, user_id, org_id) VALUES (?, ?, ?)",
    ).run("assistant-2", "user-2", "org-2");
    db.query(
      `INSERT INTO runtime_stacks (id, org_id, assistant_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("source-1", "org-1", "assistant-1", "active");
    db.query(
      `INSERT INTO runtime_stacks (id, org_id, assistant_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("source-2", "org-2", "assistant-2", "active");
    db.query(
      `INSERT INTO runtime_stacks (id, org_id, assistant_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("worker-1", "pool-org", "pool-owner", "active");
    db.query(
      `INSERT INTO runtime_stacks (id, org_id, assistant_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run("worker-2", "pool-org", "pool-owner", "active");
    db.query(
      `INSERT INTO runtime_worker_leases (
         runtime_stack_id, assistant_id, org_id, lease_token, lease_expires_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "worker-1",
      "assistant-1",
      "org-1",
      "lease-1",
      BASE_TIME + 1_000_000,
    );
    db.query(
      `INSERT INTO runtime_worker_leases (
         runtime_stack_id, assistant_id, org_id, lease_token, lease_expires_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "worker-2",
      "assistant-2",
      "org-2",
      "lease-2",
      BASE_TIME + 1_000_000,
    );
    ensureRuntimeCutoverSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function start(
    targetRuntimeId = "worker-1",
    idempotencyKey = "start-1",
    nowMs = BASE_TIME,
  ): RuntimeCutoverMutationResult {
    return startRuntimeCutover(db, {
      orgId: "org-1",
      assistantId: "assistant-1",
      sourceRuntimeId: "source-1",
      targetRuntimeId,
      idempotencyKey,
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
    });
  }

  function transition(
    expectedVersion: number,
    idempotencyKey: string,
    action: RuntimeCutoverAction,
    nowMs = BASE_TIME + expectedVersion,
  ): RuntimeCutoverMutationResult {
    const cutover = getLatestRuntimeCutover(db, "org-1", "assistant-1");
    if (!cutover) throw new Error("Expected a current cutover");
    return transitionRuntimeCutover(db, {
      orgId: "org-1",
      assistantId: "assistant-1",
      cutoverId: cutover.id,
      expectedVersion,
      idempotencyKey,
      action,
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
    });
  }

  function advanceToCanary(): RuntimeCutoverRow {
    expectApplied(start());
    expectApplied(
      transition(1, "export-1", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    expectApplied(
      transition(2, "restore-1", {
        type: "restore_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    return expectApplied(
      transition(3, "verify-1", {
        type: "verification_passed",
        checkpointChecksum: CHECKSUM,
        sourceHealth: "healthy",
        targetHealth: "healthy",
      }),
    );
  }

  function advanceToCommitted(coolingPeriodMs = 1_000): RuntimeCutoverRow {
    advanceToCanary();
    expectApplied(
      transition(4, "canary-1", {
        type: "canary_passed",
        checkpointChecksum: CHECKSUM,
        sourceHealth: "healthy",
        targetHealth: "healthy",
      }),
    );
    return expectApplied(
      transition(
        5,
        "commit-1",
        { type: "commit", coolingPeriodMs },
        BASE_TIME + 100,
      ),
    );
  }

  test("keeps source routable through verified canary and switches only on commit", () => {
    let cutover = expectApplied(start());
    expect(cutover.sequence).toBe(1);
    expect(cutover.phase).toBe("export");
    expect(routedRuntimeIdForCutover(cutover)).toBe("source-1");
    expect(
      resolveRuntimeCutoverRouting(db, "org-1", "assistant-1")?.runtimeId,
    ).toBe("source-1");

    cutover = expectApplied(
      transition(1, "export-1", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM.toUpperCase(),
      }),
    );
    expect(cutover.phase).toBe("restore");
    expect(routedRuntimeIdForCutover(cutover)).toBe("source-1");

    cutover = expectApplied(
      transition(2, "restore-1", {
        type: "restore_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    expect(cutover.phase).toBe("verify");

    cutover = expectApplied(
      transition(3, "verify-1", {
        type: "verification_passed",
        checkpointChecksum: CHECKSUM,
        sourceHealth: "healthy",
        targetHealth: "healthy",
      }),
    );
    expect(cutover.phase).toBe("canary");

    cutover = expectApplied(
      transition(4, "canary-1", {
        type: "canary_passed",
        checkpointChecksum: CHECKSUM,
        sourceHealth: "healthy",
        targetHealth: "healthy",
      }),
    );
    expect(cutover.phase).toBe("commit");
    expect(routedRuntimeIdForCutover(cutover)).toBe("source-1");
    expect(
      resolveRuntimeCutoverRouting(db, "org-1", "assistant-1")?.runtimeId,
    ).toBe("source-1");

    cutover = expectApplied(
      transition(5, "commit-1", {
        type: "commit",
        coolingPeriodMs: 1_000,
      }),
    );
    expect(cutover.phase).toBe("committed");
    expect(routedRuntimeIdForCutover(cutover)).toBe("worker-1");
    expect(resolveRuntimeCutoverRouting(db, "org-1", "assistant-1")).toEqual({
      runtimeId: "worker-1",
      cutoverId: cutover.id,
      cutoverSequence: 1,
      cutoverVersion: 6,
      phase: "committed",
    });
    expect(
      listRuntimeCutoverAuditEvents(db, cutover.id).map(
        (event) => event.version,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("rejects cross-tenant runtime IDs at start and revalidates leases on every transition", () => {
    expectRejected(start("worker-2"), "runtime_identity_mismatch");
    expect(getRuntimeCutover(db, "org-1", "assistant-1")).toBeNull();

    db.query("UPDATE runtime_stacks SET status = ? WHERE id = ?").run(
      "failed",
      "source-1",
    );
    expectRejected(start(), "runtime_identity_mismatch");
    db.query("UPDATE runtime_stacks SET status = ? WHERE id = ?").run(
      "active",
      "source-1",
    );
    expectApplied(start());
    db.query(
      `UPDATE runtime_worker_leases
       SET org_id = ?, assistant_id = ?
       WHERE runtime_stack_id = ?`,
    ).run("org-2", "assistant-2", "worker-1");
    expectRejected(
      transition(1, "export-after-rebind", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM,
      }),
      "runtime_identity_mismatch",
    );
  });

  test("rejects stale transitions without advancing twice", () => {
    expectApplied(start());
    expectApplied(
      transition(1, "export-winner", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    expectRejected(
      transition(1, "export-loser", {
        type: "export_completed",
        checkpointChecksum: OTHER_CHECKSUM,
      }),
      "stale_version",
    );
    const cutover = getRuntimeCutover(db, "org-1", "assistant-1");
    expect(cutover?.version).toBe(2);
    expect(cutover?.checkpoint_checksum).toBe(CHECKSUM);
    expect(
      listRuntimeCutoverAuditEvents(db, cutover!.id).map(
        (event) => event.idempotency_key,
      ),
    ).toEqual(["start-1", "export-winner"]);
  });

  test("serializes competing controllers against one durable version", () => {
    const path = `/tmp/worklin-runtime-cutover-${randomUUID()}.sqlite`;
    writeFileSync(path, db.serialize());
    db.close();
    db = new Database(path);
    const competitor = new Database(path);
    try {
      const started = expectApplied(start());
      expectApplied(
        transition(1, "controller-a", {
          type: "export_completed",
          checkpointChecksum: CHECKSUM,
        }),
      );
      expectRejected(
        transitionRuntimeCutover(competitor, {
          orgId: "org-1",
          assistantId: "assistant-1",
          cutoverId: started.id,
          expectedVersion: 1,
          idempotencyKey: "controller-b",
          action: {
            type: "export_completed",
            checkpointChecksum: OTHER_CHECKSUM,
          },
          nowMs: BASE_TIME + 1,
          nowIso: new Date(BASE_TIME + 1).toISOString(),
        }),
        "stale_version",
      );
      const durable = getRuntimeCutover(competitor, "org-1", "assistant-1");
      expect(durable?.version).toBe(2);
      expect(durable?.checkpoint_checksum).toBe(CHECKSUM);
      expect(listRuntimeCutoverAuditEvents(competitor, durable!.id)).toHaveLength(
        2,
      );
    } finally {
      competitor.close();
      db.close();
      unlinkSync(path);
      db = new Database(":memory:");
    }
  });

  test("allows sequential migrations only after the previous cutover is terminal", () => {
    const first = expectApplied(start());
    expect(first.sequence).toBe(1);
    expectRejected(start("worker-1", "start-too-soon"), "active_cutover_exists");

    expectApplied(
      transition(1, "rollback-start", {
        type: "begin_rollback",
        error: "operator aborted migration",
      }),
    );
    const terminal = expectApplied(
      transition(2, "rollback-complete", {
        type: "rollback_completed",
        sourceHealth: "healthy",
      }),
    );
    expect(terminal.phase).toBe("rolled_back");
    expect(getActiveRuntimeCutover(db, "org-1", "assistant-1")).toBeNull();

    const second = expectApplied(
      start("worker-1", "start-2", BASE_TIME + 100),
    );
    expect(second.sequence).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(getLatestRuntimeCutover(db, "org-1", "assistant-1")?.id).toBe(
      second.id,
    );
    expect(getActiveRuntimeCutover(db, "org-1", "assistant-1")?.id).toBe(
      second.id,
    );
    expectRejected(
      transitionRuntimeCutover(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: first.id,
        expectedVersion: 1,
        idempotencyKey: "delayed-first-export",
        action: {
          type: "export_completed",
          checkpointChecksum: CHECKSUM,
        },
        nowMs: BASE_TIME + 101,
        nowIso: new Date(BASE_TIME + 101).toISOString(),
      }),
      "cutover_identity_mismatch",
    );
    expect(getLatestRuntimeCutover(db, "org-1", "assistant-1")).toMatchObject({
      id: second.id,
      version: 1,
      phase: "export",
    });
    expect(
      db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count
           FROM runtime_cutovers
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get("org-1", "assistant-1")?.count,
    ).toBe(2);
  });

  test("serializes concurrent second starts after a terminal migration", () => {
    expectApplied(start());
    expectApplied(
      transition(1, "rollback-start", {
        type: "begin_rollback",
        error: "retry on another worker",
      }),
    );
    expectApplied(
      transition(2, "rollback-complete", {
        type: "rollback_completed",
        sourceHealth: "healthy",
      }),
    );

    const path = `/tmp/worklin-runtime-second-cutover-${randomUUID()}.sqlite`;
    writeFileSync(path, db.serialize());
    db.close();
    db = new Database(path);
    const competitor = new Database(path);
    try {
      const winner = expectApplied(
        startRuntimeCutover(db, {
          orgId: "org-1",
          assistantId: "assistant-1",
          sourceRuntimeId: "source-1",
          targetRuntimeId: "worker-1",
          idempotencyKey: "second-controller-a",
          nowMs: BASE_TIME + 200,
          nowIso: new Date(BASE_TIME + 200).toISOString(),
        }),
      );
      expect(winner.sequence).toBe(2);
      expectRejected(
        startRuntimeCutover(competitor, {
          orgId: "org-1",
          assistantId: "assistant-1",
          sourceRuntimeId: "source-1",
          targetRuntimeId: "worker-1",
          idempotencyKey: "second-controller-b",
          nowMs: BASE_TIME + 201,
          nowIso: new Date(BASE_TIME + 201).toISOString(),
        }),
        "active_cutover_exists",
      );
      expect(
        getActiveRuntimeCutover(
          competitor,
          "org-1",
          "assistant-1",
        )?.start_idempotency_key,
      ).toBe("second-controller-a");
      expect(
        competitor
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count
             FROM runtime_cutovers
             WHERE org_id = 'org-1' AND assistant_id = 'assistant-1'`,
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      competitor.close();
      db.close();
      unlinkSync(path);
      db = new Database(":memory:");
    }
  });

  test("replays an earlier start key from durable history without targeting the latest cutover", () => {
    const first = expectApplied(start());
    expectApplied(
      transition(1, "rollback-start", {
        type: "begin_rollback",
        error: "retry",
      }),
    );
    expectApplied(
      transition(2, "rollback-complete", {
        type: "rollback_completed",
        sourceHealth: "healthy",
      }),
    );
    const second = expectApplied(
      start("worker-1", "start-2", BASE_TIME + 100),
    );

    const replay = start("worker-1", "start-1", BASE_TIME + 200);
    expect(replay.status).toBe("duplicate");
    if (replay.status !== "duplicate") {
      throw new Error("Expected historical duplicate");
    }
    expect(replay.cutover.id).toBe(first.id);
    expect(replay.cutover.sequence).toBe(1);
    expect(getLatestRuntimeCutover(db, "org-1", "assistant-1")?.id).toBe(
      second.id,
    );

    const conflict = start("worker-2", "start-1", BASE_TIME + 201);
    expectRejected(conflict, "idempotency_conflict");
    if (conflict.status === "rejected") {
      expect(conflict.cutover?.id).toBe(first.id);
    }
  });

  test("migrates the one-cutover schema and preserves durable history across restart", () => {
    const path = `/tmp/worklin-runtime-cutover-schema-${randomUUID()}.sqlite`;
    db.close();
    db = new Database(path);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE runtime_cutovers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        source_runtime_id TEXT NOT NULL,
        target_runtime_id TEXT NOT NULL,
        start_idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL,
        version INTEGER NOT NULL,
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
        UNIQUE(org_id, assistant_id),
        UNIQUE(org_id, start_idempotency_key)
      );
      CREATE TABLE runtime_cutover_events (
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
      CREATE INDEX idx_runtime_cutovers_phase
        ON runtime_cutovers(phase, updated_at);
      CREATE INDEX idx_runtime_cutover_events_cutover
        ON runtime_cutover_events(cutover_id, version);
      INSERT INTO runtime_cutovers (
        id,
        org_id,
        assistant_id,
        source_runtime_id,
        target_runtime_id,
        start_idempotency_key,
        phase,
        version,
        created_at,
        updated_at
      ) VALUES (
        'legacy-cutover',
        'org-1',
        'assistant-1',
        'source-1',
        'worker-1',
        'legacy-start',
        'rolled_back',
        3,
        '2033-05-18T03:33:20.000Z',
        '2033-05-18T03:33:22.000Z'
      );
      INSERT INTO runtime_cutover_events (
        id,
        cutover_id,
        version,
        idempotency_key,
        event_type,
        from_phase,
        to_phase,
        payload_json,
        created_at
      ) VALUES (
        'legacy-event',
        'legacy-cutover',
        1,
        'legacy-start',
        'cutover_started',
        NULL,
        'export',
        '{}',
        '2033-05-18T03:33:20.000Z'
      );
    `);
    try {
      ensureRuntimeCutoverSchema(db);
      ensureRuntimeCutoverSchema(db);
      expect(getLatestRuntimeCutover(db, "org-1", "assistant-1")).toMatchObject(
        {
          id: "legacy-cutover",
          sequence: 1,
          phase: "rolled_back",
        },
      );
      expect(listRuntimeCutoverAuditEvents(db, "legacy-cutover")).toHaveLength(
        1,
      );
      db.close();
      db = new Database(path);
      ensureRuntimeCutoverSchema(db);
      expect(getActiveRuntimeCutover(db, "org-1", "assistant-1")).toBeNull();
      expect(
        db
          .query<{ name: string }, []>(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_runtime_cutovers_one_nonterminal'`,
          )
          .get()?.name,
      ).toBe("idx_runtime_cutovers_one_nonterminal");
    } finally {
      db.close();
      unlinkSync(path);
      db = new Database(":memory:");
    }
  });

  test("deduplicates exact events and rejects conflicting idempotency replays", () => {
    expectApplied(start());
    const first = transition(1, "export-replay", {
      type: "export_completed",
      checkpointChecksum: CHECKSUM,
    });
    expectApplied(first);

    const duplicate = transition(1, "export-replay", {
      checkpointChecksum: CHECKSUM,
      type: "export_completed",
    });
    expect(duplicate.status).toBe("duplicate");

    expectRejected(
      transition(1, "export-replay", {
        type: "export_completed",
        checkpointChecksum: OTHER_CHECKSUM,
      }),
      "idempotency_conflict",
    );
    const cutover = getRuntimeCutover(db, "org-1", "assistant-1")!;
    expect(cutover.version).toBe(2);
    expect(listRuntimeCutoverAuditEvents(db, cutover.id)).toHaveLength(2);
  });

  test("requires matching checkpoints and healthy source and target gates", () => {
    expectApplied(start());
    expectApplied(
      transition(1, "export-1", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    expectRejected(
      transition(2, "restore-wrong", {
        type: "restore_completed",
        checkpointChecksum: OTHER_CHECKSUM,
      }),
      "checkpoint_mismatch",
    );
    expectApplied(
      transition(2, "restore-1", {
        type: "restore_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    expectRejected(
      transition(3, "verify-unhealthy", {
        type: "verification_passed",
        checkpointChecksum: CHECKSUM,
        sourceHealth: "healthy",
        targetHealth: "unhealthy",
      }),
      "health_gate_failed",
    );
  });

  test("failed canary enters rollback and cannot commit", () => {
    const canary = advanceToCanary();
    expect(canary.phase).toBe("canary");
    const rollback = expectApplied(
      transition(4, "canary-failed", {
        type: "canary_failed",
        error: "target returned errors",
      }),
    );
    expect(rollback.phase).toBe("rollback");
    expect(routedRuntimeIdForCutover(rollback)).toBe("source-1");
    expectRejected(
      transition(5, "commit-after-failure", {
        type: "commit",
        coolingPeriodMs: 1_000,
      }),
      "invalid_transition",
    );
  });

  test("rollback requires a healthy restored source and always routes to it", () => {
    expectApplied(start());
    expectApplied(
      transition(1, "export-1", {
        type: "export_completed",
        checkpointChecksum: CHECKSUM,
      }),
    );
    const rollingBack = expectApplied(
      transition(2, "rollback-start", {
        type: "begin_rollback",
        error: "restore failed",
      }),
    );
    expect(rollingBack.phase).toBe("rollback");
    expectRejected(
      transition(3, "rollback-unhealthy", {
        type: "rollback_completed",
        sourceHealth: "unhealthy",
      }),
      "health_gate_failed",
    );
    const rolledBack = expectApplied(
      transition(3, "rollback-complete", {
        type: "rollback_completed",
        sourceHealth: "healthy",
      }),
    );
    expect(rolledBack.phase).toBe("rolled_back");
    expect(routedRuntimeIdForCutover(rolledBack)).toBe("source-1");
  });

  test("retirement is explicit, cooling-gated, verified, and non-destructive", () => {
    const committed = advanceToCommitted(1_000);
    expect(committed.cooling_until).toBe(BASE_TIME + 1_100);
    expectRejected(
      authorizeRuntimeCutoverSourceRetirement(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: committed.id,
        expectedVersion: 6,
        idempotencyKey: "retire-too-soon",
        checkpointChecksum: CHECKSUM,
        targetHealth: "healthy",
        nowMs: BASE_TIME + 1_099,
        nowIso: new Date(BASE_TIME + 1_099).toISOString(),
      }),
      "cooling_period_active",
    );
    expectRejected(
      authorizeRuntimeCutoverSourceRetirement(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: committed.id,
        expectedVersion: 6,
        idempotencyKey: "retire-unhealthy",
        checkpointChecksum: CHECKSUM,
        targetHealth: "unhealthy",
        nowMs: BASE_TIME + 1_100,
        nowIso: new Date(BASE_TIME + 1_100).toISOString(),
      }),
      "health_gate_failed",
    );
    const retired = expectApplied(
      authorizeRuntimeCutoverSourceRetirement(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: committed.id,
        expectedVersion: 6,
        idempotencyKey: "retire-authorize",
        checkpointChecksum: CHECKSUM,
        targetHealth: "healthy",
        nowMs: BASE_TIME + 1_100,
        nowIso: new Date(BASE_TIME + 1_100).toISOString(),
      }),
    );
    expect(retired.phase).toBe("retirement_authorized");
    expect(routedRuntimeIdForCutover(retired)).toBe("worker-1");
    expect(
      db
        .query<{ status: string }, [string]>(
          "SELECT status FROM runtime_stacks WHERE id = ?",
        )
        .get("source-1")?.status,
    ).toBe("active");
  });

  test("cannot retire a source from failed or incomplete cutovers", () => {
    const cutover = advanceToCanary();
    expectRejected(
      authorizeRuntimeCutoverSourceRetirement(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: cutover.id,
        expectedVersion: 4,
        idempotencyKey: "retire-incomplete",
        checkpointChecksum: CHECKSUM,
        targetHealth: "healthy",
        nowMs: BASE_TIME + 10_000,
        nowIso: new Date(BASE_TIME + 10_000).toISOString(),
      }),
      "invalid_transition",
    );
    expectApplied(
      transition(4, "canary-failed", {
        type: "canary_failed",
        error: "canary failed",
      }),
    );
    expectApplied(
      transition(5, "rollback-failed", {
        type: "rollback_failed",
        error: "source restore failed",
      }),
    );
    expectRejected(
      authorizeRuntimeCutoverSourceRetirement(db, {
        orgId: "org-1",
        assistantId: "assistant-1",
        cutoverId: cutover.id,
        expectedVersion: 6,
        idempotencyKey: "retire-failed",
        checkpointChecksum: CHECKSUM,
        targetHealth: "healthy",
        nowMs: BASE_TIME + 20_000,
        nowIso: new Date(BASE_TIME + 20_000).toISOString(),
      }),
      "invalid_transition",
    );
  });
});
