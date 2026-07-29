import { randomUUID } from "node:crypto";

import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";
import {
  tenantConversationScopeKey,
  tenantExecutionScopeKey,
} from "@vellumai/service-contracts/tenant-context";

import { FairTenantScheduler } from "./fair-scheduler.js";
import type { ConcurrentRuntimeStore } from "./store.js";
import type { ConcurrentTurnExecutor } from "./turn-executor.js";
import type {
  AcceptConcurrentMessageInput,
  AcceptedConcurrentRun,
} from "./types.js";

export interface ConcurrentRuntimeLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

const defaultLogger: ConcurrentRuntimeLogger = {
  error(fields, message) {
    console.error(message, fields);
  },
};

export interface ConcurrentRuntimeServiceOptions {
  store: ConcurrentRuntimeStore;
  executor: ConcurrentTurnExecutor;
  maxConcurrentTurns: number;
  maxConcurrentTurnsPerTenant: number;
  leaseDurationMs: number;
  leaseRenewIntervalMs?: number;
  workerId?: string;
  logger?: ConcurrentRuntimeLogger;
}

export class ConcurrentRuntimeService {
  private readonly store: ConcurrentRuntimeStore;
  private readonly executor: ConcurrentTurnExecutor;
  private readonly scheduler: FairTenantScheduler;
  private readonly leaseDurationMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly workerId: string;
  private readonly logger: ConcurrentRuntimeLogger;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly scheduledRuns = new Set<string>();
  private readonly conversationTails = new Map<string, Promise<void>>();

