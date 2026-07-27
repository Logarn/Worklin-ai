import { isPooledWorkerRuntime } from "../config/env.js";
import { ServiceUnavailableError } from "./routes/errors.js";

export type PooledRuntimeUnsupportedAsyncOperation =
  | "ACP sessions"
  | "asynchronous compaction"
  | "background jobs"
  | "background tools"
  | "background wake drains"
  | "ChatGPT subscription authentication"
  | "channel background processing"
  | "channel ingress"
  | "channel verification deliveries"
  | "conversation title jobs"
  | "debug shell jobs"
  | "launched conversations"
  | "migration jobs"
  | "MCP authentication"
  | "OAuth connections"
  | "retention onboarding surfaces"
  | "screen recordings"
  | "secure prompt callbacks"
  | "subagents"
  | "telephony calls"
  | "work-item runs"
  | "workflow runs";

export function pooledRuntimeUnsupportedAsyncMessage(
  operation: PooledRuntimeUnsupportedAsyncOperation,
): string {
  return `Pooled workers run in interactive-only mode. Unsupported operation: ${operation}.`;
}

export function assertPooledRuntimeAsyncOperationSupported(
  operation: PooledRuntimeUnsupportedAsyncOperation,
): void {
  if (!isPooledWorkerRuntime()) return;
  throw new ServiceUnavailableError(
    pooledRuntimeUnsupportedAsyncMessage(operation),
  );
}
