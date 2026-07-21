import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  pooledRuntimeWorkerCatalogConfigFromServerEnv,
  registerPooledRuntimeWorkerCatalog,
  type PooledRuntimeWorkerCatalogEntry,
} from "./runtime-worker-catalog.js";
import {
  ensureRuntimeStackSchema,
  type RuntimeStackRow,
} from "./runtime-stacks.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";

const NOW = "2026-07-20T12:00:00.000Z";
const LATER = "2026-07-20T12:05:00.000Z";

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
  ensureRuntimeStackSchema(db);
  return db;
}

function worker(
  overrides: Partial<PooledRuntimeWorkerCatalogEntry> = {},
): PooledRuntimeWorkerCatalogEntry {
  return {
    workerId: "worker-1",
    gatewayUrl: "https://worker-1.railway.internal:7821",
    serviceRef: "service-worker-1",
    capacity: { maxConcurrentLeases: 1 },
    ...overrides,
  };
}

function enabledConfig(
  workers: readonly PooledRuntimeWorkerCatalogEntry[] = [worker()],
) {
  return pooledRuntimeWorkerCatalogConfigFromServerEnv({
    WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_CATALOG_JSON: JSON.stringify(workers),
  });
}

function runtimeStack(db: Database, id: string): RuntimeStackRow | null {
  return (
    db
      .query<
        RuntimeStackRow,
        [string]
      >("SELECT * FROM runtime_stacks WHERE id = ?")
      .get(id) ?? null
  );
}

