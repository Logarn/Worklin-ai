import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  claimRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
} from "./runtime-worker-leases.js";
import {
  createRuntimeWorkerLeaseAuthorizationProvider,
  createRuntimeWorkerProductionCoordinatorFromEnv,
  runtimeWorkerProductionCoordinatorConfigFromEnv,
  type RuntimeWorkerProductionTransportFactory,
} from "./runtime-worker-production-coordinator.js";
import type {
  RuntimeWorkerObjectHead,
  RuntimeWorkerProductionTransport,
} from "./runtime-worker-production-lifecycle.js";
import type {
  RuntimeWorkerLeaseAuthorization,
  RuntimeWorkerStateTransportOperation,
} from "./runtime-worker-production-transport.js";
import type { RuntimeWorkerRouteTimer } from "./runtime-worker-request-router.js";
import {
  buildRuntimeWorkerStateObjectKey,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";

const MASTER_KEY = "a".repeat(64);
const BUCKET = "worklin-runtime-state";
const CHECKSUM = "b".repeat(64);

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO organizations (id, user_id)
    VALUES ('org-a', 'user-a'), ('org-b', 'user-b');
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
    ) VALUES (
      'worker-1',
      'pool',
      'pool-owner',
      'active',
      '${RUNTIME_WORKER_POOL_PROVIDER}',
      'https://worker-1.internal',
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

function enabledEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "worker-1",
    WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: "1",
    WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS: "60000",
    WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN: "r".repeat(64),
    WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
    ACTOR_TOKEN_SIGNING_KEY: MASTER_KEY,
    WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED: "true",
    WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED: "true",
    WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED: "true",
    WORKLIN_TENANT_USAGE_METRICS_ENABLED: "true",
    WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED: "true",
    WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED: "true",
    ...overrides,
  };
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
    gatewayUrl: "https://dedicated.internal",
    actorToken: "dedicated-token",
  };
}

