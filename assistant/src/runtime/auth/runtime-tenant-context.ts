import {
  getPlatformAssistantId,
  getPlatformOrganizationId,
  isPlatformIsolatedRuntime,
} from "../../config/env.js";
import { parseSub } from "./subject.js";
import type {
  AuthContext,
  RuntimeServiceTenantContext,
  RuntimeServiceTenantContextClaim,
  RuntimeTenantContext,
  RuntimeTenantContextClaim,
  TokenClaims,
} from "./types.js";

export const RUNTIME_TENANT_HEADER_NAMES = {
  version: "x-worklin-tenant-context-version",
  organizationId: "x-worklin-org-id",
  userId: "x-worklin-user-id",
  assistantId: "x-worklin-assistant-id",
  actorId: "x-worklin-actor-id",
  requestId: "x-worklin-request-id",
} as const;
const RUNTIME_SERVICE_TENANT_HEADER_NAME = "x-worklin-service-id";

export type RuntimeTenantContextValidation =
  | {
      ok: true;
      context: RuntimeTenantContext | undefined;
      serviceContext: RuntimeServiceTenantContext | undefined;
    }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeClaim(value: unknown): RuntimeTenantContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Partial<RuntimeTenantContextClaim>;
  if (
    claim.version !== 1 ||
    !isNonEmptyString(claim.organization_id) ||
    !isNonEmptyString(claim.user_id) ||
    !isNonEmptyString(claim.assistant_id) ||
    !isNonEmptyString(claim.actor_id) ||
    !isNonEmptyString(claim.request_id)
  ) {
    return null;
  }
  return {
    version: 1,
    organizationId: claim.organization_id,
    userId: claim.user_id,
    assistantId: claim.assistant_id,
    actorId: claim.actor_id,
    requestId: claim.request_id,
  };
}

function normalizeServiceClaim(
  value: unknown,
): RuntimeServiceTenantContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Partial<RuntimeServiceTenantContextClaim>;
  if (
    claim.version !== 1 ||
    !isNonEmptyString(claim.assistant_id) ||
    claim.service_id !== "gateway" ||
    !isNonEmptyString(claim.request_id) ||
    (claim.organization_id !== undefined &&
      !isNonEmptyString(claim.organization_id))
  ) {
    return null;
  }
  return {
    version: 1,
    assistantId: claim.assistant_id,
    serviceId: "gateway",
    requestId: claim.request_id,
    ...(claim.organization_id ? { organizationId: claim.organization_id } : {}),
  };
}

export function validateRuntimeTenantContext(
  headers: Headers,
  claims: TokenClaims,
): RuntimeTenantContextValidation {
  const subject = parseSub(claims.sub);
  const required =
    isPlatformIsolatedRuntime() &&
    subject.ok &&
    subject.principalType === "actor";
  const serviceRequired =
    isPlatformIsolatedRuntime() &&
    subject.ok &&
    subject.principalType === "svc_gateway";
  if (
    isPlatformIsolatedRuntime() &&
    subject.ok &&
    (subject.principalType === "svc_daemon" ||
      subject.principalType === "local")
  ) {
    return {
      ok: false,
      reason: `unsupported_platform_principal:${subject.principalType}`,
    };
  }
  if (
    claims.tenant_context !== undefined &&
    claims.service_tenant_context !== undefined
  ) {
    return { ok: false, reason: "ambiguous_tenant_context_claims" };
  }
  if (claims.tenant_context === undefined) {
    if (required) return { ok: false, reason: "missing_tenant_context_claim" };
    if (claims.service_tenant_context === undefined) {
      return serviceRequired
        ? { ok: false, reason: "missing_service_tenant_context_claim" }
        : { ok: true, context: undefined, serviceContext: undefined };
    }

    const serviceContext = normalizeServiceClaim(claims.service_tenant_context);
    if (!serviceContext) {
      return { ok: false, reason: "malformed_service_tenant_context_claim" };
    }
    if (!subject.ok || subject.principalType !== "svc_gateway") {
      return { ok: false, reason: "service_tenant_context_subject_mismatch" };
    }
    const runtimeAssistantId = getPlatformAssistantId().trim();
    if (serviceRequired && !runtimeAssistantId) {
      return { ok: false, reason: "tenant_context_runtime_identity_missing" };
    }
    if (
      runtimeAssistantId &&
      serviceContext.assistantId !== runtimeAssistantId
    ) {
      return { ok: false, reason: "service_tenant_context_runtime_mismatch" };
    }
    const runtimeOrganizationId = getPlatformOrganizationId().trim();
    if (
      runtimeOrganizationId &&
      serviceContext.organizationId !== runtimeOrganizationId
    ) {
      return {
        ok: false,
        reason: "service_tenant_context_organization_mismatch",
      };
    }
    return { ok: true, context: undefined, serviceContext };
  }

  const context = normalizeClaim(claims.tenant_context);
  if (!context) {
    return { ok: false, reason: "malformed_tenant_context_claim" };
  }

  if (
    !subject.ok ||
    subject.principalType !== "actor" ||
    subject.actorPrincipalId !== context.actorId
  ) {
    return { ok: false, reason: "tenant_context_subject_mismatch" };
  }

  const runtimeAssistantId = getPlatformAssistantId().trim();
  if (required && !runtimeAssistantId) {
    return { ok: false, reason: "tenant_context_runtime_identity_missing" };
  }
  if (runtimeAssistantId && context.assistantId !== runtimeAssistantId) {
    return { ok: false, reason: "tenant_context_runtime_mismatch" };
  }

  const runtimeOrganizationId = getPlatformOrganizationId().trim();
  if (
    runtimeOrganizationId &&
    context.organizationId !== runtimeOrganizationId
  ) {
    return { ok: false, reason: "tenant_context_organization_mismatch" };
  }

  const expectedHeaders: Record<
    keyof typeof RUNTIME_TENANT_HEADER_NAMES,
    string
  > = {
    version: String(context.version),
    organizationId: context.organizationId,
    userId: context.userId,
    assistantId: context.assistantId,
    actorId: context.actorId,
    requestId: context.requestId,
  };
  for (const [field, headerName] of Object.entries(
    RUNTIME_TENANT_HEADER_NAMES,
  ) as Array<
    [
      keyof typeof RUNTIME_TENANT_HEADER_NAMES,
      (typeof RUNTIME_TENANT_HEADER_NAMES)[keyof typeof RUNTIME_TENANT_HEADER_NAMES],
    ]
  >) {
    if (headers.get(headerName) !== expectedHeaders[field]) {
      return {
        ok: false,
        reason: `tenant_context_header_mismatch:${field}`,
      };
    }
  }

  return { ok: true, context, serviceContext: undefined };
}

