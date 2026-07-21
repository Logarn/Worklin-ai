import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { PooledRuntimeWorkerCatalogEntry } from "./runtime-worker-catalog.js";
import type { RuntimeWorkerHealthProbeResult } from "./runtime-worker-health-probe.js";
import {
  activatePooledRuntimeWorkersAtStartup,
  type RuntimeWorkerStartupCoordinatorOwnership,
  type RuntimeWorkerStartupHealthProbe,
} from "./runtime-worker-startup-gate.js";

const NOW = "2026-07-20T16:00:00.000Z";
const MASTER_KEY = "a".repeat(64);
const BUCKET = "worklin-runtime-state";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });

function worker(workerId: string): PooledRuntimeWorkerCatalogEntry {
  return {
    workerId,
    gatewayUrl: `https://${workerId}.railway.internal:7821`,
    serviceRef: `service-${workerId}`,
    capacity: { maxConcurrentLeases: 1 },
  };
}

function serviceAccountJson(key: KeyObject): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "runtime-state@example.com",
    private_key: key.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

function enabledEnv(
  workers: readonly PooledRuntimeWorkerCatalogEntry[] = [worker("worker-1")],
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_CATALOG_JSON: JSON.stringify(workers),
    WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: workers
      .map(({ workerId }) => workerId)
      .join(","),
    WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: String(workers.length),
    WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS: "60000",
    WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN: "r".repeat(64),
    WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
    WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON:
      serviceAccountJson(privateKey),
    WORKLIN_RUNTIME_WORKER_STATE_SIGNED_URL_TTL_SECONDS: "600",
    WORKLIN_RUNTIME_WORKER_STATE_REQUEST_TIMEOUT_MS: "1000",
    ACTOR_TOKEN_SIGNING_KEY: MASTER_KEY,
    WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS: "1000",
    WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
    WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: "b".repeat(64),
    WORKLIN_CONTROL_PLANE_EXPECTED_REPLICA_COUNT: "1",
    RAILWAY_DEPLOYMENT_ID: "deployment-1",
    RAILWAY_REPLICA_ID: "replica-1",
    WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED: "true",
    WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED: "true",
    WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED: "true",
    WORKLIN_TENANT_USAGE_METRICS_ENABLED: "true",
    WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED: "true",
    WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED: "true",
    ...overrides,
  };
}

