import { randomUUID } from "node:crypto";

import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";
import {
  tenantConversationScopeKey,
  tenantExecutionScopeKey,
} from "@vellumai/service-contracts/tenant-context";

import type {
  ConcurrentProviderConfigResolver,
  ConcurrentProviderRequestConfig,
} from "../providers/platform-proxy/concurrent-request-context.js";
import type { BrowserBrokerService } from "./browser-broker/service.js";
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
  browserBrokerService?: BrowserBrokerService;
}

export class ConcurrentRuntimeService {
  private readonly store: ConcurrentRuntimeStore;
  private readonly executor: ConcurrentTurnExecutor;
  private readonly scheduler: FairTenantScheduler;
  private readonly leaseDurationMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly workerId: string;
  private readonly logger: ConcurrentRuntimeLogger;
  private readonly browserBrokerService?: BrowserBrokerService;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly providerConfigs = new Map<
    string,
    ConcurrentProviderRequestConfig
  >();
  private readonly providerConfigResolutions = new Map<
    string,
    Promise<ConcurrentProviderRequestConfig>
  >();
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
    this.browserBrokerService = options.browserBrokerService;
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
    providerConfig?:
      | ConcurrentProviderRequestConfig
      | ConcurrentProviderConfigResolver,
  ): Promise<AcceptedConcurrentRun> {
    const accepted = await this.store.acceptMessage(context, input);
    const shouldSchedule =
      accepted.created ||
      accepted.run.status === "queued" ||
      (accepted.run.status === "processing" &&
        (accepted.run.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <=
          Date.now());
    if (shouldSchedule) {
      const runContext: TenantExecutionContext = {
        ...context,
        conversationId: accepted.conversationId,
        idempotencyKey: accepted.run.idempotencyKey,
      };
      if (typeof providerConfig === "function") {
        await this.resolveProviderConfig(
          runContext,
          accepted.run.id,
          providerConfig,
        );
      } else if (providerConfig) {
        this.providerConfigs.set(
          this.runScopeKey(runContext, accepted.run.id),
          { ...providerConfig },
        );
      }
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
    const cancelled = await this.store.cancelRun(context, runId);
    if (cancelled) this.providerConfigs.delete(key);
    return cancelled;
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
      const key = this.runScopeKey(context, run.id);
      this.activeAbortControllers.get(key)?.abort();
      this.providerConfigs.delete(key);
    }
    return cancelled.length > 0;
  }

  async onIdle(): Promise<void> {
    await this.scheduler.onIdle();
  }

  async resumeRun(
    context: TenantExecutionContext,
    runId: string,
    resolveProviderConfig?: ConcurrentProviderConfigResolver,
  ): Promise<void> {
    const run = await this.store.getRun(context, runId);
    if (!run || run.status !== "queued") return;
    const runContext = {
      ...context,
      conversationId: run.conversationId,
      idempotencyKey: run.idempotencyKey,
    };
    const key = this.runScopeKey(runContext, runId);
    if (this.scheduledRuns.has(key)) return;
    if (resolveProviderConfig && !this.providerConfigs.has(key)) {
      await this.resolveProviderConfig(
        runContext,
        runId,
        resolveProviderConfig,
      );
    }
    this.schedule(runContext, runId);
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
    if (!claimed) {
      this.clearProviderConfig(this.runScopeKey(context, runId));
      return;
    }

    const executionContext = claimed.context;
    const conversationId = claimed.run.conversationId;
    const assistantMessageId = randomUUID();
    const abortController = new AbortController();
    const runKey = this.runScopeKey(executionContext, runId);
    this.activeAbortControllers.set(runKey, abortController);
    let activityVersion = 1;
    let renewFailed = false;
    let parkedForBrowser = false;
    let terminal = false;

    const renewalTimer = setInterval(() => {
      void this.store
        .renewRunLease(
          executionContext,
          runId,
          leaseOwner,
          Date.now() + this.leaseDurationMs,
        )
        .then((renewed) => {
          if (!renewed && !parkedForBrowser) {
            renewFailed = true;
            abortController.abort();
          }
        })
        .catch((error) => {
          if (parkedForBrowser) return;
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
      const grant = this.browserBrokerService
        ? await this.store.getBrowserAccessGrant(
            executionContext,
            conversationId,
          )
        : null;
      const execution = await this.executor.execute({
        context: executionContext,
        messages: claimed.messages,
        steps: claimed.steps,
        providerConfig: this.providerConfigs.get(runKey),
        ...(claimed.run.turnSequence === 0 && claimed.onboardingContext
          ? { onboardingContext: claimed.onboardingContext }
          : {}),
        browserEnabled: grant?.enabled === true,
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

      const normalizedExecution =
        typeof execution === "string"
          ? ({ kind: "complete", content: execution } as const)
          : execution;
      if (normalizedExecution.kind === "browser_action") {
        if (!this.browserBrokerService) {
          throw new Error("Browser broker is unavailable for this runtime.");
        }
        const browserStepCount = claimed.steps.filter(
          (step) => step.stepKind === "provider_response",
        ).length;
        if (browserStepCount >= 12) {
          throw new Error("Browser action budget was exhausted for this turn.");
        }
        const dispatched = await this.browserBrokerService.dispatch(
          executionContext,
          {
            conversationId,
            runId,
            toolUseId: normalizedExecution.toolUseId,
            operation: normalizedExecution.operation,
            leaseOwner,
            providerContent: normalizedExecution.providerContent,
            executionConfig: normalizedExecution.executionConfig,
          },
        );
        parkedForBrowser = true;
        activityVersion += 1;
        await this.store.appendEvent(executionContext, conversationId, {
          type: "assistant_activity_state",
          conversationId,
          activityVersion,
          phase: "waiting",
          anchor: "assistant_turn",
          reason: "browser_action_dispatched",
          requestId: claimed.run.requestId,
          actionId: dispatched.action.actionId,
        });
        return;
      }

      await this.store.completeRun(executionContext, runId, {
        assistantMessageId,
        content: normalizedExecution.content,
        leaseOwner,
      });
      terminal = true;
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
      if (
        current?.status !== "cancelled" &&
        current?.status !== "waiting_for_browser"
      ) {
        const message =
          error instanceof Error ? error.message : "Assistant turn failed.";
        terminal = await this.store.failRun(executionContext, runId, {
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
      this.clearProviderConfig(runKey);
      if (terminal) {
        const next = await this.store.getNextQueuedRun(
          executionContext,
          conversationId,
        );
        if (next) {
          this.schedule(
            {
              ...executionContext,
              conversationId,
              idempotencyKey: next.idempotencyKey,
            },
            next.id,
          );
        }
      }
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

  private async resolveProviderConfig(
    context: TenantExecutionContext,
    runId: string,
    resolve: ConcurrentProviderConfigResolver,
  ): Promise<ConcurrentProviderRequestConfig> {
    const key = this.runScopeKey(context, runId);
    const cached = this.providerConfigs.get(key);
    if (cached) return cached;

    let resolution = this.providerConfigResolutions.get(key);
    if (!resolution) {
      resolution = resolve()
        .then((providerConfig) => {
          this.providerConfigs.set(key, { ...providerConfig });
          return providerConfig;
        })
        .finally(() => this.providerConfigResolutions.delete(key));
      this.providerConfigResolutions.set(key, resolution);
    }
    return resolution;
  }

  private clearProviderConfig(key: string): void {
    const providerConfig = this.providerConfigs.get(key);
    if (providerConfig) providerConfig.key = "";
    this.providerConfigs.delete(key);
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
