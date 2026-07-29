import { randomUUID } from "node:crypto";

import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";
import {
  tenantConversationScopeKey,
  tenantExecutionScopeKey,
} from "@vellumai/service-contracts/tenant-context";

import {
  type ConcurrentRuntimeStore,
  ConcurrentRuntimeStoreError,
} from "./store.js";
import type {
  AcceptConcurrentMessageInput,
  AcceptedConcurrentRun,
  ClaimedConcurrentRun,
  CompleteConcurrentRunInput,
  ConcurrentEvent,
  ConcurrentMessage,
  ConcurrentRun,
  FailConcurrentRunInput,
} from "./types.js";

function cloneMessage(message: ConcurrentMessage): ConcurrentMessage {
  return { ...message };
}

function cloneRun(run: ConcurrentRun): ConcurrentRun {
  return { ...run };
}

function cloneEvent(event: ConcurrentEvent): ConcurrentEvent {
  return { ...event, message: structuredClone(event.message) };
}

function assertContext(context: TenantExecutionContext): void {
  if (
    !context.organizationId ||
    !context.assistantId ||
    !context.userId ||
    !context.actorId ||
    !context.requestId
  ) {
    throw new ConcurrentRuntimeStoreError(
      "Tenant execution context is incomplete.",
      "tenant_mismatch",
    );
  }
}

export class InMemoryConcurrentRuntimeStore implements ConcurrentRuntimeStore {
  private readonly messages = new Map<string, ConcurrentMessage[]>();
  private readonly runs = new Map<string, ConcurrentRun>();
  private readonly runContexts = new Map<string, TenantExecutionContext>();
  private readonly idempotency = new Map<string, string>();
  private readonly events = new Map<string, ConcurrentEvent[]>();
  private readonly nextEventSequence = new Map<string, number>();

  async initialize(): Promise<void> {}

