import { describe, expect, test } from "bun:test";

import {
  applyRuntimeTenantContextHeaders,
  validateRuntimeTenantContext,
} from "./runtime-tenant-context.js";
import type { RuntimeTenantContextClaim, TokenClaims } from "./types.js";

const CONTEXT: RuntimeTenantContextClaim = {
  version: 1,
  organization_id: "org-abc",
  user_id: "user-123",
  assistant_id: "asst-123",
  actor_id: "vellum-principal-user-123",
  request_id: "request-123",
};

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    iss: "vellum-auth",
    aud: "vellum-gateway",
    sub: "actor:asst-123:vellum-principal-user-123",
    scope_profile: "actor_client_v1",
    exp: Math.floor(Date.now() / 1000) + 300,
    policy_epoch: 1,
    tenant_context: CONTEXT,
    ...overrides,
  };
}

function headers(): Headers {
  const result = new Headers();
  applyRuntimeTenantContextHeaders(result, CONTEXT);
  return result;
}

const HEADER_CASES = [
  ["x-worklin-org-id", "organization_id"],
  ["x-worklin-user-id", "user_id"],
  ["x-worklin-assistant-id", "assistant_id"],
  ["x-worklin-actor-id", "actor_id"],
  ["x-worklin-request-id", "request_id"],
] as const;

describe("runtime tenant context", () => {
  test("accepts a complete context bound to subject, runtime, path, and headers", () => {
    expect(
      validateRuntimeTenantContext(headers(), claims(), {
        required: true,
        expectedAssistantId: "asst-123",
        requestedAssistantId: "asst-123",
      }),
    ).toEqual({ ok: true, context: CONTEXT });
  });

  for (const [headerName, field] of HEADER_CASES) {
    test(`rejects a missing ${field} header`, () => {
      const requestHeaders = headers();
      requestHeaders.delete(headerName);
      expect(
        validateRuntimeTenantContext(requestHeaders, claims(), {
          required: true,
          expectedAssistantId: "asst-123",
        }),
      ).toEqual({
        ok: false,
        reason: `tenant_context_header_mismatch:${field}`,
      });
    });

    test(`rejects a forged ${field} header`, () => {
      const requestHeaders = headers();
      requestHeaders.set(headerName, "forged");
      expect(
        validateRuntimeTenantContext(requestHeaders, claims(), {
          required: true,
          expectedAssistantId: "asst-123",
        }),
      ).toEqual({
        ok: false,
        reason: `tenant_context_header_mismatch:${field}`,
      });
    });
  }

  test("rejects a claim whose assistant differs from the JWT subject", () => {
    expect(
      validateRuntimeTenantContext(
        headers(),
        claims({ sub: "actor:asst-other:vellum-principal-user-123" }),
        { required: true },
      ),
    ).toEqual({
      ok: false,
      reason: "tenant_context_subject_mismatch",
    });
  });

  test("rejects a claim whose actor differs from the JWT subject", () => {
    expect(
      validateRuntimeTenantContext(
        headers(),
        claims({ sub: "actor:asst-123:vellum-principal-user-other" }),
        { required: true },
      ),
    ).toEqual({
      ok: false,
      reason: "tenant_context_subject_mismatch",
    });
  });

  test("rejects a claim for another runtime or requested assistant", () => {
    expect(
      validateRuntimeTenantContext(headers(), claims(), {
        required: true,
        expectedAssistantId: "asst-other",
      }),
    ).toEqual({
      ok: false,
      reason: "tenant_context_runtime_mismatch",
    });
    expect(
      validateRuntimeTenantContext(headers(), claims(), {
        required: true,
        requestedAssistantId: "asst-other",
      }),
    ).toEqual({
      ok: false,
      reason: "tenant_context_path_mismatch",
    });
  });

  test("requires the claim for platform scope but preserves local compatibility", () => {
    const legacyClaims = claims({ tenant_context: undefined });
    expect(
      validateRuntimeTenantContext(new Headers(), legacyClaims, {
        required: true,
      }),
    ).toEqual({
      ok: false,
      reason: "missing_tenant_context_claim",
    });
    expect(
      validateRuntimeTenantContext(new Headers(), legacyClaims, {
        required: false,
      }),
    ).toEqual({ ok: true, context: null });
  });
});
