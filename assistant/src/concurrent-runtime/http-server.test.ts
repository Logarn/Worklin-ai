import { describe, expect, test } from "bun:test";

import type {
  RuntimeTenantContextClaim,
  TenantExecutionContext,
} from "@vellumai/service-contracts/tenant-context";

import type { Scope } from "../runtime/auth/types.js";
import type {
  ConcurrentAuthenticatedTenant,
  ConcurrentAuthenticationResult,
} from "./auth.js";
import { createConcurrentRuntimeHttpHandler } from "./http-server.js";
import { InMemoryConcurrentRuntimeStore } from "./in-memory-store.js";
import { ConcurrentRuntimeService } from "./service.js";
import type {
  ConcurrentTurnCallbacks,
  ConcurrentTurnExecutor,
} from "./turn-executor.js";
import type { ConcurrentMessage } from "./types.js";

class EchoExecutor implements ConcurrentTurnExecutor {
  async execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<string> {
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

function createHarness() {
  const store = new InMemoryConcurrentRuntimeStore();
  const service = new ConcurrentRuntimeService({
    store,
    executor: new EchoExecutor(),
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
  });
  return { handler, service };
}

describe("concurrent runtime HTTP handler", () => {
  test("accepts a bounded message and exposes its durable transcript", async () => {
    const { handler, service } = createHarness();
    await service.initialize();

    const accepted = await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: "conversation-123",
          content: "hello",
          clientMessageId: "message-123",
          sourceChannel: "vellum",
          interface: "vellum",
        }),
      }),
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      conversationId: "conversation-123",
    });

    await service.onIdle();
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
  });

  test("fails closed for unsupported capabilities", async () => {
    const { handler, service } = createHarness();
    await service.initialize();

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
    });
    await handler(
      new Request("http://runtime.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
});
