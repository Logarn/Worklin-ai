import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  assertRuntimeWorkerStateExportedForRelease,
  assertRuntimeWorkerStateReadyForLease,
  beginRuntimeWorkerStateExport,
  beginRuntimeWorkerStateRestore,
  buildRuntimeWorkerStateObjectKey,
  completeRuntimeWorkerStateExport,
  completeRuntimeWorkerStateRestore,
  ensureRuntimeWorkerStateCheckpointSchema,
  exportRuntimeWorkerStateWithStorage,
  getRuntimeWorkerStateCheckpoint,
  markRuntimeWorkerStateReleased,
  restoreRuntimeWorkerStateWithStorage,
  RuntimeWorkerStateError,
  type RuntimeWorkerStateErrorCode,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateStorage,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";

const NOW_ISO = () => "2026-07-20T12:00:00.000Z";
const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);
const tenantA = { orgId: "org-a", assistantId: "assistant-a" };
const tenantB = { orgId: "org-b", assistantId: "assistant-b" };

function setupDb(): Database {
  const db = new Database(":memory:");
  ensureRuntimeWorkerStateCheckpointSchema(db);
  return db;
}

function objectFor(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
  checksumSha256 = CHECKSUM_A,
): RuntimeWorkerStateObject {
  return {
    provider: "gcs",
    bucket: "worklin-runtime-state",
    objectKey: buildRuntimeWorkerStateObjectKey(tenant, generation),
    checksumSha256,
    byteSize: 4_096,
    format: "vbundle-v1",
  };
}

