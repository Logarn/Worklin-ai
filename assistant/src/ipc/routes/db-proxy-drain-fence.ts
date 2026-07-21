import type { AuthContext } from "../../runtime/auth/types.js";
import { acquirePooledRuntimeRouteRequest } from "../../runtime/pooled-runtime-drain-fence.js";

export type DatabaseProxyOperationId = "db_proxy" | "db_proxy_transaction";

export function runDatabaseProxyWithPooledRuntimeDrainFence<T>(
  authContext: AuthContext | undefined,
  operationId: DatabaseProxyOperationId,
  operation: () => PromiseLike<T>,
): Promise<T>;
export function runDatabaseProxyWithPooledRuntimeDrainFence<T>(
  authContext: AuthContext | undefined,
  operationId: DatabaseProxyOperationId,
  operation: () => T,
): T;
export function runDatabaseProxyWithPooledRuntimeDrainFence<T>(
  authContext: AuthContext | undefined,
  operationId: DatabaseProxyOperationId,
  operation: () => T | PromiseLike<T>,
): T | Promise<T> {
  const release = acquirePooledRuntimeRouteRequest(authContext, operationId);
  let result: T | PromiseLike<T>;
  try {
    result = operation();
  } catch (error) {
    release();
    throw error;
  }

  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(release);
  }
  release();
  return result;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