/**
 * Remove transport-provided identity duplicates and reconstruct only the
 * canonical values that survived signed-token validation.
 */
export function normalizedRouteHeaders(
  source: Headers | Record<string, string> | undefined,
  authContext?: AuthContext,
): Record<string, string> {
  const result: Record<string, string> = {};
  const entries =
    source instanceof Headers
      ? Array.from(source.entries())
      : Object.entries(source ?? {});
  const stripped = new Set<string>([
    "authorization",
    "x-vellum-actor-principal-id",
    "x-vellum-principal-type",
    "x-vellum-platform-owner",
    RUNTIME_SERVICE_TENANT_HEADER_NAME,
    ...Object.values(RUNTIME_TENANT_HEADER_NAMES),
  ]);

  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (!stripped.has(normalizedKey)) result[normalizedKey] = value;
  }

  if (authContext?.actorPrincipalId) {
    result["x-vellum-actor-principal-id"] = authContext.actorPrincipalId;
  }
  if (authContext?.principalType) {
    result["x-vellum-principal-type"] = authContext.principalType;
  }

  const tenant = authContext?.tenantContext;
  if (tenant) {
    result[RUNTIME_TENANT_HEADER_NAMES.version] = String(tenant.version);
    result[RUNTIME_TENANT_HEADER_NAMES.organizationId] = tenant.organizationId;
    result[RUNTIME_TENANT_HEADER_NAMES.userId] = tenant.userId;
    result[RUNTIME_TENANT_HEADER_NAMES.assistantId] = tenant.assistantId;
    result[RUNTIME_TENANT_HEADER_NAMES.actorId] = tenant.actorId;
    result[RUNTIME_TENANT_HEADER_NAMES.requestId] = tenant.requestId;
    if (authContext.principalType === "actor") {
      result["x-vellum-platform-owner"] = "true";
    }
  }

  const serviceTenant = authContext?.serviceTenantContext;
  if (serviceTenant) {
    result[RUNTIME_TENANT_HEADER_NAMES.version] = String(serviceTenant.version);
    result[RUNTIME_TENANT_HEADER_NAMES.assistantId] = serviceTenant.assistantId;
    result[RUNTIME_TENANT_HEADER_NAMES.requestId] = serviceTenant.requestId;
    result[RUNTIME_SERVICE_TENANT_HEADER_NAME] = serviceTenant.serviceId;
    if (serviceTenant.organizationId) {
      result[RUNTIME_TENANT_HEADER_NAMES.organizationId] =
        serviceTenant.organizationId;
    }
  }

  return result;
}
