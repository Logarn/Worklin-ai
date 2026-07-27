import { Socket } from "node:net";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  initAuthSigningKey,
  mintToken,
} from "../../runtime/auth/token-service.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";
import { AssistantIpcServer } from "../assistant-server.js";

delete process.env.ASSISTANT_IPC_SOCKET_DIR;

let longRequestStarted = false;
let longRequestAborted = false;
const LONG_ROUTE: RouteDefinition = {
  operationId: "tenant_long_request",
  endpoint: "/tenant-long-request",
  method: "POST" as const,
  policy: {
    requiredScopes: ["chat.write" as const],
    allowedPrincipalTypes: ["actor" as const, "local" as const],
  },
  handler: (args) =>
    new Promise((resolve) => {
      longRequestStarted = true;
      args.abortSignal?.addEventListener(
        "abort",
        () => {
          longRequestAborted = true;
          resolve({ aborted: true });
        },
        { once: true },
      );
    }),
};

type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
  statusCode?: number;
  errorCode?: string;
};

let server: InstanceType<typeof AssistantIpcServer> | null = null;
const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalAssistantId = process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
const originalOrganizationId = process.env.PLATFORM_ORGANIZATION_ID;

beforeAll(() => {
  initAuthSigningKey(Buffer.from("ipc-tenant-auth-test-signing-key!"));
});

beforeEach(async () => {
  process.env.WORKLIN_RUNTIME_MODE = "isolated";
  process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-ipc";
  process.env.PLATFORM_ORGANIZATION_ID = "org-ipc";
  longRequestStarted = false;
  longRequestAborted = false;
  server = new AssistantIpcServer({
    watchdogIntervalMs: 0,
    routes: [LONG_ROUTE],
  });
  await server.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

afterEach(() => {
  server?.stop();
  server = null;
  if (originalRuntimeMode === undefined)
    delete process.env.WORKLIN_RUNTIME_MODE;
  else process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  if (originalAssistantId === undefined) {
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
  } else {
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = originalAssistantId;
  }
  if (originalOrganizationId === undefined) {
    delete process.env.PLATFORM_ORGANIZATION_ID;
  } else {
    process.env.PLATFORM_ORGANIZATION_ID = originalOrganizationId;
  }
});

function actorHeaders(actorId: string): Record<string, string> {
  const context = {
    version: 1 as const,
    organization_id: "org-ipc",
    user_id: `user-${actorId}`,
    assistant_id: "assistant-ipc",
    actor_id: actorId,
    request_id: crypto.randomUUID(),
  };
  const token = mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${actorId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: 1,
    ttlSeconds: 300,
    tenant_context: context,
  });
  return {
    authorization: `Bearer ${token}`,
    "x-worklin-tenant-context-version": "1",
    "x-worklin-org-id": context.organization_id,
    "x-worklin-user-id": context.user_id,
    "x-worklin-assistant-id": context.assistant_id,
    "x-worklin-actor-id": context.actor_id,
    "x-worklin-request-id": context.request_id,
  };
}

function gatewayServiceHeaders(): Record<string, string> {
  const token = mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: 1,
    ttlSeconds: 300,
    service_tenant_context: {
      version: 1,
      organization_id: "org-ipc",
      assistant_id: "assistant-ipc",
      service_id: "gateway",
      request_id: crypto.randomUUID(),
    },
  });
  return { authorization: `Bearer ${token}` };
}

