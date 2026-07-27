import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  claimRuntimeWorkerLease,
  markRuntimeWorkerSanitized,
  releaseRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
} from "./runtime-worker-leases.js";
import {
  mintRuntimeWorkerLeaseActorToken,
  mintRuntimeWorkerLeaseServiceToken,
  resolveActiveRuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import {
  deriveRuntimeActorSigningKey,
  ensureRuntimeStackSchema,
} from "./runtime-stacks.js";

const MASTER_KEY = "a".repeat(64);
const NOW_ISO = () => "2026-07-20T10:00:00.000Z";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO assistants (id, user_id, org_id, name, created_at, updated_at)
    VALUES
      ('asst-1', 'user-1', 'org-1', 'Assistant One', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'),
      ('asst-2', 'user-2', 'org-2', 'Assistant Two', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
  `);
  ensureRuntimeStackSchema(db);
  db.exec(`
    INSERT INTO runtime_stacks (
      id,
      org_id,
      assistant_id,
      status,
      provider,
      gateway_url,
      public_ingress_url,
      workspace_volume_ref,
      service_ref,
      actor_signing_key_scope,
      last_health_status,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      'worker-1',
      'pool',
      'pool-owner',
      'active',
      '${RUNTIME_WORKER_POOL_PROVIDER}',
      'http://worker-1.internal',
      'https://worklin.example.com',
      NULL,
      'service-worker-1',
      'runtime_v1:worker-1',
      '200',
      NULL,
      '2026-07-20T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z'
    );
  `);
  return db;
}

function claim(db: Database, assistantId = "asst-1", orgId = "org-1") {
  return claimRuntimeWorkerLease(
    db,
    { id: assistantId, org_id: orgId },
    ["worker-1"],
    1,
    `lease-${assistantId}`,
    1_000,
    60_000,
    NOW_ISO,
  );
}

function payload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("runtime worker lease service tokens", () => {
  test("mints a short-lived worker-key token for the exact active lease", () => {
    const db = setupDb();
    claim(db);

    const result = mintRuntimeWorkerLeaseServiceToken(
      db,
      {
        organizationId: "org-1",
        userId: "user-1",
        assistantId: "asst-1",
        workerStackId: "worker-1",
        leaseToken: "lease-asst-1",
      },
      MASTER_KEY,
      1_000,
    );

    expect(result.binding).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "asst-1",
      workerStackId: "worker-1",
      leaseGeneration: 1,
      leaseExpiresAtMs: 61_000,
    });
    expect(result.expiresAtSeconds).toBe(31);
    const claims = payload(result.token);
    expect(claims).toMatchObject({
      aud: "vellum-gateway",
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
      exp: 31,
      iat: 1,
      service_tenant_context: {
        version: 1,
        organization_id: "org-1",
        assistant_id: "asst-1",
        service_id: "gateway",
      },
      pooled_worker_lease: {
        version: 1,
        issuer_service_id: "runtime_dispatcher",
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        worker_stack_id: "worker-1",
        lease_generation: 1,
        lease_expires_at: 61,
      },
    });
    expect(JSON.stringify(claims)).not.toContain("lease-asst-1");

    const [header, encodedPayload, signature] = result.token.split(".");
    const workerKey = deriveRuntimeActorSigningKey(
      MASTER_KEY,
      "runtime_v1:worker-1",
    );
    const expectedSignature = createHmac(
      "sha256",
      Buffer.from(workerKey, "hex"),
    )
      .update(`${header}.${encodedPayload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSignature);
  });

  test("rejects missing, mismatched, expired, and legacy-generation leases", () => {
    const db = setupDb();
    const input = {
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "asst-1",
      workerStackId: "worker-1",
      leaseToken: "lease-asst-1",
    };
    expect(() =>
      mintRuntimeWorkerLeaseServiceToken(db, input, MASTER_KEY, 1_000),
    ).toThrow("not active");

    claim(db);
    expect(() =>
      mintRuntimeWorkerLeaseServiceToken(
        db,
        { ...input, userId: "user-2" },
        MASTER_KEY,
        1_000,
      ),
    ).toThrow("not active");
    expect(() =>
      mintRuntimeWorkerLeaseServiceToken(
        db,
        { ...input, leaseToken: "lease-wrong" },
        MASTER_KEY,
        1_000,
      ),
    ).toThrow("not active");
    expect(() =>
      mintRuntimeWorkerLeaseServiceToken(db, input, MASTER_KEY, 61_000),
    ).toThrow("not active");

    db.query(
      `UPDATE runtime_worker_leases
       SET lease_generation = 0
       WHERE runtime_stack_id = 'worker-1'`,
    ).run();
    expect(() =>
      mintRuntimeWorkerLeaseServiceToken(db, input, MASTER_KEY, 1_000),
    ).toThrow("not active");
  });

  test("can mint a lease-bound gateway ingress capability", () => {
    const db = setupDb();
    claim(db);
    const result = mintRuntimeWorkerLeaseServiceToken(
      db,
      {
        organizationId: "org-1",
        userId: "user-1",
        assistantId: "asst-1",
        workerStackId: "worker-1",
        leaseToken: "lease-asst-1",
        scopeProfile: "gateway_ingress_v1",
      },
      MASTER_KEY,
      1_000,
    );

    expect(payload(result.token).scope_profile).toBe("gateway_ingress_v1");
  });

  test("mints a short-lived actor token bound to the same active lease", () => {
    const db = setupDb();
    claim(db);
    const result = mintRuntimeWorkerLeaseActorToken(
      db,
      {
        organizationId: "org-1",
        userId: "user-1",
        assistantId: "asst-1",
        actorId: "vellum-principal-user-1",
        requestId: "request-1",
        workerStackId: "worker-1",
        leaseToken: "lease-asst-1",
      },
      MASTER_KEY,
      1_000,
    );

    expect(result.expiresAtSeconds).toBe(31);
    expect(payload(result.token)).toMatchObject({
      aud: "vellum-gateway",
      sub: "actor:asst-1:vellum-principal-user-1",
      scope_profile: "actor_client_v1",
      exp: 31,
      iat: 1,
      jti: "request-1",
      tenant_context: {
        version: 1,
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        actor_id: "vellum-principal-user-1",
        request_id: "request-1",
      },
      pooled_worker_lease: {
        version: 1,
        issuer_service_id: "runtime_dispatcher",
        organization_id: "org-1",
        user_id: "user-1",
        assistant_id: "asst-1",
        worker_stack_id: "worker-1",
        lease_generation: 1,
        lease_expires_at: 61,
      },
    });
  });

  test("authoritative binding invalidates released and reassigned generations", () => {
    const db = setupDb();
    claim(db);
    const first = resolveActiveRuntimeWorkerLeaseServiceBinding(
      db,
      "worker-1",
      1_001,
    );
    expect(first?.leaseGeneration).toBe(1);

    releaseRuntimeWorkerLease(
      db,
      { id: "asst-1", org_id: "org-1" },
      "lease-asst-1",
      1_100,
      NOW_ISO,
    );
    expect(
      resolveActiveRuntimeWorkerLeaseServiceBinding(db, "worker-1", 1_101),
    ).toBeNull();

    markRuntimeWorkerSanitized(
      db,
      "worker-1",
      { id: "asst-1", org_id: "org-1" },
      1_101,
      NOW_ISO,
    );
    claim(db, "asst-2", "org-2");

    expect(
      resolveActiveRuntimeWorkerLeaseServiceBinding(db, "worker-1", 1_102),
    ).toEqual({
      organizationId: "org-2",
      userId: "user-2",
      assistantId: "asst-2",
      workerStackId: "worker-1",
      leaseGeneration: 2,
      leaseExpiresAtMs: 61_000,
    });
  });
});
