import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureRuntimeStackSchema } from "./runtime-stacks.js";
import {
  claimRuntimeWorkerLease,
  ensureRuntimeWorkerLeaseSchema,
  getActiveRuntimeWorkerLease,
  markRuntimeWorkerSanitized,
  releaseRuntimeWorkerLease,
  renewRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
} from "./runtime-worker-leases.js";

const NOW_ISO = () => "2026-07-20T10:00:00.000Z";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO assistants (id, user_id, org_id, name, created_at, updated_at)
    VALUES
      ('asst-1', 'user-1', 'org-1', 'Assistant One', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'),
      ('asst-2', 'user-2', 'org-2', 'Assistant Two', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
  `);
  ensureRuntimeStackSchema(db);
  db.exec(`
    INSERT INTO runtime_stacks (
      id,
      org_id,
      assistant_id,
      status,
      provider,
      gateway_url,
      public_ingress_url,
      workspace_volume_ref,
      service_ref,
      actor_signing_key_scope,
      last_health_status,
      last_error,
      created_at,
      updated_at
    ) VALUES
      (
        'worker-1',
        'pool',
        'pool-owner-1',
        'active',
        '${RUNTIME_WORKER_POOL_PROVIDER}',
        'http://worker-1.internal',
        'https://worklin.example.com',
        NULL,
        'service-worker-1',
        'runtime_v1:worker-1',
        '200',
        NULL,
        '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z'
      ),
      (
        'worker-2',
        'pool',
        'pool-owner-2',
        'active',
        '${RUNTIME_WORKER_POOL_PROVIDER}',
        'http://worker-2.internal',
        'https://worklin.example.com',
        NULL,
        'service-worker-2',
        'runtime_v1:worker-2',
        '200',
        NULL,
        '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z'
      );
  `);
  return db;
}

const assistantOne = { id: "asst-1", org_id: "org-1" };
const assistantTwo = { id: "asst-2", org_id: "org-2" };
const workers = ["worker-1", "worker-2"];

describe("runtime worker leases", () => {
  test("acquires an explicitly configured worker and is idempotent by token", () => {
    const db = setupDb();
    const first = claimRuntimeWorkerLease(
      db,
      assistantOne,
      workers,
      2,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );
    const repeated = claimRuntimeWorkerLease(
      db,
      assistantOne,
      workers,
      2,
      "lease-1",
      1_001,
      5_000,
      NOW_ISO,
    );

    expect(first).toMatchObject({
      leaseAcquired: true,
      reason: "acquired",
      assignment: {
        stack: { id: "worker-1", gateway_url: "http://worker-1.internal" },
        lease: {
          assistant_id: "asst-1",
          org_id: "org-1",
          lease_token: "lease-1",
          lease_generation: 1,
        },
      },
    });
    expect(repeated.assignment).toEqual(first.assignment);
  });

  test("increments a monotonic generation for every new lease", () => {
    const db = setupDb();
    const first = claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-1",
      1_000,
      1_000,
      NOW_ISO,
    );
    expect(first.assignment?.lease.lease_generation).toBe(1);

    releaseRuntimeWorkerLease(db, assistantOne, "lease-1", 1_100, NOW_ISO);
    const second = claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-2",
      1_101,
      1_000,
      NOW_ISO,
    );
    expect(second.assignment?.lease.lease_generation).toBe(2);

    const repeated = claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-2",
      1_102,
      1_000,
      NOW_ISO,
    );
    expect(repeated.assignment?.lease.lease_generation).toBe(2);
  });

  test("backfills lease generation without replacing existing rows", () => {
    const db = setupDb();
    db.exec("DROP TABLE runtime_worker_leases");
    db.exec(`
      CREATE TABLE runtime_worker_leases (
        runtime_stack_id TEXT PRIMARY KEY,
        assistant_id TEXT,
        org_id TEXT,
        lease_token TEXT UNIQUE,
        lease_expires_at INTEGER,
        acquired_at INTEGER,
        released_at INTEGER,
        sanitized_at INTEGER,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runtime_worker_leases (
        runtime_stack_id,
        assistant_id,
        org_id,
        lease_token,
        lease_expires_at,
        acquired_at,
        released_at,
        sanitized_at,
        updated_at
      ) VALUES (
        'worker-1',
        'asst-1',
        'org-1',
        'lease-existing',
        5000,
        1000,
        NULL,
        NULL,
        '2026-07-20T10:00:00.000Z'
      );
    `);

    ensureRuntimeWorkerLeaseSchema(db);

    expect(
      db
        .query<
          {
            lease_token: string | null;
            lease_generation: number;
          },
          []
        >(
          `SELECT lease_token, lease_generation
           FROM runtime_worker_leases
           WHERE runtime_stack_id = 'worker-1'`,
        )
        .get(),
    ).toEqual({
      lease_token: "lease-existing",
      lease_generation: 0,
    });
  });

  test("enforces the configured concurrent lease capacity atomically", () => {
    const db = setupDb();
    const first = claimRuntimeWorkerLease(
      db,
      assistantOne,
      workers,
      1,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );
    const blocked = claimRuntimeWorkerLease(
      db,
      assistantTwo,
      workers,
      1,
      "lease-2",
      1_000,
      5_000,
      NOW_ISO,
    );

    expect(first.leaseAcquired).toBe(true);
    expect(blocked).toEqual({
      assignment: null,
      leaseAcquired: false,
      reason: "capacity_exhausted",
      retryAfterMs: 5_000,
    });
    expect(
      db
        .query<
          { count: number },
          []
        >(
          `SELECT COUNT(*) AS count
           FROM runtime_worker_leases
           WHERE lease_token IS NOT NULL`,
        )
        .get()?.count,
    ).toBe(1);
  });

  test("fails closed for a mismatched organization and lease owner", () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      assistantOne,
      workers,
      2,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );

    expect(
      getActiveRuntimeWorkerLease(
        db,
        { id: "asst-1", org_id: "org-2" },
        "lease-1",
        1_001,
      ),
    ).toBeNull();
    expect(() =>
      renewRuntimeWorkerLease(
        db,
        assistantTwo,
        "lease-1",
        1_001,
        5_000,
        NOW_ISO,
      ),
    ).toThrow("lease was lost");
    expect(() =>
      releaseRuntimeWorkerLease(
        db,
        assistantTwo,
        "lease-1",
        1_001,
        NOW_ISO,
      ),
    ).toThrow("lease was lost");
  });

  test("renews and releases only the current assistant lease", () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      assistantOne,
      workers,
      2,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );
    const renewed = renewRuntimeWorkerLease(
      db,
      assistantOne,
      "lease-1",
      2_000,
      10_000,
      NOW_ISO,
    );
    expect(renewed.lease.lease_expires_at).toBe(12_000);

    releaseRuntimeWorkerLease(
      db,
      assistantOne,
      "lease-1",
      2_500,
      NOW_ISO,
    );
    expect(
      getActiveRuntimeWorkerLease(
        db,
        assistantOne,
        "lease-1",
        2_501,
      ),
    ).toBeNull();
    expect(
      db
        .query<
          {
            assistant_id: string | null;
            lease_token: string | null;
            released_at: number | null;
          },
          []
        >(
          `SELECT assistant_id, lease_token, released_at
           FROM runtime_worker_leases
           WHERE runtime_stack_id = 'worker-1'`,
        )
        .get(),
    ).toEqual({
      assistant_id: "asst-1",
      lease_token: null,
      released_at: 2_500,
    });
  });

  test("requires sanitization before a worker can cross assistant boundaries", () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-1",
      1_000,
      1_000,
      NOW_ISO,
    );

    const expiredButBound = claimRuntimeWorkerLease(
      db,
      assistantTwo,
      ["worker-1"],
      1,
      "lease-2",
      2_001,
      1_000,
      NOW_ISO,
    );
    expect(expiredButBound).toMatchObject({
      assignment: null,
      leaseAcquired: false,
      reason: "capacity_exhausted",
    });

    markRuntimeWorkerSanitized(
      db,
      "worker-1",
      assistantOne,
      2_002,
      NOW_ISO,
    );
    const reassigned = claimRuntimeWorkerLease(
      db,
      assistantTwo,
      ["worker-1"],
      1,
      "lease-2",
      2_003,
      1_000,
      NOW_ISO,
    );
    expect(reassigned).toMatchObject({
      leaseAcquired: true,
      reason: "acquired",
      assignment: {
        stack: { id: "worker-1" },
        lease: { assistant_id: "asst-2", org_id: "org-2" },
      },
    });
  });

  test("refuses sanitization while a lease is active", () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );

    expect(() =>
      markRuntimeWorkerSanitized(
        db,
        "worker-1",
        assistantOne,
        1_001,
        NOW_ISO,
      ),
    ).toThrow("cannot be sanitized while leased");
  });

  test("remains inert for ordinary active runtime stacks", () => {
    const db = setupDb();
    db.query(
      `UPDATE runtime_stacks
       SET provider = 'railway'
       WHERE id = 'worker-1'`,
    ).run();

    const claim = claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      1,
      "lease-1",
      1_000,
      5_000,
      NOW_ISO,
    );
    expect(claim).toEqual({
      assignment: null,
      leaseAcquired: false,
      reason: "capacity_exhausted",
      retryAfterMs: null,
    });
  });

  test("does not silently move an assistant outside its configured worker set", () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-1"],
      2,
      "lease-1",
      1_000,
      1_000,
      NOW_ISO,
    );

    const moved = claimRuntimeWorkerLease(
      db,
      assistantOne,
      ["worker-2"],
      2,
      "lease-2",
      2_001,
      1_000,
      NOW_ISO,
    );
    expect(moved).toEqual({
      assignment: null,
      leaseAcquired: false,
      reason: "capacity_exhausted",
      retryAfterMs: null,
    });
  });
});
