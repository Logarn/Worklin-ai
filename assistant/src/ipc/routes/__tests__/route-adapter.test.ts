/**
 * Tests for `routeDefinitionsToIpcMethods`: filtering eligibility,
 * meta-route emission, and — critically — policy serialization.
 *
 * Policy serialization is what the gateway IPC proxy depends on to
 * enforce scope/principal checks without maintaining its own table
 * (ATL-315). If the daemon's resolution drifts from what the HTTP path
 * actually enforces, IPC and HTTP diverge silently.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  initAuthSigningKey,
  mintToken,
} from "../../../runtime/auth/token-service.js";
import type { RouteDefinition } from "../../../runtime/routes/types.js";
import { routeDefinitionsToIpcMethods } from "../route-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopHandler() {
  return {};
}

function defineRoute(overrides: Partial<RouteDefinition>): RouteDefinition {
  return {
    operationId: "test_route",
    endpoint: "test",
    method: "GET",
    handler: noopHandler,
    policy: null,
    ...overrides,
  };
}

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalPlatformAssistantId = process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
const originalPlatformOrganizationId = process.env.PLATFORM_ORGANIZATION_ID;

beforeAll(() => {
  initAuthSigningKey(Buffer.from("ipc-route-adapter-signing-key!!"));
});

afterEach(() => {
  if (originalRuntimeMode === undefined)
    delete process.env.WORKLIN_RUNTIME_MODE;
  else process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  if (originalPlatformAssistantId === undefined) {
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
  } else {
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = originalPlatformAssistantId;
  }
  if (originalPlatformOrganizationId === undefined) {
    delete process.env.PLATFORM_ORGANIZATION_ID;
  } else {
    process.env.PLATFORM_ORGANIZATION_ID = originalPlatformOrganizationId;
  }
});

function isolatedHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const tenantContext = {
    version: 1 as const,
    organization_id: "org-ipc",
    user_id: "user-ipc",
    assistant_id: "assistant-ipc",
    actor_id: "actor-ipc",
    request_id: "request-ipc",
  };
  const token = mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:actor-ipc",
    scope_profile: "actor_client_v1",
    policy_epoch: 1,
    ttlSeconds: 300,
    tenant_context: tenantContext,
  });
  return {
    authorization: `Bearer ${token}`,
    "x-worklin-tenant-context-version": "1",
    "x-worklin-org-id": tenantContext.organization_id,
    "x-worklin-user-id": tenantContext.user_id,
    "x-worklin-assistant-id": tenantContext.assistant_id,
    "x-worklin-actor-id": tenantContext.actor_id,
    "x-worklin-request-id": tenantContext.request_id,
    ...overrides,
  };
}

interface SchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
  policy: {
    requiredScopes: string[];
    allowedPrincipalTypes: string[];
  } | null;
}

async function getSchema(routes: RouteDefinition[]): Promise<SchemaEntry[]> {
  const ipcMethods = routeDefinitionsToIpcMethods(routes);
  const meta = ipcMethods.find((r) => r.operationId === "get_route_schema");
  expect(meta).toBeDefined();
  const result = await meta!.handler({});
  return result as SchemaEntry[];
}

// ---------------------------------------------------------------------------
// Eligibility filter
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — eligibility", () => {
  test("excludes routes that requireGuardian", () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "ok", endpoint: "ok" }),
      defineRoute({
        operationId: "guarded",
        endpoint: "guarded",
        requireGuardian: true,
      }),
    ];
    const result = routeDefinitionsToIpcMethods(routes);
    const ids = result
      .map((r) => r.operationId)
      .filter((id) => id !== "get_route_schema");
    expect(ids).toEqual(["ok"]);
  });

  test("excludes routes that are public", () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "ok", endpoint: "ok" }),
      defineRoute({
        operationId: "pub",
        endpoint: "pub",
        isPublic: true,
      }),
    ];
    const result = routeDefinitionsToIpcMethods(routes);
    const ids = result
      .map((r) => r.operationId)
      .filter((id) => id !== "get_route_schema");
    expect(ids).toEqual(["ok"]);
  });

  test("appends the get_route_schema meta-route", () => {
    const routes: RouteDefinition[] = [defineRoute({})];
    const result = routeDefinitionsToIpcMethods(routes);
    expect(
      result.find((r) => r.operationId === "get_route_schema"),
    ).toBeDefined();
  });
});

describe("routeDefinitionsToIpcMethods — isolated tenant authentication", () => {
  test("rejects an isolated IPC route without a daemon exchange token", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-ipc";
    const [route] = routeDefinitionsToIpcMethods([
      defineRoute({ operationId: "protected" }),
    ]);

    await expect(route.handler({ headers: {} })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
  });

  test("does not trust an AuthContext supplied inside IPC params", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-ipc";
    const [route] = routeDefinitionsToIpcMethods([
      defineRoute({ operationId: "protected" }),
    ]);

    await expect(
      route.handler({
        authContext: {
          subject: "svc:gateway:self",
          principalType: "svc_gateway",
          assistantId: "self",
          scopeProfile: "gateway_service_v1",
          scopes: new Set(["internal.write"]),
          policyEpoch: 1,
        },
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
  });

  test("validates the signed tenant context and exposes only normalized identity", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-ipc";
    process.env.PLATFORM_ORGANIZATION_ID = "org-ipc";
    let received: Parameters<RouteDefinition["handler"]>[0] | undefined;
    const [route] = routeDefinitionsToIpcMethods([
      defineRoute({
        operationId: "protected",
        handler: (args) => {
          received = args;
          return { ok: true };
        },
      }),
    ]);

    await route.handler({
      headers: isolatedHeaders({
        "X-Vellum-Actor-Principal-Id": "forged-actor",
        "x-vellum-platform-owner": "caller-value",
      }),
    });

    expect(received?.authContext?.assistantId).toBe("self");
    expect(received?.authContext?.tenantContext).toEqual({
      version: 1,
      organizationId: "org-ipc",
      userId: "user-ipc",
      assistantId: "assistant-ipc",
      actorId: "actor-ipc",
      requestId: "request-ipc",
    });
    expect(received?.headers?.authorization).toBeUndefined();
    expect(received?.headers?.["x-worklin-user-id"]).toBe("user-ipc");
    expect(received?.headers?.["x-vellum-actor-principal-id"]).toBe(
      "actor-ipc",
    );
    expect(received?.headers?.["x-vellum-platform-owner"]).toBe("true");
    expect(
      Object.keys(received?.headers ?? {}).filter(
        (key) => key.toLowerCase() === "x-worklin-user-id",
      ),
    ).toEqual(["x-worklin-user-id"]);
  });

  test("rejects a signed IPC token when canonical metadata is altered", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-ipc";
    const [route] = routeDefinitionsToIpcMethods([
      defineRoute({ operationId: "protected" }),
    ]);

    await expect(
      route.handler({
        headers: isolatedHeaders({ "x-worklin-request-id": "forged-request" }),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });

  test("preserves unauthenticated local IPC compatibility outside isolated mode", async () => {
    delete process.env.WORKLIN_RUNTIME_MODE;
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
    const [route] = routeDefinitionsToIpcMethods([
      defineRoute({
        operationId: "local",
        handler: (args) => args.headers,
      }),
    ]);

    await expect(
      route.handler({
        headers: { "x-vellum-actor-principal-id": "local-guardian" },
      }),
    ).resolves.toEqual({
      "x-vellum-actor-principal-id": "local-guardian",
      "x-vellum-principal-type": "local",
    });
  });

  test("enforces route principal and scope policy for direct local IPC", async () => {
    delete process.env.WORKLIN_RUNTIME_MODE;
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
    const [localRoute, gatewayRoute] = routeDefinitionsToIpcMethods([
      defineRoute({
        operationId: "local-write",
        policy: {
          requiredScopes: ["chat.write"],
          allowedPrincipalTypes: ["local"],
        },
        handler: () => ({ ok: true }),
      }),
      defineRoute({
        operationId: "gateway-only",
        policy: {
          requiredScopes: ["internal.write"],
          allowedPrincipalTypes: ["svc_gateway"],
        },
        handler: () => ({ ok: true }),
      }),
    ]);

    await expect(localRoute.handler({})).resolves.toEqual({ ok: true });
    await expect(gatewayRoute.handler({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// Schema serialization
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — schema shape", () => {
  test("schema entry has operationId / endpoint / method / policy fields", async () => {
    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "a", endpoint: "a", method: "POST" }),
    ];
    const schema = await getSchema(routes);
    expect(schema).toHaveLength(1);
    expect(schema[0]).toEqual({
      operationId: "a",
      endpoint: "a",
      method: "POST",
      policy: null,
    });
  });

  test("schema validates against the wire-shape Zod schema (gateway contract)", async () => {
    // The gateway's `route-schema-cache.ts` parses the schema with this
    // exact shape (Zod). If the daemon ever drifts (e.g. drops `policy`),
    // this test fails — preventing the silent fail-open class of bug
    // ATL-315 set out to fix.
    const entrySchema = z.object({
      operationId: z.string(),
      endpoint: z.string(),
      method: z.string(),
      policy: z
        .object({
          requiredScopes: z.array(z.string()),
          allowedPrincipalTypes: z.array(z.string()),
        })
        .nullable(),
    });

    const routes: RouteDefinition[] = [
      defineRoute({ operationId: "a", endpoint: "a/:id" }),
      defineRoute({ operationId: "b", endpoint: "b", method: "POST" }),
    ];
    const schema = await getSchema(routes);
    for (const entry of schema) {
      const parsed = entrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Policy resolution — the load-bearing piece
// ---------------------------------------------------------------------------

describe("routeDefinitionsToIpcMethods — policy serialization", () => {
  test("routes with policy: null ship policy: null", async () => {
    // Unprotected route (e.g. health endpoint) carries policy: null
    // and the adapter passes it through unchanged.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "z",
        endpoint: "unprotected_endpoint",
        policy: null,
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy).toBeNull();
  });

  test("routes with declared policy ship it verbatim", async () => {
    // The adapter is now a straight pass-through: whatever policy the
    // RouteDefinition declares, the wire schema reflects.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "m_get",
        endpoint: "messages",
        method: "GET",
        policy: {
          requiredScopes: ["chat.read"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
      defineRoute({
        operationId: "m_post",
        endpoint: "messages",
        method: "POST",
        policy: {
          requiredScopes: ["chat.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy?.requiredScopes).toEqual(["chat.read"]);
    expect(schema[1].policy?.requiredScopes).toEqual(["chat.write"]);
  });

  test("schema is a structural pass-through (no derivation, no lookup)", async () => {
    // Sibling routes with the same endpoint+different policy don't
    // collide — each route's own .policy is used verbatim, exactly
    // the property-on-entity guarantee ATL-315's followup buys us.
    const routes: RouteDefinition[] = [
      defineRoute({
        operationId: "plugins_install",
        endpoint: "plugins/:name",
        method: "POST",
        policy: {
          requiredScopes: ["settings.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
      defineRoute({
        operationId: "plugins_uninstall",
        endpoint: "plugins/:name",
        method: "DELETE",
        policy: {
          requiredScopes: ["settings.write"],
          allowedPrincipalTypes: [
            "actor",
            "svc_gateway",
            "svc_daemon",
            "local",
          ],
        },
      }),
    ];
    const schema = await getSchema(routes);
    expect(schema[0].policy?.requiredScopes).toEqual(["settings.write"]);
    expect(schema[1].policy?.requiredScopes).toEqual(["settings.write"]);
  });
});