  async acceptMessage(
    context: TenantExecutionContext,
    input: AcceptConcurrentMessageInput,
  ): Promise<AcceptedConcurrentRun> {
    assertContext(context);
    const idempotencyKey =
      context.idempotencyKey ?? input.clientMessageId ?? context.requestId;
    const tenantKey = tenantExecutionScopeKey(context);
    const idempotencyScope = JSON.stringify([tenantKey, idempotencyKey]);
    const existingRunId = this.idempotency.get(idempotencyScope);
    if (existingRunId) {
      const existingRun = this.runs.get(
        JSON.stringify([tenantKey, existingRunId]),
      );
      if (!existingRun) {
        throw new ConcurrentRuntimeStoreError(
          "Idempotency record references a missing run.",
          "invalid_state",
        );
      }
      const existingMessages =
        this.messages.get(
          tenantConversationScopeKey(context, existingRun.conversationId),
        ) ?? [];
      const userMessage = existingMessages.find(
        (message) => message.id === existingRun.userMessageId,
      );
      if (!userMessage) {
        throw new ConcurrentRuntimeStoreError(
          "Accepted run references a missing user message.",
          "invalid_state",
        );
      }
      const existingEvent = (this.events.get(tenantKey) ?? []).find(
        (event) =>
          event.message.type === "user_message_echo" &&
          event.message.messageId === userMessage.id,
      );
      if (!existingEvent) {
        throw new ConcurrentRuntimeStoreError(
          "Accepted run references a missing user-message event.",
          "invalid_state",
        );
      }
      return {
        created: false,
        conversationId: existingRun.conversationId,
        userMessage: cloneMessage(userMessage),
        run: cloneRun(existingRun),
        event: cloneEvent(existingEvent),
      };
    }

    const conversationId =
      input.conversationId ?? context.conversationId ?? randomUUID();
    if (
      context.conversationId &&
      input.conversationId &&
      context.conversationId !== input.conversationId
    ) {
      throw new ConcurrentRuntimeStoreError(
        "Conversation identity does not match the execution context.",
        "tenant_mismatch",
      );
    }

    const timestamp = new Date().toISOString();
    const userMessage: ConcurrentMessage = {
      id: randomUUID(),
      organizationId: context.organizationId,
      assistantId: context.assistantId,
      conversationId,
      role: "user",
      content: input.content,
      ...(input.clientMessageId
        ? { clientMessageId: input.clientMessageId }
        : {}),
      createdAt: timestamp,
    };
    const run: ConcurrentRun = {
      id: randomUUID(),
      organizationId: context.organizationId,
      assistantId: context.assistantId,
      conversationId,
      requestId: context.requestId,
      idempotencyKey,
      userMessageId: userMessage.id,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const conversationKey = tenantConversationScopeKey(context, conversationId);
    const conversationMessages = this.messages.get(conversationKey) ?? [];
    conversationMessages.push(userMessage);
    this.messages.set(conversationKey, conversationMessages);

    const runKey = JSON.stringify([tenantKey, run.id]);
    this.runs.set(runKey, run);
    this.runContexts.set(runKey, {
      ...context,
      conversationId,
      idempotencyKey,
    });
    this.idempotency.set(idempotencyScope, run.id);
    const event = this.appendEventRecord(context, conversationId, {
      type: "user_message_echo",
      text: userMessage.content,
      conversationId,
      messageId: userMessage.id,
      requestId: run.requestId,
      ...(userMessage.clientMessageId
        ? { clientMessageId: userMessage.clientMessageId }
        : {}),
    });

    return {
      created: true,
      conversationId,
      userMessage: cloneMessage(userMessage),
      run: cloneRun(run),
      event,
    };
  }

  async claimRun(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<ClaimedConcurrentRun | null> {
    assertContext(context);
    const tenantKey = tenantExecutionScopeKey(context);
    const runKey = JSON.stringify([tenantKey, runId]);
    const run = this.runs.get(runKey);
    if (!run) return null;
    const now = Date.now();
    if (
      run.status !== "queued" &&
      !(
        run.status === "processing" &&
        (run.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <= now
      )
    ) {
      return null;
    }
    run.status = "processing";
    run.leaseOwner = leaseOwner;
    run.leaseExpiresAt = leaseExpiresAt;
    run.updatedAt = new Date().toISOString();

    const storedContext = this.runContexts.get(runKey);
    if (!storedContext) {
      throw new ConcurrentRuntimeStoreError(
        "Run execution context is missing.",
        "invalid_state",
      );
    }
    const messages =
      this.messages.get(
        tenantConversationScopeKey(context, run.conversationId),
      ) ?? [];
    const userMessageIndex = messages.findIndex(
      (message) => message.id === run.userMessageId,
    );
    if (userMessageIndex < 0) {
      throw new ConcurrentRuntimeStoreError(
        "Run user message is missing from conversation history.",
        "invalid_state",
      );
    }
    return {
      context: { ...storedContext },
      run: cloneRun(run),
      messages: messages.slice(0, userMessageIndex + 1).map(cloneMessage),
    };
  }

  async renewRunLease(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    const run = this.scopedRun(context, runId);
    if (!run || run.status !== "processing" || run.leaseOwner !== leaseOwner) {
      return false;
    }
    run.leaseExpiresAt = leaseExpiresAt;
    run.updatedAt = new Date().toISOString();
    return true;
  }

  async completeRun(
    context: TenantExecutionContext,
    runId: string,
    input: CompleteConcurrentRunInput,
  ): Promise<ConcurrentMessage> {
    const run = this.requireLeasedRun(context, runId, input.leaseOwner);
    const assistantMessage: ConcurrentMessage = {
      id: input.assistantMessageId,
      organizationId: context.organizationId,
      assistantId: context.assistantId,
      conversationId: run.conversationId,
      role: "assistant",
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    const conversationKey = tenantConversationScopeKey(
      context,
      run.conversationId,
    );
    const conversationMessages = this.messages.get(conversationKey) ?? [];
    const userMessageIndex = conversationMessages.findIndex(
      (message) => message.id === run.userMessageId,
    );
    if (userMessageIndex < 0) {
      throw new ConcurrentRuntimeStoreError(
        "Run user message is missing from conversation history.",
        "invalid_state",
      );
    }
    conversationMessages.splice(userMessageIndex + 1, 0, assistantMessage);
    this.messages.set(conversationKey, conversationMessages);
    run.status = "completed";
    run.assistantMessageId = assistantMessage.id;
    delete run.leaseOwner;
    delete run.leaseExpiresAt;
    run.updatedAt = new Date().toISOString();
    return cloneMessage(assistantMessage);
  }

  async failRun(
    context: TenantExecutionContext,
    runId: string,
    input: FailConcurrentRunInput,
  ): Promise<boolean> {
    const run = this.scopedRun(context, runId);
    if (
      !run ||
      run.status !== "processing" ||
      run.leaseOwner !== input.leaseOwner
    ) {
      return false;
    }
    run.status = "failed";
    run.errorCode = input.errorCode;
    run.errorMessage = input.errorMessage;
    delete run.leaseOwner;
    delete run.leaseExpiresAt;
    run.updatedAt = new Date().toISOString();
    return true;
  }

  async cancelRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<boolean> {
    const run = this.scopedRun(context, runId);
    if (!run || (run.status !== "queued" && run.status !== "processing")) {
      return false;
    }
    run.status = "cancelled";
    delete run.leaseOwner;
    delete run.leaseExpiresAt;
    run.updatedAt = new Date().toISOString();
    return true;
  }

  async cancelConversationRuns(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentRun[]> {
    assertContext(context);
    const cancelled: ConcurrentRun[] = [];
    for (const run of this.runs.values()) {
      if (
        run.organizationId !== context.organizationId ||
        run.assistantId !== context.assistantId ||
        run.conversationId !== conversationId ||
        (run.status !== "queued" && run.status !== "processing")
      ) {
        continue;
      }
      run.status = "cancelled";
      delete run.leaseOwner;
      delete run.leaseExpiresAt;
      run.updatedAt = new Date().toISOString();
      cancelled.push(cloneRun(run));
    }
    return cancelled;
  }

  async getRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<ConcurrentRun | null> {
    const run = this.scopedRun(context, runId);
    return run ? cloneRun(run) : null;
  }

  async listMessages(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentMessage[]> {
    assertContext(context);
    return (
      this.messages.get(tenantConversationScopeKey(context, conversationId)) ??
      []
    ).map(cloneMessage);
  }

  async hasActiveRun(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<boolean> {
    assertContext(context);
    return [...this.runs.values()].some(
      (run) =>
        run.organizationId === context.organizationId &&
        run.assistantId === context.assistantId &&
        run.conversationId === conversationId &&
        (run.status === "queued" || run.status === "processing"),
    );
  }

  async appendEvent(
    context: TenantExecutionContext,
    conversationId: string,
    message: Record<string, unknown>,
  ): Promise<ConcurrentEvent> {
    assertContext(context);
    return this.appendEventRecord(context, conversationId, message);
  }

  private appendEventRecord(
    context: TenantExecutionContext,
    conversationId: string,
    message: Record<string, unknown>,
  ): ConcurrentEvent {
    const tenantKey = tenantExecutionScopeKey(context);
    const nextSequence = (this.nextEventSequence.get(tenantKey) ?? 0) + 1;
    this.nextEventSequence.set(tenantKey, nextSequence);
    const event: ConcurrentEvent = {
      id: randomUUID(),
      organizationId: context.organizationId,
      assistantId: context.assistantId,
      conversationId,
      seq: nextSequence,
      emittedAt: new Date().toISOString(),
      message: structuredClone(message),
    };
    const tenantEvents = this.events.get(tenantKey) ?? [];
    tenantEvents.push(event);
    this.events.set(tenantKey, tenantEvents);
    return cloneEvent(event);
  }

  async listEvents(
    context: TenantExecutionContext,
    input: {
      afterSeq: number;
      conversationId?: string;
      limit: number;
    },
  ): Promise<ConcurrentEvent[]> {
    assertContext(context);
    const tenantEvents =
      this.events.get(tenantExecutionScopeKey(context)) ?? [];
    return tenantEvents
      .filter(
        (event) =>
          event.seq > input.afterSeq &&
          (!input.conversationId ||
            event.conversationId === input.conversationId),
      )
      .slice(0, input.limit)
      .map(cloneEvent);
  }

  private scopedRun(
    context: TenantExecutionContext,
    runId: string,
  ): ConcurrentRun | undefined {
    assertContext(context);
    return this.runs.get(
      JSON.stringify([tenantExecutionScopeKey(context), runId]),
    );
  }

  private requireLeasedRun(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
  ): ConcurrentRun {
    const run = this.scopedRun(context, runId);
    if (!run) {
      throw new ConcurrentRuntimeStoreError(
        "Run was not found for this tenant.",
        "run_not_found",
      );
    }
    if (run.status !== "processing" || run.leaseOwner !== leaseOwner) {
      throw new ConcurrentRuntimeStoreError(
        "Run lease is no longer owned by this worker.",
        "lease_lost",
      );
    }
    return run;
  }
}
