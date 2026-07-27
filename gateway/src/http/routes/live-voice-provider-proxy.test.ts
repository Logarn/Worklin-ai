import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  initSigningKey,
  mintToken,
  verifyToken,
} from "../../auth/token-service.js";
import type { GatewayConfig } from "../../config.js";
import { authorizeLiveVoiceRuntimeCallback } from "./live-voice-provider-proxy.js";

const TEST_KEY = Buffer.from("voice-callback-signing-key-32byte");
const tempDirectories: string[] = [];

beforeAll(() => {
  initSigningKey(TEST_KEY);
});

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pooledConfig(workerStackId = "worker-1"): GatewayConfig {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "gateway-voice-callback-")),
  );
  tempDirectories.push(directory);
  return {
    runtimeWorkerStackId: workerStackId,
    runtimeWorkerLeaseAuthorityFile: join(directory, "active-lease.json"),
  } as GatewayConfig;
}

function pooledIngressToken(workerStackId = "worker-1"): string {
  const now = Math.floor(Date.now() / 1_000);
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: 1,
    ttlSeconds: 30,
    jti: "voice-callback-request",
    service_tenant_context: {
      version: 1,
      organization_id: "org-1",
      assistant_id: "asst-1",
      service_id: "gateway",
      request_id: "voice-callback-request",
    },
    pooled_worker_lease: {
      version: 1,
      issuer_service_id: "runtime_dispatcher",
      organization_id: "org-1",
      user_id: "user-1",
      assistant_id: "asst-1",
      worker_stack_id: workerStackId,
      lease_generation: 7,
      lease_expires_at: now + 45,
    },
  });
}

describe("managed voice callback runtime authorization", () => {
  test("exchanges an exact pooled ingress token and installs its lease authority", () => {
    const config = pooledConfig();
    const result = authorizeLiveVoiceRuntimeCallback(
      `Bearer ${pooledIngressToken()}`,
      config,
    );
    expect(result).toBeString();
    if (typeof result !== "string") return;

    const verified = verifyToken(result, "vellum-daemon");
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      pooled_worker_lease: {
        organization_id: "org-1",
        assistant_id: "asst-1",
        worker_stack_id: "worker-1",
        lease_generation: 7,
      },
    });
    expect(
      JSON.parse(readFileSync(config.runtimeWorkerLeaseAuthorityFile!, "utf8")),
    ).toMatchObject({
      worker_stack_id: "worker-1",
      authority_generation: 7,
      active_lease: {
        organization_id: "org-1",
        assistant_id: "asst-1",
        lease_generation: 7,
      },
    });
  });

  test("fails closed for a missing, malformed, or wrong-worker pooled token", () => {
    expect(
      authorizeLiveVoiceRuntimeCallback(null, pooledConfig()),
    ).toMatchObject({ status: 401 });
    expect(
      authorizeLiveVoiceRuntimeCallback("Basic no", pooledConfig()),
    ).toMatchObject({ status: 401 });
    expect(
      authorizeLiveVoiceRuntimeCallback(
        `Bearer ${pooledIngressToken("worker-2")}`,
        pooledConfig("worker-1"),
      ),
    ).toMatchObject({ status: 403 });
  });

  test("preserves the existing dedicated callback service token", () => {
    const result = authorizeLiveVoiceRuntimeCallback(null, {} as GatewayConfig);
    expect(result).toBeString();
    if (typeof result !== "string") return;
    const verified = verifyToken(result, "vellum-daemon");
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.scope_profile).toBe("gateway_service_v1");
    expect(verified.claims.pooled_worker_lease).toBeUndefined();
  });
});
