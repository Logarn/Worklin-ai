import { describe, expect, test } from "bun:test";

import {
  createTenantExecutionContext,
  type RuntimeTenantContextClaim,
  type TenantExecutionContext,
} from "@vellumai/service-contracts/tenant-context";

import { InMemoryConcurrentRuntimeStore } from "./in-memory-store.js";
import { ConcurrentRuntimeService } from "./service.js";
import type {
  ConcurrentTurnCallbacks,
  ConcurrentTurnExecutor,
} from "./turn-executor.js";
import type { ConcurrentMessage } from "./types.js";

class RecordingExecutor implements ConcurrentTurnExecutor {
  readonly calls: Array<{
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
  }> = [];

  async execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<string> {
    this.calls.push({
      context: input.context,
      messages: input.messages.map((message) => ({ ...message })),
    });
    if (input.signal.aborted) throw new Error("cancelled");
    const latest = input.messages.at(-1)?.content ?? "";
    const response = `reply:${latest}`;
    await input.callbacks.onTextDelta(response);
    return response;
  }
}

function executionContext(input: {
  organizationId: string;
  assistantId: string;
  requestId: string;
  conversationId?: string;
  idempotencyKey?: string;
}): TenantExecutionContext {
  const claim: RuntimeTenantContextClaim = {
    version: 1,
    organization_id: input.organizationId,
    user_id: `user-${input.organizationId}`,
    assistant_id: input.assistantId,
    actor_id: `actor-${input.organizationId}`,
    request_id: input.requestId,
  };
  return createTenantExecutionContext({
    claim,
    authorizationVersion: 1,
    configVersion: 1,
    runtimeGeneration: 1,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

function createHarness(): {
  store: InMemoryConcurrentRuntimeStore;
  executor: RecordingExecutor;
  service: ConcurrentRuntimeService;
} {
  const store = new InMemoryConcurrentRuntimeStore();
  const executor = new RecordingExecutor();
  const service = new ConcurrentRuntimeService({
    store,
    executor,
    maxConcurrentTurns: 8,
    maxConcurrentTurnsPerTenant: 2,
    leaseDurationMs: 30_000,
  });
  return { store, executor, service };
}

describe("ConcurrentRuntimeService", () => {
  test("runs different tenants concurrently without sharing state", async () => {
    const { store, executor, service } = createHarness();
    await service.initialize();
    const tenantA = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-a",
      conversationId: "conv-shared-name",
      idempotencyKey: "message-a",
    });
    const tenantB = executionContext({
      organizationId: "org-b",
      assistantId: "assistant-b",
      requestId: "request-b",
      conversationId: "conv-shared-name",
      idempotencyKey: "message-b",
    });

    await Promise.all([
      service.submitMessage(tenantA, {
        conversationId: "conv-shared-name",
        content: "tenant a",
        clientMessageId: "message-a",
      }),
      service.submitMessage(tenantB, {
        conversationId: "conv-shared-name",
        content: "tenant b",
        clientMessageId: "message-b",
      }),
    ]);
    await service.onIdle();

    expect(
      (await store.listMessages(tenantA, "conv-shared-name")).map(
        (message) => message.content,
      ),
    ).toEqual(["tenant a", "reply:tenant a"]);
    expect(
      (await store.listMessages(tenantB, "conv-shared-name")).map(
        (message) => message.content,
      ),
    ).toEqual(["tenant b", "reply:tenant b"]);
    expect(executor.calls).toHaveLength(2);
    expect(
      new Set(executor.calls.map((call) => call.context.organizationId)),
    ).toEqual(new Set(["org-a", "org-b"]));
  });

  test("serializes turns in one conversation and preserves transcript order", async () => {
    const { store, executor, service } = createHarness();
    await service.initialize();
    const first = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-1",
      conversationId: "conv-1",
      idempotencyKey: "message-1",
    });
    const second = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-2",
      conversationId: "conv-1",
      idempotencyKey: "message-2",
    });

    await Promise.all([
      service.submitMessage(first, {
        conversationId: "conv-1",
        content: "first",
        clientMessageId: "message-1",
      }),
      service.submitMessage(second, {
        conversationId: "conv-1",
        content: "second",
        clientMessageId: "message-2",
      }),
    ]);
    await service.onIdle();

    const messages = await store.listMessages(first, "conv-1");
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "first"],
      ["assistant", "reply:first"],
      ["user", "second"],
      ["assistant", "reply:second"],
    ]);
    expect(
      executor.calls[0].messages.map((message) => message.content),
    ).toEqual(["first"]);
    expect(
      executor.calls[1].messages.map((message) => message.content),
    ).toEqual(["first", "reply:first", "second"]);
  });

  test("deduplicates repeated sends by tenant-scoped idempotency key", async () => {
    const { store, executor, service } = createHarness();
    await service.initialize();
    const context = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-1",
      conversationId: "conv-1",
      idempotencyKey: "message-1",
    });
    const input = {
      conversationId: "conv-1",
      content: "hello",
      clientMessageId: "message-1",
    };

    const [first, duplicate] = await Promise.all([
      service.submitMessage(context, input),
      service.submitMessage(context, input),
    ]);
    await service.onIdle();

    expect([first.created, duplicate.created].sort()).toEqual([false, true]);
    expect(executor.calls).toHaveLength(1);
    expect(await store.listMessages(context, "conv-1")).toHaveLength(2);
  });

  test("events are scoped by organization and assistant", async () => {
    const { store, service } = createHarness();
    await service.initialize();
    const tenantA = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-a",
      conversationId: "conv-1",
    });
    const tenantB = executionContext({
      organizationId: "org-b",
      assistantId: "assistant-b",
      requestId: "request-b",
      conversationId: "conv-1",
    });
    await service.submitMessage(tenantA, {
      conversationId: "conv-1",
      content: "private a",
    });
    await service.submitMessage(tenantB, {
      conversationId: "conv-1",
      content: "private b",
    });
    await service.onIdle();

    const eventsA = await store.listEvents(tenantA, {
      afterSeq: 0,
      conversationId: "conv-1",
      limit: 100,
    });
    const eventsB = await store.listEvents(tenantB, {
      afterSeq: 0,
      conversationId: "conv-1",
      limit: 100,
    });
    expect(JSON.stringify(eventsA).includes("private b")).toBe(false);
    expect(JSON.stringify(eventsB).includes("private a")).toBe(false);
  });

  test("reclaims an expired run when the accepted message is retried", async () => {
    const { store, executor, service } = createHarness();
    await service.initialize();
    const context = executionContext({
      organizationId: "org-a",
      assistantId: "assistant-a",
      requestId: "request-a",
      conversationId: "conv-1",
      idempotencyKey: "message-1",
    });
    const accepted = await store.acceptMessage(context, {
      conversationId: "conv-1",
      content: "recover me",
      clientMessageId: "message-1",
    });
    const stale = await store.claimRun(
      context,
      accepted.run.id,
      "crashed-worker",
      Date.now() - 1,
    );
    expect(stale?.run.status).toBe("processing");

    const retried = await service.submitMessage(context, {
      conversationId: "conv-1",
      content: "recover me",
      clientMessageId: "message-1",
    });
    expect(retried.created).toBe(false);
    await service.onIdle();

    expect(executor.calls).toHaveLength(1);
    expect((await store.getRun(context, accepted.run.id))?.status).toBe(
      "completed",
    );
  });
});
