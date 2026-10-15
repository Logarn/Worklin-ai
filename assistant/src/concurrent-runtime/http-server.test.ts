import { describe, expect, test } from "bun:test";

import type {
  RuntimeTenantContextClaim,
  TenantExecutionContext,
} from "@vellumai/service-contracts/tenant-context";

import type { Scope } from "../runtime/auth/types.js";
import { APP_VERSION } from "../version.js";
import type {
  ConcurrentAuthenticatedTenant,
  ConcurrentAuthenticationResult,
} from "./auth.js";
import { BrowserBrokerService } from "./browser-broker/service.js";
import { createConcurrentRuntimeHttpHandler } from "./http-server.js";
import { InMemoryConcurrentRuntimeStore } from "./in-memory-store.js";
import { ConcurrentRuntimeService } from "./service.js";
import type {
  ConcurrentTurnCallbacks,
  ConcurrentTurnExecutor,
} from "./turn-executor.js";
import type { ConcurrentMessage } from "./types.js";

class EchoExecutor implements ConcurrentTurnExecutor {
  onboardingContext: unknown = null;

  async execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    onboardingContext?: unknown;
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<string> {
    this.onboardingContext = input.onboardingContext;
    const content = `reply:${input.messages.at(-1)?.content ?? ""}`;
    await input.callbacks.onTextDelta(content);
    return content;
  }
}

function authenticatedTenant(
  assistantId = "assistant-123",
): ConcurrentAuthenticatedTenant {
  const claim: RuntimeTenantContextClaim = {
    version: 1,
    organization_id: "org-abc",
    user_id: "user-123",
    assistant_id: assistantId,
    actor_id: "actor-123",
    request_id: "request-123",
  };
  return { claim, authorizationVersion: 1 };
}

function providerRequestHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-worklin-concurrent-model-provider": "openai",
    "x-worklin-concurrent-model-key-capability": "test-capability",
  };
}

function createHarness() {
  const store = new InMemoryConcurrentRuntimeStore();
  const executor = new EchoExecutor();
  const service = new ConcurrentRuntimeService({
    store,
    executor,
    maxConcurrentTurns: 4,
    maxConcurrentTurnsPerTenant: 2,
    leaseDurationMs: 30_000,
  });
  const tenant = authenticatedTenant();
  const authenticate = (
    _request: Request,
    _scope: Scope,
  ): ConcurrentAuthenticationResult => ({ ok: true, tenant });
  const handler = createConcurrentRuntimeHttpHandler({
    store,
    service,
    authenticate,
    resolveModelKey: async (capability, provider) =>
      capability === "test-capability" && provider === "openai"
        ? "test-provider-key"
        : null,
  });
  return { handler, service, store, tenant, executor };
}

