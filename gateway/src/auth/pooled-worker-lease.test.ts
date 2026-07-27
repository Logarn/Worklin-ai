import { beforeAll, describe, expect, test } from "bun:test";

import { validatePooledWorkerLeaseClaims } from "./pooled-worker-lease.js";
import { mintExchangeToken, validateEdgeToken } from "./token-exchange.js";
import { initSigningKey, mintToken, verifyToken } from "./token-service.js";
import type { TokenClaims } from "./types.js";

const TEST_KEY = Buffer.from("pooled-worker-signing-key-32byt");

beforeAll(() => {
  initSigningKey(TEST_KEY);
});

function mintPooledEdgeToken(
  overrides: Partial<NonNullable<TokenClaims["pooled_worker_lease"]>> = {},
  scopeProfile:
    | "gateway_service_v1"
    | "gateway_ingress_v1" = "gateway_service_v1",
): string {
  const now = Math.floor(Date.now() / 1_000);
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: scopeProfile,
    policy_epoch: 1,
    ttlSeconds: 30,
    jti: "request-1",
    service_tenant_context: {
      version: 1,
      organization_id: "org-1",
      assistant_id: "asst-1",
      service_id: "gateway",
      request_id: "request-1",
    },
    pooled_worker_lease: {
      version: 1,
      issuer_service_id: "runtime_dispatcher",
      organization_id: "org-1",
      user_id: "user-1",
      assistant_id: "asst-1",
      worker_stack_id: "worker-1",
      lease_generation: 4,
      lease_expires_at: now + 45,
      ...overrides,
    },
  });
}

describe("pooled worker lease gateway exchange", () => {
  test("validates and explicitly preserves the lease claim", () => {
    const edgeToken = mintPooledEdgeToken();
    const edge = validateEdgeToken(edgeToken);
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;

    expect(
      validatePooledWorkerLeaseClaims(edge.claims, "worker-1"),
    ).toMatchObject({
      ok: true,
      claim: {
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        worker_stack_id: "worker-1",
        lease_generation: 4,
      },
    });

    const daemonToken = mintExchangeToken(edge.claims, "gateway_service_v1");
    const daemon = verifyToken(daemonToken, "vellum-daemon");
    expect(daemon.ok).toBe(true);
    if (!daemon.ok) return;
    expect(daemon.claims.pooled_worker_lease).toEqual(
      edge.claims.pooled_worker_lease,
    );
    expect(daemon.claims.service_tenant_context).toEqual(
      edge.claims.service_tenant_context,
    );
    expect(daemon.claims.jti).toBe(edge.claims.jti);
    expect(daemon.claims.exp).toBeLessThanOrEqual(edge.claims.exp);
    expect(daemon.claims.exp).toBeLessThanOrEqual(
      edge.claims.pooled_worker_lease!.lease_expires_at,
    );
  });

  test("rejects missing and mismatched pooled service identity", () => {
    const staticToken = mintToken({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: 1,
      ttlSeconds: 30,
    });
    const staticResult = validateEdgeToken(staticToken);
    expect(staticResult.ok).toBe(true);
    if (staticResult.ok) {
      expect(
        validatePooledWorkerLeaseClaims(staticResult.claims, "worker-1"),
      ).toEqual({
        ok: false,
        reason: "pooled_worker_lease_claim_missing",
      });
    }

    const wrongWorker = validateEdgeToken(
      mintPooledEdgeToken({ worker_stack_id: "worker-2" }),
    );
    expect(wrongWorker.ok).toBe(true);
    if (wrongWorker.ok) {
      expect(
        validatePooledWorkerLeaseClaims(wrongWorker.claims, "worker-1"),
      ).toEqual({
        ok: false,
        reason: "pooled_worker_lease_worker_mismatch",
      });
    }
  });

  test("accepts explicit lease binding for gateway ingress", () => {
    const edge = validateEdgeToken(
      mintPooledEdgeToken({}, "gateway_ingress_v1"),
    );
    expect(edge.ok).toBe(true);
    if (edge.ok) {
      expect(
        validatePooledWorkerLeaseClaims(edge.claims, "worker-1"),
      ).toMatchObject({ ok: true });
    }
  });

  test("accepts an actor token only for its exact assistant and tenant", () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = mintToken({
      aud: "vellum-gateway",
      sub: "actor:asst-1:vellum-principal-user-1",
      scope_profile: "actor_client_v1",
      policy_epoch: 1,
      ttlSeconds: 30,
      jti: "request-actor-1",
      tenant_context: {
        version: 1,
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        actor_id: "vellum-principal-user-1",
        request_id: "request-actor-1",
      },
      pooled_worker_lease: {
        version: 1,
        issuer_service_id: "runtime_dispatcher",
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        worker_stack_id: "worker-1",
        lease_generation: 4,
        lease_expires_at: now + 45,
      },
    });
    const edge = validateEdgeToken(token);
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    expect(
      validatePooledWorkerLeaseClaims(edge.claims, "worker-1"),
    ).toMatchObject({ ok: true });

    expect(
      validatePooledWorkerLeaseClaims(
        { ...edge.claims, sub: "actor:asst-2:vellum-principal-user-1" },
        "worker-1",
      ),
    ).toEqual({
      ok: false,
      reason: "pooled_worker_lease_envelope_mismatch",
    });
  });

  test("does not alter dedicated gateway service-token behavior", () => {
    const token = mintToken({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      policy_epoch: 1,
      ttlSeconds: 30,
    });
    const verified = validateEdgeToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(
        validatePooledWorkerLeaseClaims(verified.claims, undefined),
      ).toEqual({ ok: true, claim: null });
    }
  });
});