function coordinatorOwnership(isLive: () => boolean = () => true) {
  return {
    binding: {
      ownerId: "process-1",
      deploymentId: "deployment-1",
      replicaId: "replica-1",
      epoch: 1,
      acquiredAtMs: 1_000,
      heartbeatAtMs: 1_000,
      expiresAtMs: 61_000,
    },
    isLive,
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

  async runWithDelay(delayMs: number): Promise<void> {
    const match = [...this.callbacks.entries()].find(
      ([, value]) => value.delayMs === delayMs,
    );
    if (!match) throw new Error(`No timer scheduled for ${delayMs}ms.`);
    this.callbacks.delete(match[0]);
    await match[1].callback();
  }
}

function stateObject(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
): RuntimeWorkerStateObject {
  return {
    provider: "gcs",
    bucket: BUCKET,
    objectKey: buildRuntimeWorkerStateObjectKey(tenant, generation),
    checksumSha256: CHECKSUM,
    byteSize: 4_096,
    format: "vbundle-v1",
  };
}

function objectHead(object: RuntimeWorkerStateObject): RuntimeWorkerObjectHead {
  return {
    ...object,
    contentType: "application/octet-stream",
  };
}

function transportHarness(
  events: string[],
  hooks: Partial<
    Record<RuntimeWorkerStateTransportOperation, () => Promise<void>>
  > = {},
): {
  factory: RuntimeWorkerProductionTransportFactory;
  authorizations: Array<{
    operation: RuntimeWorkerStateTransportOperation;
    authorization: RuntimeWorkerLeaseAuthorization;
  }>;
} {
  const authorizations: Array<{
    operation: RuntimeWorkerStateTransportOperation;
    authorization: RuntimeWorkerLeaseAuthorization;
  }> = [];
  const objects = new Map<string, RuntimeWorkerStateObject>();
  const revokedBindings = new Set<string>();
  const factory: RuntimeWorkerProductionTransportFactory = (
    _rawEnv,
    dependencies,
  ) => {
    const authorize = async (
      tenant: RuntimeWorkerStateTenant,
      workerStackId: string,
      operation: RuntimeWorkerStateTransportOperation,
    ): Promise<RuntimeWorkerLeaseAuthorization> => {
      const authorization = await dependencies.authorizeLease({
        tenant,
        workerStackId,
        operation,
      });
      const bindingKey = [
        authorization.binding.organizationId,
        authorization.binding.assistantId,
        authorization.binding.workerStackId,
        authorization.binding.leaseGeneration,
      ].join(":");
      if (operation !== "revoke" && revokedBindings.has(bindingKey)) {
        throw new Error("Worker authority is revoked.");
      }
      authorizations.push({ operation, authorization });
      return authorization;
    };
    const transport: RuntimeWorkerProductionTransport = {
      prepareEmptyWorkspace: async ({
        tenant,
        workerStackId,
        leaseGeneration,
      }) => {
        await authorize(tenant, workerStackId, "prepare_empty");
        await hooks.prepare_empty?.();
        events.push(`prepare:${tenant.orgId}`);
        return {
          status: "prepared_empty",
          tenant,
          workerStackId,
          leaseGeneration,
          remainingTenantPaths: 0,
          credentialsTouched: false,
        };
      },
      exportRedactedVBundle: async ({
        tenant,
        workerStackId,
        leaseGeneration,
        stateGeneration,
        objectKey,
      }) => {
        await authorize(tenant, workerStackId, "export");
        await hooks.export?.();
        const match = /generation-(\d+)\.vbundle$/u.exec(objectKey);
        if (!match?.[1]) throw new Error("Invalid object key.");
        const object = stateObject(tenant, Number(match[1]));
        objects.set(objectKey, object);
        events.push(`export:${tenant.orgId}`);
        return {
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration,
          object,
          workspaceByteSize: 0,
          entries: [],
          credentialsIncluded: 0,
          secretsRedacted: true,
        };
      },
      restoreRedactedVBundle: async ({
        tenant,
        workerStackId,
        leaseGeneration,
        stateGeneration,
        object,
      }) => {
        await authorize(tenant, workerStackId, "restore");
        await hooks.restore?.();
        events.push(`restore:${tenant.orgId}`);
        return {
          status: "restored",
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration,
          object,
          workspaceByteSize: 0,
          filesRestored: 0,
          credentialsImported: 0,
          secretsMaterialized: false,
        };
      },
      headObject: async ({ objectKey }) => {
        const object = objects.get(objectKey);
        return object ? objectHead(object) : null;
      },
      sanitizeWorkspace: async ({ tenant, workerStackId, leaseGeneration }) => {
        await authorize(tenant, workerStackId, "sanitize");
        await hooks.sanitize?.();
        events.push(`sanitize:${tenant.orgId}`);
        return {
          status: "sanitized",
          tenant,
          workerStackId,
          leaseGeneration,
          remainingTenantPaths: 0,
          credentialsTouched: false,
        };
      },
      revokeLeaseAuthority: async ({
        tenant,
        workerStackId,
        leaseGeneration,
      }) => {
        const authorization = await authorize(tenant, workerStackId, "revoke");
        await hooks.revoke?.();
        revokedBindings.add(
          [
            authorization.binding.organizationId,
            authorization.binding.assistantId,
            authorization.binding.workerStackId,
            authorization.binding.leaseGeneration,
          ].join(":"),
        );
        events.push(`revoke:${tenant.orgId}:g${leaseGeneration}`);
        return {
          status: "revoked",
          workerStackId,
          leaseGeneration,
        };
      },
    };
    return transport;
  };
  return { factory, authorizations };
}

function createHarness(options: {
  db?: Database;
  now?: number;
  leaseTokens?: string[];
  requestHandles?: string[];
  transportHooks?: Partial<
    Record<RuntimeWorkerStateTransportOperation, () => Promise<void>>
  >;
  ownershipLive?: () => boolean;
}) {
  const db = options.db ?? setupDb();
  const timer = new DeterministicTimer();
  const events: string[] = [];
  const transport = transportHarness(events, options.transportHooks);
  const leaseTokens = options.leaseTokens ?? ["lease-a", "lease-b"];
  const requestHandles = options.requestHandles ?? ["request-a", "request-b"];
  let now = options.now ?? 1_000;
  const coordinator = createRuntimeWorkerProductionCoordinatorFromEnv(
    db,
    enabledEnv(),
    {
      timer,
      coordinatorOwnership: coordinatorOwnership(options.ownershipLive),
      transportFactory: transport.factory,
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
        return handle;
      },
    },
  );
  return {
    db,
    timer,
    events,
    transport,
    coordinator,
    setNow(value: number) {
      now = value;
    },
  };
}

