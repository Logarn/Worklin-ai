import { parseSub } from "./subject.js";
import type { RuntimeTenantContextClaim, TokenClaims } from "./types.js";

const TENANT_HEADER_NAMES = {
  version: "x-worklin-tenant-context-version",
  organization_id: "x-worklin-org-id",
  user_id: "x-worklin-user-id",
  assistant_id: "x-worklin-assistant-id",
  actor_id: "x-worklin-actor-id",
  request_id: "x-worklin-request-id",
} as const;

export type RuntimeTenantContextValidation =
  | { ok: true; context: RuntimeTenantContextClaim | null }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRuntimeTenantContext(
  value: unknown,
): RuntimeTenantContextClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  if (
    context.version !== 1 ||
    !isNonEmptyString(context.organization_id) ||
    !isNonEmptyString(context.user_id) ||
    !isNonEmptyString(context.assistant_id) ||
    !isNonEmptyString(context.actor_id) ||
    !isNonEmptyString(context.request_id)
  ) {
    return null;
  }
  return context as unknown as RuntimeTenantContextClaim;
}

export function validateRuntimeTenantContext(
  headers: Headers,
  claims: TokenClaims,
  options: {
    required: boolean;
    expectedAssistantId?: string | null;
    requestedAssistantId?: string | null;
    requireHeaders?: boolean;
  },
): RuntimeTenantContextValidation {
  if (claims.tenant_context === undefined) {
    return options.required
      ? { ok: false, reason: "missing_tenant_context_claim" }
      : { ok: true, context: null };
  }

  const context = parseRuntimeTenantContext(claims.tenant_context);
  if (!context) {
    return { ok: false, reason: "malformed_tenant_context_claim" };
  }

  const subject = parseSub(claims.sub);
  if (
    !subject.ok ||
    subject.principalType !== "actor" ||
    subject.assistantId !== context.assistant_id ||
    subject.actorPrincipalId !== context.actor_id
  ) {
    return { ok: false, reason: "tenant_context_subject_mismatch" };
  }
  if (
    options.expectedAssistantId &&
    context.assistant_id !== options.expectedAssistantId
  ) {
    return { ok: false, reason: "tenant_context_runtime_mismatch" };
  }
  if (
    options.requestedAssistantId &&
    context.assistant_id !== options.requestedAssistantId
  ) {
    return { ok: false, reason: "tenant_context_path_mismatch" };
  }

  if (options.requireHeaders !== false) {
    const expectedHeaders = {
      version: String(context.version),
      organization_id: context.organization_id,
      user_id: context.user_id,
      assistant_id: context.assistant_id,
      actor_id: context.actor_id,
      request_id: context.request_id,
    };
    for (const [field, headerName] of Object.entries(TENANT_HEADER_NAMES)) {
      if (
        headers.get(headerName) !==
        expectedHeaders[field as keyof typeof expectedHeaders]
      ) {
        return {
          ok: false,
          reason: `tenant_context_header_mismatch:${field}`,
        };
      }
    }
  }

  return { ok: true, context };
}

export function applyRuntimeTenantContextHeaders(
  headers: Headers,
  context: RuntimeTenantContextClaim | null,
): void {
  for (const headerName of Object.values(TENANT_HEADER_NAMES)) {
    headers.delete(headerName);
  }
  if (!context) return;
  headers.set(TENANT_HEADER_NAMES.version, String(context.version));
  headers.set(TENANT_HEADER_NAMES.organization_id, context.organization_id);
  headers.set(TENANT_HEADER_NAMES.user_id, context.user_id);
  headers.set(TENANT_HEADER_NAMES.assistant_id, context.assistant_id);
  headers.set(TENANT_HEADER_NAMES.actor_id, context.actor_id);
  headers.set(TENANT_HEADER_NAMES.request_id, context.request_id);
}

export function applyRuntimeTenantContextRecord(
  headers: Record<string, string>,
  context: RuntimeTenantContextClaim | null,
): void {
  for (const headerName of Object.values(TENANT_HEADER_NAMES)) {
    delete headers[headerName];
  }
  if (!context) return;
  headers[TENANT_HEADER_NAMES.version] = String(context.version);
  headers[TENANT_HEADER_NAMES.organization_id] = context.organization_id;
  headers[TENANT_HEADER_NAMES.user_id] = context.user_id;
  headers[TENANT_HEADER_NAMES.assistant_id] = context.assistant_id;
  headers[TENANT_HEADER_NAMES.actor_id] = context.actor_id;
  headers[TENANT_HEADER_NAMES.request_id] = context.request_id;
}