function liveCoordinatorOwnership(
  live = true,
): RuntimeWorkerStartupCoordinatorOwnership {
  return {
    binding: {
      ownerId: "process-1",
      deploymentId: "deployment-1",
      replicaId: "replica-1",
      epoch: 1,
      acquiredAtMs: 1_000,
      heartbeatAtMs: 1_000,
      expiresAtMs: 16_000,
    },
    isLive: () => live,
  };
}

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
  `);
  return db;
}

function greenHealth(
  workerCount: number,
  overrides: Partial<RuntimeWorkerHealthProbeResult> = {},
): RuntimeWorkerHealthProbeResult {
  return {
    status: "completed",
    registeredWorkerCount: workerCount,
    probedWorkerCount: workerCount,
    healthyWorkerCount: workerCount,
    httpFailureCount: 0,
    timeoutCount: 0,
    fetchFailureCount: 0,
    updatedWorkerCount: workerCount,
    driftedWorkerCount: 0,
    ...overrides,
  };
}

describe("pooled runtime worker startup gate", () => {
  test("is count-only and fully inert by default", async () => {
    const db = new Database(":memory:");
    let probeCalls = 0;

    const activation = await activatePooledRuntimeWorkersAtStartup(
      db,
      {},
      {
        probe: async () => {
          probeCalls += 1;
          throw new Error("disabled startup must not probe workers");
        },
      },
    );

    expect(activation).toEqual({
      status: "disabled",
      catalogWorkerCount: 0,
      registeredWorkerCount: 0,
      healthyWorkerCount: 0,
      failedWorkerCount: 0,
      driftedWorkerCount: 0,
      maxConcurrentLeases: 0,
    });
    expect(probeCalls).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("fails closed when only some activation components are enabled", async () => {
    const partialEnvironments = [
      {
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_CATALOG_JSON: JSON.stringify([
          worker("worker-1"),
        ]),
      },
      { WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true" },
      { WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true" },
      { WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true" },
    ];

    for (const rawEnv of partialEnvironments) {
      await expect(
        activatePooledRuntimeWorkersAtStartup(setupDb(), rawEnv),
      ).rejects.toThrow("requires catalog, pool, production transport");
    }
    await expect(
      activatePooledRuntimeWorkersAtStartup(setupDb(), {
        WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "perhaps",
      }),
    ).rejects.toThrow("must be a boolean");
  });

  test("requires the encrypted model-key vault before registering pooled workers", async () => {
    const db = setupDb();
    let probeCalls = 0;

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        db,
        enabledEnv(undefined, {
          WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: undefined,
          WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: undefined,
        }),
        {
          probe: async () => {
            probeCalls += 1;
            return greenHealth(1);
          },
        },
      ),
    ).rejects.toThrow("WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED=true");
    expect(probeCalls).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_stacks'",
        )
        .get()?.count,
    ).toBe(0);

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(undefined, {
          WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: "invalid",
        }),
      ),
    ).rejects.toThrow("must be exactly 64 hexadecimal characters");
  });

  test("requires unique candidates in the exact catalog order", async () => {
    const workers = [worker("worker-1"), worker("worker-2")];

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(workers, {
          WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "worker-2,worker-1",
        }),
      ),
    ).rejects.toThrow("exactly match catalog order");

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv([worker("worker-1")], {
          WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "worker-1,worker-1",
        }),
      ),
    ).rejects.toThrow("must be unique");

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(workers, {
          WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "worker-1,,worker-2",
        }),
      ),
    ).rejects.toThrow("candidate worker IDs are invalid");
  });

  test("bounds global concurrency by truthful single-worker capacity", async () => {
    const workers = [worker("worker-1"), worker("worker-2")];

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(workers, {
          WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: "3",
        }),
      ),
    ).rejects.toThrow("exceeds declared worker capacity");

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(
          [
            {
              ...worker("worker-1"),
              capacity: { maxConcurrentLeases: 2 },
            } as unknown as PooledRuntimeWorkerCatalogEntry,
          ],
          { WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: "1" },
        ),
      ),
    ).rejects.toThrow("maxConcurrentLeases must be exactly 1");
  });

  test("requires valid coordinator and production transport configuration", async () => {
    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(undefined, { ACTOR_TOKEN_SIGNING_KEY: "invalid" }),
      ),
    ).rejects.toThrow("must be 64 hex characters");

    await expect(
      activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(undefined, {
          WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON: undefined,
        }),
      ),
    ).rejects.toThrow(
      "WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON is required",
    );

    expect(
      await activatePooledRuntimeWorkersAtStartup(
        setupDb(),
        enabledEnv(undefined, {
          WORKLIN_RUNTIME_WORKER_STATE_PROVIDER: "s3",
          WORKLIN_RUNTIME_WORKER_STATE_BUCKET: undefined,
          WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON: undefined,
          BUCKET,
          ACCESS_KEY_ID: "railway-access-key",
          SECRET_ACCESS_KEY: "railway-secret-key-value",
          REGION: "auto",
          ENDPOINT: "https://storage.railway.app",
          URL_STYLE: "virtual",
        }),
        {
          nowIso: () => NOW,
          probe: async () => greenHealth(1),
          coordinatorOwnership: liveCoordinatorOwnership(),
        },
      ),
    ).toMatchObject({ status: "active", healthyWorkerCount: 1 });
  });

  test("requires every tenant safety control before pooled activation", async () => {
    const requiredFlags = [
      "WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED",
      "WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED",
      "WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED",
      "WORKLIN_TENANT_USAGE_METRICS_ENABLED",
      "WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED",
      "WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED",
    ] as const;

    for (const flag of requiredFlags) {
      for (const value of [undefined, "false"]) {
        await expect(
          activatePooledRuntimeWorkersAtStartup(
            setupDb(),
            enabledEnv(undefined, { [flag]: value }),
          ),
        ).rejects.toThrow(`${flag} must be enabled`);
      }
    }
  });

  test("requires a live singleton coordinator owner before registering workers", async () => {
    for (const coordinatorOwnership of [
      undefined,
      liveCoordinatorOwnership(false),
      {
        ...liveCoordinatorOwnership(),
        binding: {
          ...liveCoordinatorOwnership().binding,
          replicaId: "another-replica",
        },
      },
    ]) {
      const db = setupDb();
      let probeCalls = 0;
      await expect(
        activatePooledRuntimeWorkersAtStartup(db, enabledEnv(), {
          ...(coordinatorOwnership ? { coordinatorOwnership } : {}),
          probe: async () => {
            probeCalls += 1;
            return greenHealth(1);
          },
        }),
      ).rejects.toThrow("live singleton coordinator ownership");
      expect(probeCalls).toBe(0);
      expect(
        db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'table' AND name = 'runtime_stacks'`,
          )
          .get()?.count,
      ).toBe(0);
      db.close();
    }
  });

  test("rejects failed, incomplete, or drifted startup health", async () => {
    const unhealthyResults = [
      greenHealth(1, {
        healthyWorkerCount: 0,
        httpFailureCount: 1,
      }),
      greenHealth(1, {
        updatedWorkerCount: 0,
        driftedWorkerCount: 1,
      }),
      greenHealth(1, {
        registeredWorkerCount: 0,
      }),
    ];

    for (const health of unhealthyResults) {
      await expect(
        activatePooledRuntimeWorkersAtStartup(setupDb(), enabledEnv(), {
          nowIso: () => NOW,
          probe: async () => health,
          coordinatorOwnership: liveCoordinatorOwnership(),
        }),
      ).rejects.toThrow("health gate is not green");
    }
  });

  test("rechecks the same coordinator epoch after the health probe", async () => {
    let checks = 0;
    await expect(
      activatePooledRuntimeWorkersAtStartup(setupDb(), enabledEnv(), {
        nowIso: () => NOW,
        probe: async () => greenHealth(1),
        coordinatorOwnership: {
          ...liveCoordinatorOwnership(),
          isLive: () => {
            checks += 1;
            return checks === 1;
          },
        },
      }),
    ).rejects.toThrow("live singleton coordinator ownership");
    expect(checks).toBe(2);
  });

  test("registers after schema setup, probes once, and activates on all-green health", async () => {
    const db = setupDb();
    const workers = [worker("worker-1"), worker("worker-2")];
    let probeCalls = 0;
    const probe: RuntimeWorkerStartupHealthProbe = async (
      probeDb,
      config,
      catalog,
    ) => {
      probeCalls += 1;
      expect(config.enabled).toBe(true);
      expect(catalog.enabled).toBe(true);
      expect(
        probeDb
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runtime_stacks WHERE provider = 'pooled_worker'",
          )
          .get()?.count,
      ).toBe(2);
      return greenHealth(2);
    };

    const activation = await activatePooledRuntimeWorkersAtStartup(
      db,
      enabledEnv(workers),
      {
        nowIso: () => NOW,
        probe,
        coordinatorOwnership: liveCoordinatorOwnership(),
      },
    );

    expect(activation).toEqual({
      status: "active",
      catalogWorkerCount: 2,
      registeredWorkerCount: 2,
      healthyWorkerCount: 2,
      failedWorkerCount: 0,
      driftedWorkerCount: 0,
      maxConcurrentLeases: 2,
    });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_worker_leases",
        )
        .get()?.count,
    ).toBe(0);
    expect(probeCalls).toBe(1);
    const serialized = JSON.stringify(activation);
    expect(serialized).not.toContain("worker-1");
    expect(serialized).not.toContain("railway.internal");
    expect(serialized).not.toContain(MASTER_KEY);
    expect(serialized).not.toContain("private_key");
  });
});
