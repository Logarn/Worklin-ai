import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

export type ConcurrentMessageRole = "user" | "assistant";
export type ConcurrentRunStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConcurrentMessage {
  id: string;
  organizationId: string;
  assistantId: string;
  conversationId: string;
  role: ConcurrentMessageRole;
  content: string;
  clientMessageId?: string;
  createdAt: string;
}

export interface ConcurrentRun {
  id: string;
  organizationId: string;
  assistantId: string;
  conversationId: string;
  requestId: string;
  idempotencyKey: string;
  userMessageId: string;
  assistantMessageId?: string;
  status: ConcurrentRunStatus;
  errorCode?: string;
  errorMessage?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConcurrentEvent {
  id: string;
  organizationId: string;
  assistantId: string;
  conversationId: string;
  seq: number;
  emittedAt: string;
  message: Record<string, unknown>;
}

export interface AcceptedConcurrentRun {
  created: boolean;
  conversationId: string;
  userMessage: ConcurrentMessage;
  run: ConcurrentRun;
  event: ConcurrentEvent;
}

export interface ClaimedConcurrentRun {
  context: TenantExecutionContext;
  run: ConcurrentRun;
  messages: ConcurrentMessage[];
}

export interface AcceptConcurrentMessageInput {
  conversationId?: string;
  content: string;
  clientMessageId?: string;
}

export interface CompleteConcurrentRunInput {
  assistantMessageId: string;
  content: string;
  leaseOwner: string;
}

export interface FailConcurrentRunInput {
  errorCode: string;
  errorMessage: string;
  leaseOwner: string;
}

export interface ConcurrentRuntimeStatus {
  ready: boolean;
  mode: "concurrent_service";
  supportedCapabilities: readonly string[];
}
