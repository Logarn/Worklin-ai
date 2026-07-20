import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureRuntimeStackSchema } from "./runtime-stacks.js";
import {
  dispatchRuntimeWorker,
  getRuntimeWorkerCapacityTelemetry,
  inspectRuntimeWorkerCandidates,
  releaseDispatchedRuntimeWorker,
  renewDispatchedRuntimeWorker,
  runtimeWorkerPoolConfigFromEnv,
  type RuntimeWorkerLifecycleAdapter,
  type RuntimeWorkerPoolConfig,
} from "./runtime-worker-dispatcher.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";

const NOW_ISO = () => "2026-07-20T12:00:00.000Z";

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
        'worker-1', 'pool', 'pool-owner-1', 'active',
        '${RUNTIME_WORKER_POOL_PROVIDER}', 'http://worker-1.internal',
        'https://worklin.example.com', NULL, 'service-worker-1',
        'runtime_v1:worker-1', '200', NULL,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      ),
      (
        'worker-2', 'pool', 'pool-owner-2', 'active',
        '${RUNTIME_WORKER_POOL_PROVIDER}', 'http://worker-2.internal',
        'https://worklin.example.com', NULL, 'service-worker-2',
        'runtime_v1:worker-2', '503', NULL,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
  `);
  return db;
}

function config(
  overrides: Partial<RuntimeWorkerPoolConfig> = {},
): RuntimeWorkerPoolConfig {
  return {
    enabled: true,
    candidateStackIds: ["worker-1", "worker-2"],
    maxConcurrentLeases: 2,
    leaseTtlMs: 5_000,
    ...overrides,
  };
}

const assistantOne = { id: "asst-1", org_id: "org-1" };
const assistantTwo = { id: "asst-2", org_id: "org-2" };
const CHECKSUM = "a".repeat(64);

function lifecycle(): RuntimeWorkerLifecycleAdapter {
  return {
    storage: {
      restore: async ({ object }) => ({
        checksumSha256: object?.checksumSha256 ?? null,
      }),
      export: async ({ objectKey }) => ({
        provider: "gcs",
        bucket: "worklin-runtime-state",
        objectKey,
        checksumSha256: CHECKSUM,
        byteSize: 4_096,
        format: "vbundle-v1",
      }),
    },
    sanitize: async () => {},
  };
}

describe("runtime worker pool config", () => {
  test("is disabled with no registered workers by default", () => {
    expect(runtimeWorkerPoolConfigFromEnv({})).toEqual({
      enabled: false,
      candidateStackIds: [],
      maxConcurrentLeases: 0,
      leaseTtlMs: 60_000,
    });
  });

  test("parses an explicitly enabled bounded pool", () => {
    expect(
      runtimeWorkerPoolConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS:
          " worker-1, worker-2, worker-1 ",
        WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: "2",
        WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS: "45000",
      }),
    ).toEqual({
      enabled: true,
      candidateStackIds: ["worker-1", "worker-2"],
      maxConcurrentLeases: 2,
      leaseTtlMs: 45_000,
    });
  });
});

describe("runtime worker dispatcher", () => {
  test("does not inspect or lease workers while disabled", async () => {
    const db = setupDb();
    const result = await dispatchRuntimeWorker(
      db,
      assistantOne,
      runtimeWorkerPoolConfigFromEnv({}),
      "lease-1",
      1_000,
      NOW_ISO,
    );

    expect(result).toMatchObject({
      status: "disabled",
      telemetry: { state: "disabled", activeLeaseCount: 0 },
    });
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM runtime_worker_leases")
        .get()?.count,
    ).toBe(0);
  });

  test("reports explicitly enabled empty capacity without claiming", async () => {
    const db = setupDb();
    const result = await dispatchRuntimeWorker(
      db,
      assistantOne,
      config({ candidateStackIds: [], maxConcurrentLeases: 0 }),
      "lease-1",
      1_000,
      NOW_ISO,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "empty_capacity",
      telemetry: {
        state: "empty",
        configuredWorkerCount: 0,
        availableNewAssistantCapacity: 0,
      },
    });
  });

  test("excludes unhealthy and unregistered runtime stacks", async () => {
    const db = setupDb();
    const poolConfig = config({
      candidateStackIds: ["worker-2", "missing-worker"],
      maxConcurrentLeases: 2,
    });
    expect(inspectRuntimeWorkerCandidates(db, poolConfig)).toEqual([
      { stackId: "worker-2", readiness: "unhealthy", stack: null },
      { stackId: "missing-worker", readiness: "missing", stack: null },
    ]);

    const result = await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
    );
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "no_ready_workers",
      telemetry: {
        state: "unavailable",
        readyWorkerCount: 0,
        unhealthyWorkerCount: 1,
        missingWorkerCount: 1,
      },
    });
  });

  test("enforces max concurrency and exposes saturation telemetry", async () => {
    const db = setupDb();
    db.query(
      "UPDATE runtime_stacks SET last_health_status = '200' WHERE id = 'worker-2'",
    ).run();
    const poolConfig = config({ maxConcurrentLeases: 1 });
    const first = await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle(),
    );
    const blocked = await dispatchRuntimeWorker(
      db,
      assistantTwo,
      poolConfig,
      "lease-2",
      1_001,
      NOW_ISO,
      lifecycle(),
    );

    expect(first.status).toBe("leased");
    expect(blocked).toMatchObject({
      status: "unavailable",
      reason: "capacity_exhausted",
      retryAfterMs: 4_999,
      telemetry: {
        state: "saturated",
        activeLeaseCount: 1,
        maxConcurrentLeases: 1,
        availableNewAssistantCapacity: 0,
      },
    });
  });

  test("returns a typed lease-loss result for renewal and release", async () => {
    const db = setupDb();
    const poolConfig = config({ candidateStackIds: ["worker-1"] });
    const assignment = await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle(),
    );
    expect(assignment.status).toBe("leased");

    expect(
      renewDispatchedRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "wrong-token",
        1_001,
        NOW_ISO,
        lifecycle(),
      ),
    ).toEqual({ status: "lease_lost" });
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "wrong-token",
        1_001,
        NOW_ISO,
        lifecycle(),
      ),
    ).toEqual({ status: "lease_lost" });
  });

  test("releases a worker only after the sanitizer clears it", async () => {
    const db = setupDb();
    const poolConfig = config({
      candidateStackIds: ["worker-1"],
      maxConcurrentLeases: 1,
    });
    const assignment = await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle(),
    );
    expect(assignment.status).toBe("leased");
    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        assistantOne,
        "lease-1",
        1_001,
        NOW_ISO,
        lifecycle(),
      ),
    ).toEqual({ status: "released" });

    const denied = await dispatchRuntimeWorker(
      db,
      assistantTwo,
      poolConfig,
      "lease-2",
      1_002,
      NOW_ISO,
      lifecycle(),
    );
    expect(denied).toMatchObject({
      status: "leased",
    });
  });

  test("renews only while the registered worker remains healthy", async () => {
    const db = setupDb();
    const poolConfig = config({ candidateStackIds: ["worker-1"] });
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      poolConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle(),
    );
    expect(
      renewDispatchedRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "lease-1",
        1_001,
        NOW_ISO,
        lifecycle(),
      ),
    ).toMatchObject({ status: "renewed" });

    db.query(
      "UPDATE runtime_stacks SET last_health_status = '503' WHERE id = 'worker-1'",
    ).run();
    expect(
      renewDispatchedRuntimeWorker(
        db,
        assistantOne,
        poolConfig,
        "lease-1",
        1_002,
        NOW_ISO,
        lifecycle(),
      ),
    ).toEqual({ status: "worker_unavailable" });
  });

  test("provides count-only degraded capacity telemetry for operators", () => {
    const db = setupDb();
    const telemetry = getRuntimeWorkerCapacityTelemetry(
      db,
      config({
        candidateStackIds: ["worker-1", "worker-2", "missing-worker"],
      }),
      1_000,
    );
    expect(telemetry).toEqual({
      state: "degraded",
      configuredWorkerCount: 3,
      readyWorkerCount: 1,
      unhealthyWorkerCount: 1,
      missingWorkerCount: 1,
      activeLeaseCount: 0,
      unregisteredActiveLeaseCount: 0,
      boundIdleWorkerCount: 0,
      unboundReadyWorkerCount: 1,
      maxConcurrentLeases: 2,
      availableNewAssistantCapacity: 1,
    });
  });

  test("counts active leases removed from registration against the global cap", async () => {
    const db = setupDb();
    const firstConfig = config({
      candidateStackIds: ["worker-1"],
      maxConcurrentLeases: 1,
    });
    await dispatchRuntimeWorker(
      db,
      assistantOne,
      firstConfig,
      "lease-1",
      1_000,
      NOW_ISO,
      lifecycle(),
    );
    db.query(
      "UPDATE runtime_stacks SET last_health_status = '200' WHERE id = 'worker-2'",
    ).run();

    const telemetry = getRuntimeWorkerCapacityTelemetry(
      db,
      config({
        candidateStackIds: ["worker-2"],
        maxConcurrentLeases: 1,
      }),
      1_001,
    );
    expect(telemetry).toMatchObject({
      state: "saturated",
      activeLeaseCount: 1,
      unregisteredActiveLeaseCount: 1,
      availableNewAssistantCapacity: 0,
    });
  });
});
