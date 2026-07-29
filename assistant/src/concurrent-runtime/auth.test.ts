import { describe, expect, test } from "bun:test";

import {
  applyRuntimeTenantContextHeaders,
  type RuntimeTenantContextClaim,
} from "@vellumai/service-contracts/tenant-context";

import type { TokenClaims } from "../runtime/auth/types.js";
import { validateConcurrentRuntimeClaims } from "./auth.js";

const tenantClaim: RuntimeTenantContextClaim = {
  version: 1,
  organization_id: "org-abc",
  user_id: "user-123",
  assistant_id: "assistant-123",
  actor_id: "actor-123",
  request_id: "request-123",
};

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    iss: "vellum-auth",
    aud: "vellum-daemon",
    sub: "actor:self:actor-123",
    scope_profile: "actor_client_v1",
    exp: Math.floor(Date.now() / 1_000) + 60,
    policy_epoch: 1,
    tenant_context: tenantClaim,
    ...overrides,
  };
}

function headers(): Headers {
  const value = new Headers();
  applyRuntimeTenantContextHeaders(value, tenantClaim);
  return value;
}

describe("concurrent runtime authentication", () => {
  test("accepts a tenant-bound actor token with matching canonical headers", () => {
    expect(
      validateConcurrentRuntimeClaims(headers(), claims(), "chat.write"),
    ).toEqual({
      ok: true,
      tenant: {
        claim: tenantClaim,
        authorizationVersion: 1,
      },
    });
  });

  test("rejects forged headers and subject mismatches", () => {
    const forgedHeaders = headers();
    forgedHeaders.set("x-worklin-assistant-id", "assistant-other");
    expect(
      validateConcurrentRuntimeClaims(forgedHeaders, claims(), "chat.read"),
    ).toMatchObject({
      ok: false,
      reason: "tenant_context_header_mismatch:assistantId",
      status: 403,
    });
    expect(
      validateConcurrentRuntimeClaims(
        headers(),
        claims({ sub: "actor:self:actor-other" }),
        "chat.read",
      ),
    ).toMatchObject({
      ok: false,
      reason: "tenant_context_subject_mismatch",
      status: 403,
    });
  });

  test("rejects worker leases and service tenant authority", () => {
    expect(
      validateConcurrentRuntimeClaims(
        headers(),
        claims({
          pooled_worker_lease: {
            version: 1,
            issuer_service_id: "runtime_dispatcher",
            organization_id: "org-abc",
            user_id: "user-123",
            assistant_id: "assistant-123",
            worker_stack_id: "worker-123",
            lease_generation: 1,
            lease_expires_at: Math.floor(Date.now() / 1_000) + 60,
          },
        }),
        "chat.read",
      ),
    ).toMatchObject({
      ok: false,
      reason: "pooled_worker_lease_not_supported",
    });
    expect(
      validateConcurrentRuntimeClaims(
        headers(),
        claims({
          service_tenant_context: {
            version: 1,
            assistant_id: "assistant-123",
            service_id: "gateway",
            request_id: "request-123",
            organization_id: "org-abc",
          },
        }),
        "chat.read",
      ),
    ).toMatchObject({
      ok: false,
      reason: "service_tenant_context_not_supported",
    });
  });
});
