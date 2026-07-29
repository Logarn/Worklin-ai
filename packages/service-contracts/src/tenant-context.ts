import { z } from "zod";

export const RUNTIME_TENANT_CONTEXT_VERSION = 1 as const;
export const TENANT_EXECUTION_CONTEXT_VERSION = 1 as const;

const opaqueIdentifierSchema = z.string().trim().min(1).max(512);

export const RuntimeTenantContextClaimSchema = z
  .object({
    version: z.literal(RUNTIME_TENANT_CONTEXT_VERSION),
    organization_id: opaqueIdentifierSchema,
    user_id: opaqueIdentifierSchema,
    assistant_id: opaqueIdentifierSchema,
    actor_id: opaqueIdentifierSchema,
    request_id: opaqueIdentifierSchema,
  })
  .strict();

export type RuntimeTenantContextClaim = z.infer<
  typeof RuntimeTenantContextClaimSchema
>;

export const RuntimeServiceTenantContextClaimSchema = z
  .object({
    version: z.literal(RUNTIME_TENANT_CONTEXT_VERSION),
    assistant_id: opaqueIdentifierSchema,
    service_id: z.literal("gateway"),
    request_id: opaqueIdentifierSchema,
    organization_id: opaqueIdentifierSchema.optional(),
  })
  .strict();

export type RuntimeServiceTenantContextClaim = z.infer<
  typeof RuntimeServiceTenantContextClaimSchema
>;

export const TenantExecutionContextSchema = z
  .object({
    version: z.literal(TENANT_EXECUTION_CONTEXT_VERSION),
    organizationId: opaqueIdentifierSchema,
    userId: opaqueIdentifierSchema,
    assistantId: opaqueIdentifierSchema,
    actorId: opaqueIdentifierSchema,
    requestId: opaqueIdentifierSchema,
    conversationId: opaqueIdentifierSchema.optional(),
    idempotencyKey: opaqueIdentifierSchema.optional(),
    authorizationVersion: z.number().int().nonnegative(),
    configVersion: z.number().int().positive(),
    runtimeGeneration: z.number().int().positive(),
  })
  .strict();

export type TenantExecutionContext = Readonly<
  z.infer<typeof TenantExecutionContextSchema>
>;

export const RUNTIME_TENANT_HEADER_NAMES = {
  version: "x-worklin-tenant-context-version",
  organizationId: "x-worklin-org-id",
  userId: "x-worklin-user-id",
  assistantId: "x-worklin-assistant-id",
  actorId: "x-worklin-actor-id",
  requestId: "x-worklin-request-id",
} as const;

export function parseRuntimeTenantContextClaim(
  value: unknown,
): RuntimeTenantContextClaim | null {
  const result = RuntimeTenantContextClaimSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseRuntimeServiceTenantContextClaim(
  value: unknown,
): RuntimeServiceTenantContextClaim | null {
  const result = RuntimeServiceTenantContextClaimSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function createTenantExecutionContext(input: {
  claim: RuntimeTenantContextClaim;
  authorizationVersion: number;
  configVersion: number;
  runtimeGeneration: number;
  conversationId?: string;
  idempotencyKey?: string;
}): TenantExecutionContext {
  return TenantExecutionContextSchema.parse({
    version: TENANT_EXECUTION_CONTEXT_VERSION,
    organizationId: input.claim.organization_id,
    userId: input.claim.user_id,
    assistantId: input.claim.assistant_id,
    actorId: input.claim.actor_id,
    requestId: input.claim.request_id,
    ...(input.conversationId
      ? { conversationId: input.conversationId }
      : {}),
    ...(input.idempotencyKey
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    authorizationVersion: input.authorizationVersion,
    configVersion: input.configVersion,
    runtimeGeneration: input.runtimeGeneration,
  });
}

export function runtimeTenantContextClaimFromExecutionContext(
  context: TenantExecutionContext,
): RuntimeTenantContextClaim {
  return {
    version: RUNTIME_TENANT_CONTEXT_VERSION,
    organization_id: context.organizationId,
    user_id: context.userId,
    assistant_id: context.assistantId,
    actor_id: context.actorId,
    request_id: context.requestId,
  };
}

export function applyRuntimeTenantContextHeaders(
  headers: Headers,
  context: RuntimeTenantContextClaim | null,
): void {
  for (const headerName of Object.values(RUNTIME_TENANT_HEADER_NAMES)) {
    headers.delete(headerName);
  }
  if (!context) return;
  headers.set(
    RUNTIME_TENANT_HEADER_NAMES.version,
    String(context.version),
  );
  headers.set(
    RUNTIME_TENANT_HEADER_NAMES.organizationId,
    context.organization_id,
  );
  headers.set(RUNTIME_TENANT_HEADER_NAMES.userId, context.user_id);
  headers.set(RUNTIME_TENANT_HEADER_NAMES.assistantId, context.assistant_id);
  headers.set(RUNTIME_TENANT_HEADER_NAMES.actorId, context.actor_id);
  headers.set(RUNTIME_TENANT_HEADER_NAMES.requestId, context.request_id);
}

export function validateRuntimeTenantContextHeaders(
  headers: Headers,
  context: RuntimeTenantContextClaim,
): string | null {
  const expected = {
    version: String(context.version),
    organizationId: context.organization_id,
    userId: context.user_id,
    assistantId: context.assistant_id,
    actorId: context.actor_id,
    requestId: context.request_id,
  };
  for (const [field, headerName] of Object.entries(
    RUNTIME_TENANT_HEADER_NAMES,
  ) as Array<
    [
      keyof typeof RUNTIME_TENANT_HEADER_NAMES,
      (typeof RUNTIME_TENANT_HEADER_NAMES)[keyof typeof RUNTIME_TENANT_HEADER_NAMES],
    ]
  >) {
    if (headers.get(headerName) !== expected[field]) {
      return `tenant_context_header_mismatch:${field}`;
    }
  }
  return null;
}

export function tenantExecutionScopeKey(
  context: Pick<
    TenantExecutionContext,
    "organizationId" | "assistantId"
  >,
): string {
  return JSON.stringify([context.organizationId, context.assistantId]);
}

export function tenantConversationScopeKey(
  context: Pick<
    TenantExecutionContext,
    "organizationId" | "assistantId"
  >,
  conversationId: string,
): string {
  return JSON.stringify([
    context.organizationId,
    context.assistantId,
    conversationId,
  ]);
}
