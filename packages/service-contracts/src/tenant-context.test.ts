import { describe, expect, test } from "bun:test";

import {
  applyRuntimeTenantContextHeaders,
  createTenantExecutionContext,
  parseRuntimeTenantContextClaim,
  RUNTIME_TENANT_CONTEXT_VERSION,
  runtimeTenantContextClaimFromExecutionContext,
  tenantConversationScopeKey,
  tenantExecutionScopeKey,
  validateRuntimeTenantContextHeaders,
} from "./tenant-context.js";

const CLAIM = {
  version: RUNTIME_TENANT_CONTEXT_VERSION,
  organization_id: "org-abc",
  user_id: "user-123",
  assistant_id: "assistant-456",
  actor_id: "actor-789",
  request_id: "request-012",
} as const;

describe("tenant context contract", () => {
  test("parses a strict signed tenant claim", () => {
    expect(parseRuntimeTenantContextClaim(CLAIM)).toEqual(CLAIM);
    expect(
      parseRuntimeTenantContextClaim({ ...CLAIM, organization_id: "" }),
    ).toBeNull();
    expect(
      parseRuntimeTenantContextClaim({ ...CLAIM, untrusted: true }),
    ).toBeNull();
  });

  test("creates an immutable execution context projection", () => {
    const context = createTenantExecutionContext({
      claim: CLAIM,
      authorizationVersion: 7,
      configVersion: 3,
      runtimeGeneration: 2,
      conversationId: "conv-xyz",
      idempotencyKey: "message-abc",
    });

    expect(context).toEqual({
      version: 1,
      organizationId: "org-abc",
      userId: "user-123",
      assistantId: "assistant-456",
      actorId: "actor-789",
      requestId: "request-012",
      conversationId: "conv-xyz",
      idempotencyKey: "message-abc",
      authorizationVersion: 7,
      configVersion: 3,
      runtimeGeneration: 2,
    });
    expect(runtimeTenantContextClaimFromExecutionContext(context)).toEqual(
      CLAIM,
    );
  });

  test("reconstructs and validates canonical headers", () => {
    const headers = new Headers({
      "x-worklin-org-id": "attacker-org",
    });
    applyRuntimeTenantContextHeaders(headers, CLAIM);

    expect(validateRuntimeTenantContextHeaders(headers, CLAIM)).toBeNull();
    headers.set("x-worklin-assistant-id", "assistant-other");
    expect(validateRuntimeTenantContextHeaders(headers, CLAIM)).toBe(
      "tenant_context_header_mismatch:assistantId",
    );
  });

  test("keys every runtime and conversation scope by tenant", () => {
    const context = createTenantExecutionContext({
      claim: CLAIM,
      authorizationVersion: 1,
      configVersion: 1,
      runtimeGeneration: 1,
    });
    expect(tenantExecutionScopeKey(context)).not.toEqual(
      tenantExecutionScopeKey({
        organizationId: "org-other",
        assistantId: context.assistantId,
      }),
    );
    expect(tenantConversationScopeKey(context, "conv-xyz")).not.toEqual(
      tenantConversationScopeKey(
        {
          organizationId: context.organizationId,
          assistantId: "assistant-other",
        },
        "conv-xyz",
      ),
    );
  });
});
