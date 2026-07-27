import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { initSigningKey, mintToken } from "../../auth/token-service.js";
import type { RuntimeWorkerLeaseClaim } from "../../auth/types.js";
import {
  installRuntimeWorkerLeaseAuthority,
  revokeRuntimeWorkerLeaseAuthority,
} from "../../runtime-worker-lease-authority.js";
import { createRuntimeWorkerLeaseRevokeHandler } from "./runtime-worker-lease-revoke.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  initSigningKey(Buffer.alloc(32, 7));
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "gateway-lease-revoke-")),
  );
  directories.push(directory);
  const authorityFile = join(directory, "active-lease.json");
  const handler = createRuntimeWorkerLeaseRevokeHandler({
    runtimeWorkerStackId: "worker-1",
    runtimeWorkerLeaseAuthorityFile: authorityFile,
  });
  return { authorityFile, handler };
}

function leaseClaim(
  generation = 1,
  overrides: Partial<RuntimeWorkerLeaseClaim> = {},
): RuntimeWorkerLeaseClaim {
  return {
    version: 1,
    issuer_service_id: "runtime_dispatcher",
    organization_id: "org-1",
    user_id: "user-1",
    assistant_id: "asst-1",
    worker_stack_id: "worker-1",
    lease_generation: generation,
    lease_expires_at: Math.floor(Date.now() / 1_000) + 120,
    ...overrides,
  };
}

function tokenFor(
  claim: RuntimeWorkerLeaseClaim,
  principal: "service" | "actor" = "service",
): string {
  const requestId = `request-${claim.lease_generation}-${principal}`;
  return mintToken({
    aud: "vellum-gateway",
    sub:
      principal === "service"
        ? "svc:gateway:self"
        : `actor:${claim.assistant_id}:actor-1`,
    scope_profile:
      principal === "service" ? "gateway_service_v1" : "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 30,
    jti: requestId,
    pooled_worker_lease: claim,
    ...(principal === "service"
      ? {
          service_tenant_context: {
            version: 1 as const,
            organization_id: claim.organization_id,
            assistant_id: claim.assistant_id,
            service_id: "gateway" as const,
            request_id: requestId,
          },
        }
      : {
          tenant_context: {
            version: 1 as const,
            organization_id: claim.organization_id,
            user_id: claim.user_id,
            assistant_id: claim.assistant_id,
            actor_id: "actor-1",
            request_id: requestId,
          },
        }),
  });
}

function request(token: string, body: unknown): Request {
  return new Request(
    "http://gateway.test/v1/internal/pooled-worker/lease/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("pooled worker lease authority revoke route", () => {
  test("revokes the authenticated generation and permits idempotent retry", async () => {
    const { authorityFile, handler } = fixture();
    const claim = leaseClaim();
    installRuntimeWorkerLeaseAuthority(authorityFile, claim);
    const token = tokenFor(claim);
    const body = {
      worker_stack_id: claim.worker_stack_id,
      lease_generation: claim.lease_generation,
    };

    const first = await handler(request(token, body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      status: "revoked",
      worker_stack_id: "worker-1",
      lease_generation: 1,
    });

    const repeated = await handler(request(token, body));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      status: "already_revoked",
      worker_stack_id: "worker-1",
      lease_generation: 1,
    });
  });

  test("rejects actor credentials and body identity swaps", async () => {
    const { authorityFile, handler } = fixture();
    const claim = leaseClaim();
    installRuntimeWorkerLeaseAuthority(authorityFile, claim);
    const body = {
      worker_stack_id: claim.worker_stack_id,
      lease_generation: claim.lease_generation,
    };

    expect(
      (await handler(request(tokenFor(claim, "actor"), body))).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request(tokenFor(claim), {
            ...body,
            worker_stack_id: "worker-2",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request(tokenFor(claim), {
            ...body,
            lease_generation: 2,
          }),
        )
      ).status,
    ).toBe(403);

    expect(
      JSON.parse(readFileSync(authorityFile, "utf8")).active_lease,
    ).not.toBeNull();
  });

  test("cannot revoke a newer generation with a stale signed lease", async () => {
    const { authorityFile, handler } = fixture();
    const first = leaseClaim(1);
    const second = leaseClaim(2, {
      organization_id: "org-2",
      user_id: "user-2",
      assistant_id: "asst-2",
    });
    installRuntimeWorkerLeaseAuthority(authorityFile, first);
    revokeRuntimeWorkerLeaseAuthority(authorityFile, {
      workerStackId: "worker-1",
      leaseGeneration: 1,
    });
    installRuntimeWorkerLeaseAuthority(authorityFile, second);

    const response = await handler(
      request(tokenFor(first), {
        worker_stack_id: "worker-1",
        lease_generation: 1,
      }),
    );
    expect(response.status).toBe(409);
    expect(
      JSON.parse(readFileSync(authorityFile, "utf8")).active_lease,
    ).toMatchObject({
      organization_id: "org-2",
      assistant_id: "asst-2",
      lease_generation: 2,
    });
  });

  test("fails closed when pooled worker authority is not configured", async () => {
    initSigningKey(Buffer.alloc(32, 7));
    const claim = leaseClaim();
    const handler = createRuntimeWorkerLeaseRevokeHandler({});
    const response = await handler(
      request(tokenFor(claim), {
        worker_stack_id: "worker-1",
        lease_generation: 1,
      }),
    );
    expect(response.status).toBe(503);
  });
});