describe("concurrent runtime HTTP handler", () => {
  test("accepts a bounded message and exposes its durable transcript", async () => {
    const { handler, service, executor } = createHarness();
    await service.initialize();

    const accepted = await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: providerRequestHeaders(),
        body: JSON.stringify({
          conversationId: "conversation-123",
          content: "hello",
          clientMessageId: "message-123",
          sourceChannel: "vellum",
          interface: "vellum",
          onboarding: {
            tools: ["Gmail"],
            tasks: ["writing"],
            tone: "warm",
            brandName: "ChickMagnet",
            websiteUrl: "https://chickmagnet.xyz",
          },
        }),
      }),
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      conversationId: "conversation-123",
    });

    await service.onIdle();
    expect(executor.onboardingContext).toEqual({
      tools: ["Gmail"],
      tasks: ["writing"],
      tone: "warm",
      brandName: "ChickMagnet",
      websiteUrl: "https://chickmagnet.xyz",
    });
    const transcript = await handler(
      new Request(
        "http://runtime.test/v1/messages?conversationId=conversation-123",
      ),
    );
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      conversationId: "conversation-123",
      isProcessing: false,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply:hello" },
      ],
    });

    const listResponse = await handler(
      new Request("http://runtime.test/v1/conversations?limit=50&offset=0"),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      conversations: [
        {
          id: "conversation-123",
          title: "hello",
          conversationType: "standard",
          source: "vellum",
          isProcessing: false,
        },
      ],
      nextOffset: 1,
      hasMore: false,
    });

    const detailResponse = await handler(
      new Request("http://runtime.test/v1/conversations/conversation-123"),
    );
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      conversation: {
        id: "conversation-123",
        title: "hello",
        isProcessing: false,
      },
    });

    const secondTurn = await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: providerRequestHeaders(),
        body: JSON.stringify({
          conversationId: "conversation-123",
          content: "follow-up",
          clientMessageId: "message-124",
        }),
      }),
    );
    expect(secondTurn.status).toBe(202);
    await service.onIdle();
    expect(executor.onboardingContext).toBeUndefined();
  });

  test("exposes read-only web bootstrap compatibility routes", async () => {
    const { handler, service } = createHarness();
    await service.initialize();

    const identity = await handler(
      new Request("http://runtime.test/v1/identity"),
    );
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({
      name: "Worklin",
      version: APP_VERSION,
    });

    const health = await handler(new Request("http://runtime.test/v1/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      version: APP_VERSION,
      capabilities: { memoryOptOut: true },
    });

    const pending = await handler(
      new Request("http://runtime.test/v1/pending-interactions"),
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ interactions: [] });

    const config = await handler(
      new Request("http://runtime.test/v1/config", {
        headers: { "x-worklin-concurrent-model-provider": "openai" },
      }),
    );
    expect(config.status).toBe(200);
    const configBody = await config.json();
    expect(configBody).toMatchObject({
      llm: { default: { provider: "openai" } },
    });
    expect(JSON.stringify(configBody)).not.toContain("test-provider-key");
  });

  test("conversation listings remain isolated between logical tenants", async () => {
    const store = new InMemoryConcurrentRuntimeStore();
    const service = new ConcurrentRuntimeService({
      store,
      executor: new EchoExecutor(),
      maxConcurrentTurns: 4,
      maxConcurrentTurnsPerTenant: 2,
      leaseDurationMs: 30_000,
    });
    await service.initialize();
    const handler = createConcurrentRuntimeHttpHandler({
      store,
      service,
      resolveModelKey: async () => "test-provider-key",
      authenticate(request) {
        return {
          ok: true,
          tenant: authenticatedTenant(
            request.headers.get("x-test-assistant") ?? "assistant-a",
          ),
        };
      },
    });
    for (const [assistantId, content] of [
      ["assistant-a", "tenant A secret"],
      ["assistant-b", "tenant B secret"],
    ]) {
      const response = await handler(
        new Request("http://runtime.test/v1/messages", {
          method: "POST",
          headers: {
            ...providerRequestHeaders(),
            "x-test-assistant": assistantId,
          },
          body: JSON.stringify({ conversationId: "shared-id", content }),
        }),
      );
      expect(response.status).toBe(202);
    }
    await service.onIdle();

    const tenantAList = await handler(
      new Request("http://runtime.test/v1/conversations", {
        headers: { "x-test-assistant": "assistant-a" },
      }),
    );
    const tenantABody = await tenantAList.json();
    expect(tenantABody).toMatchObject({
      conversations: [{ id: "shared-id", title: "tenant A secret" }],
    });
    expect(JSON.stringify(tenantABody)).not.toContain("tenant B secret");
  });

  test("fails closed for unsupported capabilities", async () => {
    const { handler, service } = createHarness();
    await service.initialize();

    const providerMissingResponse = await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      }),
    );
    expect(providerMissingResponse.status).toBe(409);
    expect(await providerMissingResponse.json()).toMatchObject({
      error: { code: "model_provider_not_configured" },
    });

    const attachmentResponse = await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "inspect this",
          attachmentIds: ["attachment-123"],
        }),
      }),
    );
    expect(attachmentResponse.status).toBe(409);
    expect(await attachmentResponse.json()).toMatchObject({
      error: { code: "requires_dedicated_runtime" },
    });

    const unknownResponse = await handler(
      new Request("http://runtime.test/v1/settings"),
    );
    expect(unknownResponse.status).toBe(409);
    expect(await unknownResponse.json()).toMatchObject({
      error: { code: "requires_dedicated_runtime" },
    });
  });

  test("supports conversation-scoped cancellation", async () => {
    const store = new InMemoryConcurrentRuntimeStore();
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const service = new ConcurrentRuntimeService({
      store,
      executor: {
        async execute(input) {
          await Promise.race([
            executionGate,
            new Promise<never>((_, reject) => {
              input.signal.addEventListener(
                "abort",
                () => reject(new Error("cancelled")),
                { once: true },
              );
            }),
          ]);
          return "late reply";
        },
      },
      maxConcurrentTurns: 1,
      maxConcurrentTurnsPerTenant: 1,
      leaseDurationMs: 30_000,
    });
    await service.initialize();
    const tenant = authenticatedTenant();
    const handler = createConcurrentRuntimeHttpHandler({
      store,
      service,
      authenticate: () => ({ ok: true, tenant }),
      resolveModelKey: async () => "test-provider-key",
    });
    await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: providerRequestHeaders(),
        body: JSON.stringify({
          conversationId: "conversation-123",
          content: "stop this",
        }),
      }),
    );

    const response = await handler(
      new Request(
        "http://runtime.test/v1/conversations/conversation-123/cancel",
        { method: "POST" },
      ),
    );
    releaseExecution();
    await service.onIdle();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      cancelled: true,
      conversationId: "conversation-123",
    });
  });

  test("exposes the browser broker only when configured and grants an exact client", async () => {
    const store = new InMemoryConcurrentRuntimeStore();
    const tenant = authenticatedTenant();
    const serviceRef: { current?: ConcurrentRuntimeService } = {};
    const browserBrokerService = new BrowserBrokerService({
      store,
      allowedOrigins: ["https://example.com"],
      onRunRunnable: async (context, runId): Promise<void> => {
        if (!serviceRef.current) throw new Error("Service is unavailable.");
        await serviceRef.current.resumeRun(context, runId);
      },
    });
    const service = new ConcurrentRuntimeService({
      store,
      executor: new EchoExecutor(),
      browserBrokerService,
      maxConcurrentTurns: 2,
      maxConcurrentTurnsPerTenant: 1,
      leaseDurationMs: 30_000,
    });
    serviceRef.current = service;
    await service.initialize();
    const handler = createConcurrentRuntimeHttpHandler({
      store,
      service,
      browserBrokerService,
      authenticate: () => ({ ok: true, tenant }),
      resolveModelKey: async () => "test-provider-key",
    });

    const health = await handler(new Request("http://runtime.test/health"));
    expect(await health.json()).toMatchObject({
      capabilities: expect.arrayContaining(["browser_broker_v1"]),
    });
    const connection = await handler(
      new Request("http://runtime.test/v1/browser-broker/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          interfaceId: "chrome-extension",
          clientInstallationId: "client-123",
          capabilities: ["browser_broker_v1", "interaction_v1"],
        }),
      }),
    );
    expect(connection.status).toBe(201);
    await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: providerRequestHeaders(),
        body: JSON.stringify({
          conversationId: "conversation-browser",
          content: "hello",
        }),
      }),
    );
    await service.onIdle();
    const grant = await handler(
      new Request(
        "http://runtime.test/v1/conversations/conversation-browser/browser-access",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientInstallationId: "client-123",
            enabled: true,
          }),
        },
      ),
    );
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({
      grant: {
        conversationId: "conversation-browser",
        clientInstallationId: "client-123",
        enabled: true,
      },
    });
  });
});
