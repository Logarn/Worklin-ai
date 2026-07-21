import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config.js";
import {
  initSigningKey,
  mintToken,
  verifyToken,
} from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid edge JWT (aud=vellum-gateway) for test requests. */
function mintEdgeToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "actor:test-assistant:test-user",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintEdgeToken();
const PLATFORM_TENANT_CONTEXT = {
  version: 1 as const,
  organization_id: "org-test",
  user_id: "test-user",
  assistant_id: "test-assistant",
  actor_id: "vellum-principal-test-user",
  request_id: "request-test",
};
const PLATFORM_TOKEN = mintToken({
  aud: "vellum-gateway",
  sub: "actor:test-assistant:vellum-principal-test-user",
  scope_profile: "actor_client_v1",
  policy_epoch: CURRENT_POLICY_EPOCH,
  ttlSeconds: 300,
  tenant_context: PLATFORM_TENANT_CONTEXT,
});

function platformHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${PLATFORM_TOKEN}`,
    "x-worklin-tenant-context-version": "1",
    "x-worklin-org-id": PLATFORM_TENANT_CONTEXT.organization_id,
    "x-worklin-user-id": PLATFORM_TENANT_CONTEXT.user_id,
    "x-worklin-assistant-id": PLATFORM_TENANT_CONTEXT.assistant_id,
    "x-worklin-actor-id": PLATFORM_TENANT_CONTEXT.actor_id,
    "x-worklin-request-id": PLATFORM_TENANT_CONTEXT.request_id,
  };
}
function mintPooledServiceToken(input: {
  organizationId: string;
  userId: string;
  assistantId: string;
  generation: number;
  requestId: string;
}): string {
  const now = Math.floor(Date.now() / 1_000);
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 30,
    jti: input.requestId,
    service_tenant_context: {
      version: 1,
      organization_id: input.organizationId,
      assistant_id: input.assistantId,
      service_id: "gateway",
      request_id: input.requestId,
    },
    pooled_worker_lease: {
      version: 1,
      issuer_service_id: "runtime_dispatcher",
      organization_id: input.organizationId,
      user_id: input.userId,
      assistant_id: input.assistantId,
      worker_stack_id: "worker-1",
      lease_generation: input.generation,
      lease_expires_at: now + 45,
    },
  });
}
const originalGatewaySecurityDir = process.env.GATEWAY_SECURITY_DIR;
const claimDirectories: string[] = [];

function useClaimDirectory(): void {
  const directory = mkdtempSync(join(tmpdir(), "worklin-proxy-claim-"));
  claimDirectories.push(directory);
  process.env.GATEWAY_SECURITY_DIR = directory;
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
  if (originalGatewaySecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = originalGatewaySecurityDir;
  }
  for (const directory of claimDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function mockUpstream() {
  fetchMock = mock(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("runtime proxy auth enforcement", () => {
  test("auth required: rejects missing token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("auth required: rejects invalid token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer wrong-token" },
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("auth required: accepts valid token and proxies", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("pooled worker service request preserves its lease through exchange", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers;
        return Response.json({ ok: true });
      },
    );
    const now = Math.floor(Date.now() / 1_000);
    const authorityDirectory = realpathSync(
      mkdtempSync(join(tmpdir(), "worklin-lease-authority-")),
    );
    claimDirectories.push(authorityDirectory);
    const authorityFile = join(authorityDirectory, "active-lease.json");
    const edgeToken = mintToken({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 30,
      jti: "pooled-request-1",
      service_tenant_context: {
        version: 1,
        organization_id: "org-test",
        assistant_id: "test-assistant",
        service_id: "gateway",
        request_id: "pooled-request-1",
      },
      pooled_worker_lease: {
        version: 1,
        issuer_service_id: "runtime_dispatcher",
        organization_id: "org-test",
        user_id: "test-user",
        assistant_id: "test-assistant",
        worker_stack_id: "worker-1",
        lease_generation: 7,
        lease_expires_at: now + 45,
      },
    });
    const handler = createRuntimeProxyHandler(
      makeConfig({
        runtimeAssistantScopeMode: "enforce",
        runtimeWorkerLeaseAuthorityFile: authorityFile,
        runtimeWorkerStackId: "worker-1",
      }),
    );

    const response = await handler(
      new Request(
        "http://localhost:7830/v1/internal/pooled-worker/state/export",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${edgeToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(authorityFile, "utf8"))).toMatchObject({
      version: 1,
      worker_stack_id: "worker-1",
      authority_generation: 7,
      active_lease: {
        organization_id: "org-test",
        user_id: "test-user",
        assistant_id: "test-assistant",
        lease_generation: 7,
      },
    });
    const upstreamAuthorization = capturedHeaders?.get("authorization");
    expect(upstreamAuthorization).toStartWith("Bearer ");
    const verified = verifyToken(
      upstreamAuthorization!.slice("Bearer ".length),
      "vellum-daemon",
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.pooled_worker_lease).toMatchObject({
        organization_id: "org-test",
        user_id: "test-user",
        assistant_id: "test-assistant",
        worker_stack_id: "worker-1",
        lease_generation: 7,
      });
    }
  });

  test("exact secret resolution rejects cross-tenant and stale lease generations", async () => {
    mockUpstream();
    const authorityDirectory = realpathSync(
      mkdtempSync(join(tmpdir(), "worklin-secret-lease-authority-")),
    );
    claimDirectories.push(authorityDirectory);
    const authorityFile = join(authorityDirectory, "active-lease.json");
    const handler = createRuntimeProxyHandler(
      makeConfig({
        runtimeAssistantScopeMode: "enforce",
        runtimeWorkerLeaseAuthorityFile: authorityFile,
        runtimeWorkerStackId: "worker-1",
      }),
    );
    const submitSecret = (
      token: string,
      assistantId: string,
      requestId: string,
    ) =>
      handler(
        new Request(
          `http://localhost:7830/v1/assistants/${assistantId}/secret`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId,
              value: "test-only",
              delivery: "transient_send",
            }),
          },
        ),
      );

    const tenantA7 = mintPooledServiceToken({
      organizationId: "org-a",
      userId: "user-a",
      assistantId: "asst-a",
      generation: 7,
      requestId: "secret-a-7",
    });
    expect((await submitSecret(tenantA7, "asst-a", "prompt-a")).status).toBe(
      200,
    );

    // The same generation can never be rebound to another tenant.
    const tenantB7 = mintPooledServiceToken({
      organizationId: "org-b",
      userId: "user-b",
      assistantId: "asst-b",
      generation: 7,
      requestId: "secret-b-7",
    });
    expect((await submitSecret(tenantB7, "asst-b", "prompt-b")).status).toBe(
      503,
    );

    const tenantB8 = mintPooledServiceToken({
      organizationId: "org-b",
      userId: "user-b",
      assistantId: "asst-b",
      generation: 8,
      requestId: "secret-b-8",
    });
    expect((await submitSecret(tenantB8, "asst-b", "prompt-b")).status).toBe(
      200,
    );

    // After reassignment, the old tenant's exact resolver never reaches the
    // worker even if its signed token has not reached wall-clock expiry.
    expect((await submitSecret(tenantA7, "asst-a", "prompt-a")).status).toBe(
      403,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("auth required: replaces client edge token with exchange token for upstream", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await handler(req);

    const upstreamAuth = capturedHeaders!.get("authorization");
    expect(upstreamAuth).toBeTruthy();
    // The upstream should receive an exchange token (aud=vellum-daemon),
    // NOT the original edge token.
    expect(upstreamAuth).toStartWith("Bearer ");
    expect(upstreamAuth).not.toBe(`Bearer ${TOKEN}`);
  });

  test("isolated runtime binds a tenant-scoped platform actor to the default owner namespace", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return Response.json({ ok: true });
      },
    );

    const handler = createRuntimeProxyHandler(
      makeConfig({
        runtimeAssistantScopeMode: "enforce",
        platformAssistantId: "test-assistant",
      }),
    );
    const res = await handler(
      new Request("http://localhost:7830/v1/health", {
        headers: platformHeaders(),
      }),
    );

    expect(res.status).toBe(200);
    const exchangeToken = capturedHeaders!
      .get("authorization")!
      .replace(/^Bearer /, "");
    const verified = verifyToken(exchangeToken, "vellum-daemon");
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe("actor:self:vellum-principal-test-user");
      expect(verified.claims.tenant_context).toEqual(PLATFORM_TENANT_CONTEXT);
    }
    expect(capturedHeaders!.get("x-worklin-org-id")).toBe("org-test");
    expect(capturedHeaders!.get("x-worklin-user-id")).toBe("test-user");
    expect(capturedHeaders!.get("x-worklin-assistant-id")).toBe(
      "test-assistant",
    );
    expect(capturedHeaders!.get("x-worklin-actor-id")).toBe(
      "vellum-principal-test-user",
    );
    expect(capturedHeaders!.get("x-worklin-request-id")).toBe("request-test");
  });

  test("isolated runtime rejects a platform token without tenant context", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(
      makeConfig({
        runtimeAssistantScopeMode: "enforce",
        platformAssistantId: "test-assistant",
      }),
    );

    const res = await handler(
      new Request("http://localhost:7830/v1/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("isolated runtime rejects an actor token scoped to another assistant", async () => {
    mockUpstream();
    const otherAssistantToken = mintToken({
      aud: "vellum-gateway",
      sub: "actor:other-assistant:test-user",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
    const handler = createRuntimeProxyHandler(
      makeConfig({
        runtimeAssistantScopeMode: "enforce",
        platformAssistantId: "test-assistant",
      }),
    );

    const res = await handler(
      new Request("http://localhost:7830/v1/health", {
        headers: { authorization: `Bearer ${otherAssistantToken}` },
      }),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("claim-once runtime locks to the first signed assistant", async () => {
    useClaimDirectory();
    mockUpstream();
    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeAssistantScopeMode: "claim_once" }),
    );

    const first = await handler(
      new Request("http://localhost:7830/v1/health", {
        headers: platformHeaders(),
      }),
    );
    expect(first.status).toBe(200);

    const otherAssistantToken = mintToken({
      aud: "vellum-gateway",
      sub: "actor:other-assistant:test-user",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
    const second = await handler(
      new Request("http://localhost:7830/v1/health", {
        headers: { authorization: `Bearer ${otherAssistantToken}` },
      }),
    );

    expect(second.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("assistant-scoped URL binds a legacy platform actor when stack enforcement is off", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return Response.json({ ok: true });
      },
    );
    const handler = createRuntimeProxyHandler(makeConfig());

    const res = await handler(
      new Request("http://localhost:7830/v1/assistants/test-assistant/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders!.get("x-vellum-platform-owner")).toBe("true");
    const exchangeToken = capturedHeaders!
      .get("authorization")!
      .replace(/^Bearer /, "");
    const verified = verifyToken(exchangeToken, "vellum-daemon");
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe("actor:self:vellum-principal-test-user");
    }
  });

  test("assistant-scoped URL rejects a token for another assistant", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());

    const res = await handler(
      new Request(
        "http://localhost:7830/v1/assistants/other-assistant/health",
        { headers: { authorization: `Bearer ${TOKEN}` } },
      ),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("auth not required: proxies without token", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  test("OPTIONS request bypasses auth", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      method: "OPTIONS",
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
  });
});
