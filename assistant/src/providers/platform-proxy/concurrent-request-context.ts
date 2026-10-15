import { AsyncLocalStorage } from "node:async_hooks";

import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

import { isConcurrentServiceRuntime } from "../../config/env.js";
import type { ConcurrentProviderConfig } from "./concurrent-provider-config.js";

export interface ConcurrentProviderRequestConfig extends ConcurrentProviderConfig {
  key: string;
}

export type ConcurrentProviderConfigResolver =
  () => Promise<ConcurrentProviderRequestConfig>;

interface ConcurrentManagedProviderScope {
  active: boolean;
  assistantId: string;
  requestId: string;
  providerConfig: ConcurrentProviderRequestConfig | null;
}

const requestContext = new AsyncLocalStorage<ConcurrentManagedProviderScope>();

export async function runWithConcurrentManagedProviderContext<T>(
  context: TenantExecutionContext,
  providerConfig: ConcurrentProviderRequestConfig | null,
  handler: () => Promise<T> | T,
): Promise<T> {
  if (!isConcurrentServiceRuntime()) return handler();

  const scope: ConcurrentManagedProviderScope = {
    active: true,
    assistantId: context.assistantId,
    requestId: context.requestId,
    providerConfig: providerConfig ? { ...providerConfig } : null,
  };
  try {
    return await requestContext.run(scope, handler);
  } finally {
    scope.active = false;
    if (scope.providerConfig) scope.providerConfig.key = "";
    scope.providerConfig = null;
  }
}

export function concurrentManagedProviderContextIsActive(): boolean {
  if (!isConcurrentServiceRuntime()) return false;
  const scope = requestContext.getStore();
  return Boolean(scope?.active && scope.assistantId && scope.requestId);
}

export function getConcurrentProviderRequestConfig(): ConcurrentProviderRequestConfig | null {
  if (!isConcurrentServiceRuntime()) return null;
  const scope = requestContext.getStore();
  return scope?.active ? scope.providerConfig : null;
}
