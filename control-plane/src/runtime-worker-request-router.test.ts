import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  releaseDispatchedRuntimeWorker,
  type RuntimeWorkerLifecycleAdapter,
  type RuntimeWorkerPoolConfig,
} from "./runtime-worker-dispatcher.js";
import { RUNTIME_WORKER_POOL_PROVIDER } from "./runtime-worker-leases.js";
import {
  RuntimeWorkerRequestRouter,
  type RuntimeWorkerRequestRouterOptions,
  type RuntimeWorkerRouteTimer,
} from "./runtime-worker-request-router.js";
import {
  mintRuntimeWorkerLeaseActorToken,
  resolveActiveRuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";

const MASTER_KEY = "a".repeat(64);
const CHECKSUM = "b".repeat(64);
const WORKSPACE_BYTES = 3_072;

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
      ('asst-a', 'user-a', 'org-a', 'Assistant A', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'),
      ('asst-b', 'user-b', 'org-b', 'Assistant B', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
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

function poolConfig(enabled = true): RuntimeWorkerPoolConfig {
  return {
    enabled,
    candidateStackIds: enabled ? ["worker-1"] : [],
    maxConcurrentLeases: enabled ? 1 : 0,
    leaseTtlMs: 60_000,
  };
}

class DeterministicTimer implements RuntimeWorkerRouteTimer {
  private nextId = 1;
  private readonly callbacks = new Map<
    number,
    { callback: () => Promise<void>; delayMs: number }
  >();

  schedule(callback: () => Promise<void>, delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  size(): number {
    return this.callbacks.size;
  }

  async runWithDelay(delayMs: number): Promise<void> {
    const match = [...this.callbacks.entries()].find(
      ([, task]) => task.delayMs === delayMs,
    );
    if (!match) throw new Error(`No timer scheduled for ${delayMs}ms.`);
    this.callbacks.delete(match[0]);
    await match[1].callback();
  }
}

function identity(suffix: "a" | "b") {
  return {
    organizationId: `org-${suffix}`,
    userId: `user-${suffix}`,
    assistantId: `asst-${suffix}`,
    actorId: `actor-${suffix}`,
  };
}

function dedicatedRoute() {
  return {
    gatewayUrl: "http://dedicated.internal",
    actorToken: "dedicated-token",
  };
}

function restoredState(
  object: { checksumSha256: string } | null,
  expectedWorkspaceByteSize: number | null,
) {
  return {
    checksumSha256: object?.checksumSha256 ?? null,
    workspaceByteSize: expectedWorkspaceByteSize ?? 0,
  };
}

function exportedState(objectKey: string, byteSize = 4_096) {
  return {
    object: {
      provider: "gcs" as const,
      bucket: "worklin-runtime-state",
      objectKey,
      checksumSha256: CHECKSUM,
      byteSize,
      format: "vbundle-v1" as const,
    },
    workspaceByteSize: WORKSPACE_BYTES,
  };
}

function actorClaims(token: string): {
  pooled_worker_lease: {
    organization_id: string;
    assistant_id: string;
    worker_stack_id: string;
    lease_generation: number;
  };
} {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as {
    pooled_worker_lease: {
      organization_id: string;
      assistant_id: string;
      worker_stack_id: string;
      lease_generation: number;
    };
  };
}

function createHarness(options: {
  db?: Database;
  timer?: DeterministicTimer;
  events?: string[];
  leaseTokens?: string[];
  requestHandles?: string[];
  pool?: RuntimeWorkerPoolConfig;
  lifecycle?: RuntimeWorkerLifecycleAdapter;
  now?: number;
  onLeaseReady?: NonNullable<RuntimeWorkerRequestRouterOptions["onLeaseReady"]>;
  onRequestHandleAllocated?: (handle: string) => void;
  ownershipLive?: () => boolean;
}) {
  const db = options.db ?? setupDb();
  const timer = options.timer ?? new DeterministicTimer();
  const events = options.events ?? [];
  const leaseTokens = options.leaseTokens ?? ["lease-a", "lease-b"];
  const requestHandles = options.requestHandles ?? [
    "request-a-1",
    "request-a-2",
    "request-b-1",
  ];
  let now = options.now ?? 1_000;
  const lifecycle: RuntimeWorkerLifecycleAdapter = options.lifecycle ?? {
    storage: {
      restore: async ({ tenant, object, expectedWorkspaceByteSize }) => {
        events.push(`restore:${tenant.orgId}`);
        return restoredState(object, expectedWorkspaceByteSize);
      },
      export: async ({ tenant, objectKey }) => {
        events.push(`export:${tenant.orgId}`);
        return exportedState(objectKey);
      },
    },
    sanitize: async ({ assistant }) => {
      events.push(`sanitize:${assistant.org_id}`);
    },
    revokeAuthority: async ({ assistant, leaseGeneration }) => {
      events.push(`revoke:${assistant.org_id}:g${leaseGeneration}`);
    },
  };
  const router = new RuntimeWorkerRequestRouter({
    db,
    poolConfig: options.pool ?? poolConfig(),
    lifecycle,
    masterActorSigningKey: MASTER_KEY,
    releaseLease: (input) =>
      releaseDispatchedRuntimeWorker(
        input.db,
        input.assistant,
        input.leaseToken,
        input.nowMs,
        input.nowIso,
        input.lifecycle,
        input.lifecycleHeartbeat,
      ),
    revokeLeaseTokens: async ({ binding }) => {
      events.push(
        `revoke:${binding.organizationId}:g${binding.leaseGeneration}`,
      );
    },
    timer,
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
    leaseTokenFactory: () => {
      const token = leaseTokens.shift();
      if (!token) throw new Error("No lease token available.");
      return token;
    },
    requestHandleFactory: () => {
      const handle = requestHandles.shift();
      if (!handle) throw new Error("No request handle available.");
      options.onRequestHandleAllocated?.(handle);
      return handle;
    },
    ...(options.onLeaseReady ? { onLeaseReady: options.onLeaseReady } : {}),
    coordinatorOwnership: {
      isLive: options.ownershipLive ?? (() => true),
    },
    renewIntervalMs: 20_000,
    idleReleaseDelayMs: 500,
  });
  return {
    db,
    timer,
    events,
    router,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("runtime worker request router", () => {
  test("preserves dedicated routing while the pool is disabled", async () => {
    const route = dedicatedRoute();
    const router = new RuntimeWorkerRequestRouter({
      db: setupDb(),
      poolConfig: poolConfig(false),
    });

    expect(
      await router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: route,
      }),
    ).toEqual({ mode: "dedicated", route });
  });

  test("fails closed before leasing when required enabled dependencies are missing", async () => {
    const db = setupDb();
    const router = new RuntimeWorkerRequestRouter({
      db,
      poolConfig: poolConfig(),
    });

    expect(
      await router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "coordinator_dependencies_unavailable",
      retryAfterMs: null,
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

  test("fences active requests and leaves their worker lease quarantined after ownership loss", async () => {
    let ownershipLive = true;
    const events: string[] = [];
    const harness = createHarness({
      events,
      ownershipLive: () => ownershipLive,
    });
    const first = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(first).toMatchObject({
      mode: "pooled",
      requestHandle: "request-a-1",
    });

    ownershipLive = false;
    expect(
      await harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "coordinator_ownership_lost",
      retryAfterMs: null,
    });
    expect(events).toContain("revoke:org-a:g1");
    expect(events.some((event) => event.startsWith("export:"))).toBe(false);
    expect(events.some((event) => event.startsWith("sanitize:"))).toBe(false);
    expect(
      await harness.router.finishRequest({
        requestHandle: "request-a-1",
        identity: identity("a"),
      }),
    ).toEqual({ status: "unknown_request" });
    expect(
      harness.db
        .query<
          {
            assistant_id: string | null;
            org_id: string | null;
            lease_token: string | null;
          },
          []
        >(
          `SELECT assistant_id, org_id, lease_token
           FROM runtime_worker_leases
           WHERE runtime_stack_id = 'worker-1'`,
        )
        .get(),
    ).toEqual({
      assistant_id: "asst-a",
      org_id: "org-a",
      lease_token: "lease-a",
    });
  });

  test("does not return freshly minted capabilities when ownership changes during routing", async () => {
    let checks = 0;
    const events: string[] = [];
    const harness = createHarness({
      events,
      ownershipLive: () => {
        checks += 1;
        return checks < 4;
      },
    });

    expect(
      await harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "coordinator_ownership_lost",
      retryAfterMs: null,
    });
    expect(events).toContain("revoke:org-a:g1");
    expect(events.some((event) => event.startsWith("export:"))).toBe(false);
    expect(events.some((event) => event.startsWith("sanitize:"))).toBe(false);
  });

  test("rejects a tenant configuration change while a request is active", async () => {
    const harness = createHarness({});
    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    let mutationCalls = 0;

    expect(
      await harness.router.runTenantConfigurationMutation({
        identity: identity("a"),
        mutation: async () => {
          mutationCalls += 1;
          return "changed";
        },
      }),
    ).toEqual({
      status: "rejected",
      reason: "active_requests",
      activeRequestCount: 1,
    });
    expect(mutationCalls).toBe(0);
  });

  test("fully releases an idle worker and holds routing until configuration mutation completes", async () => {
    const events: string[] = [];
    let completeMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      completeMutation = resolve;
    });
    let mutationStarted = false;
    const harness = createHarness({ events });
    const first = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (first.mode !== "pooled") throw new Error("Expected pooled route.");
    expect(
      await harness.router.finishRequest({
        requestHandle: first.requestHandle,
        identity: identity("a"),
      }),
    ).toEqual({ status: "release_scheduled" });

    const mutation = harness.router.runTenantConfigurationMutation({
      identity: identity("a"),
      mutation: async () => {
        events.push("configuration-mutation");
        mutationStarted = true;
        await mutationGate;
        return "changed";
      },
    });
    for (let tick = 0; tick < 8 && !mutationStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(mutationStarted).toBe(true);
    expect(events).toEqual([
      "restore:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
      "configuration-mutation",
    ]);

    let secondRouteSettled = false;
    const secondRoute = harness.router
      .routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      })
      .finally(() => {
        secondRouteSettled = true;
      });
    await Promise.resolve();
    expect(secondRouteSettled).toBe(false);

    completeMutation();
    expect(await mutation).toEqual({ status: "applied", value: "changed" });
    expect(await secondRoute).toMatchObject({
      mode: "pooled",
      requestHandle: "request-a-2",
      binding: { leaseGeneration: 2 },
    });
  });

  test("does not mutate configuration across a persisted restart lease", async () => {
    const db = setupDb();
    const first = createHarness({ db });
    expect(
      await first.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toMatchObject({ mode: "pooled" });

    const restarted = createHarness({ db });
    let mutationCalls = 0;
    expect(
      await restarted.router.runTenantConfigurationMutation({
        identity: identity("a"),
        mutation: async () => {
          mutationCalls += 1;
          return "changed";
        },
      }),
    ).toEqual({ status: "unavailable", reason: "restart_quarantined" });
    expect(mutationCalls).toBe(0);
  });

  test("does not acknowledge a configuration mutation after ownership loss", async () => {
    let ownershipLive = true;
    const harness = createHarness({
      ownershipLive: () => ownershipLive,
    });
    expect(
      await harness.router.runTenantConfigurationMutation({
        identity: identity("a"),
        mutation: async () => {
          ownershipLive = false;
          return "changed";
        },
      }),
    ).toEqual({
      status: "unavailable",
      reason: "coordinator_ownership_lost",
    });
  });

  test("observes exact empty restored state before returning a route handle", async () => {
    const events: string[] = [];
    const observations: Array<
      Parameters<
        NonNullable<RuntimeWorkerRequestRouterOptions["onLeaseReady"]>
      >[0]
    > = [];
    const harness = createHarness({
      events,
      onLeaseReady: (observation) => {
        events.push("lease-ready");
        observations.push(observation);
      },
      onRequestHandleAllocated: () => {
        events.push("request-handle");
      },
    });

    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });

    expect(route).toMatchObject({
      mode: "pooled",
      gatewayUrl: "http://worker-1.internal",
      requestHandle: "request-a-1",
      binding: {
        organizationId: "org-a",
        userId: "user-a",
        assistantId: "asst-a",
        workerStackId: "worker-1",
        leaseGeneration: 1,
      },
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");
    expect(actorClaims(route.gatewayIngressToken)).toMatchObject({
      scope_profile: "gateway_ingress_v1",
      pooled_worker_lease: {
        organization_id: "org-a",
        assistant_id: "asst-a",
        worker_stack_id: "worker-1",
        lease_generation: 1,
      },
    });
    expect(observations).toEqual([
      {
        identity: identity("a"),
        workerStackId: "worker-1",
        leaseToken: "lease-a",
        leaseGeneration: 1,
        stateGeneration: 0,
        observedBytes: 0,
        observedAtMs: 1_000,
      },
    ]);
    expect(events).toEqual(["restore:org-a", "lease-ready", "request-handle"]);
  });

  test("observes persisted uncompressed workspace bytes instead of compressed object bytes", async () => {
    const observations: Array<
      Parameters<
        NonNullable<RuntimeWorkerRequestRouterOptions["onLeaseReady"]>
      >[0]
    > = [];
    const harness = createHarness({
      onLeaseReady: (observation) => {
        observations.push(observation);
      },
    });

    const first = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (first.mode !== "pooled") throw new Error("Expected pooled route.");
    await harness.router.finishRequest({
      requestHandle: first.requestHandle,
      identity: identity("a"),
    });
    await harness.timer.runWithDelay(500);

    const second = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(second).toMatchObject({
      mode: "pooled",
      binding: { leaseGeneration: 2 },
    });
    expect(
      observations.map(({ stateGeneration, observedBytes }) => ({
        stateGeneration,
        observedBytes,
      })),
    ).toEqual([
      { stateGeneration: 0, observedBytes: 0 },
      { stateGeneration: 1, observedBytes: WORKSPACE_BYTES },
    ]);
    expect(
      harness.db
        .query<
          { byte_size: number; workspace_bytes: number },
          [string, string]
        >(
          `SELECT byte_size, workspace_bytes
           FROM runtime_worker_state_objects
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get("org-a", "asst-a"),
    ).toEqual({ byte_size: 4_096, workspace_bytes: WORKSPACE_BYTES });
  });

  test("lease-ready observation rejection cleans the worker before failing closed", async () => {
    const events: string[] = [];
    const requestHandles = ["request-must-not-be-used"];
    const harness = createHarness({
      events,
      requestHandles,
      onLeaseReady: ({ stateGeneration, observedBytes }) => {
        events.push(`lease-ready:g${stateGeneration}:${observedBytes}`);
        throw new Error("Tenant storage observation was rejected.");
      },
      onRequestHandleAllocated: (handle) => {
        events.push(`request-handle:${handle}`);
      },
    });

    expect(
      await harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "worker_unavailable",
      retryAfterMs: null,
    });
    expect(events).toEqual([
      "restore:org-a",
      "lease-ready:g0:0",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);
    expect(requestHandles).toEqual(["request-must-not-be-used"]);
    expect(
      harness.db
        .query<
          {
            assistant_id: string | null;
            org_id: string | null;
            lease_token: string | null;
            lease_expires_at: number | null;
          },
          [string]
        >(
          `SELECT assistant_id, org_id, lease_token, lease_expires_at
           FROM runtime_worker_leases
           WHERE runtime_stack_id = ?`,
        )
        .get("worker-1"),
    ).toEqual({
      assistant_id: null,
      org_id: null,
      lease_token: null,
      lease_expires_at: null,
    });
  });

  test("coalesces concurrent assistant requests and releases only after the final reference", async () => {
    const leaseTokens = ["lease-a", "unused-lease"];
    const harness = createHarness({ leaseTokens });
    const [first, second] = await Promise.all([
      harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
      harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ]);

    expect(first).toMatchObject({
      mode: "pooled",
      gatewayUrl: "http://worker-1.internal",
      binding: { leaseGeneration: 1, assistantId: "asst-a" },
    });
    expect(second).toMatchObject({
      mode: "pooled",
      binding: { leaseGeneration: 1, assistantId: "asst-a" },
    });
    expect(leaseTokens).toEqual(["unused-lease"]);

    if (first.mode !== "pooled" || second.mode !== "pooled") {
      throw new Error("Expected pooled routes.");
    }
    expect(
      await harness.router.finishRequest({
        requestHandle: first.requestHandle,
        identity: identity("a"),
      }),
    ).toEqual({ status: "active", activeRequestCount: 1 });
    expect(harness.events).not.toContain("sanitize:org-a");
    expect(
      await harness.router.finishRequest({
        requestHandle: second.requestHandle,
        identity: identity("a"),
      }),
    ).toEqual({ status: "release_scheduled" });
    expect(harness.timer.size()).toBe(1);
    await harness.timer.runWithDelay(500);
    expect(harness.events).toContain("sanitize:org-a");
  });

  test("keeps the lease active for a pending pooled POST and releases only after it resolves", async () => {
    const harness = createHarness({});
    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    // The proxy still owns this route handle while the assistant's pooled
    // /messages request is awaiting its agent loop (including approvals).
    expect(harness.timer.size()).toBe(1);
    expect(harness.events).toEqual(["restore:org-a"]);
    expect(
      harness.db
        .query<
          { lease_token: string | null },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBe("lease-a");

    expect(
      await harness.router.finishRequest({
        requestHandle: route.requestHandle,
        identity: identity("a"),
      }),
    ).toEqual({ status: "release_scheduled" });
    expect(harness.events).toEqual(["restore:org-a"]);

    await harness.timer.runWithDelay(500);
    expect(harness.events).toEqual([
      "restore:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);
    expect(
      harness.db
        .query<
          { lease_token: string | null },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBeNull();
  });

  test("rejects cross-tenant assistant and route-handle reuse", async () => {
    const harness = createHarness({});
    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    expect(
      await harness.router.finishRequest({
        requestHandle: route.requestHandle,
        identity: { ...identity("a"), organizationId: "org-b" },
      }),
    ).toEqual({ status: "route_handle_mismatch" });
    expect(
      await harness.router.routeRequest({
        identity: { ...identity("a"), organizationId: "org-b" },
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "tenant_mismatch",
      retryAfterMs: null,
    });
  });

  test("renews the tenant lease while at least one request remains active", async () => {
    const harness = createHarness({});
    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    expect(
      harness.db
        .query<
          { lease_expires_at: number },
          [string]
        >("SELECT lease_expires_at FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_expires_at,
    ).toBe(61_000);

    harness.setNow(21_000);
    await harness.timer.runWithDelay(20_000);
    expect(
      harness.db
        .query<
          { lease_expires_at: number },
          [string]
        >("SELECT lease_expires_at FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_expires_at,
    ).toBe(81_000);
    expect(harness.timer.size()).toBe(1);
  });

  test("renews the exact lease throughout a restore that outlives its original TTL", async () => {
    let restoreStarted = false;
    let completeRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      completeRestore = resolve;
    });
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ object, expectedWorkspaceByteSize }) => {
          restoreStarted = true;
          await restoreGate;
          return restoredState(object, expectedWorkspaceByteSize);
        },
        export: async ({ objectKey }) => exportedState(objectKey),
      },
      sanitize: async () => {},
      revokeAuthority: async () => {},
    };
    const harness = createHarness({ lifecycle });

    const pendingRoute = harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    for (let tick = 0; tick < 8 && !restoreStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(restoreStarted).toBe(true);

    for (const now of [21_000, 41_000, 61_000, 81_000]) {
      harness.setNow(now);
      await harness.timer.runWithDelay(20_000);
    }
    expect(
      harness.db
        .query<
          { lease_expires_at: number },
          [string]
        >("SELECT lease_expires_at FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_expires_at,
    ).toBe(141_000);

    completeRestore();
    const route = await pendingRoute;
    expect(route).toMatchObject({
      mode: "pooled",
      binding: { leaseExpiresAtMs: 141_000 },
    });
  });

  test("quarantines restored state when the exact lifecycle lease expires before final authorization", async () => {
    let restoreStarted = false;
    let completeRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      completeRestore = resolve;
    });
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ object, expectedWorkspaceByteSize }) => {
          restoreStarted = true;
          await restoreGate;
          return restoredState(object, expectedWorkspaceByteSize);
        },
        export: async ({ objectKey }) => exportedState(objectKey),
      },
      sanitize: async () => {},
      revokeAuthority: async () => {},
    };
    const harness = createHarness({
      lifecycle,
      leaseTokens: ["lease-a", "blocked-lease-b", "lease-b"],
    });

    const pendingRoute = harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    for (let tick = 0; tick < 8 && !restoreStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(restoreStarted).toBe(true);

    // Simulate an event-loop stall that prevents the scheduled heartbeat from
    // running until after the durable lease has expired.
    harness.setNow(70_000);
    completeRestore();
    expect(await pendingRoute).toEqual({
      mode: "unavailable",
      reason: "state_quarantined",
      retryAfterMs: null,
    });
    expect(
      harness.db
        .query<
          {
            status: string;
            failure_code: string | null;
            worker_stack_id: string | null;
          },
          [string, string]
        >(
          `SELECT status, failure_code, worker_stack_id
           FROM runtime_worker_state_checkpoints
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get("org-a", "asst-a"),
    ).toEqual({
      status: "quarantined",
      failure_code: "restore_failed",
      worker_stack_id: "worker-1",
    });

    expect(
      await harness.router.routeRequest({
        identity: identity("b"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "capacity_exhausted",
      retryAfterMs: null,
    });
    expect(
      harness.db
        .query<{ lease_token: string; lease_generation: number }, [string]>(
          `SELECT lease_token, lease_generation
           FROM runtime_worker_leases
           WHERE runtime_stack_id = ?`,
        )
        .get("worker-1"),
    ).toEqual({ lease_token: "lease-a", lease_generation: 1 });

    const candidate = harness.router.listOperatorRecoveryCandidates()[0]!;
    expect(candidate).toMatchObject({
      recoveryKind: "quarantined_state",
      checkpointFailureCode: "restore_failed",
      inProcessActive: false,
    });
    expect(
      await harness.router.discardQuarantinedState({
        binding: candidate.binding,
      }),
    ).toEqual({ status: "recovered" });
    expect(
      await harness.router.routeRequest({
        identity: identity("b"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toMatchObject({
      mode: "pooled",
      binding: { assistantId: "asst-b", leaseGeneration: 2 },
    });
  });

  test("renews throughout a slow export before sanitizing and releasing", async () => {
    let exportStarted = false;
    let completeExport!: () => void;
    const exportGate = new Promise<void>((resolve) => {
      completeExport = resolve;
    });
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ object, expectedWorkspaceByteSize }) =>
          restoredState(object, expectedWorkspaceByteSize),
        export: async ({ objectKey }) => {
          exportStarted = true;
          await exportGate;
          return exportedState(objectKey);
        },
      },
      sanitize: async () => {},
      revokeAuthority: async () => {},
    };
    const harness = createHarness({ lifecycle });
    const route = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");
    await harness.router.finishRequest({
      requestHandle: route.requestHandle,
      identity: identity("a"),
    });

    const pendingRelease = harness.timer.runWithDelay(500);
    for (let tick = 0; tick < 8 && !exportStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(exportStarted).toBe(true);
    for (const now of [21_000, 41_000, 61_000, 81_000]) {
      harness.setNow(now);
      await harness.timer.runWithDelay(20_000);
    }
    expect(
      harness.db
        .query<
          { lease_expires_at: number },
          [string]
        >("SELECT lease_expires_at FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_expires_at,
    ).toBe(141_000);

    completeExport();
    await pendingRelease;
    expect(
      harness.db
        .query<
          { assistant_id: string | null },
          [string]
        >("SELECT assistant_id FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.assistant_id,
    ).toBeNull();
  });

  for (const expiryStage of ["export", "sanitize", "revoke"] as const) {
    test(`quarantines the exact generation when authorization expires after ${expiryStage}`, async () => {
      let stageStarted = false;
      let completeStage!: () => void;
      const stageGate = new Promise<void>((resolve) => {
        completeStage = resolve;
      });
      const waitAtStage = async (
        stage: "export" | "sanitize" | "revoke",
      ): Promise<void> => {
        if (stage !== expiryStage) return;
        stageStarted = true;
        await stageGate;
      };
      const lifecycle: RuntimeWorkerLifecycleAdapter = {
        storage: {
          restore: async ({ object, expectedWorkspaceByteSize }) =>
            restoredState(object, expectedWorkspaceByteSize),
          export: async ({ objectKey }) => {
            await waitAtStage("export");
            return exportedState(objectKey);
          },
        },
        sanitize: async () => {
          await waitAtStage("sanitize");
        },
        revokeAuthority: async () => {
          await waitAtStage("revoke");
        },
      };
      const harness = createHarness({
        lifecycle,
        leaseTokens: [
          "lease-a",
          `blocked-lease-b-${expiryStage}`,
          `lease-b-${expiryStage}`,
        ],
      });
      const route = await harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      });
      if (route.mode !== "pooled") throw new Error("Expected pooled route.");
      await harness.router.finishRequest({
        requestHandle: route.requestHandle,
        identity: identity("a"),
      });

      const pendingRelease = harness.timer.runWithDelay(500);
      for (let tick = 0; tick < 8 && !stageStarted; tick += 1) {
        await Promise.resolve();
      }
      expect(stageStarted).toBe(true);
      harness.setNow(70_000);
      completeStage();
      await pendingRelease;

      expect(
        harness.db
          .query<
            {
              status: string;
              failure_code: string | null;
              generation: number;
            },
            [string, string]
          >(
            `SELECT status, failure_code, generation
             FROM runtime_worker_state_checkpoints
             WHERE org_id = ? AND assistant_id = ?`,
          )
          .get("org-a", "asst-a"),
      ).toEqual({
        status: "quarantined",
        failure_code: "export_failed",
        generation: 1,
      });

      expect(
        await harness.router.routeRequest({
          identity: identity("b"),
          dedicatedRoute: dedicatedRoute(),
        }),
      ).toEqual({
        mode: "unavailable",
        reason: "capacity_exhausted",
        retryAfterMs: null,
      });
      expect(
        harness.db
          .query<{ lease_token: string; lease_generation: number }, [string]>(
            `SELECT lease_token, lease_generation
             FROM runtime_worker_leases
             WHERE runtime_stack_id = ?`,
          )
          .get("worker-1"),
      ).toEqual({ lease_token: "lease-a", lease_generation: 1 });

      const candidate = harness.router.listOperatorRecoveryCandidates()[0]!;
      expect(candidate).toMatchObject({
        recoveryKind: "quarantined_state",
        checkpointFailureCode: "export_failed",
        inProcessActive: false,
      });
      expect(
        await harness.router.discardQuarantinedState({
          binding: candidate.binding,
        }),
      ).toEqual({ status: "recovered" });
      expect(
        await harness.router.routeRequest({
          identity: identity("b"),
          dedicatedRoute: dedicatedRoute(),
        }),
      ).toMatchObject({
        mode: "pooled",
        binding: { assistantId: "asst-b", leaseGeneration: 2 },
      });
    });
  }

  test("durably quarantines an active persisted lease after restart", async () => {
    const db = setupDb();
    const first = createHarness({ db });
    const route = await first.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");

    const restarted = createHarness({
      db,
      leaseTokens: ["unused-lease"],
      requestHandles: ["request-after-restart"],
    });
    expect(
      await restarted.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "restart_quarantined",
      retryAfterMs: null,
    });
    expect(
      db
        .query<
          { lease_token: string },
          [string]
        >("SELECT lease_token FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.lease_token,
    ).toBe("lease-a");
  });

  test("operator recovery requires the exact generation and performs full cleanup before reuse", async () => {
    const db = setupDb();
    const events: string[] = [];
    const first = createHarness({ db, events });
    const route = await first.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    const restarted = createHarness({
      db,
      events,
      leaseTokens: ["lease-b"],
      requestHandles: ["request-after-recovery"],
    });
    expect(
      await restarted.router.recoverRestartQuarantine({
        binding: { ...route.binding, leaseGeneration: 2 },
      }),
    ).toEqual({ status: "binding_mismatch" });
    expect(events).toEqual(["restore:org-a"]);

    expect(
      await restarted.router.recoverRestartQuarantine({
        binding: route.binding,
      }),
    ).toEqual({ status: "recovered" });
    expect(events).toEqual([
      "restore:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);

    const rerouted = await restarted.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(rerouted).toMatchObject({
      mode: "pooled",
      requestHandle: "request-after-recovery",
      binding: {
        assistantId: "asst-a",
        workerStackId: "worker-1",
        leaseGeneration: 2,
      },
    });
  });

  test("an exact expired restart binding receives cleanup-only authority and blocks reuse until sanitation", async () => {
    const db = setupDb();
    const first = createHarness({ db });
    const route = await first.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    let exportStarted = false;
    let completeExport!: () => void;
    const exportGate = new Promise<void>((resolve) => {
      completeExport = resolve;
    });
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ object, expectedWorkspaceByteSize }) =>
          restoredState(object, expectedWorkspaceByteSize),
        export: async ({ objectKey }) => {
          exportStarted = true;
          await exportGate;
          return exportedState(objectKey);
        },
      },
      sanitize: async () => {},
      revokeAuthority: async () => {},
    };
    const restarted = createHarness({
      db,
      lifecycle,
      now: 70_000,
      leaseTokens: ["blocked-lease-b", "lease-b"],
      requestHandles: ["request-b"],
    });
    expect(
      await restarted.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "orphaned_expired_lease",
      retryAfterMs: null,
    });

    const recovery = restarted.router.recoverRestartQuarantine({
      binding: route.binding,
    });
    for (let tick = 0; tick < 8 && !exportStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(exportStarted).toBe(true);
    expect(
      await restarted.router.routeRequest({
        identity: identity("b"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "capacity_exhausted",
      retryAfterMs: 60_000,
    });

    completeExport();
    expect(await recovery).toEqual({ status: "recovered" });
    expect(
      await restarted.router.routeRequest({
        identity: identity("b"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toMatchObject({
      mode: "pooled",
      requestHandle: "request-b",
      binding: { assistantId: "asst-b", leaseGeneration: 2 },
    });
  });

  test("explicit quarantine discard preserves the last checkpoint and sanitizes before reuse", async () => {
    const db = setupDb();
    const events: string[] = [];
    const failingLifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ object, expectedWorkspaceByteSize }) =>
          restoredState(object, expectedWorkspaceByteSize),
        export: async () => {
          throw new Error("Object storage unavailable.");
        },
      },
      sanitize: async () => {
        events.push("unexpected-first-sanitize");
      },
      revokeAuthority: async () => {
        events.push("unexpected-first-revoke");
      },
    };
    const first = createHarness({ db, lifecycle: failingLifecycle });
    const route = await first.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");
    await first.router.finishRequest({
      requestHandle: route.requestHandle,
      identity: identity("a"),
    });
    await first.timer.runWithDelay(500);
    expect(
      db
        .query<{ status: string; generation: number }, [string, string]>(
          `SELECT status, generation
           FROM runtime_worker_state_checkpoints
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get("org-a", "asst-a"),
    ).toEqual({ status: "quarantined", generation: 0 });

    const recoveryEvents: string[] = [];
    const restarted = createHarness({ db, events: recoveryEvents });
    expect(
      await restarted.router.discardQuarantinedState({
        binding: { ...route.binding, leaseGeneration: 2 },
      }),
    ).toEqual({ status: "binding_mismatch" });
    expect(recoveryEvents).toEqual([]);

    expect(
      await restarted.router.discardQuarantinedState({
        binding: route.binding,
      }),
    ).toEqual({ status: "recovered" });
    expect(recoveryEvents).toEqual(["sanitize:org-a", "revoke:org-a:g1"]);
    expect(
      db
        .query<
          {
            status: string;
            generation: number;
            worker_stack_id: string | null;
            failure_code: string | null;
          },
          [string, string]
        >(
          `SELECT status, generation, worker_stack_id, failure_code
           FROM runtime_worker_state_checkpoints
           WHERE org_id = ? AND assistant_id = ?`,
        )
        .get("org-a", "asst-a"),
    ).toEqual({
      status: "checkpointed",
      generation: 0,
      worker_stack_id: null,
      failure_code: null,
    });
    expect(
      await restarted.router.routeRequest({
        identity: identity("b"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toMatchObject({
      mode: "pooled",
      binding: { assistantId: "asst-b", leaseGeneration: 2 },
    });
  });

  test("operator inspection exposes an exact recovery binding after restore quarantines before routing", async () => {
    const events: string[] = [];
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async () => {
          throw new Error("Restore failed.");
        },
        export: async ({ objectKey }) => exportedState(objectKey),
      },
      sanitize: async ({ assistant }) => {
        events.push(`sanitize:${assistant.org_id}`);
      },
      revokeAuthority: async ({ assistant, leaseGeneration }) => {
        events.push(`revoke:${assistant.org_id}:g${leaseGeneration}`);
      },
    };
    const harness = createHarness({ lifecycle });
    expect(
      await harness.router.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "state_quarantined",
      retryAfterMs: null,
    });
    const candidates = harness.router.listOperatorRecoveryCandidates();
    expect(candidates).toEqual([
      {
        binding: {
          organizationId: "org-a",
          userId: "user-a",
          assistantId: "asst-a",
          workerStackId: "worker-1",
          leaseGeneration: 1,
          leaseExpiresAtMs: 61_000,
        },
        recoveryKind: "quarantined_state",
        checkpointFailureCode: "storage_unavailable",
        inProcessActive: false,
      },
    ]);

    expect(
      await harness.router.discardQuarantinedState({
        binding: candidates[0]!.binding,
      }),
    ).toEqual({ status: "recovered" });
    expect(events).toEqual(["sanitize:org-a", "revoke:org-a:g1"]);
  });

  test("unrelated assistants do not share a lifecycle mutex", async () => {
    let releaseAssistantA!: () => void;
    let assistantBRestoreStarted = false;
    const assistantARestore = new Promise<void>((resolve) => {
      releaseAssistantA = resolve;
    });
    const lifecycle: RuntimeWorkerLifecycleAdapter = {
      storage: {
        restore: async ({ tenant, expectedWorkspaceByteSize }) => {
          if (tenant.assistantId === "asst-a") {
            await assistantARestore;
          } else {
            assistantBRestoreStarted = true;
          }
          return restoredState(null, expectedWorkspaceByteSize);
        },
        export: async ({ tenant, objectKey }) =>
          exportedState(objectKey, tenant.assistantId === "asst-a" ? 1 : 2),
      },
      sanitize: async () => {},
      revokeAuthority: async () => {},
    };
    const harness = createHarness({
      lifecycle,
      pool: {
        enabled: true,
        candidateStackIds: ["worker-1", "worker-2"],
        maxConcurrentLeases: 2,
        leaseTtlMs: 60_000,
      },
      leaseTokens: ["lease-a", "lease-b"],
      requestHandles: ["request-a", "request-b"],
    });

    const routeA = harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    await Promise.resolve();
    const routeB = harness.router.routeRequest({
      identity: identity("b"),
      dedicatedRoute: dedicatedRoute(),
    });
    for (let tick = 0; tick < 8 && !assistantBRestoreStarted; tick += 1) {
      await Promise.resolve();
    }

    try {
      expect(assistantBRestoreStarted).toBe(true);
    } finally {
      releaseAssistantA();
    }
    const [resultA, resultB] = await Promise.all([routeA, routeB]);
    expect(resultA).toMatchObject({ mode: "pooled" });
    expect(resultB).toMatchObject({ mode: "pooled" });
  });

  test("releases and sanitizes tenant A before assigning tenant B and rejects stale generation reuse", async () => {
    const leaseTokens = ["lease-a", "lease-b"];
    const harness = createHarness({ leaseTokens });
    const tenantA = await harness.router.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(tenantA.mode).toBe("pooled");
    if (tenantA.mode !== "pooled") throw new Error("Expected tenant A route.");

    await harness.router.finishRequest({
      requestHandle: tenantA.requestHandle,
      identity: identity("a"),
    });
    await harness.timer.runWithDelay(500);

    const tenantB = await harness.router.routeRequest({
      identity: identity("b"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(tenantB.mode).toBe("pooled");
    if (tenantB.mode !== "pooled") throw new Error("Expected tenant B route.");

    expect(harness.events).toEqual([
      "restore:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
      "restore:org-b",
    ]);
    const claimsA = actorClaims(tenantA.actorToken).pooled_worker_lease;
    const claimsB = actorClaims(tenantB.actorToken).pooled_worker_lease;
    expect(claimsA).toMatchObject({
      organization_id: "org-a",
      assistant_id: "asst-a",
      worker_stack_id: "worker-1",
      lease_generation: 1,
    });
    expect(claimsB).toMatchObject({
      organization_id: "org-b",
      assistant_id: "asst-b",
      worker_stack_id: "worker-1",
      lease_generation: 2,
    });
    expect(
      resolveActiveRuntimeWorkerLeaseServiceBinding(
        harness.db,
        "worker-1",
        1_000,
      ),
    ).toMatchObject({
      organizationId: "org-b",
      assistantId: "asst-b",
      leaseGeneration: 2,
    });
    expect(() =>
      mintRuntimeWorkerLeaseActorToken(
        harness.db,
        {
          ...identity("a"),
          requestId: "stale-request-a",
          workerStackId: "worker-1",
          leaseToken: "lease-a",
        },
        MASTER_KEY,
        1_000,
      ),
    ).toThrow("not active for this tenant");
  });
});