function tokenPayload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("runtime worker production coordinator configuration", () => {
  test("is disabled by default and preserves the dedicated route", async () => {
    const coordinator = createRuntimeWorkerProductionCoordinatorFromEnv(
      setupDb(),
      {},
    );
    expect(coordinator.config).toMatchObject({ enabled: false });
    expect(
      await coordinator.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({ mode: "dedicated", route: dedicatedRoute() });
  });

  test("rejects ambiguous enable flags and incomplete production dependencies", () => {
    expect(() =>
      runtimeWorkerProductionCoordinatorConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "perhaps",
      }),
    ).toThrow("must be a boolean");
    expect(() =>
      runtimeWorkerProductionCoordinatorConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "",
        }),
      ),
    ).toThrow("at least one worker");
    expect(() =>
      runtimeWorkerProductionCoordinatorConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "false",
        }),
      ),
    ).toThrow("must be enabled");
    expect(() =>
      runtimeWorkerProductionCoordinatorConfigFromEnv(
        enabledEnv({ ACTOR_TOKEN_SIGNING_KEY: "not-a-key" }),
      ),
    ).toThrow("64 hex");
    expect(() =>
      runtimeWorkerProductionCoordinatorConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN: undefined,
        }),
      ),
    ).toThrow("WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN");
    for (const requiredFlag of [
      "WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED",
      "WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED",
      "WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED",
      "WORKLIN_TENANT_USAGE_METRICS_ENABLED",
      "WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED",
      "WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED",
    ]) {
      expect(() =>
        runtimeWorkerProductionCoordinatorConfigFromEnv(
          enabledEnv({ [requiredFlag]: "false" }),
        ),
      ).toThrow(`${requiredFlag} must be enabled`);
    }
    expect(() =>
      createRuntimeWorkerProductionCoordinatorFromEnv(setupDb(), enabledEnv(), {
        coordinatorOwnership: coordinatorOwnership(),
        transportFactory: () => null,
      }),
    ).toThrow("transport is unavailable");
  });
});

describe("runtime worker exact active-lease authorization", () => {
  test("mints a worker service token only for the exact active tenant lease", async () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      { id: "asst-a", org_id: "org-a" },
      ["worker-1"],
      1,
      "lease-a",
      1_000,
      60_000,
      () => "2026-07-20T00:00:01.000Z",
    );
    let now = 1_000;
    const authorize = createRuntimeWorkerLeaseAuthorizationProvider({
      db,
      masterActorSigningKey: MASTER_KEY,
      nowMs: () => now,
      coordinatorOwnership: coordinatorOwnership(),
    });

    const result = await authorize({
      tenant: { orgId: "org-a", assistantId: "asst-a" },
      workerStackId: "worker-1",
      operation: "restore",
    });
    expect(result.binding).toEqual({
      organizationId: "org-a",
      userId: "user-a",
      assistantId: "asst-a",
      workerStackId: "worker-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: 61_000,
    });
    expect(tokenPayload(result.bearerToken)).toMatchObject({
      sub: "svc:gateway:self",
      service_tenant_context: {
        organization_id: "org-a",
        assistant_id: "asst-a",
      },
      pooled_worker_lease: {
        organization_id: "org-a",
        assistant_id: "asst-a",
        worker_stack_id: "worker-1",
        lease_generation: 1,
      },
    });
    await expect(
      authorize({
        tenant: { orgId: "org-b", assistantId: "asst-b" },
        workerStackId: "worker-1",
        operation: "restore",
      }),
    ).rejects.toThrow("exact tenant");
    now = 61_000;
    await expect(
      authorize({
        tenant: { orgId: "org-a", assistantId: "asst-a" },
        workerStackId: "worker-1",
        operation: "restore",
      }),
    ).rejects.toThrow("exact tenant");
  });

  test("does not return service authority if singleton ownership changes during mint", async () => {
    const db = setupDb();
    claimRuntimeWorkerLease(
      db,
      { id: "asst-a", org_id: "org-a" },
      ["worker-1"],
      1,
      "lease-a",
      1_000,
      60_000,
      () => "2026-07-20T00:00:01.000Z",
    );
    let checks = 0;
    const authorize = createRuntimeWorkerLeaseAuthorizationProvider({
      db,
      masterActorSigningKey: MASTER_KEY,
      nowMs: () => 1_000,
      coordinatorOwnership: coordinatorOwnership(() => {
        checks += 1;
        return checks === 1;
      }),
    });

    await expect(
      authorize({
        tenant: { orgId: "org-a", assistantId: "asst-a" },
        workerStackId: "worker-1",
        operation: "restore",
      }),
    ).rejects.toThrow("ownership is not live");
  });
});

