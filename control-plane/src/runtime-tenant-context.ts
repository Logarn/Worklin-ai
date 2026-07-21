import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { AssistantRow } from "./assistant-store.js";
import { platformOwnerPrincipalId } from "./platform-owner-principal.js";
import type { RuntimeStackRow } from "./runtime-stacks.js";

export const RUNTIME_TENANT_CONTEXT_VERSION = 1;

export interface RuntimeTenantContext {
  version: typeof RUNTIME_TENANT_CONTEXT_VERSION;
  organizationId: string;
  userId: string;
  assistantId: string;
  actorId: string;
  requestId: string;
}

export interface RuntimeTenantContextClaim {
  version: typeof RUNTIME_TENANT_CONTEXT_VERSION;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  actor_id: string;
  request_id: string;
}

export class RuntimeTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTenantContextError";
  }
}

export function getOwnedAssistantForRuntime(
  db: Database,
  assistantId: string,
  userId: string,
): AssistantRow | null {
  return (
    db
      .query<AssistantRow, [string, string]>(
        `SELECT assistant.*
         FROM assistants AS assistant
         JOIN organizations AS organization
           ON organization.id = assistant.org_id
          AND organization.user_id = assistant.user_id
         WHERE assistant.id = ?
           AND assistant.user_id = ?`,
      )
      .get(assistantId, userId) ?? null
  );
}

export function createRuntimeTenantContext(
  assistant: AssistantRow,
  userId: string,
  runtimeStack: RuntimeStackRow,
  requestId = randomUUID(),
): RuntimeTenantContext {
  if (!userId || !requestId) {
    throw new RuntimeTenantContextError(
      "Runtime tenant context requires a user and request identity.",
    );
  }
  // Workspace authorization is enforced before this helper is called. Keep
  // the tenant owner stable for pooled state and admission while attributing
  // the action to the authenticated owner, manager, or collaborator.
  if (
    runtimeStack.assistant_id !== assistant.id ||
    runtimeStack.org_id !== assistant.org_id
  ) {
    throw new RuntimeTenantContextError(
      "Runtime identity does not match the assistant tenant.",
    );
  }

  return {
    version: RUNTIME_TENANT_CONTEXT_VERSION,
    organizationId: assistant.org_id,
    userId: assistant.user_id,
    assistantId: assistant.id,
    actorId: platformOwnerPrincipalId(userId),
    requestId,
  };
}

export function runtimeTenantContextClaim(
  context: RuntimeTenantContext,
): RuntimeTenantContextClaim {
  return {
    version: context.version,
    organization_id: context.organizationId,
    user_id: context.userId,
    assistant_id: context.assistantId,
    actor_id: context.actorId,
    request_id: context.requestId,
  };
}

export function applyRuntimeTenantHeaders(
  headers: Headers,
  context: RuntimeTenantContext,
): void {
  headers.set("X-Worklin-Tenant-Context-Version", String(context.version));
  headers.set("X-Worklin-Org-Id", context.organizationId);
  headers.set("X-Worklin-User-Id", context.userId);
  headers.set("X-Worklin-Assistant-Id", context.assistantId);
  headers.set("X-Worklin-Actor-Id", context.actorId);
  headers.set("X-Worklin-Request-Id", context.requestId);
}
