import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Scope } from "../auth/types.js";
import { type HTTPRouteDefinition, HttpRouter } from "../http-router.js";
import {
  getProductionPooledRuntimeDrainFence,
  installPooledRuntimeQuiescenceProbe,
  type PooledRuntimeLeaseIdentity,
  resetPooledRuntimeDrainFenceForTesting,
} from "../pooled-runtime-drain-fence.js";

const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: "org-http-stream", assistantId: "assistant-http-stream" },
  workerStackId: "worker-http-stream",
  generation: 11,
};

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;

function authContext() {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway" as const,
    assistantId: "self",
    scopeProfile: "gateway_service_v1" as const,
    scopes: new Set<Scope>(["internal.write"]),
    policyEpoch: 1,
    serviceTenantContext: {
      version: 1 as const,
      organizationId: IDENTITY.tenant.orgId,
      assistantId: IDENTITY.tenant.assistantId,
      serviceId: "gateway" as const,
      requestId: "request-http-stream",
    },
    pooledWorkerLease: {
      version: 1 as const,
      organizationId: IDENTITY.tenant.orgId,
      userId: "user-http-stream",
      assistantId: IDENTITY.tenant.assistantId,
      workerStackId: IDENTITY.workerStackId,
      leaseGeneration: IDENTITY.generation,
      leaseExpiresAtSeconds: 4_000_000_000,
    },
  };
}

function routerWithHandler(
  handler: HTTPRouteDefinition["handler"],
): HttpRouter {
  const router = new HttpRouter();
  const internals = router as unknown as {
    compiledRoutes: Array<{
      def: HTTPRouteDefinition;
      regex: RegExp;
      paramNames: string[];
    }>;
  };
  internals.compiledRoutes = [
    {
      def: {
        endpoint: "test-stream",
        method: "GET",
        operationId: "test_stream",
        policy: null,
        handler,
      },
      regex: /^test-stream$/u,
      paramNames: [],
    },
  ];
  return router;
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

async function dispatch(router: HttpRouter): Promise<Response> {
  const response = await router.dispatch(
    "test-stream",
    new Request("http://assistant.local/v1/test-stream"),
    new URL("http://assistant.local/v1/test-stream"),
    {} as ReturnType<typeof Bun.serve>,
    authContext(),
  );
  if (!response) throw new Error("Expected the test route to match.");
  return response;
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

describe("pooled HTTP response drain lifetime", () => {
  test("keeps activity through headers and heartbeat, then releases at EOF", async () => {
    const fence = await activateProductionFence();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const router = routerWithHandler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(new TextEncoder().encode(" "));
            },
          }),
          { headers: { "x-test-stream": "heartbeat" } },
        ),
    );

    const response = await dispatch(router);
    expect(response.headers.get("x-test-stream")).toBe("heartbeat");
    expect(fence.snapshotForTesting().activeRequests).toBe(1);

    const reader = response.body!.getReader();
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(" ");
    expect(fence.snapshotForTesting().activeRequests).toBe(1);

    bodyController.close();
    expect((await reader.read()).done).toBe(true);
    expect(fence.snapshotForTesting().activeRequests).toBe(0);
  });

  test("releases activity when the response consumer cancels", async () => {
    const fence = await activateProductionFence();
    const router = routerWithHandler(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(" "));
            },
          }),
        ),
    );

    const response = await dispatch(router);
    expect(fence.snapshotForTesting().activeRequests).toBe(1);
    const reader = response.body!.getReader();
    await reader.read();
    expect(fence.snapshotForTesting().activeRequests).toBe(1);

    await reader.cancel("client disconnected");
    expect(fence.snapshotForTesting().activeRequests).toBe(0);
  });
});
