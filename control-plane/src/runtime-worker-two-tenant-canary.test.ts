import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  dispatchRuntimeWorker,
  releaseDispatchedRuntimeWorker,
  type RuntimeWorkerLifecycleAdapter,
  type RuntimeWorkerPoolConfig,
} from "./runtime-worker-dispatcher.js";
import {
  createRuntimeWorkerProductionLifecycleAdapter,
  type RuntimeWorkerObjectHead,
  type RuntimeWorkerProductionTransport,
} from "./runtime-worker-production-lifecycle.js";
import {
  PooledModelKeyVault,
  pooledModelKeyVaultConfigFromEnv,
  type PooledModelKeyTenant,
} from "./pooled-model-key-vault.js";
import {
  RUNTIME_WORKER_POOL_PROVIDER,
  type RuntimeWorkerLeaseAssistant,
} from "./runtime-worker-leases.js";
import {
  mintRuntimeWorkerLeaseActorToken,
  mintRuntimeWorkerLeaseServiceToken,
  resolveActiveRuntimeWorkerLeaseServiceBinding,
  type RuntimeWorkerLeaseClaim,
  type RuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import {
  buildRuntimeWorkerStateObjectKey,
  getRuntimeWorkerStateCheckpoint,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";

const WORKER_ID = "worker-canary-1";
const BUCKET = "worklin-runtime-state";
const MASTER_SIGNING_KEY = "a".repeat(64);
const VAULT_MASTER_KEY = "b".repeat(64);
const NOW_ISO = () => "2026-07-20T12:00:00.000Z";
const POOL_CONFIG: RuntimeWorkerPoolConfig = {
  enabled: true,
  candidateStackIds: [WORKER_ID],
  maxConcurrentLeases: 1,
  leaseTtlMs: 60_000,
};

const TENANT_A = {
  organizationId: "org-canary-a",
  userId: "user-canary-a",
  assistantId: "assistant-canary-a",
} as const;
const TENANT_B = {
  organizationId: "org-canary-b",
  userId: "user-canary-b",
  assistantId: "assistant-canary-b",
} as const;
const ASSISTANT_A = {
  id: TENANT_A.assistantId,
  org_id: TENANT_A.organizationId,
} as const;
const ASSISTANT_B = {
  id: TENANT_B.assistantId,
  org_id: TENANT_B.organizationId,
} as const;
const STATE_TENANT_A = {
  orgId: TENANT_A.organizationId,
  assistantId: TENANT_A.assistantId,
} as const;
const STATE_TENANT_B = {
  orgId: TENANT_B.organizationId,
  assistantId: TENANT_B.assistantId,
} as const;
const TENANT_A_KEY = "sk-test-tenant-a-unique-value";
const TENANT_B_KEY = "sk-test-tenant-b-unique-value";
const TENANT_A_STATE = "tenant-a-private-state-marker";
const TENANT_B_STATE = "tenant-b-private-state-marker";

interface WorkspaceState {
  tenant: RuntimeWorkerStateTenant;
  state: string;
}

interface StoredArchive {
  body: string;
  object: RuntimeWorkerStateObject;
}

class SingleWorkerArchiveTransport implements RuntimeWorkerProductionTransport {
  readonly archives = new Map<string, StoredArchive>();
  readonly revokedGenerations: number[] = [];
  readonly sanitizedGenerations: number[] = [];
  private workspace: WorkspaceState | null = null;

  writeTenantState(tenant: RuntimeWorkerStateTenant, state: string): void {
    if (!this.workspace || !sameStateTenant(this.workspace.tenant, tenant)) {
      throw new Error("Canary workspace is not bound to this tenant.");
    }
    this.workspace = { tenant: { ...tenant }, state };
  }

  workspaceSnapshot(): WorkspaceState | null {
    return this.workspace
      ? {
          tenant: { ...this.workspace.tenant },
          state: this.workspace.state,
        }
      : null;
  }

  exportRedactedVBundle: RuntimeWorkerProductionTransport["exportRedactedVBundle"] =
    async ({
      tenant,
      workerStackId,
      leaseGeneration,
      stateGeneration,
      bucket,
      objectKey,
    }) => {
      if (
        workerStackId !== WORKER_ID ||
        !this.workspace ||
        !sameStateTenant(this.workspace.tenant, tenant)
      ) {
        throw new Error("Canary export tenant does not own the worker.");
      }
      const body = JSON.stringify({
        version: 1,
        tenant,
        state: this.workspace.state,
      });
      const checksumSha256 = sha256(body);
      const object: RuntimeWorkerStateObject = {
        provider: "gcs",
        bucket,
        objectKey,
        checksumSha256,
        byteSize: Buffer.byteLength(body),
        format: "vbundle-v1",
      };
      this.archives.set(objectKey, { body, object });
      return {
        tenant: { ...tenant },
        workerStackId,
        leaseGeneration,
        stateGeneration,
        object,
        workspaceByteSize: Buffer.byteLength(body),
        entries: [
          {
            path: "workspace/state.json",
            kind: "file",
            checksumSha256,
            byteSize: Buffer.byteLength(body),
          },
        ],
        credentialsIncluded: 0,
        secretsRedacted: true,
      };
    };

  restoreRedactedVBundle: RuntimeWorkerProductionTransport["restoreRedactedVBundle"] =
    async ({
      tenant,
      workerStackId,
      leaseGeneration,
      stateGeneration,
      object,
    }) => {
      const archive = this.archives.get(object.objectKey);
      if (
        workerStackId !== WORKER_ID ||
        !archive ||
        archive.object.checksumSha256 !== object.checksumSha256
      ) {
        throw new Error("Canary restore object is unavailable.");
      }
      const restored = JSON.parse(archive.body) as WorkspaceState & {
        version: 1;
      };
      if (!sameStateTenant(restored.tenant, tenant)) {
        throw new Error("Canary restore object belongs to another tenant.");
      }
      this.workspace = { tenant: { ...tenant }, state: restored.state };
      return {
        status: "restored",
        tenant: { ...tenant },
        workerStackId,
        leaseGeneration,
        stateGeneration,
        object,
        workspaceByteSize: Buffer.byteLength(archive.body),
        filesRestored: 1,
        credentialsImported: 0,
        secretsMaterialized: false,
      };
    };

  prepareEmptyWorkspace: RuntimeWorkerProductionTransport["prepareEmptyWorkspace"] =
    async ({ tenant, workerStackId, leaseGeneration }) => {
      if (workerStackId !== WORKER_ID || this.workspace !== null) {
        throw new Error("Canary worker was not sanitized before assignment.");
      }
      this.workspace = { tenant: { ...tenant }, state: "" };
      return {
        status: "prepared_empty",
        tenant: { ...tenant },
        workerStackId,
        leaseGeneration,
        remainingTenantPaths: 0,
        credentialsTouched: false,
      };
    };

  headObject: RuntimeWorkerProductionTransport["headObject"] = async ({
    objectKey,
  }) => {
    const archive = this.archives.get(objectKey);
    return archive ? headFor(archive.object) : null;
  };

  sanitizeWorkspace: RuntimeWorkerProductionTransport["sanitizeWorkspace"] =
    async ({ tenant, workerStackId, leaseGeneration }) => {
      if (
        workerStackId !== WORKER_ID ||
        (this.workspace !== null &&
          !sameStateTenant(this.workspace.tenant, tenant))
      ) {
        throw new Error("Canary sanitizer cannot clear another tenant.");
      }
      this.workspace = null;
      this.sanitizedGenerations.push(leaseGeneration);
      return {
        status: "sanitized",
        tenant: { ...tenant },
        workerStackId,
        leaseGeneration,
        remainingTenantPaths: 0,
        credentialsTouched: false,
      };
    };

  revokeLeaseAuthority: RuntimeWorkerProductionTransport["revokeLeaseAuthority"] =
    async ({ workerStackId, leaseGeneration }) => {
      if (workerStackId !== WORKER_ID) {
        throw new Error("Canary lease authority belongs to another worker.");
      }
      this.revokedGenerations.push(leaseGeneration);
      return { status: "revoked", workerStackId, leaseGeneration };
    };
}

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
    INSERT INTO assistants (
      id, user_id, org_id, name, created_at, updated_at
    ) VALUES
      (
        '${TENANT_A.assistantId}',
        '${TENANT_A.userId}',
        '${TENANT_A.organizationId}',
        'Canary Assistant A',
        '${NOW_ISO()}',
        '${NOW_ISO()}'
      ),
      (
        '${TENANT_B.assistantId}',
        '${TENANT_B.userId}',
        '${TENANT_B.organizationId}',
        'Canary Assistant B',
        '${NOW_ISO()}',
        '${NOW_ISO()}'
      );
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
      '${WORKER_ID}',
      'pool',
      'pool-owner',
      'active',
      '${RUNTIME_WORKER_POOL_PROVIDER}',
      'http://worker-canary-1.internal',
      'https://worklin.example.com',
      NULL,
      'service-worker-canary-1',
      'runtime_v1:${WORKER_ID}',
      '200',
      NULL,
      '${NOW_ISO()}',
      '${NOW_ISO()}'
    );
  `);
  return db;
}

function enabledVault(db: Database): PooledModelKeyVault {
  return new PooledModelKeyVault(
    db,
    pooledModelKeyVaultConfigFromEnv({
      WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
      WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: VAULT_MASTER_KEY,
    }),
  );
}

async function dispatch(
  db: Database,
  assistant: RuntimeWorkerLeaseAssistant,
  leaseToken: string,
  nowMs: number,
  lifecycle: RuntimeWorkerLifecycleAdapter,
) {
  const result = await dispatchRuntimeWorker(
    db,
    assistant,
    POOL_CONFIG,
    leaseToken,
    nowMs,
    NOW_ISO,
    lifecycle,
  );
  expect(result.status).toBe("leased");
  if (result.status !== "leased") {
    throw new Error(`Expected a leased worker, received ${result.status}.`);
  }
  return result.assignment;
}

function activeBinding(
  db: Database,
  nowMs: number,
): RuntimeWorkerLeaseServiceBinding {
  const binding = resolveActiveRuntimeWorkerLeaseServiceBinding(
    db,
    WORKER_ID,
    nowMs,
  );
  if (!binding) throw new Error("Expected an active canary worker binding.");
  return binding;
}

function serviceToken(
  db: Database,
  tenant: PooledModelKeyTenant,
  leaseToken: string,
  nowMs: number,
) {
  return mintRuntimeWorkerLeaseServiceToken(
    db,
    {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      assistantId: tenant.assistantId,
      workerStackId: WORKER_ID,
      leaseToken,
    },
    MASTER_SIGNING_KEY,
    nowMs,
  );
}

function actorToken(
  db: Database,
  tenant: PooledModelKeyTenant,
  leaseToken: string,
  requestId: string,
  nowMs: number,
) {
  return mintRuntimeWorkerLeaseActorToken(
    db,
    {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      assistantId: tenant.assistantId,
      actorId: `principal-${tenant.userId}`,
      requestId,
      workerStackId: WORKER_ID,
      leaseToken,
    },
    MASTER_SIGNING_KEY,
    nowMs,
  );
}

function leaseClaimFromToken(token: string): RuntimeWorkerLeaseClaim {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) throw new Error("Canary token payload is missing.");
  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  ) as { pooled_worker_lease?: RuntimeWorkerLeaseClaim };
  if (!payload.pooled_worker_lease) {
    throw new Error("Canary token lease claim is missing.");
  }
  return payload.pooled_worker_lease;
}

function tokenMatchesActiveBinding(
  token: string,
  binding: RuntimeWorkerLeaseServiceBinding,
): boolean {
  const claim = leaseClaimFromToken(token);
  return (
    claim.organization_id === binding.organizationId &&
    claim.user_id === binding.userId &&
    claim.assistant_id === binding.assistantId &&
    claim.worker_stack_id === binding.workerStackId &&
    claim.lease_generation === binding.leaseGeneration &&
    claim.lease_expires_at === Math.floor(binding.leaseExpiresAtMs / 1_000)
  );
}

function sameStateTenant(
  left: RuntimeWorkerStateTenant,
  right: RuntimeWorkerStateTenant,
): boolean {
  return left.orgId === right.orgId && left.assistantId === right.assistantId;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function headFor(object: RuntimeWorkerStateObject): RuntimeWorkerObjectHead {
  return {
    provider: object.provider,
    bucket: object.bucket,
    objectKey: object.objectKey,
    checksumSha256: object.checksumSha256,
    byteSize: object.byteSize,
    contentType: "application/octet-stream",
  };
}

function assertContainsNoTenantAData(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const tenantAValue of [
    TENANT_A.organizationId,
    TENANT_A.userId,
    TENANT_A.assistantId,
    TENANT_A_KEY,
    TENANT_A_STATE,
    buildRuntimeWorkerStateObjectKey(STATE_TENANT_A, 1),
  ]) {
    expect(serialized).not.toContain(tenantAValue);
  }
}

describe("single pooled worker two-tenant sequential canary", () => {
  test("fences generation A and exposes only tenant B key and state after cutover", async () => {
    const db = setupDb();
    const vault = enabledVault(db);
    const transport = new SingleWorkerArchiveTransport();
    const lifecycle = createRuntimeWorkerProductionLifecycleAdapter(
      { bucket: BUCKET },
      transport,
    );
    vault.set(TENANT_A, "openai", TENANT_A_KEY, NOW_ISO());
    vault.set(TENANT_B, "openai", TENANT_B_KEY, NOW_ISO());

    const assignmentA = await dispatch(
      db,
      ASSISTANT_A,
      "lease-canary-a",
      1_000,
      lifecycle,
    );
    expect(assignmentA.lease.lease_generation).toBe(1);
    transport.writeTenantState(STATE_TENANT_A, TENANT_A_STATE);

    const bindingA = activeBinding(db, 1_001);
    const serviceA = serviceToken(db, TENANT_A, "lease-canary-a", 1_001);
    const actorA = actorToken(
      db,
      TENANT_A,
      "lease-canary-a",
      "request-actor-a",
      1_001,
    );
    const capabilityA = vault.mintRequestCapability(
      TENANT_A,
      bindingA,
      "request-key-a",
      1_001,
    );
    expect(vault.resolveWithCapability(capabilityA, "openai", 1_002)).toEqual({
      ok: true,
      tenant: TENANT_A,
      provider: "openai",
      value: TENANT_A_KEY,
    });

    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        ASSISTANT_A,
        "lease-canary-a",
        1_100,
        NOW_ISO,
        lifecycle,
      ),
    ).toEqual({ status: "released" });
    expect(transport.workspaceSnapshot()).toBeNull();
    expect(transport.sanitizedGenerations).toEqual([1]);
    expect(transport.revokedGenerations).toEqual([1]);

    const checkpointA = getRuntimeWorkerStateCheckpoint(db, STATE_TENANT_A);
    expect(checkpointA).toMatchObject({
      generation: 1,
      status: "checkpointed",
      worker_stack_id: null,
      object_key: buildRuntimeWorkerStateObjectKey(STATE_TENANT_A, 1),
    });

    const assignmentB = await dispatch(
      db,
      ASSISTANT_B,
      "lease-canary-b",
      1_200,
      lifecycle,
    );
    expect(assignmentB.stack.id).toBe(assignmentA.stack.id);
    expect(assignmentB.lease.lease_generation).toBe(2);
    expect(transport.workspaceSnapshot()).toEqual({
      tenant: STATE_TENANT_B,
      state: "",
    });

    const bindingB = activeBinding(db, 1_201);
    expect(bindingB).toEqual({
      organizationId: TENANT_B.organizationId,
      userId: TENANT_B.userId,
      assistantId: TENANT_B.assistantId,
      workerStackId: WORKER_ID,
      leaseGeneration: 2,
      leaseExpiresAtMs: 61_200,
    });
    expect(tokenMatchesActiveBinding(serviceA.token, bindingB)).toBe(false);
    expect(tokenMatchesActiveBinding(actorA.token, bindingB)).toBe(false);
    expect(vault.resolveWithCapability(capabilityA, "openai", 1_202)).toEqual({
      ok: false,
      reason: "stale_lease_generation",
    });
    expect(() => serviceToken(db, TENANT_A, "lease-canary-a", 1_202)).toThrow(
      "not active",
    );
    expect(() =>
      actorToken(
        db,
        TENANT_A,
        "lease-canary-a",
        "request-stale-actor-a",
        1_202,
      ),
    ).toThrow("not active");

    const objectA = transport.archives.get(
      buildRuntimeWorkerStateObjectKey(STATE_TENANT_A, 1),
    )?.object;
    if (!objectA) throw new Error("Expected tenant A archive.");
    await expect(
      lifecycle.storage.restore({
        tenant: STATE_TENANT_B,
        workerStackId: WORKER_ID,
        leaseGeneration: 2,
        stateGeneration: 1,
        object: objectA,
        expectedWorkspaceByteSize: null,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("outside the tenant generation namespace");
    expect(transport.workspaceSnapshot()).toEqual({
      tenant: STATE_TENANT_B,
      state: "",
    });

    transport.writeTenantState(STATE_TENANT_B, TENANT_B_STATE);
    const capabilityB = vault.mintRequestCapability(
      TENANT_B,
      bindingB,
      "request-key-b",
      1_203,
    );
    const tenantBInternalResponse = vault.resolveWithCapability(
      capabilityB,
      "openai",
      1_204,
    );
    expect(tenantBInternalResponse).toEqual({
      ok: true,
      tenant: TENANT_B,
      provider: "openai",
      value: TENANT_B_KEY,
    });
    expect(vault.get(TENANT_A, "openai")).toBe(TENANT_A_KEY);
    expect(vault.get(TENANT_B, "openai")).toBe(TENANT_B_KEY);

    const tenantBRendererResponses = [
      await vault.handleSecretRoute({
        method: "GET",
        routeSegments: ["secrets"],
        tenant: TENANT_B,
      }),
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets", "read"],
        tenant: TENANT_B,
        body: { type: "api_key", name: "openai", reveal: true },
      }),
    ];
    expect(tenantBRendererResponses[1]).toMatchObject({
      status: 200,
      body: { found: true, revealSupported: false },
    });
    assertContainsNoTenantAData({
      internal: tenantBInternalResponse,
      renderer: tenantBRendererResponses,
    });

    expect(
      await releaseDispatchedRuntimeWorker(
        db,
        ASSISTANT_B,
        "lease-canary-b",
        1_300,
        NOW_ISO,
        lifecycle,
      ),
    ).toEqual({ status: "released" });
    expect(transport.sanitizedGenerations).toEqual([1, 2]);
    expect(transport.revokedGenerations).toEqual([1, 2]);
    expect(transport.workspaceSnapshot()).toBeNull();

    const checkpointB = getRuntimeWorkerStateCheckpoint(db, STATE_TENANT_B);
    expect(checkpointB).toMatchObject({
      generation: 1,
      status: "checkpointed",
      worker_stack_id: null,
      object_key: buildRuntimeWorkerStateObjectKey(STATE_TENANT_B, 1),
    });
    expect(checkpointB?.object_key).not.toBe(checkpointA?.object_key);

    const archiveB = transport.archives.get(
      buildRuntimeWorkerStateObjectKey(STATE_TENANT_B, 1),
    );
    expect(archiveB).toBeDefined();
    expect(archiveB?.body).toContain(TENANT_B_STATE);
    assertContainsNoTenantAData({
      checkpoint: checkpointB,
      archive: archiveB,
    });

    const encryptedRows = db
      .query<{ organization_id: string; ciphertext: string }, []>(
        `SELECT organization_id, ciphertext
           FROM pooled_model_provider_keys
          ORDER BY organization_id`,
      )
      .all();
    expect(JSON.stringify(encryptedRows)).not.toContain(TENANT_A_KEY);
    expect(JSON.stringify(encryptedRows)).not.toContain(TENANT_B_KEY);
  });
});
