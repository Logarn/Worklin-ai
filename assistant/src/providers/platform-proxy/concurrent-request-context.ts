import { AsyncLocalStorage } from "node:async_hooks";

import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

import { isConcurrentServiceRuntime } from "../../config/env.js";

interface ConcurrentManagedProviderScope {
  active: boolean;
  assistantId: string;
  requestId: string;
}

const requestContext = new AsyncLocalStorage<ConcurrentManagedProviderScope>();

export async function runWithConcurrentManagedProviderContext<T>(
  context: TenantExecutionContext,
  handler: () => Promise<T> | T,
): Promise<T> {
  if (!isConcurrentServiceRuntime()) return handler();

  const scope: ConcurrentManagedProviderScope = {
    active: true,
    assistantId: context.assistantId,
    requestId: context.requestId,
  };
  try {
    return await requestContext.run(scope, handler);
  } finally {
    scope.active = false;
  }
}

export function concurrentManagedProviderContextIsActive(): boolean {
  if (!isConcurrentServiceRuntime()) return false;
  const scope = requestContext.getStore();
  return Boolean(scope?.active && scope.assistantId && scope.requestId);
}
