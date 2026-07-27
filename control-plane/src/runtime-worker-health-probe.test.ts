import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  pooledRuntimeWorkerCatalogConfigFromServerEnv,
  registerPooledRuntimeWorkerCatalog,
  type PooledRuntimeWorkerCatalogEntry,
} from "./runtime-worker-catalog.js";
import {
  probePooledRuntimeWorkerCatalog,
  runtimeWorkerHealthProbeConfigFromServerEnv,
} from "./runtime-worker-health-probe.js";
import type { RuntimeStackRow } from "./runtime-stacks.js";

const NOW = "2026-07-20T14:00:00.000Z";
const LATER = "2026-07-20T14:05:00.000Z";

function worker(
  workerId: string,
  overrides: Partial<PooledRuntimeWorkerCatalogEntry> = {},
): PooledRuntimeWorkerCatalogEntry {
  return {
    workerId,
    gatewayUrl: `https://${workerId}.railway.internal:7821`,
    serviceRef: `service-${workerId}`,
    capacity: { maxConcurrentLeases: 1 },
    ...overrides,
  };
}

function catalog(
  workers: readonly PooledRuntimeWorkerCatalogEntry[] = [worker("worker-1")],
) {
  return pooledRuntimeWorkerCatalogConfigFromServerEnv({
    WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_CATALOG_JSON: JSON.stringify(workers),
  });
}

function probeConfig(timeoutMs = 5_000) {
  return runtimeWorkerHealthProbeConfigFromServerEnv({
    WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS: String(timeoutMs),
    WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
  });
}

function setupDb(workers = [worker("worker-1")]) {
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
  const configuredCatalog = catalog(workers);
  registerPooledRuntimeWorkerCatalog(db, configuredCatalog, () => NOW);
  return { db, configuredCatalog };
}

function runtimeStack(db: Database, workerId: string): RuntimeStackRow {
  const row = db
    .query<RuntimeStackRow, [string]>(
      "SELECT * FROM runtime_stacks WHERE id = ?",
    )
    .get(workerId);
  if (!row) throw new Error("Expected runtime stack fixture.");
  return row;
}

describe("pooled runtime worker health probe config", () => {
  test("is disabled by default and rejects misleading disabled settings", () => {
    expect(runtimeWorkerHealthProbeConfigFromServerEnv({})).toEqual({
      enabled: false,
      timeoutMs: 5_000,
    });
    expect(() =>
      runtimeWorkerHealthProbeConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS: "1000",
      }),
    ).toThrow(
      "WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS requires WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED=true",
    );
  });

  test("requires both pool and catalog gates with a strict bounded timeout", () => {
    expect(() =>
      runtimeWorkerHealthProbeConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true",
      }),
    ).toThrow("requires WORKLIN_RUNTIME_WORKER_POOL_ENABLED=true");
    expect(() =>
      runtimeWorkerHealthProbeConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
      }),
    ).toThrow("requires WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED=true");
    expect(() => probeConfig(30_001)).toThrow(
      "must be an integer between 1 and 30000",
    );
    expect(() =>
      runtimeWorkerHealthProbeConfigFromServerEnv({
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: " true",
      }),
    ).toThrow("must not contain surrounding whitespace");
  });
});