describe("runtime worker production coordinator", () => {
  test("requires live singleton ownership before constructing an enabled coordinator", () => {
    expect(() =>
      createRuntimeWorkerProductionCoordinatorFromEnv(
        setupDb(),
        enabledEnv(),
        {
          coordinatorOwnership: coordinatorOwnership(() => false),
          transportFactory: transportHarness([]).factory,
        },
      ),
    ).toThrow("live singleton ownership");
  });

  test("composes lifecycle transport and signed actor/service authority", async () => {
    const harness = createHarness({});
    const route = await harness.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route).toMatchObject({
      mode: "pooled",
      gatewayUrl: "https://worker-1.internal",
      binding: {
        organizationId: "org-a",
        assistantId: "asst-a",
        leaseGeneration: 1,
      },
    });
    expect(harness.events).toEqual(["prepare:org-a"]);
    expect(harness.transport.authorizations).toHaveLength(1);
    expect(harness.transport.authorizations[0]).toMatchObject({
      operation: "prepare_empty",
      authorization: {
        binding: {
          organizationId: "org-a",
          assistantId: "asst-a",
          leaseGeneration: 1,
        },
      },
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");
    expect(tokenPayload(route.actorToken)).toMatchObject({
      scope_profile: "actor_client_v1",
      tenant_context: {
        organization_id: "org-a",
        assistant_id: "asst-a",
      },
      pooled_worker_lease: { lease_generation: 1 },
    });
  });

  test("revokes transport authority when an active lease cannot renew", async () => {
    const harness = createHarness({});
    const route = await harness.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    harness.db
      .query(
        "UPDATE runtime_stacks SET last_health_status = '503' WHERE id = 'worker-1'",
      )
      .run();
    harness.setNow(21_000);
    await harness.timer.runWithDelay(20_000);

    expect(harness.events).toContain("revoke:org-a:g1");
    expect(
      harness.transport.authorizations.some(
        ({ operation }) => operation === "revoke",
      ),
    ).toBe(true);
  });

  test("exports and sanitizes before revoking and releasing an idle lease", async () => {
    const harness = createHarness({});
    const route = await harness.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    expect(
      await harness.coordinator.finishRequest({
        requestHandle: route.requestHandle,
        identity: identity("a"),
      }),
    ).toEqual({ status: "release_scheduled" });
    await harness.timer.runWithDelay(1_000);

    expect(harness.events).toEqual([
      "prepare:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);
    expect(
      harness.db
        .query<
          { assistant_id: string | null },
          [string]
        >("SELECT assistant_id FROM runtime_worker_leases WHERE runtime_stack_id = ?")
        .get("worker-1")?.assistant_id,
    ).toBeNull();
  });

  test("keeps production transport authorized across a restore longer than the original lease", async () => {
    let prepareStarted = false;
    let completePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      completePrepare = resolve;
    });
    const harness = createHarness({
      transportHooks: {
        prepare_empty: async () => {
          prepareStarted = true;
          await prepareGate;
        },
      },
    });
    const routePromise = harness.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    for (let tick = 0; tick < 8 && !prepareStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(prepareStarted).toBe(true);

    for (const now of [21_000, 41_000, 61_000, 81_000]) {
      harness.setNow(now);
      await harness.timer.runWithDelay(20_000);
    }
    completePrepare();
    expect(await routePromise).toMatchObject({
      mode: "pooled",
      binding: { leaseExpiresAtMs: 141_000 },
    });
  });

  test("renews before later production cleanup calls after a slow export", async () => {
    let exportStarted = false;
    let completeExport!: () => void;
    const exportGate = new Promise<void>((resolve) => {
      completeExport = resolve;
    });
    const harness = createHarness({
      transportHooks: {
        export: async () => {
          exportStarted = true;
          await exportGate;
        },
      },
    });
    const route = await harness.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");
    await harness.coordinator.finishRequest({
      requestHandle: route.requestHandle,
      identity: identity("a"),
    });

    const release = harness.timer.runWithDelay(1_000);
    for (let tick = 0; tick < 8 && !exportStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(exportStarted).toBe(true);
    for (const now of [21_000, 41_000, 61_000, 81_000]) {
      harness.setNow(now);
      await harness.timer.runWithDelay(20_000);
    }
    completeExport();
    await release;

    expect(
      harness.transport.authorizations.find(
        ({ operation }) => operation === "sanitize",
      )?.authorization.binding.leaseExpiresAtMs,
    ).toBe(141_000);
    expect(harness.events).toEqual([
      "prepare:org-a",
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);
  });

  test("quarantines restart leases until exact operator recovery completes", async () => {
    const db = setupDb();
    const first = createHarness({ db });
    const route = await first.coordinator.routeRequest({
      identity: identity("a"),
      dedicatedRoute: dedicatedRoute(),
    });
    expect(route.mode).toBe("pooled");
    if (route.mode !== "pooled") throw new Error("Expected pooled route.");

    const restarted = createHarness({
      db,
      leaseTokens: ["lease-after-recovery"],
      requestHandles: ["request-after-restart"],
    });
    expect(
      await restarted.coordinator.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toEqual({
      mode: "unavailable",
      reason: "restart_quarantined",
      retryAfterMs: null,
    });

    expect(
      await restarted.coordinator.recoverRestartQuarantine({
        binding: route.binding,
      }),
    ).toEqual({ status: "recovered" });
    expect(restarted.events).toEqual([
      "export:org-a",
      "sanitize:org-a",
      "revoke:org-a:g1",
    ]);
    expect(
      await restarted.coordinator.routeRequest({
        identity: identity("a"),
        dedicatedRoute: dedicatedRoute(),
      }),
    ).toMatchObject({
      mode: "pooled",
      requestHandle: "request-after-restart",
      binding: { leaseGeneration: 2 },
    });
  });
});
