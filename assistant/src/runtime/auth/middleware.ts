/**
 * JWT bearer auth middleware for the runtime HTTP server.
 *
 * Extracts `Authorization: Bearer <token>`, verifies the JWT, and
 * builds an AuthContext from the claims.
 *
 * Accepts two JWT audiences:
 *   - `vellum-daemon` — primary audience, used by the gateway's runtime
 *     proxy after token exchange.
 *   - `vellum-gateway` — fallback audience, used by direct local clients
 *     (e.g., the macOS app's SettingsStore) that hold a guardian-issued
 *     JWT but call daemon endpoints directly without routing through the
 *     gateway's runtime proxy. Both daemon and gateway share the same
 *     HMAC signing key (~/.vellum/protected/actor-token-signing-key),
 *     so the signature is valid regardless of audience.
 *
 * Replaces both the legacy bearer shared-secret check and the
 * actor-token HMAC middleware with a single JWT verification path.
 *
 * When DISABLE_HTTP_AUTH is set (platform-managed deployments), JWT
 * verification is skipped and a synthetic AuthContext is constructed
 * so downstream code always has a typed context to consume.
 */

import {
  getRuntimeWorkerLeaseAuthorityFile,
  getRuntimeWorkerStackId,
  isHttpAuthDisabled,
  isPlatformIsolatedRuntime,
  isPooledWorkerRuntime,
} from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { extractBearerToken } from "../middleware/auth.js";
import { buildAuthContext } from "./context.js";
import {
  createPooledWorkerLeaseFileAuthority,
  validatePooledWorkerServiceAuthorization,
} from "./pooled-worker-service-auth.js";
import { validateRuntimeTenantContext } from "./runtime-tenant-context.js";
import { resolveScopeProfile } from "./scopes.js";
import { verifyToken } from "./token-service.js";
import type { AuthContext } from "./types.js";

const log = getLogger("auth-middleware");

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type AuthenticateResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// Dev bypass synthetic context
// ---------------------------------------------------------------------------

/**
 * Construct a synthetic AuthContext for dev mode when auth is bypassed.
 * Grants the broadest profile so all routes are accessible during
 * local development.
 */