describe("pooled runtime worker health probes", () => {
  test("remains fully inert while disabled", async () => {
    const db = new Database(":memory:");
    let fetchCalls = 0;

    const result = await probePooledRuntimeWorkerCatalog(
      db,
      runtimeWorkerHealthProbeConfigFromServerEnv({}),
      {
        enabled: true,
        workers: [worker("worker-1")],
      },
      {
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("fetch must remain inert");
        },
        nowIso: () => {
          throw new Error("clock must remain inert");
        },
      },
    );

    expect(result).toEqual({
      status: "disabled",
      registeredWorkerCount: 0,
      probedWorkerCount: 0,
      healthyWorkerCount: 0,
      httpFailureCount: 0,
      timeoutCount: 0,
      fetchFailureCount: 0,
      updatedWorkerCount: 0,
      driftedWorkerCount: 0,
    });
    expect(fetchCalls).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("accepts 2xx readiness and persists only count-safe output", async () => {
    const { db, configuredCatalog } = setupDb([
      worker("worker-1", {
        gatewayUrl: "http://worker-1.railway.internal:7821",
      }),
    ]);
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

    const result = await probePooledRuntimeWorkerCatalog(
      db,
      probeConfig(),
      configuredCatalog,
      {
        fetch: async (input, init) => {
          requests.push({ url: String(input), init });
          return new Response(null, { status: 204 });
        },
        nowIso: () => LATER,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://worker-1.railway.internal:7821/readyz",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      status: "completed",
      registeredWorkerCount: 1,
      probedWorkerCount: 1,
      healthyWorkerCount: 1,
      httpFailureCount: 0,
      timeoutCount: 0,
      fetchFailureCount: 0,
      updatedWorkerCount: 1,
      driftedWorkerCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain("worker-1");
    expect(JSON.stringify(result)).not.toContain("railway.internal");
    expect(runtimeStack(db, "worker-1")).toMatchObject({
      last_health_status: "204",
      last_error: null,
      updated_at: LATER,
    });
  });

  test("records non-2xx and refuses to follow redirects", async () => {
    const workers = [worker("worker-1"), worker("worker-2")];
    const { db, configuredCatalog } = setupDb(workers);
    const redirectModes: Array<RequestRedirect | undefined> = [];

    const result = await probePooledRuntimeWorkerCatalog(
      db,
      probeConfig(),
      configuredCatalog,
      {
        fetch: async (input, init) => {
          redirectModes.push(init?.redirect);
          return String(input).includes("worker-1")
            ? new Response(null, { status: 503 })
            : new Response(null, {
                status: 302,
                headers: { location: "https://external.example.com/readyz" },
              });
        },
        nowIso: () => LATER,
      },
    );

    expect(redirectModes).toEqual(["error", "error"]);
    expect(result).toMatchObject({
      healthyWorkerCount: 0,
      httpFailureCount: 2,
      updatedWorkerCount: 2,
      driftedWorkerCount: 0,
    });
    expect(runtimeStack(db, "worker-1")).toMatchObject({
      last_health_status: "503",
      last_error: "health_http_503",
      updated_at: LATER,
    });
    expect(runtimeStack(db, "worker-2")).toMatchObject({
      last_health_status: "302",
      last_error: "health_http_302",
      updated_at: LATER,
    });
  });

  test("bounds hanging fetches and records fetch failures without error text", async () => {
    const workers = [worker("worker-timeout"), worker("worker-failure")];
    const { db, configuredCatalog } = setupDb(workers);

    const result = await probePooledRuntimeWorkerCatalog(
      db,
      probeConfig(5),
      configuredCatalog,
      {
        fetch: async (input, init) => {
          if (String(input).includes("worker-failure")) {
            throw new Error("secret-bearing upstream failure");
          }
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("Expected bounded abort signal.");
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        nowIso: () => LATER,
      },
    );

    expect(result).toMatchObject({
      healthyWorkerCount: 0,
      timeoutCount: 1,
      fetchFailureCount: 1,
      updatedWorkerCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
    expect(runtimeStack(db, "worker-timeout")).toMatchObject({
      last_health_status: null,
      last_error: "health_probe_timeout",
      updated_at: LATER,
    });
    expect(runtimeStack(db, "worker-failure")).toMatchObject({
      last_health_status: null,
      last_error: "health_probe_fetch_failed",
      updated_at: LATER,
    });
  });

  test("does not mutate a row whose registered identity drifted", async () => {
    const { db, configuredCatalog } = setupDb();
    db.query(
      `UPDATE runtime_stacks
       SET gateway_url = 'https://replacement.railway.internal',
           service_ref = 'replacement-service',
           last_health_status = 'previous',
           last_error = 'preserve-me'
       WHERE id = 'worker-1'`,
    ).run();
    const before = runtimeStack(db, "worker-1");

    const result = await probePooledRuntimeWorkerCatalog(
      db,
      probeConfig(),
      configuredCatalog,
      {
        fetch: async () => new Response(null, { status: 200 }),
        nowIso: () => LATER,
      },
    );

    expect(result).toMatchObject({
      healthyWorkerCount: 1,
      updatedWorkerCount: 0,
      driftedWorkerCount: 1,
    });
    expect(runtimeStack(db, "worker-1")).toEqual(before);
  });
});