function openRequest(request: Record<string, unknown>): {
  socket: Socket;
  response: Promise<IpcResponse>;
} {
  const socket = new Socket();
  const response = new Promise<IpcResponse>((resolve, reject) => {
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      resolve(JSON.parse(buffer.slice(0, newline)) as IpcResponse);
    });
    socket.connect(server!.getSocketPath(), () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
  return { socket, response };
}

async function call(request: Record<string, unknown>): Promise<IpcResponse> {
  const pending = openRequest(request);
  try {
    return await pending.response;
  } finally {
    pending.socket.destroy();
  }
}

describe("isolated IPC meta-method tenant authentication", () => {
  test("rejects direct database and cancellation calls without auth", async () => {
    const database = await call({
      id: "db-unauthenticated",
      method: "db_proxy",
      params: {},
    });
    expect(database).toMatchObject({
      statusCode: 401,
      errorCode: "UNAUTHORIZED",
    });

    const transaction = await call({
      id: "db-transaction-unauthenticated",
      method: "db_proxy_transaction",
      params: { steps: [] },
    });
    expect(transaction).toMatchObject({
      statusCode: 401,
      errorCode: "UNAUTHORIZED",
    });

    const cancellation = await call({
      id: "cancel-unauthenticated",
      method: "$cancel",
      params: { targetId: "any-request" },
    });
    expect(cancellation).toMatchObject({
      statusCode: 401,
      errorCode: "UNAUTHORIZED",
    });
  });

  test("rejects forged in-band AuthContext and actor access to the database proxy", async () => {
    const forged = await call({
      id: "db-forged-context",
      method: "db_proxy",
      params: {
        sql: "SELECT 1",
        mode: "query",
        authContext: {
          principalType: "svc_gateway",
          scopes: ["internal.write"],
        },
      },
    });
    expect(forged).toMatchObject({
      statusCode: 401,
      errorCode: "UNAUTHORIZED",
    });

    const actor = await call({
      id: "db-actor",
      method: "db_proxy",
      params: {
        sql: "SELECT 1",
        mode: "query",
        headers: actorHeaders("actor-a"),
      },
    });
    expect(actor).toMatchObject({
      statusCode: 403,
      errorCode: "FORBIDDEN",
    });

    const actorTransaction = await call({
      id: "db-transaction-actor",
      method: "db_proxy_transaction",
      params: {
        steps: [{ sql: "SELECT 1" }],
        headers: actorHeaders("actor-a"),
      },
    });
    expect(actorTransaction).toMatchObject({
      statusCode: 403,
      errorCode: "FORBIDDEN",
    });
  });

  test("allows only the bound gateway internal principal to use the database proxy", async () => {
    const response = await call({
      id: "db-gateway",
      method: "db_proxy",
      params: {
        sql: "SELECT 1 AS value",
        mode: "query",
        headers: gatewayServiceHeaders(),
      },
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ rows: [{ value: 1 }] });
  });

  test("enforces the shared route policy after authenticating direct IPC", async () => {
    const response = await call({
      id: "route-wrong-principal",
      method: "tenant_long_request",
      params: { headers: gatewayServiceHeaders() },
    });
    expect(response).toMatchObject({
      statusCode: 403,
      errorCode: "FORBIDDEN",
    });
    expect(longRequestStarted).toBe(false);
  });

  test("does not let one tenant principal cancel another principal's request", async () => {
    const longRequest = openRequest({
      id: "long-request",
      method: "tenant_long_request",
      params: { headers: actorHeaders("actor-a") },
    });
    for (let attempt = 0; attempt < 20 && !longRequestStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(longRequestStarted).toBe(true);

    const duplicate = await call({
      id: "long-request",
      method: "tenant_long_request",
      params: { headers: actorHeaders("actor-b") },
    });
    expect(duplicate).toMatchObject({
      statusCode: 409,
      errorCode: "CONFLICT",
    });
    expect(longRequestAborted).toBe(false);

    const denied = await call({
      id: "cancel-wrong-actor",
      method: "$cancel",
      params: {
        targetId: "long-request",
        headers: actorHeaders("actor-b"),
      },
    });
    expect(denied).toMatchObject({
      statusCode: 403,
      errorCode: "FORBIDDEN",
    });
    expect(longRequestAborted).toBe(false);

    const accepted = await call({
      id: "cancel-owner",
      method: "$cancel",
      params: {
        targetId: "long-request",
        headers: actorHeaders("actor-a"),
      },
    });
    expect(accepted.result).toBeNull();
    await longRequest.response;
    longRequest.socket.destroy();
    expect(longRequestAborted).toBe(true);
  });
});