function seedRuntimeStack(
  db: Database,
  input: {
    id: string;
    provider: string;
    gatewayUrl: string;
    serviceRef: string;
    assistantId?: string;
    status?: RuntimeStackRow["status"];
    health?: string | null;
  },
): void {
  db.query(
    `INSERT INTO runtime_stacks (
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
     ) VALUES (?, 'existing-org', ?, ?, ?, ?, NULL, NULL, ?, 'global', ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.assistantId ?? `existing-${input.id}`,
    input.status ?? "active",
    input.provider,
    input.gatewayUrl,
    input.serviceRef,
    input.health ?? null,
    NOW,
    NOW,
  );
}

describe("pooled runtime worker catalog config", () => {
  test("is disabled and empty by default", () => {
    expect(pooledRuntimeWorkerCatalogConfigFromServerEnv({})).toEqual({
      enabled: false,
      workers: [],
    });
  });

  test("fails closed on an invalid flag or a catalog supplied while disabled", () => {
    expect(() =>
      pooledRuntimeWorkerCatalogConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "maybe",
      }),
    ).toThrow("must be a boolean");
    expect(() =>
      pooledRuntimeWorkerCatalogConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "false",
        WORKLIN_RUNTIME_WORKER_CATALOG_JSON: "[]",
      }),
    ).toThrow("requires WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED=true");
  });

  test("requires a non-empty strict JSON array when enabled", () => {
    expect(() =>
      pooledRuntimeWorkerCatalogConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
      }),
    ).toThrow("is required");
    expect(() =>
      pooledRuntimeWorkerCatalogConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_CATALOG_JSON: "{",
      }),
    ).toThrow("must be valid JSON");
    expect(() => enabledConfig([])).toThrow("between 1 and");
    expect(() =>
      enabledConfig([
        {
          ...worker(),
          unexpected: true,
        } as PooledRuntimeWorkerCatalogEntry,
      ]),
    ).toThrow("unknown or missing fields");
  });

  test("accepts private HTTPS origins and Railway-internal HTTP only", () => {
    expect(
      enabledConfig([
        worker(),
        worker({
          workerId: "worker-ipv4",
          gatewayUrl: "https://10.42.0.8:7821",
          serviceRef: "service-ipv4",
        }),
        worker({
          workerId: "worker-ipv6",
          gatewayUrl: "https://[fd00::8]:7821",
          serviceRef: "service-ipv6",
        }),
        worker({
          workerId: "worker-loopback",
          gatewayUrl: "https://127.0.0.1:7821",
          serviceRef: "service-loopback",
        }),
        worker({
          workerId: "worker-k8s",
          gatewayUrl: "https://worker.gateway.svc.cluster.local",
          serviceRef: "service-k8s",
        }),
        worker({
          workerId: "worker-railway-http",
          gatewayUrl: "http://worker-http.railway.internal:7821",
          serviceRef: "service-railway-http",
        }),
      ]).workers.map(({ gatewayUrl }) => gatewayUrl),
    ).toEqual([
      "https://worker-1.railway.internal:7821",
      "https://10.42.0.8:7821",
      "https://[fd00::8]:7821",
      "https://127.0.0.1:7821",
      "https://worker.gateway.svc.cluster.local",
      "http://worker-http.railway.internal:7821",
    ]);

    for (const gatewayUrl of [
      "http://worker-1.internal",
      "http://127.0.0.1:7821",
      "http://worker.gateway.svc.cluster.local",
      "https://worklin.example.com",
      "https://localhost",
      "https://169.254.169.254",
      "https://worker-1.railway.internal/v1",
      "https://worker-1.railway.internal?token=secret",
      "https://user:password@worker-1.railway.internal",
      "https://.internal",
      "https://worker..internal",
    ]) {
      expect(() => enabledConfig([worker({ gatewayUrl })])).toThrow(
        "private service origin",
      );
    }
  });

  test("rejects duplicate worker identities, routes, and service references", () => {
    expect(() =>
      enabledConfig([
        worker(),
        worker({
          gatewayUrl: "https://worker-2.railway.internal",
          serviceRef: "service-worker-2",
        }),
      ]),
    ).toThrow("workerIds must be unique");
    expect(() =>
      enabledConfig([
        worker(),
        worker({
          workerId: "worker-2",
          gatewayUrl: "https://worker-1.railway.internal:7821/",
          serviceRef: "service-worker-2",
        }),
      ]),
    ).toThrow("gatewayUrls must be unique");
    expect(() =>
      enabledConfig([
        worker(),
        worker({
          workerId: "worker-2",
          gatewayUrl: "https://worker-2.railway.internal",
        }),
      ]),
    ).toThrow("serviceRefs must be unique");
  });

  test("requires truthful single-lease capacity metadata", () => {
    for (const capacity of [
      undefined,
      null,
      {},
      { maxConcurrentLeases: 0 },
      { maxConcurrentLeases: 2 },
      { maxConcurrentLeases: 1.5 },
      { maxConcurrentLeases: "1" },
      { maxConcurrentLeases: 1, burst: 2 },
    ]) {
      expect(() =>
        enabledConfig([
          {
            ...worker(),
            capacity,
          } as unknown as PooledRuntimeWorkerCatalogEntry,
        ]),
      ).toThrow();
    }
  });
});

describe("pooled runtime worker catalog registration", () => {
  test("does not touch the database while disabled", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "dedicated-1",
      provider: "railway",
      gatewayUrl: "https://dedicated.example.com",
      serviceRef: "dedicated-service",
    });
    const before = db
      .query<RuntimeStackRow, []>("SELECT * FROM runtime_stacks")
      .all();

    const result = registerPooledRuntimeWorkerCatalog(
      db,
      pooledRuntimeWorkerCatalogConfigFromServerEnv({}),
      () => NOW,
    );

    expect(result).toEqual({
      status: "disabled",
      workerIds: [],
      insertedWorkerIds: [],
      updatedWorkerIds: [],
      unchangedWorkerIds: [],
      totalMaxConcurrentLeases: 0,
    });
    expect(
      db.query<RuntimeStackRow, []>("SELECT * FROM runtime_stacks").all(),
    ).toEqual(before);
  });

  test("registers only inert pooled_worker rows and reports capacity", () => {
    const db = setupDb();
    const config = enabledConfig([
      worker(),
      worker({
        workerId: "worker-2",
        gatewayUrl: "https://worker-2.railway.internal:7821",
        serviceRef: "service-worker-2",
      }),
    ]);

    const result = registerPooledRuntimeWorkerCatalog(db, config, () => NOW);

    expect(result).toEqual({
      status: "registered",
      workerIds: ["worker-1", "worker-2"],
      insertedWorkerIds: ["worker-1", "worker-2"],
      updatedWorkerIds: [],
      unchangedWorkerIds: [],
      totalMaxConcurrentLeases: 2,
    });
    for (const workerId of result.workerIds) {
      expect(runtimeStack(db, workerId)).toMatchObject({
        id: workerId,
        status: "active",
        provider: RUNTIME_WORKER_POOL_PROVIDER,
        public_ingress_url: null,
        workspace_volume_ref: null,
        service_capacity_reserved: 0,
        service_create_attempted_at: null,
        volume_create_attempted_at: null,
        provisioning_lease_token: null,
        provisioning_lease_expires_at: null,
        actor_signing_key_scope: `runtime_v1:${workerId}`,
        last_health_status: null,
        last_error: null,
        created_at: NOW,
        updated_at: NOW,
      });
    }
    expect(runtimeStack(db, "worker-1")?.assistant_id).toBe(
      "__worklin_pooled_worker__:worker-1",
    );
  });

  test("is idempotent without rewriting a healthy registration", () => {
    const db = setupDb();
    const config = enabledConfig();
    registerPooledRuntimeWorkerCatalog(db, config, () => NOW);
    db.query(
      `UPDATE runtime_stacks
       SET last_health_status = '200',
           last_error = 'transient health failure'
       WHERE id = 'worker-1'`,
    ).run();

    const repeated = registerPooledRuntimeWorkerCatalog(
      db,
      config,
      () => LATER,
    );

    expect(repeated).toMatchObject({
      insertedWorkerIds: [],
      updatedWorkerIds: [],
      unchangedWorkerIds: ["worker-1"],
    });
    expect(runtimeStack(db, "worker-1")).toMatchObject({
      last_health_status: "200",
      last_error: "transient health failure",
      created_at: NOW,
      updated_at: NOW,
    });
  });

  test("updates only an unassigned pooled row and preserves its database identity", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "worker-1",
      provider: RUNTIME_WORKER_POOL_PROVIDER,
      gatewayUrl: "https://old-worker.railway.internal",
      serviceRef: "old-service",
      assistantId: "manual-pool-owner",
      status: "suspended",
      health: "200",
    });
    db.query(
      `UPDATE runtime_stacks
       SET public_ingress_url = 'https://public.example.com',
           workspace_volume_ref = 'old-volume',
           service_capacity_reserved = 1,
           service_create_attempted_at = 100,
           volume_create_attempted_at = 200,
           provisioning_lease_token = 'old-provisioning-token',
           provisioning_lease_expires_at = 300,
           last_error = 'old failure'
       WHERE id = 'worker-1'`,
    ).run();

    const result = registerPooledRuntimeWorkerCatalog(
      db,
      enabledConfig(),
      () => LATER,
    );

    expect(result.updatedWorkerIds).toEqual(["worker-1"]);
    expect(runtimeStack(db, "worker-1")).toMatchObject({
      org_id: "existing-org",
      assistant_id: "manual-pool-owner",
      status: "active",
      provider: RUNTIME_WORKER_POOL_PROVIDER,
      gateway_url: "https://worker-1.railway.internal:7821",
      public_ingress_url: null,
      workspace_volume_ref: null,
      service_ref: "service-worker-1",
      service_capacity_reserved: 0,
      service_create_attempted_at: null,
      volume_create_attempted_at: null,
      provisioning_lease_token: null,
      provisioning_lease_expires_at: null,
      actor_signing_key_scope: "runtime_v1:worker-1",
      last_health_status: null,
      last_error: null,
      created_at: NOW,
      updated_at: LATER,
    });
  });

  test("rejects mutation while a pooled worker remains assigned", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "worker-1",
      provider: RUNTIME_WORKER_POOL_PROVIDER,
      gatewayUrl: "https://old-worker.railway.internal",
      serviceRef: "old-service",
    });
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
       ) VALUES (
         'worker-1',
         'customer-assistant',
         'customer-org',
         'active-lease',
         1,
         9999999999999,
         1,
         NULL,
         NULL,
         ?
       )`,
    ).run(NOW);

    expect(() =>
      registerPooledRuntimeWorkerCatalog(db, enabledConfig(), () => LATER),
    ).toThrow("cannot be changed while assigned");
    expect(runtimeStack(db, "worker-1")).toMatchObject({
      gateway_url: "https://old-worker.railway.internal",
      service_ref: "old-service",
      updated_at: NOW,
    });
  });

  test("never overwrites dedicated or preprovisioned rows and rolls back the catalog atomically", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "worker-protected",
      provider: "preprovisioned",
      gatewayUrl: "https://protected.example.com",
      serviceRef: "protected-service",
      assistantId: "protected-owner",
    });
    const protectedBefore = runtimeStack(db, "worker-protected");
    const config = enabledConfig([
      worker(),
      worker({
        workerId: "worker-protected",
        gatewayUrl: "https://protected-worker.railway.internal",
        serviceRef: "protected-worker-service",
      }),
    ]);

    expect(() =>
      registerPooledRuntimeWorkerCatalog(db, config, () => LATER),
    ).toThrow("belongs to provider preprovisioned");
    expect(runtimeStack(db, "worker-protected")).toEqual(protectedBefore);
    expect(runtimeStack(db, "worker-1")).toBeNull();
  });

  test("rejects route or service collisions without claiming another stack", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "dedicated-1",
      provider: "railway",
      gatewayUrl: "https://worker-1.railway.internal:7821",
      serviceRef: "dedicated-service",
    });
    const dedicatedBefore = runtimeStack(db, "dedicated-1");

    expect(() =>
      registerPooledRuntimeWorkerCatalog(db, enabledConfig(), () => LATER),
    ).toThrow("collides with runtime stack dedicated-1");
    expect(runtimeStack(db, "dedicated-1")).toEqual(dedicatedBefore);
    expect(runtimeStack(db, "worker-1")).toBeNull();
  });

  test("leaves unlisted pooled and dedicated stacks untouched", () => {
    const db = setupDb();
    seedRuntimeStack(db, {
      id: "unlisted-pool",
      provider: RUNTIME_WORKER_POOL_PROVIDER,
      gatewayUrl: "https://unlisted.railway.internal",
      serviceRef: "unlisted-service",
      health: "200",
    });
    seedRuntimeStack(db, {
      id: "dedicated-1",
      provider: "railway",
      gatewayUrl: "https://dedicated.example.com",
      serviceRef: "dedicated-service",
    });
    const unlistedBefore = runtimeStack(db, "unlisted-pool");
    const dedicatedBefore = runtimeStack(db, "dedicated-1");

    registerPooledRuntimeWorkerCatalog(db, enabledConfig(), () => LATER);

    expect(runtimeStack(db, "unlisted-pool")).toEqual(unlistedBefore);
    expect(runtimeStack(db, "dedicated-1")).toEqual(dedicatedBefore);
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM runtime_stacks")
        .get()?.count,
    ).toBe(3);
  });

  test("has no paid infrastructure provisioning dependency", async () => {
    const source = await Bun.file(
      new URL("./runtime-worker-catalog.ts", import.meta.url),
    ).text();

    expect(source).not.toContain("railway-runtime-provisioner");
    expect(source).not.toContain("createService");
    expect(source).not.toContain("createVolume");
  });
});
