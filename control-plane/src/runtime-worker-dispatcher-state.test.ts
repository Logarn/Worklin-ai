import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  dispatchRuntimeWorker,
  releaseDispatchedRuntimeWorker,
  type RuntimeWorkerLifecycleAdapter,
  type RuntimeWorkerPoolConfig,
} from "./runtime-worker-dispatcher.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";
import {
  getRuntimeWorkerStateCheckpoint,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  type RuntimeWorkerStateObject,
} from "./runtime-worker-state-checkpoints.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";

const NOW_ISO = () => "2026-07-20T14:00:00.000Z";
const CHECKSUM = "c".repeat(64);
const WORKSPACE_BYTES = 3_072;
const assistantOne = { id: "asst-1", org_id: "org-1" };
const assistantTwo = { id: "asst-2", org_id: "org-2" };
const poolConfig: RuntimeWorkerPoolConfig = {
  enabled: true,
  candidateStackIds: ["worker-1"],
  maxConcurrentLeases: 1,
  leaseTtlMs: 10_000,
};

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
    ) VALUES (
      'worker-1',
      'pool',
      'pool-owner',
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
    );
  `);
  return db;
}

function exportedObject(objectKey: string): RuntimeWorkerStateObject {
  return {
    provider: "gcs",
    bucket: "worklin-runtime-state",
    objectKey,
    checksumSha256: CHECKSUM,
    byteSize: 8_192,
    format: "vbundle-v1",
  };
}

function exportedState(objectKey: string) {
  return {
    object: exportedObject(objectKey),
    workspaceByteSize: WORKSPACE_BYTES,
  };
}

function immediateLifecycle(
  overrides: Partial<RuntimeWorkerLifecycleAdapter> = {},
): RuntimeWorkerLifecycleAdapter {
  return {
    storage: {
      restore: async ({ object, expectedWorkspaceByteSize }) => ({
        checksumSha256: object?.checksumSha256 ?? null,
        workspaceByteSize: expectedWorkspaceByteSize ?? 0,
      }),
      export: async ({ objectKey }) => exportedState(objectKey),
    },
    sanitize: async () => {},
    revokeAuthority: async () => {},
    ...overrides,
  };
}

describe("runtime worker checkpoint lifecycle integration", () => {
  test("keeps lease generations separate from tenant state generations", async () => {
    const db = setupDb();
    const restoreGenerations: Array<{
      leaseGeneration: number;
      stateGeneration: number;
    }> = [];
    const exportGenerations: Array<{
      leaseGeneration: number;
      currentStateGeneration: number;
      nextStateGeneration: number;
    }> = [];
    const sanitizeGenerations: number[] = [];
    const lifecycle = immediateLifecycle({
      storage: {
        restore: async ({
          leaseGeneration,
          stateGeneration,
          object,
          expectedWorkspaceByteSize,
        }) => {
          restoreGenerations.push({ leaseGeneration, stateGeneration });
          return {
            checksumSha256: object?.checksumSha256 ?? null,
            workspaceByteSize: expectedWorkspaceByteSize ?? 0,
          };
        },
        export: async ({
          leaseGeneration,
          currentStateGeneration,
          nextStateGeneration,
          objectKey,
        }) => {
          exportGenerations.push({
            leaseGeneration,
            currentStateGeneration,
            nextStateGeneration,
          });
          return exportedState(objectKey);
        },
      },
      sanitize: async ({ leaseGeneration }) => {
        sanitizeGenerations.push(leaseGeneration);
      },
    });

    expect(
      await dispatchRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "lease-1",
        1_000,
        NOW_ISO,
        lifecycle,
      ),
    ).toMatchObject({
      status: "leased",
      assignment: { lease: { lease_generation: 1 } },
    });
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_001,
        NOW_ISO,
        lifecycle,
      ),
    ).toEqual({ status: "released" });
    expect(
      await dispatchRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "lease-2",
        1_002,
        NOW_ISO,
        lifecycle,
      ),
    ).toMatchObject({
      status: "leased",
      assignment: { lease: { lease_generation: 2 } },
    });

    expect(restoreGenerations).toEqual([
      { leaseGeneration: 1, stateGeneration: 0 },
      { leaseGeneration: 2, stateGeneration: 1 },
    ]);
    expect(exportGenerations).toEqual([
      {
        leaseGeneration: 1,
        currentStateGeneration: 0,
        nextStateGeneration: 1,
      },
    ]);
    expect(sanitizeGenerations).toEqual([1]);
  });

  test("fails closed without a lifecycle adapter and does not claim a lease", async () => {
    const db = setupDb();
    expect(
      await dispatchRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "lease-1",
        1_000,
        NOW_ISO,
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "state_lifecycle_unavailable",
    });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM runtime_worker_leases
           WHERE lease_token IS NOT NULL`,
        )
        .get()?.count,
    ).toBe(0);
  });

  test("does not return a routable assignment before restore completes", async () => {
    const db = setupDb();
    let restoreStarted = false;
    let finishRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const lifecycle = immediateLifecycle({
      storage: {
        restore: async () => {
          restoreStarted = true;
          await restoreGate;
          return { checksumSha256: null, workspaceByteSize: 0 };
        },
        export: async ({ objectKey }) => exportedState(objectKey),
      },
    });

    let routed = false;
    const dispatch = dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle,
    ).then((result) => {
      routed = result.status === "leased";
      return result;
    });
    await Promise.resolve();

    expect(restoreStarted).toBe(true);
    expect(routed).toBe(false);
    expect(
      getRuntimeWorkerStateCheckpoint(db, {
        orgId: "org-1",
        assistantId: "asst-1",
      })?.status,
    ).toBe("restoring");

    finishRestore();
    expect(await dispatch).toMatchObject({
      status: "leased",
      assignment: { stack: { id: "worker-1" } },
    });
  });

  test("does not release or sanitize a worker before export completes", async () => {
    const db = setupDb();
    const base = immediateLifecycle();
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      base,
    );

    let finishExport!: (object: ReturnType<typeof exportedState>) => void;
    let exportObjectKey = "";
    let sanitizeCalls = 0;
    const exportGate = new Promise<ReturnType<typeof exportedState>>(
      (resolve) => {
        finishExport = resolve;
      },
    );
    const gated = immediateLifecycle({
      storage: {
        restore: base.storage.restore,
        export: async ({ objectKey }) => {
          exportObjectKey = objectKey;
          return exportGate;
        },
      },
      sanitize: async () => {
        sanitizeCalls += 1;
      },
    });
    let released = false;
    const release = releaseDispatchedRuntimeWorker(
      db,
      assistantOne,
      "lease-1",
      1_001,
      NOW_ISO,
      gated,
    ).then((result) => {
      released = result.status === "released";
      return result;
    });
    await Promise.resolve();

    expect(released).toBe(false);
    expect(sanitizeCalls).toBe(0);
    expect(
      db
        .query<
          { lease_token: string | null },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBe("lease-1");

    finishExport(exportedState(exportObjectKey));
    expect(await release).toEqual({ status: "released" });
    expect(sanitizeCalls).toBe(1);
  });

  test("quarantines failed restore and export without routing or reuse", async () => {
    const restoreDb = setupDb();
    const failedRestore = await dispatchRuntimeWorker(
      restoreDb,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      immediateLifecycle({
        storage: {
          restore: async () => {
            throw new Error("storage unavailable");
          },
          export: async ({ objectKey }) => exportedState(objectKey),
        },
      }),
    );
    expect(failedRestore).toMatchObject({
      status: "unavailable",
      reason: "state_quarantined",
    });
    expect(
      getRuntimeWorkerStateCheckpoint(restoreDb, {
        orgId: "org-1",
        assistantId: "asst-1",
      }),
    ).toMatchObject({
      status: "quarantined",
      failure_code: "storage_unavailable",
    });
    expect(
      await dispatchRuntimeWorker(
        restoreDb,
        assistantTwo,
        poolConfig,
        "lease-2",
        1_001,
        NOW_ISO,
        immediateLifecycle(),
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "capacity_exhausted",
    });

    const exportDb = setupDb();
    const lifecycle = immediateLifecycle();
    await dispatchRuntimeWorker(
      exportDb,
      assistantOne,
      poolConfig,
      "lease-1",
      2_000,
      NOW_ISO,
      lifecycle,
    );
    let sanitizeCalls = 0;
    const failedExport = await releaseDispatchedRuntimeWorker(
      exportDb,
      assistantOne,
      "lease-1",
      2_001,
      NOW_ISO,
      immediateLifecycle({
        storage: {
          restore: lifecycle.storage.restore,
          export: async () => {
            throw new Error("storage unavailable");
          },
        },
        sanitize: async () => {
          sanitizeCalls += 1;
        },
      }),
    );
    expect(failedExport).toEqual({ status: "state_quarantined" });
    expect(sanitizeCalls).toBe(0);
    expect(
      getRuntimeWorkerStateCheckpoint(exportDb, {
        orgId: "org-1",
        assistantId: "asst-1",
      })?.status,
    ).toBe("quarantined");
  });

  test("rejects a stale restore generation before routing", async () => {
    const db = setupDb();
    let finishRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const dispatch = dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      immediateLifecycle({
        storage: {
          restore: async () => {
            await restoreGate;
            return { checksumSha256: null, workspaceByteSize: 0 };
          },
          export: async ({ objectKey }) => exportedState(objectKey),
        },
      }),
    );
    await Promise.resolve();
    db.query(
      `UPDATE runtime_worker_state_checkpoints
       SET generation = generation + 1
       WHERE org_id = ? AND assistant_id = ?`,
    ).run("org-1", "asst-1");
    finishRestore();

    expect(await dispatch).toMatchObject({
      status: "unavailable",
      reason: "state_restore_failed",
    });
  });

  test("blocks cross-assistant reuse until sanitization and excludes CES credentials", async () => {
    const db = setupDb();
    const restorePolicies: string[] = [];
    const lifecycle = immediateLifecycle({
      storage: {
        restore: async ({
          object,
          credentialPolicy,
          expectedWorkspaceByteSize,
        }) => {
          restorePolicies.push(credentialPolicy);
          return {
            checksumSha256: object?.checksumSha256 ?? null,
            workspaceByteSize: expectedWorkspaceByteSize ?? 0,
          };
        },
        export: async ({ objectKey }) => exportedState(objectKey),
      },
    });
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle,
    );

    const exportPolicies: string[] = [];
    const sanitizePolicies: string[] = [];
    const failedSanitizer = immediateLifecycle({
      storage: {
        restore: lifecycle.storage.restore,
        export: async ({ objectKey, credentialPolicy }) => {
          exportPolicies.push(credentialPolicy);
          return exportedState(objectKey);
        },
      },
      sanitize: async ({ credentialPolicy }) => {
        sanitizePolicies.push(credentialPolicy);
        throw new Error("sanitizer offline");
      },
    });
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_001,
        NOW_ISO,
        failedSanitizer,
      ),
    ).toEqual({ status: "sanitization_failed" });
    expect(exportPolicies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
    expect(sanitizePolicies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
    expect(
      await dispatchRuntimeWorker(
        db,
        assistantTwo,
        poolConfig,
        "lease-2",
        1_002,
        NOW_ISO,
        lifecycle,
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "capacity_exhausted",
    });

    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_003,
        NOW_ISO,
        lifecycle,
      ),
    ).toEqual({ status: "released" });
    expect(
      await dispatchRuntimeWorker(
        db,
        assistantTwo,
        poolConfig,
        "lease-2",
        1_004,
        NOW_ISO,
        lifecycle,
      ),
    ).toMatchObject({
      status: "leased",
      assignment: { stack: { id: "worker-1" } },
    });
    expect(restorePolicies).toEqual([
      RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    ]);
  });

  test("revokes authority after sanitization and before durable lease release", async () => {
    const db = setupDb();
    const base = immediateLifecycle();
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      base,
    );

    const events: string[] = [];
    const revocationFailure = immediateLifecycle({
      storage: {
        restore: base.storage.restore,
        export: async ({ objectKey }) => {
          events.push("export");
          return exportedState(objectKey);
        },
      },
      sanitize: async () => {
        events.push("sanitize");
      },
      revokeAuthority: async () => {
        events.push("revoke");
        throw new Error("gateway unavailable");
      },
    });
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_001,
        NOW_ISO,
        revocationFailure,
      ),
    ).toEqual({ status: "authority_revocation_failed" });
    expect(events).toEqual(["export", "sanitize", "revoke"]);
    expect(
      db
        .query<
          { lease_token: string | null },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBe("lease-1");

    const retryEvents: string[] = [];
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_002,
        NOW_ISO,
        immediateLifecycle({
          sanitize: async () => {
            retryEvents.push("sanitize");
          },
          revokeAuthority: async ({ leaseGeneration }) => {
            retryEvents.push(`revoke:${leaseGeneration}`);
          },
        }),
      ),
    ).toEqual({ status: "released" });
    expect(retryEvents).toEqual(["sanitize", "revoke:1"]);
    expect(
      db
        .query<
          { lease_token: string | null },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBeNull();
  });

  test("final release CAS cannot clear a newer worker generation", async () => {
    const db = setupDb();
    const base = immediateLifecycle();
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      base,
    );

    const events: string[] = [];
    const result = await releaseDispatchedRuntimeWorker(
      db,
      assistantOne,
      "lease-1",
      1_001,
      NOW_ISO,
      immediateLifecycle({
        storage: {
          restore: base.storage.restore,
          export: async ({ objectKey }) => {
            events.push("export");
            return exportedState(objectKey);
          },
        },
        sanitize: async () => {
          events.push("sanitize");
        },
        revokeAuthority: async () => {
          events.push("revoke");
          // Simulate ownership changing after the exact old generation was
          // revoked but before the coordinator commits its final DB release.
          db.query(
            `UPDATE runtime_worker_leases
             SET lease_token = 'lease-2',
                 lease_generation = 2,
                 lease_expires_at = 90000
             WHERE runtime_stack_id = 'worker-1'`,
          ).run();
        },
      }),
    );

    expect(result).toEqual({ status: "lease_lost" });
    expect(events).toEqual(["export", "sanitize", "revoke"]);
    expect(
      db
        .query<
          {
            assistant_id: string | null;
            lease_token: string | null;
            lease_generation: number;
            sanitized_at: number | null;
          },
          [string]
        >(
          `SELECT assistant_id, lease_token, lease_generation, sanitized_at
           FROM runtime_worker_leases
           WHERE runtime_stack_id = ?`,
        )
        .get("worker-1"),
    ).toEqual({
      assistant_id: assistantOne.id,
      lease_token: "lease-2",
      lease_generation: 2,
      sanitized_at: null,
    });
    expect(
      db
        .query<
          { status: string; worker_stack_id: string | null },
          [string, string]
        >(
          `SELECT status, worker_stack_id
           FROM runtime_worker_state_checkpoints
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get(assistantOne.org_id, assistantOne.id),
    ).toEqual({
      status: "exported",
      worker_stack_id: "worker-1",
    });
  });
});
