import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

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

export interface ConcurrentRuntimeStore {
  initialize(): Promise<void>;

  acceptMessage(
    context: TenantExecutionContext,
    input: AcceptConcurrentMessageInput,
  ): Promise<AcceptedConcurrentRun>;

  claimRun(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<ClaimedConcurrentRun | null>;

  renewRunLease(
    context: TenantExecutionContext,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: number,
  ): Promise<boolean>;

  completeRun(
    context: TenantExecutionContext,
    runId: string,
    input: CompleteConcurrentRunInput,
  ): Promise<ConcurrentMessage>;

  failRun(
    context: TenantExecutionContext,
    runId: string,
    input: FailConcurrentRunInput,
  ): Promise<boolean>;

  cancelRun(context: TenantExecutionContext, runId: string): Promise<boolean>;

  cancelConversationRuns(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentRun[]>;

  getRun(
    context: TenantExecutionContext,
    runId: string,
  ): Promise<ConcurrentRun | null>;

  listMessages(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<ConcurrentMessage[]>;

  hasActiveRun(
    context: TenantExecutionContext,
    conversationId: string,
  ): Promise<boolean>;

  appendEvent(
    context: TenantExecutionContext,
    conversationId: string,
    message: Record<string, unknown>,
  ): Promise<ConcurrentEvent>;

  listEvents(
    context: TenantExecutionContext,
    input: {
      afterSeq: number;
      conversationId?: string;
      limit: number;
    },
  ): Promise<ConcurrentEvent[]>;
}

export class ConcurrentRuntimeStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "tenant_mismatch"
      | "conversation_not_found"
      | "run_not_found"
      | "lease_lost"
      | "invalid_state",
  ) {
    super(message);
    this.name = "ConcurrentRuntimeStoreError";
  }
}
