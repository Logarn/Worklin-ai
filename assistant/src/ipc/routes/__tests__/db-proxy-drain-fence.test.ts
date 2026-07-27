import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AuthContext, Scope } from "../../../runtime/auth/types.js";
import {
  getProductionPooledRuntimeDrainFence,
  installPooledRuntimeQuiescenceProbe,
  type PooledRuntimeLeaseIdentity,
  resetPooledRuntimeDrainFenceForTesting,
} from "../../../runtime/pooled-runtime-drain-fence.js";
import { runDatabaseProxyWithPooledRuntimeDrainFence } from "../db-proxy-drain-fence.js";

const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: "org-db-proxy", assistantId: "assistant-db-proxy" },
  workerStackId: "worker-db-proxy",
  generation: 7,
};

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;

function gatewayAuth(): AuthContext {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway",
    assistantId: "self",
    scopeProfile: "gateway_service_v1",
    scopes: new Set<Scope>(["internal.write"]),
    policyEpoch: 1,
    serviceTenantContext: {
      version: 1,
      organizationId: IDENTITY.tenant.orgId,
      assistantId: IDENTITY.tenant.assistantId,
      serviceId: "gateway",
      requestId: "request-db-proxy",
    },
    pooledWorkerLease: {
      version: 1,
      organizationId: IDENTITY.tenant.orgId,
      userId: "user-db-proxy",
      assistantId: IDENTITY.tenant.assistantId,
      workerStackId: IDENTITY.workerStackId,
      leaseGeneration: IDENTITY.generation,
      leaseExpiresAtSeconds: 4_000_000_000,
    },
  };
}

async function activateProductionFence() {
  installPooledRuntimeQuiescenceProbe({
    proveQuiescent: async () => ({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    }),
  });
  const fence = getProductionPooledRuntimeDrainFence();
  fence.beginAssignmentMutation(IDENTITY);
  await fence.proveAssignmentMutationQuiescent(IDENTITY);
  fence.activateAssignment(IDENTITY);
  return fence;
}

beforeEach(() => {
  resetPooledRuntimeDrainFenceForTesting();
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = IDENTITY.workerStackId;
});

afterEach(() => {
  resetPooledRuntimeDrainFenceForTesting();
  if (originalRuntimeMode === undefined) {
    delete process.env.WORKLIN_RUNTIME_MODE;
  } else {
    process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  }
  if (originalWorkerStackId === undefined) {
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
  } else {
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = originalWorkerStackId;
  }
});

describe("direct database IPC pooled-runtime drain fencing", () => {
  test("holds db_proxy activity through synchronous success and failure", async () => {
    const fence = await activateProductionFence();

    const result = runDatabaseProxyWithPooledRuntimeDrainFence(
      gatewayAuth(),
      "db_proxy",
      () => {
        expect(fence.snapshotForTesting().activeRequests).toBe(1);
        return "ok";
      },
    );
    expect(result).toBe("ok");
    expect(fence.snapshotForTesting().activeRequests).toBe(0);

    expect(() =>
      runDatabaseProxyWithPooledRuntimeDrainFence(
        gatewayAuth(),
        "db_proxy",
        () => {
          expect(fence.snapshotForTesting().activeRequests).toBe(1);
          throw new Error("query failed");
        },
      ),
    ).toThrow("query failed");
    expect(fence.snapshotForTesting().activeRequests).toBe(0);
  });

  test("holds db_proxy_transaction activity until asynchronous settlement", async () => {
    const fence = await activateProductionFence();
    let resolveTransaction!: (value: string) => void;
    const transaction = new Promise<string>((resolve) => {
      resolveTransaction = resolve;
    });

    const pending = runDatabaseProxyWithPooledRuntimeDrainFence(
      gatewayAuth(),
      "db_proxy_transaction",
      () => transaction,
    );
    expect(fence.snapshotForTesting().activeRequests).toBe(1);
    resolveTransaction("committed");
    await expect(pending).resolves.toBe("committed");
    expect(fence.snapshotForTesting().activeRequests).toBe(0);

    const rejected = runDatabaseProxyWithPooledRuntimeDrainFence(
      gatewayAuth(),
      "db_proxy_transaction",
      () => Promise.reject(new Error("transaction failed")),
    );
    expect(fence.snapshotForTesting().activeRequests).toBe(1);
    await expect(rejected).rejects.toThrow("transaction failed");
    expect(fence.snapshotForTesting().activeRequests).toBe(0);
  });

  test("rejects direct database work after drain begins", async () => {
    const fence = await activateProductionFence();
    fence.beginDrain(IDENTITY);
    let called = false;

    expect(() =>
      runDatabaseProxyWithPooledRuntimeDrainFence(
        gatewayAuth(),
        "db_proxy",
        () => {
          called = true;
        },
      ),
    ).toThrow("quarantined or draining");
    expect(called).toBe(false);
    expect(fence.snapshotForTesting().activeRequests).toBe(0);
  });

  test("is a no-op for isolated runtimes", () => {
    resetPooledRuntimeDrainFenceForTesting();
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
    let called = false;

    const result = runDatabaseProxyWithPooledRuntimeDrainFence(
      undefined,
      "db_proxy_transaction",
      () => {
        called = true;
        return "isolated-result";
      },
    );

    expect(result).toBe("isolated-result");
    expect(called).toBe(true);
  });
});
