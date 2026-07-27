/**
 * Filters the ROUTES array down to IPC-eligible routes and appends the
 * meta-route used by the gateway for IPC proxy discovery.
 *
 * The schema includes each route's policy verbatim — the gateway's
 * IPC proxy enforces equivalent scope/principal checks without
 * maintaining a parallel table. The policy is a property of each
 * RouteDefinition; no lookup or derivation happens here.
 */

import { isPlatformIsolatedRuntime } from "../../config/env.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { authenticateRequest } from "../../runtime/auth/middleware.js";
import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { enforcePolicy } from "../../runtime/auth/route-policy.js";
import { normalizedRouteHeaders } from "../../runtime/auth/runtime-tenant-context.js";
import { resolveScopeProfile } from "../../runtime/auth/scopes.js";
import type { AuthContext } from "../../runtime/auth/types.js";
import { acquirePooledRuntimeRouteRequest } from "../../runtime/pooled-runtime-drain-fence.js";
import {
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../runtime/routes/errors.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";

const authenticatedRouteArgs = new WeakSet<object>();

function isIpcEligible(r: RouteDefinition): boolean {
  return !r.requireGuardian && !r.isPublic;
}

/**
 * Wire-shape entry returned by `get_route_schema`. Matches the gateway's
 * `RouteSchemaEntry` (see `gateway/src/ipc/route-schema-cache.ts`).
 *
 * `policy: null` means the daemon has explicitly registered the route as
 * unprotected (e.g. health, debug). The gateway respects that and
 * skips enforcement. `policy: { ... }` carries the same scopes /
 * principal types the daemon's HTTP path enforces via `enforcePolicy()`.
 */
interface IpcRouteSchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
  policy: {
    requiredScopes: string[];
    allowedPrincipalTypes: string[];
  } | null;
}

function toSchemaEntry(r: RouteDefinition): IpcRouteSchemaEntry {
  return {
    operationId: r.operationId,
    endpoint: r.endpoint,
    method: r.method,
    policy: r.policy
      ? {
          // Spread into mutable string[] for serialization — the wire
          // shape doesn't carry the `Scope` / `PrincipalType` narrowing.
          requiredScopes: [...r.policy.requiredScopes],
          allowedPrincipalTypes: [...r.policy.allowedPrincipalTypes],
        }
      : null,
  };
}

export function authenticateIpcRouteArgs(
  args: Parameters<RouteDefinition["handler"]>[0],
  endpoint: string,
  method: string,
): Parameters<RouteDefinition["handler"]>[0] {
  if (authenticatedRouteArgs.has(args)) return args;

  const { authContext: _untrustedAuthContext, ...untrustedArgs } = args;
  const rawHeaders = untrustedArgs.headers ?? {};
  const authorization = Object.entries(rawHeaders).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (!authorization && !isPlatformIsolatedRuntime()) {
    const authContext = buildLocalIpcAuthContext(rawHeaders);
    return markAuthenticated({
      ...untrustedArgs,
      authContext,
      headers: normalizedRouteHeaders(rawHeaders, authContext),
    });
  }

  const authResult = authenticateRequest(
    new Request(`http://assistant.local/v1/${endpoint}`, {
      method,
      headers: new Headers(rawHeaders),
    }),
  );
  if (!authResult.ok) {
    if (authResult.response.status === 503) {
      throw new ServiceUnavailableError("Runtime identity unavailable");
    }
    if (authResult.response.status === 403) {
      throw new ForbiddenError("Invalid IPC tenant context");
    }
    throw new UnauthorizedError("IPC authentication failed");
  }

  return markAuthenticated({
    ...untrustedArgs,
    authContext: authResult.context,
    headers: normalizedRouteHeaders(rawHeaders, authResult.context),
  });
}

function markAuthenticated(
  args: Parameters<RouteDefinition["handler"]>[0],
): Parameters<RouteDefinition["handler"]>[0] {
  authenticatedRouteArgs.add(args);
  return args;
}

function buildLocalIpcAuthContext(
  headers: Record<string, string>,
): AuthContext {
  const actorPrincipalId = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "x-vellum-actor-principal-id",
  )?.[1];
  return {
    subject: "local:self:ipc",
    principalType: "local",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    ...(actorPrincipalId ? { actorPrincipalId } : {}),
    conversationId: "ipc",
    scopeProfile: "local_v1",
    scopes: resolveScopeProfile("local_v1"),
    policyEpoch: CURRENT_POLICY_EPOCH,
  };
}

function enforceIpcRoutePolicy(
  route: RouteDefinition,
  authContext: AuthContext | undefined,
): void {
  if (!authContext) {
    throw new UnauthorizedError("IPC authentication failed");
  }
  const denied = enforcePolicy(route.endpoint, route.policy, authContext);
  if (denied) {
    throw new ForbiddenError("IPC route policy denied");
  }
}

function withAuthenticatedTenantContext(
  route: RouteDefinition,
): RouteDefinition {
  const originalHandler = route.handler;
  return {
    ...route,
    handler: async (args) => {
      const authenticated = authenticateIpcRouteArgs(
        args,
        route.endpoint,
        route.method,
      );
      enforceIpcRoutePolicy(route, authenticated.authContext);
      const release = acquirePooledRuntimeRouteRequest(
        authenticated.authContext,
        route.operationId,
      );
      try {
        const result = await originalHandler(authenticated);
        if (isStreamingRouteResult(result)) {
          return {
            ...result,
            stream: streamWithActivityRelease(result.stream, release),
          };
        }
        if (result instanceof ReadableStream) {
          return streamWithActivityRelease(result, release);
        }
        release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

function isStreamingRouteResult(
  value: unknown,
): value is { stream: ReadableStream<Uint8Array> } & Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "stream" in value &&
    (value as { stream?: unknown }).stream instanceof ReadableStream
  );
}

function streamWithActivityRelease(
  source: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}

export function routeDefinitionsToIpcMethods(
  routes: RouteDefinition[],
): RouteDefinition[] {
  const eligible = routes.filter(isIpcEligible);
  const authenticated = eligible.map(withAuthenticatedTenantContext);

  // Meta-route: exposes the route schema to the gateway for IPC proxy
  // discovery. Lives here (not in ROUTES) because it describes ROUTES itself.
  const metaRoute: RouteDefinition = {
    operationId: "get_route_schema",
    method: "GET",
    endpoint: "_internal/route-schema",
    // The IPC route schema endpoint is the gateway's bootstrap call —
    // it runs before any policy table is in scope and has no actor
    // scopes attached. Explicitly unprotected.
    policy: null,
    handler: async () => eligible.map(toSchemaEntry),
  };

  return [...authenticated, metaRoute];
}
