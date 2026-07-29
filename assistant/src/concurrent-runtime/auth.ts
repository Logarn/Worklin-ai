import {
  parseRuntimeTenantContextClaim,
  type RuntimeTenantContextClaim,
  validateRuntimeTenantContextHeaders,
} from "@vellumai/service-contracts/tenant-context";

import { resolveScopeProfile } from "../runtime/auth/scopes.js";
import { parseSub } from "../runtime/auth/subject.js";
import { verifyToken } from "../runtime/auth/token-service.js";
import type { Scope, TokenClaims } from "../runtime/auth/types.js";

export interface ConcurrentAuthenticatedTenant {
  claim: RuntimeTenantContextClaim;
  authorizationVersion: number;
  tokenId?: string;
}

export type ConcurrentAuthenticationResult =
  | { ok: true; tenant: ConcurrentAuthenticatedTenant }
  | { ok: false; reason: string; status: 401 | 403 };

export function validateConcurrentRuntimeClaims(
  headers: Headers,
  claims: TokenClaims,
  requiredScope: Scope,
): ConcurrentAuthenticationResult {
  if (claims.service_tenant_context !== undefined) {
    return {
      ok: false,
      reason: "service_tenant_context_not_supported",
      status: 403,
    };
  }
  if (claims.pooled_worker_lease !== undefined) {
    return {
      ok: false,
      reason: "pooled_worker_lease_not_supported",
      status: 403,
    };
  }
  const claim = parseRuntimeTenantContextClaim(claims.tenant_context);
  if (!claim) {
    return {
      ok: false,
      reason: "missing_or_malformed_tenant_context",
      status: 403,
    };
  }
  const subject = parseSub(claims.sub);
  if (
    !subject.ok ||
    subject.principalType !== "actor" ||
    subject.assistantId !== "self" ||
    subject.actorPrincipalId !== claim.actor_id
  ) {
    return {
      ok: false,
      reason: "tenant_context_subject_mismatch",
      status: 403,
    };
  }
  const headerError = validateRuntimeTenantContextHeaders(headers, claim);
  if (headerError) {
    return { ok: false, reason: headerError, status: 403 };
  }
  const scopes = resolveScopeProfile(claims.scope_profile);
  if (!scopes.has(requiredScope)) {
    return {
      ok: false,
      reason: `missing_scope:${requiredScope}`,
      status: 403,
    };
  }
  return {
    ok: true,
    tenant: {
      claim,
      authorizationVersion: claims.policy_epoch,
      ...(claims.jti ? { tokenId: claims.jti } : {}),
    },
  };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function authenticateConcurrentRuntimeRequest(
  request: Request,
  requiredScope: Scope,
): ConcurrentAuthenticationResult {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, reason: "missing_token", status: 401 };
  }
  const verified = verifyToken(token, "vellum-daemon");
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      status: 401,
    };
  }
  return validateConcurrentRuntimeClaims(
    request.headers,
    verified.claims,
    requiredScope,
  );
}
