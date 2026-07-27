import { afterEach, describe, expect, test } from "bun:test";

import {
  resolvePooledModelProviderKey,
  runWithPooledModelKeyRequestContext,
} from "../../../security/pooled-model-key-context.js";
import type { AuthContext } from "../../auth/types.js";
import { createPooledMessageHeartbeatResponse } from "../http-adapter.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
const controlPlaneUrl = "http://control-plane.railway.internal:8080";

function enablePooledWorker(): void {
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function request(): Request {
  return new Request("http://worker.test/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worklin-pooled-model-key-capability": "private-capability",
    },
    body: "{}",
  });
}

function authContext(): AuthContext {
  return {
    subject: "actor:self:user-1",
    principalType: "actor",
    assistantId: "self",
    actorPrincipalId: "user-1",
    scopeProfile: "actor_client_v1",
    scopes: new Set(["chat.write"]),
    policyEpoch: 1,
    tenantContext: {
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "asst-1",
      actorId: "user-1",
      requestId: "request-1",
    },
    pooledWorkerLease: {
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "asst-1",
      workerStackId: "worker-1",
      leaseGeneration: 7,
      leaseExpiresAtSeconds: 2_000,
    },
  };
}

afterEach(() => {
  restoreEnv("WORKLIN_RUNTIME_MODE", originalRuntimeMode);
  restoreEnv("WORKLIN_RUNTIME_WORKER_STACK_ID", originalWorkerStackId);
});

describe("pooled model-key authority across heartbeat responses", () => {
  test("keeps a delayed lookup authorized while the heartbeat body is active", async () => {
    enablePooledWorker();
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const response = await runWithPooledModelKeyRequestContext(
      request(),
      authContext(),
      () =>
        createPooledMessageHeartbeatResponse({
          execute: async () => {
            await turnGate;
            const result = await resolvePooledModelProviderKey("openai", {
              fetch: async () => Response.json({ value: "sk-stream-bound" }),
              controlPlaneUrl,
            });
            return {
              accepted: result.handled && result.value === "sk-stream-bound",
            };
          },
          status: 202,
          heartbeatIntervalMs: 10,
          timeoutMs: 1_000,
        }),
    );

    releaseTurn();
    expect(JSON.parse((await response.text()).trim())).toEqual({
      accepted: true,
    });
  });

  test("withholds plaintext when a fetch settles after the body completes", async () => {
    enablePooledWorker();
    let finishFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      finishFetch = resolve;
    });
    let lookupStarted!: () => void;
    const lookupStartedPromise = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let lateLookup!: ReturnType<typeof resolvePooledModelProviderKey>;

    const response = await runWithPooledModelKeyRequestContext(
      request(),
      authContext(),
      () =>
        createPooledMessageHeartbeatResponse({
          execute: async () => {
            lateLookup = resolvePooledModelProviderKey("openai", {
              fetch: async () => {
                lookupStarted();
                return pendingFetch;
              },
              controlPlaneUrl,
            });
            return { accepted: true };
          },
          status: 202,
          timeoutMs: 1_000,
        }),
    );

    await lookupStartedPromise;
    expect(JSON.parse((await response.text()).trim())).toEqual({
      accepted: true,
    });
    finishFetch(Response.json({ value: "must-not-escape" }));
    expect(await lateLookup).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });

  test("withholds a delayed response body after the heartbeat is cancelled", async () => {
    enablePooledWorker();
    let releaseSecretBody!: () => void;
    const secretBodyGate = new Promise<void>((resolve) => {
      releaseSecretBody = resolve;
    });
    let responseBodyRead!: () => void;
    const responseBodyReadPromise = new Promise<void>((resolve) => {
      responseBodyRead = resolve;
    });
    let lookup!: ReturnType<typeof resolvePooledModelProviderKey>;

    const response = await runWithPooledModelKeyRequestContext(
      request(),
      authContext(),
      () =>
        createPooledMessageHeartbeatResponse({
          execute: async () => {
            lookup = resolvePooledModelProviderKey("openai", {
              fetch: async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    async pull(controller) {
                      responseBodyRead();
                      await secretBodyGate;
                      controller.enqueue(
                        new TextEncoder().encode(
                          JSON.stringify({ value: "must-not-escape" }),
                        ),
                      );
                      controller.close();
                    },
                  }),
                ),
              controlPlaneUrl,
            });
            await lookup;
            return { accepted: true };
          },
          status: 202,
          timeoutMs: 1_000,
        }),
    );

    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await responseBodyReadPromise;
    await reader.cancel("client disconnected");
    releaseSecretBody();
    expect(await lookup).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });
});