function expectStateError(
  callback: () => unknown,
  code: RuntimeWorkerStateErrorCode,
): void {
  try {
    callback();
    throw new Error(`Expected RuntimeWorkerStateError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeWorkerStateError);
    expect((error as RuntimeWorkerStateError).code).toBe(code);
  }
}

async function expectAsyncStateError(
  callback: () => Promise<unknown>,
  code: RuntimeWorkerStateErrorCode,
): Promise<void> {
  try {
    await callback();
    throw new Error(`Expected RuntimeWorkerStateError(${code}).`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeWorkerStateError);
    expect((error as RuntimeWorkerStateError).code).toBe(code);
  }
}

function makeStorage(overrides?: Partial<RuntimeWorkerStateStorage>): RuntimeWorkerStateStorage {
  return {
    restore: async ({ object }) => ({
      checksumSha256: object?.checksumSha256 ?? null,
    }),
    export: async ({ tenant, nextGeneration }) =>
      objectFor(tenant, nextGeneration),
    ...overrides,
  };
}

describe("runtime worker tenant checkpoints", () => {
  test("restores before readiness and exports a monotonic checkpoint before release", async () => {
    const db = setupDb();
    const restored = await restoreRuntimeWorkerStateWithStorage(
      db,
      makeStorage(),
      tenantA,
      "worker-1",
      0,
      "restore-1",
      NOW_ISO,
    );

    expect(restored).toMatchObject({
      generation: 0,
      status: "ready",
      worker_stack_id: "worker-1",
      restored_generation: 0,
    });
    expect(
      assertRuntimeWorkerStateReadyForLease(db, tenantA, "worker-1").status,
    ).toBe("ready");
    expectStateError(
      () =>
        assertRuntimeWorkerStateExportedForRelease(
          db,
          tenantA,
          "worker-1",
        ),
      "state_not_exported",
    );

    const exported = await exportRuntimeWorkerStateWithStorage(
      db,
      makeStorage(),
      tenantA,
      "worker-1",
      0,
      "export-1",
      NOW_ISO,
    );
    expect(exported).toMatchObject({
      generation: 1,
      status: "exported",
      object_key: buildRuntimeWorkerStateObjectKey(tenantA, 1),
      checksum_sha256: CHECKSUM_A,
    });
    expect(
      assertRuntimeWorkerStateExportedForRelease(
        db,
        tenantA,
        "worker-1",
      ).generation,
    ).toBe(1);

    const released = markRuntimeWorkerStateReleased(
      db,
      tenantA,
      "worker-1",
      NOW_ISO,
    );
    expect(released).toMatchObject({
      generation: 1,
      status: "checkpointed",
      worker_stack_id: null,
    });

    const restorePlan = beginRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-2",
      1,
      "restore-2",
      NOW_ISO,
    );
    expect(restorePlan).toEqual({
      generation: 1,
      object: objectFor(tenantA, 1),
      idempotent: false,
    });
    completeRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-2",
      1,
      "restore-2",
      CHECKSUM_A,
      NOW_ISO,
    );
    expect(
      assertRuntimeWorkerStateReadyForLease(db, tenantA, "worker-2"),
    ).toMatchObject({ generation: 1, restored_generation: 1 });
  });

  test("rejects stale generations and concurrent restore claims", () => {
    const db = setupDb();
    const first = beginRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-1",
      0,
      "restore-1",
      NOW_ISO,
    );
    expect(first.idempotent).toBe(false);
    expect(
      beginRuntimeWorkerStateRestore(
        db,
        tenantA,
        "worker-1",
        0,
        "restore-1",
        NOW_ISO,
      ).idempotent,
    ).toBe(true);
    expectStateError(
      () =>
        beginRuntimeWorkerStateRestore(
          db,
          tenantA,
          "worker-2",
          0,
          "restore-racer",
          NOW_ISO,
        ),
      "concurrent_operation",
    );
    expectStateError(
      () =>
        beginRuntimeWorkerStateRestore(
          db,
          tenantA,
          "worker-1",
          1,
          "restore-stale",
          NOW_ISO,
        ),
      "stale_generation",
    );
  });

  test("rejects cross-tenant object reuse and signed transport metadata", () => {
    const db = setupDb();
    for (const [tenant, worker, operation] of [
      [tenantA, "worker-a", "restore-a"],
      [tenantB, "worker-b", "restore-b"],
    ] as const) {
      beginRuntimeWorkerStateRestore(
        db,
        tenant,
        worker,
        0,
        operation,
        NOW_ISO,
      );
      completeRuntimeWorkerStateRestore(
        db,
        tenant,
        worker,
        0,
        operation,
        null,
        NOW_ISO,
      );
    }
    beginRuntimeWorkerStateExport(
      db,
      tenantB,
      "worker-b",
      0,
      "export-b",
      NOW_ISO,
    );
    expectStateError(
      () =>
        completeRuntimeWorkerStateExport(
          db,
          tenantB,
          "worker-b",
          0,
          "export-b",
          objectFor(tenantA, 1),
          NOW_ISO,
        ),
      "cross_tenant_object",
    );

    const signedUrlObject = {
      ...objectFor(tenantB, 1),
      objectKey:
        "https://storage.googleapis.com/worklin-runtime-state/object" +
        "?X-Goog-Signature=top-secret",
    };
    expectStateError(
      () =>
        completeRuntimeWorkerStateExport(
          db,
          tenantB,
          "worker-b",
          0,
          "export-b",
          signedUrlObject,
          NOW_ISO,
        ),
      "cross_tenant_object",
    );

    const serialized = JSON.stringify(
      db.query("SELECT * FROM runtime_worker_state_checkpoints").all(),
    );
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("X-Goog-Signature");
    expect(serialized).not.toContain("https://");
  });

  test("fails closed and quarantines a worker when restore storage is unavailable", async () => {
    const db = setupDb();
    const secretBearingFailure =
      "https://storage.googleapis.com/bucket/object?X-Goog-Signature=secret";
    await expectAsyncStateError(
      () =>
        restoreRuntimeWorkerStateWithStorage(
          db,
          makeStorage({
            restore: async () => {
              throw new Error(secretBearingFailure);
            },
          }),
          tenantA,
          "worker-1",
          0,
          "restore-1",
          NOW_ISO,
        ),
      "quarantined",
    );

    expect(getRuntimeWorkerStateCheckpoint(db, tenantA)).toMatchObject({
      status: "quarantined",
      failure_code: "storage_unavailable",
      operation_id: null,
      restored_generation: null,
    });
    expectStateError(
      () => assertRuntimeWorkerStateReadyForLease(db, tenantA, "worker-1"),
      "quarantined",
    );
    const serialized = JSON.stringify(
      db.query("SELECT * FROM runtime_worker_state_checkpoints").all(),
    );
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("https://");
  });

  test("fails closed and quarantines a worker when export storage is unavailable", async () => {
    const db = setupDb();
    await restoreRuntimeWorkerStateWithStorage(
      db,
      makeStorage(),
      tenantA,
      "worker-1",
      0,
      "restore-1",
      NOW_ISO,
    );
    await expectAsyncStateError(
      () =>
        exportRuntimeWorkerStateWithStorage(
          db,
          makeStorage({
            export: async () => {
              throw new Error("GCS request failed with credential=secret");
            },
          }),
          tenantA,
          "worker-1",
          0,
          "export-1",
          NOW_ISO,
        ),
      "quarantined",
    );

    expect(getRuntimeWorkerStateCheckpoint(db, tenantA)).toMatchObject({
      generation: 0,
      status: "quarantined",
      failure_code: "storage_unavailable",
    });
    expectStateError(
      () =>
        assertRuntimeWorkerStateExportedForRelease(
          db,
          tenantA,
          "worker-1",
        ),
      "quarantined",
    );
    expect(
      JSON.stringify(
        db.query("SELECT * FROM runtime_worker_state_checkpoints").all(),
      ),
    ).not.toContain("credential=secret");
  });

  test("rejects checksum mismatches and replayed export generations", async () => {
    const db = setupDb();
    beginRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-1",
      0,
      "restore-1",
      NOW_ISO,
    );
    completeRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-1",
      0,
      "restore-1",
      null,
      NOW_ISO,
    );
    beginRuntimeWorkerStateExport(
      db,
      tenantA,
      "worker-1",
      0,
      "export-1",
      NOW_ISO,
    );
    completeRuntimeWorkerStateExport(
      db,
      tenantA,
      "worker-1",
      0,
      "export-1",
      objectFor(tenantA, 1),
      NOW_ISO,
    );
    db.query(
      `UPDATE runtime_worker_state_checkpoints
       SET generation = 0,
           status = 'exporting',
           operation_id = 'replay-export',
           restored_generation = 0
       WHERE org_id = ? AND assistant_id = ?`,
    ).run(tenantA.orgId, tenantA.assistantId);
    expectStateError(
      () =>
        completeRuntimeWorkerStateExport(
          db,
          tenantA,
          "worker-1",
          0,
          "replay-export",
          objectFor(tenantA, 1),
          NOW_ISO,
        ),
      "object_replay",
    );
    db.query(
      `UPDATE runtime_worker_state_checkpoints
       SET generation = 1,
           status = 'exported',
           operation_id = NULL,
           restored_generation = NULL
       WHERE org_id = ? AND assistant_id = ?`,
    ).run(tenantA.orgId, tenantA.assistantId);
    markRuntimeWorkerStateReleased(db, tenantA, "worker-1", NOW_ISO);

    expectStateError(
      () =>
        beginRuntimeWorkerStateRestore(
          db,
          tenantA,
          "worker-2",
          0,
          "restore-stale",
          NOW_ISO,
        ),
      "stale_generation",
    );

    beginRuntimeWorkerStateRestore(
      db,
      tenantA,
      "worker-2",
      1,
      "restore-2",
      NOW_ISO,
    );
    expectStateError(
      () =>
        completeRuntimeWorkerStateRestore(
          db,
          tenantA,
          "worker-2",
          1,
          "restore-2",
          CHECKSUM_B,
          NOW_ISO,
        ),
      "checksum_mismatch",
    );
    expect(getRuntimeWorkerStateCheckpoint(db, tenantA)?.status).toBe(
      "quarantined",
    );
  });
});