function buildDevBypassContext(): AuthContext {
  return {
    subject: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:dev-bypass`,
    principalType: "actor",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    actorPrincipalId: "dev-bypass",
    scopeProfile: "actor_client_v1",
    scopes: resolveScopeProfile("actor_client_v1"),
    policyEpoch: Number.MAX_SAFE_INTEGER,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming HTTP request via JWT bearer token.
 *
 * Returns an AuthContext on success, or an error Response on failure.
 * The caller should return the error Response directly to the client.
 */
export function authenticateRequest(req: Request): AuthenticateResult {
  // Dev bypass: skip JWT verification entirely
  if (isHttpAuthDisabled() && !isPlatformIsolatedRuntime()) {
    return { ok: true, context: buildDevBypassContext() };
  }

  const path = new URL(req.url).pathname;

  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    log.warn(
      { reason: "missing_token", path },
      "Auth denied: missing Authorization header",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Missing Authorization header",
          },
        },
        { status: 401 },
      ),
    };
  }

  // Verify the JWT — prefer vellum-daemon audience (gateway-proxied requests
  // and daemon-minted tokens), but also accept vellum-gateway audience for
  // direct local clients (macOS SettingsStore) that hold a guardian-issued JWT
  // and call daemon endpoints without routing through the gateway runtime proxy.
  let verifyResult = verifyToken(rawToken, "vellum-daemon");
  if (
    !verifyResult.ok &&
    verifyResult.reason?.startsWith("audience_mismatch")
  ) {
    verifyResult = verifyToken(rawToken, "vellum-gateway");
    // Normalize gateway-audience claims to daemon context so that
    // buildAuthContext applies the same assistantId normalization
    // (aud=vellum-daemon → assistantId='self') that gateway-exchanged
    // tokens receive. Without this rewrite, the external assistant ID
    // from the guardian-issued JWT would leak into daemon-internal
    // scoping (storage keys, routing), violating the invariant
    // documented in context.ts:30-33.
    if (verifyResult.ok) {
      verifyResult = {
        ok: true,
        claims: { ...verifyResult.claims, aud: "vellum-daemon" },
      };
    }
  }
  if (!verifyResult.ok) {
    // Stale policy epoch gets a specific error code so clients can refresh
    if (verifyResult.reason === "stale_policy_epoch") {
      log.warn(
        { reason: "stale_policy_epoch", path },
        "Auth denied: stale policy epoch",
      );
      return {
        ok: false,
        response: Response.json(
          {
            error: {
              code: "refresh_required",
              message: "Token policy epoch is stale; refresh required",
            },
          },
          { status: 401 },
        ),
      };
    }

    log.warn(
      { reason: verifyResult.reason, path },
      "Auth denied: JWT verification failed",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid token: ${verifyResult.reason}`,
          },
        },
        { status: 401 },
      ),
    };
  }

  const pooledRuntime = isPooledWorkerRuntime();
  const expectedWorkerStackId = getRuntimeWorkerStackId();
  const pooledServiceResult = validatePooledWorkerServiceAuthorization({
    claims: verifyResult.claims,
    pooledRuntime,
    expectedWorkerStackId,
    authority: pooledRuntime
      ? createPooledWorkerLeaseFileAuthority(
          getRuntimeWorkerLeaseAuthorityFile(),
          expectedWorkerStackId,
        )
      : null,
  });
  if (!pooledServiceResult.ok) {
    log.warn(
      { reason: pooledServiceResult.reason, path },
      "Auth denied: invalid pooled worker lease identity",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: pooledServiceResult.unavailable
              ? "SERVICE_UNAVAILABLE"
              : "FORBIDDEN",
            message: pooledServiceResult.unavailable
              ? "Pooled worker lease authority unavailable"
              : "Invalid pooled worker lease identity",
          },
        },
        { status: pooledServiceResult.unavailable ? 503 : 403 },
      ),
    };
  }

  const tenantResult = validateRuntimeTenantContext(
    req.headers,
    verifyResult.claims,
  );
  if (!tenantResult.ok) {
    log.warn(
      { reason: tenantResult.reason, path },
      "Auth denied: invalid runtime tenant context",
    );
    const unavailable =
      tenantResult.reason === "tenant_context_runtime_identity_missing";
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: unavailable ? "SERVICE_UNAVAILABLE" : "FORBIDDEN",
            message: unavailable
              ? "Runtime assistant identity unavailable"
              : "Invalid runtime tenant context",
          },
        },
        { status: unavailable ? 503 : 403 },
      ),
    };
  }

  // Build normalized AuthContext from verified claims and the independently
  // validated tenant envelope.
  const contextResult = buildAuthContext(
    verifyResult.claims,
    tenantResult.context,
    tenantResult.serviceContext,
    pooledRuntime && verifyResult.claims.pooled_worker_lease
      ? {
          version: 1,
          organizationId:
            verifyResult.claims.pooled_worker_lease.organization_id,
          userId: verifyResult.claims.pooled_worker_lease.user_id,
          assistantId: verifyResult.claims.pooled_worker_lease.assistant_id,
          workerStackId:
            verifyResult.claims.pooled_worker_lease.worker_stack_id,
          leaseGeneration:
            verifyResult.claims.pooled_worker_lease.lease_generation,
          leaseExpiresAtSeconds:
            verifyResult.claims.pooled_worker_lease.lease_expires_at,
        }
      : undefined,
  );
  if (!contextResult.ok) {
    log.warn(
      { reason: contextResult.reason, path, sub: verifyResult.claims.sub },
      "Auth denied: invalid JWT claims",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid token claims: ${contextResult.reason}`,
          },
        },
        { status: 401 },
      ),
    };
  }

  return { ok: true, context: contextResult.context };
}
