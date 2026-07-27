import { describe, expect, test } from "bun:test";

import {
  selectRuntimeWorkerRoutingPolicy,
  type RuntimeWorkerRoutingPolicy,
} from "./runtime-worker-routing-policy.js";
import type { RuntimeStackRow } from "./runtime-stacks.js";
import type { RuntimeWorkerProductionCoordinatorConfig } from "./runtime-worker-production-coordinator.js";

function stack(
  overrides: Partial<RuntimeStackRow> = {},
): RuntimeStackRow {
  return {
    id: "rt-assistant-a",
    org_id: "org-a",
    assistant_id: "assistant-a",
    status: "provisioning",
    provider: "railway",
    gateway_url: null,
    public_ingress_url: "https://worklin.example.com",
    workspace_volume_ref: null,
    service_ref: null,
    service_capacity_reserved: 0,
    service_create_attempted_at: null,
    volume_create_attempted_at: null,
    provisioning_lease_token: null,
    provisioning_lease_expires_at: null,
    actor_signing_key_scope: "runtime_v1:rt-assistant-a",
    last_health_status: null,
    last_error: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function config(enabled: boolean): RuntimeWorkerProductionCoordinatorConfig {
  return {
    enabled,
    pool: {
      enabled,
      candidateStackIds: enabled ? ["worker-1"] : [],
      maxConcurrentLeases: enabled ? 1 : 0,
      leaseTtlMs: 60_000,
    },
  };
}

function select(
  value: RuntimeStackRow,
  enabled = true,
): RuntimeWorkerRoutingPolicy {
  return selectRuntimeWorkerRoutingPolicy(value, config(enabled), 10_000);
}

describe("runtime worker routing policy", () => {
  test("preserves every existing routable dedicated assistant", () => {
    const dedicated = stack({
      status: "active",
      gateway_url: "https://dedicated.internal",
      service_ref: "railway-service",
    });
    expect(select(dedicated)).toEqual({
      mode: "dedicated",
      stack: dedicated,
    });
  });

  test("allows only a resource-free placeholder to use the pool", () => {
    expect(select(stack())).toEqual({ mode: "pooled" });
    expect(select(stack({ status: "failed" }))).toEqual({ mode: "pooled" });
  });

  test("never races a dedicated runtime that owns resources or an active lease", () => {
    const transitional = [
      stack({ service_ref: "railway-service" }),
      stack({ workspace_volume_ref: "railway-volume" }),
      stack({ gateway_url: "https://not-yet-active.internal" }),
      stack({ service_capacity_reserved: 1 }),
      stack({
        provisioning_lease_token: "lease",
        provisioning_lease_expires_at: 9_999,
      }),
      stack({ service_create_attempted_at: 9_000 }),
      stack({ volume_create_attempted_at: 9_000 }),
    ];
    for (const candidate of transitional) {
      expect(select(candidate)).toEqual({
        mode: "unavailable",
        reason: "dedicated_runtime_in_transition",
      });
    }
  });

  test("does not let the pool bypass suspension, deletion, or a disabled gate", () => {
    expect(select(stack({ status: "suspended" }))).toEqual({
      mode: "unavailable",
      reason: "dedicated_runtime_suspended",
    });
    expect(select(stack({ status: "deleted" }))).toEqual({
      mode: "unavailable",
      reason: "dedicated_runtime_deleted",
    });
    expect(select(stack(), false)).toEqual({
      mode: "unavailable",
      reason: "pool_disabled",
    });
  });

  test("rejects invalid time instead of guessing lease ownership", () => {
    expect(() =>
      selectRuntimeWorkerRoutingPolicy(stack(), config(true), Number.NaN),
    ).toThrow("time is invalid");
  });
});