  constructor(options: ConcurrentRuntimeServiceOptions) {
    if (
      !Number.isInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1_000
    ) {
      throw new Error("Concurrent runtime lease duration must be at least 1s.");
    }
    this.store = options.store;
    this.executor = options.executor;
    this.leaseDurationMs = options.leaseDurationMs;
    this.leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ??
      Math.max(1_000, Math.floor(options.leaseDurationMs / 3));
    this.workerId = options.workerId ?? randomUUID();
    this.logger = options.logger ?? defaultLogger;
    this.scheduler = new FairTenantScheduler({
      maxConcurrent: options.maxConcurrentTurns,
      maxConcurrentPerTenant: options.maxConcurrentTurnsPerTenant,
      onTaskError: (error) => {
        this.logger.error({ error }, "Concurrent runtime task failed");
      },
    });
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async submitMessage(
    context: TenantExecutionContext,
    input: AcceptConcurrentMessageInput,
  ): Promise<AcceptedConcurrentRun> {
    const accepted = await this.store.acceptMessage(context, input);
    if (
      accepted.created ||
      accepted.run.status === "queued" ||
      (accepted.run.status === "processing" &&
        (accepted.run.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <= Date.now())
    ) {
      const runContext: TenantExecutionContext = {
        ...context,
        conversationId: accepted.conversationId,
        idempotencyKey: accepted.run.idempotencyKey,
      };
      this.schedule(runContext, accepted.run.id);
    }
    return accepted;
  }

  async cancelRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<boolean> {
    const key = this.runScopeKey(context, runId);
    this.activeAbortControllers.get(key)?.abort();
    return this.store.cancelRun(context, runId);
  }

  async cancelConversation(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<boolean> {
    const cancelled = await this.store.cancelConversationRuns(
      context,
      conversationId,
    );
    for (const run of cancelled) {
      this.activeAbortControllers
        .get(this.runScopeKey(context, run.id))
        ?.abort();
    }
    return cancelled.length > 0;
  }

  async onIdle(): Promise<void> {
    await this.scheduler.onIdle();
  }

  schedulerSnapshot(): {
    active: number;
    pending: number;
    tenants: number;
  } {
    return this.scheduler.snapshot();
  }

  private schedule(context: TenantExecutionContext, runId: string): void {
    const runKey = this.runScopeKey(context, runId);
    if (this.scheduledRuns.has(runKey)) return;
    this.scheduledRuns.add(runKey);
    const tenantKey = tenantExecutionScopeKey(context);
    this.scheduler.enqueue(tenantKey, async () => {
      try {
        await this.withConversationLock(context, () =>
          this.processRun(context, runId),
        );
      } finally {
        this.scheduledRuns.delete(runKey);
      }
    });
  }

  private async processRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<void> {
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.store.claimRun(
      context,
      runId,
      leaseOwner,
      Date.now() + this.leaseDurationMs,
    );
    if (!claimed) return;

    const executionContext = claimed.context;
    const conversationId = claimed.run.conversationId;
    const assistantMessageId = randomUUID();
    const abortController = new AbortController();
    const runKey = this.runScopeKey(executionContext, runId);
    this.activeAbortControllers.set(runKey, abortController);
    let activityVersion = 1;
    let renewFailed = false;

    const renewalTimer = setInterval(() => {
      void this.store
        .renewRunLease(
          executionContext,
          runId,
          leaseOwner,
          Date.now() + this.leaseDurationMs,
        )
        .then((renewed) => {
          if (!renewed) {
            renewFailed = true;
            abortController.abort();
          }
        })
        .catch((error) => {
          renewFailed = true;
          this.logger.error(
            { error, runId, conversationId },
            "Concurrent runtime lease renewal failed",
          );
          abortController.abort();
        });
    }, this.leaseRenewIntervalMs);

    try {
      await this.store.appendEvent(executionContext, conversationId, {
        type: "assistant_turn_start",
        messageId: assistantMessageId,
        conversationId,
      });
      await this.store.appendEvent(executionContext, conversationId, {
        type: "assistant_activity_state",
        conversationId,
        activityVersion,
        phase: "thinking",
        anchor: "assistant_turn",
        reason: "message_dequeued",
        requestId: claimed.run.requestId,
      });

      let receivedTextDelta = false;
      const content = await this.executor.execute({
        context: executionContext,
        messages: claimed.messages,
        signal: abortController.signal,
        callbacks: {
          onTextDelta: async (text) => {
            if (!receivedTextDelta) {
              receivedTextDelta = true;
              activityVersion += 1;
              await this.store.appendEvent(executionContext, conversationId, {
                type: "assistant_activity_state",
                conversationId,
                activityVersion,
                phase: "streaming",
                anchor: "assistant_turn",
                reason: "first_text_delta",
                requestId: claimed.run.requestId,
              });
            }
            await this.store.appendEvent(executionContext, conversationId, {
              type: "assistant_text_delta",
              text,
              messageId: assistantMessageId,
              conversationId,
            });
          },
        },
      });
      if (renewFailed) {
        throw new Error("Concurrent runtime lease was lost.");
      }

      await this.store.completeRun(executionContext, runId, {
        assistantMessageId,
        content,
        leaseOwner,
      });
      await this.store.appendEvent(executionContext, conversationId, {
        type: "message_complete",
        messageId: assistantMessageId,
        conversationId,
        source: "main",
      });
      activityVersion += 1;
      await this.store.appendEvent(executionContext, conversationId, {
        type: "assistant_activity_state",
        conversationId,
        activityVersion,
        phase: "idle",
        anchor: "assistant_turn",
        reason: "message_complete",
        requestId: claimed.run.requestId,
      });
    } catch (error) {
      const current = await this.store.getRun(executionContext, runId);
      if (current?.status !== "cancelled") {
        const message =
          error instanceof Error ? error.message : "Assistant turn failed.";
        await this.store.failRun(executionContext, runId, {
          errorCode: renewFailed ? "lease_lost" : "turn_failed",
          errorMessage: message,
          leaseOwner,
        });
        await this.store.appendEvent(executionContext, conversationId, {
          type: "error",
          message,
          code: renewFailed ? "lease_lost" : "turn_failed",
          requestId: claimed.run.requestId,
          conversationId,
        });
      }
    } finally {
      clearInterval(renewalTimer);
      this.activeAbortControllers.delete(runKey);
    }
  }

  private runScopeKey(context: TenantExecutionContext, runId: string): string {
    return JSON.stringify([
      tenantConversationScopeKey(
        context,
        context.conversationId ?? "unassigned",
      ),
      runId,
    ]);
  }

  private async withConversationLock(
    context: TenantExecutionContext,
    execute: () => Promise<void>,
  ): Promise<void> {
    const key = tenantConversationScopeKey(
      context,
      context.conversationId ?? "unassigned",
    );
    const previous = this.conversationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.conversationTails.set(key, tail);
    await previous;
    try {
      await execute();
    } finally {
      release();
      if (this.conversationTails.get(key) === tail) {
        this.conversationTails.delete(key);
      }
    }
  }
}
