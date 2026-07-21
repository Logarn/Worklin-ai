import { afterEach, describe, expect, test } from "bun:test";

import {
  resolvePooledModelProviderKey,
  runWithPooledModelKeyRequestContext,
} from "../../../security/pooled-model-key-context.js";
import type { AuthContext } from "../../auth/types.js";
import {
  createPooledMessageHeartbeatResponse,
  routeDefinitionsToHTTPRoutes,
} from "../http-adapter.js";
import type { RouteDefinition } from "../types.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
const encoder = new TextEncoder();

afterEach(() => {
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

const authContext = {
  subject: "actor:self:user-1",
  principalType: "actor",
  assistantId: "self",
  scopeProfile: "actor_client_v1",
  scopes: new Set(["chat.write"]),
  policyEpoch: 1,
} as AuthContext;

function pooledAuthContext(): AuthContext {
  const leaseExpiresAtSeconds = Math.floor(Date.now() / 1_000) + 60;
  return {
    ...authContext,
    subject: "actor:asst-1:user-1",
    assistantId: "asst-1",
    actorPrincipalId: "user-1",
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
      leaseGeneration: 4,
      leaseExpiresAtSeconds,
    },
  };
}

function messagesRoute(handler: RouteDefinition["handler"]): RouteDefinition {
  return {
    operationId: "messages_post",
    endpoint: "messages",
    method: "POST",
    policy: null,
    responseStatus: "202",
    handler,
  };
}

function routeContext(req: Request) {
  return {
    req,
    url: new URL(req.url),
    params: {},
    authContext,
    server: {} as ReturnType<typeof Bun.serve>,
  };
}

describe("pooled message heartbeat response", () => {
  test("writes whitespace heartbeats and one final valid JSON object", async () => {
    let finish!: (value: unknown) => void;
    const execution = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const response = createPooledMessageHeartbeatResponse({
      execute: async () => execution,
      status: 202,
      headers: {
        "content-length": "2",
        "content-encoding": "gzip",
        etag: '"buffered"',
      },
      heartbeatIntervalMs: 5,
      timeoutMs: 1_000,
    });
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    const reader = response.body!.getReader();

    const initial = await reader.read();
    expect(initial.done).toBe(false);
    expect(new TextDecoder().decode(initial.value)).toMatch(/^ +$/);

    const heartbeat = await reader.read();
    expect(heartbeat.done).toBe(false);
    expect(new TextDecoder().decode(heartbeat.value)).toMatch(/^ +$/);

    finish({
      accepted: true,
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    let remainder = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      remainder += new TextDecoder().decode(part.value);
    }
    expect(JSON.parse(remainder.trim())).toEqual({
      accepted: true,
      messageId: "msg-1",
      conversationId: "conv-1",
    });
  });

  test("aborts execution and closes with a bounded timeout envelope", async () => {
    let executionSignal: AbortSignal | undefined;
    const response = createPooledMessageHeartbeatResponse({
      execute: async (signal) => {
        executionSignal = signal;
        return new Promise<never>(() => {});
      },
      status: 202,
      heartbeatIntervalMs: 5,
      timeoutMs: 15,
    });

    const payload = JSON.parse((await response.text()).trim()) as {
      accepted: boolean;
      status: number;
      error: { code: string };
    };
    expect(payload).toMatchObject({
      accepted: false,
      status: 504,
      error: { code: "POOLED_TURN_TIMEOUT" },
    });
    expect(executionSignal?.aborted).toBe(true);
  });

  test("cancelling the streamed body aborts execution and clears the request", async () => {
    let executionSignal: AbortSignal | undefined;
    const response = createPooledMessageHeartbeatResponse({
      execute: async (signal) => {
        executionSignal = signal;
        return new Promise<never>(() => {});
      },
      status: 202,
      timeoutMs: 1_000,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("downstream closed");

    expect(executionSignal?.aborted).toBe(true);
  });

  test("request disconnect aborts execution and clears heartbeat timers", async () => {
    const requestAbort = new AbortController();
    let executionSignal: AbortSignal | undefined;
    const response = createPooledMessageHeartbeatResponse({
      execute: async (signal) => {
        executionSignal = signal;
        return new Promise<never>(() => {});
      },
      requestSignal: requestAbort.signal,
      status: 202,
      heartbeatIntervalMs: 5,
      timeoutMs: 1_000,
    });
    const reader = response.body!.getReader();
    await reader.read();
    requestAbort.abort("browser disconnected");

    let remainder = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      remainder += new TextDecoder().decode(part.value);
    }
    expect(executionSignal?.aborted).toBe(true);
    expect(JSON.parse(remainder.trim())).toMatchObject({
      accepted: false,
      status: 499,
      error: { code: "REQUEST_ABORTED" },
    });
  });
});

describe("HTTP route adapter pooled message contract", () => {
  test("returns pooled message headers before the handler settles", async () => {
    let finish!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const [route] = routeDefinitionsToHTTPRoutes(
      [
        messagesRoute(async () => {
          await handlerFinished;
          return { accepted: true, conversationId: "conv-1" };
        }),
      ],
      { isPooledRuntime: () => true },
    );

    const response = await route!.handler(
      routeContext(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoder.encode("{}"),
        }),
      ),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/^ +$/);

    finish();
    let final = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      final += new TextDecoder().decode(part.value);
    }
    expect(JSON.parse(final.trim())).toEqual({
      accepted: true,
      conversationId: "conv-1",
    });
  });

  test("preserves the dedicated buffered response behavior", async () => {
    let finish!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let responseSettled = false;
    const [route] = routeDefinitionsToHTTPRoutes(
      [
        messagesRoute(async () => {
          await handlerFinished;
          return { accepted: true };
        }),
      ],
      { isPooledRuntime: () => false },
    );

    const responsePromise = Promise.resolve(
      route!.handler(
        routeContext(
          new Request("http://localhost/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        ),
      ),
    ).then((response) => {
      responseSettled = true;
      return response;
    });
    await Promise.resolve();
    expect(responseSettled).toBe(false);

    finish();
    const response = await responsePromise;
    expect(await response.json()).toEqual({ accepted: true });
  });

  test("keeps pooled BYOK authority through delayed work until stream completion", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted!: () => void;
    const lookupStartedPromise = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const [route] = routeDefinitionsToHTTPRoutes(
      [
        messagesRoute(async () => {
          lookupStarted();
          await lookupGate;
          const lookup = await resolvePooledModelProviderKey("openai", {
            fetch: async () => Response.json({ value: "sk-request-bound" }),
            controlPlaneUrl: "http://control-plane.railway.internal:8080",
          });
          return {
            accepted: true,
            providerKeyResolved:
              lookup.handled && lookup.value === "sk-request-bound",
          };
        }),
      ],
      { isPooledRuntime: () => true },
    );
    const context = pooledAuthContext();
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worklin-pooled-model-key-capability": "private-capability",
      },
      body: "{}",
    });

    const response = await runWithPooledModelKeyRequestContext(
      request,
      context,
      (sanitized) =>
        route!.handler({
          ...routeContext(sanitized),
          authContext: context,
        }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(
      /^ +$/,
    );
    await lookupStartedPromise;
    releaseLookup();

    let final = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      final += new TextDecoder().decode(part.value);
    }
    expect(JSON.parse(final.trim())).toMatchObject({
      accepted: true,
      providerKeyResolved: true,
    });

    const afterCompletion = await resolvePooledModelProviderKey("openai", {
      fetch: async () => Response.json({ value: "must-not-escape" }),
      controlPlaneUrl: "http://control-plane.railway.internal:8080",
    });
    expect(afterCompletion).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });
});
