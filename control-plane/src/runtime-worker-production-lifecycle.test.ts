import { describe, expect, test } from "bun:test";

import {
  createRuntimeWorkerProductionLifecycleAdapter,
  runtimeWorkerProductionLifecycleConfigFromEnv,
  type RuntimeWorkerObjectHead,
  type RuntimeWorkerProductionTransport,
  type RuntimeWorkerRestoreReceipt,
  type RuntimeWorkerVBundleEntry,
  type RuntimeWorkerVBundleReceipt,
} from "./runtime-worker-production-lifecycle.js";
import {
  buildRuntimeWorkerStateObjectKey,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import { runtimeWorkerProductionTransportConfigFromEnv } from "./runtime-worker-production-transport.js";

const tenantA = { orgId: "org-a", assistantId: "assistant-a" };
const tenantB = { orgId: "org-b", assistantId: "assistant-b" };
const BUCKET = "worklin-runtime-state";
const CHECKSUM = "a".repeat(64);
const WORKER = "worker-1";
const LEASE_GENERATION = 7;
const WORKSPACE_BYTES = 1_152;

function objectFor(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
  overrides: Partial<RuntimeWorkerStateObject> = {},
): RuntimeWorkerStateObject {
  return {
    provider: "gcs",
    bucket: BUCKET,
    objectKey: buildRuntimeWorkerStateObjectKey(tenant, generation),
    checksumSha256: CHECKSUM,
    byteSize: 4_096,
    format: "vbundle-v1",
    ...overrides,
  };
}

function safeEntries(): RuntimeWorkerVBundleEntry[] {
  return [
    {
      path: "workspace/data/db/assistant.db",
      kind: "file",
      checksumSha256: "b".repeat(64),
      byteSize: 1_024,
    },
    {
      path: "workspace/config.json",
      kind: "file",
      checksumSha256: "c".repeat(64),
      byteSize: 128,
    },
  ];
}

function receiptFor(input: {
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  object: RuntimeWorkerStateObject;
  entries?: readonly RuntimeWorkerVBundleEntry[];
  credentialsIncluded?: number;
  secretsRedacted?: boolean;
  leaseGeneration?: number;
  stateGeneration?: number;
  workspaceByteSize?: number;
}): RuntimeWorkerVBundleReceipt {
  const entries = input.entries ?? safeEntries();
  return {
    tenant: input.tenant,
    workerStackId: input.workerStackId,
    leaseGeneration: input.leaseGeneration ?? LEASE_GENERATION,
    stateGeneration:
      input.stateGeneration ?? generationFromKey(input.object.objectKey),
    object: input.object,
    workspaceByteSize:
      input.workspaceByteSize ??
      entries.reduce((total, entry) => total + entry.byteSize, 0),
    entries,
    credentialsIncluded: input.credentialsIncluded ?? 0,
    secretsRedacted: input.secretsRedacted ?? true,
  };
}

function restoreReceiptFor(input: {
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  object: RuntimeWorkerStateObject;
  leaseGeneration?: number;
  stateGeneration?: number;
}): RuntimeWorkerRestoreReceipt {
  return {
    status: "restored",
    tenant: input.tenant,
    workerStackId: input.workerStackId,
    leaseGeneration: input.leaseGeneration ?? LEASE_GENERATION,
    stateGeneration:
      input.stateGeneration ?? generationFromKey(input.object.objectKey),
    object: input.object,
    workspaceByteSize: WORKSPACE_BYTES,
    filesRestored: 2,
    credentialsImported: 0,
    secretsMaterialized: false,
  };
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

function makeTransport(
  overrides: Partial<RuntimeWorkerProductionTransport> = {},
): RuntimeWorkerProductionTransport {
  const objects = new Map<string, RuntimeWorkerStateObject>();
  return {
    exportRedactedVBundle: async ({
      tenant,
      workerStackId,
      objectKey,
      leaseGeneration,
      stateGeneration,
    }) => {
      const object = objectFor(tenant, generationFromKey(objectKey));
      objects.set(objectKey, object);
      return receiptFor({
        tenant,
        workerStackId,
        object,
        leaseGeneration,
        stateGeneration,
      });
    },
    restoreRedactedVBundle: async ({
      tenant,
      workerStackId,
      object,
      leaseGeneration,
      stateGeneration,
    }) =>
      restoreReceiptFor({
        tenant,
        workerStackId,
        object,
        leaseGeneration,
        stateGeneration,
      }),
    prepareEmptyWorkspace: async ({
      tenant,
      workerStackId,
      leaseGeneration,
    }) => ({
      status: "prepared_empty",
      tenant,
      workerStackId,
      leaseGeneration,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    }),
    headObject: async ({ objectKey }) => {
      const object = objects.get(objectKey);
      return object ? headFor(object) : null;
    },
    sanitizeWorkspace: async ({ tenant, workerStackId, leaseGeneration }) => ({
      status: "sanitized",
      tenant,
      workerStackId,
      leaseGeneration,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    }),
    revokeLeaseAuthority: async ({ workerStackId, leaseGeneration }) => ({
      status: "revoked",
      workerStackId,
      leaseGeneration,
    }),
    ...overrides,
  };
}

function generationFromKey(objectKey: string): number {
  const match = /generation-(\d+)\.vbundle$/u.exec(objectKey);
  if (!match?.[1]) throw new Error("Invalid fixture object key.");
  return Number(match[1]);
}

function adapter(transport: RuntimeWorkerProductionTransport) {
  return createRuntimeWorkerProductionLifecycleAdapter(
    { bucket: BUCKET },
    transport,
  );
}

describe("runtime worker production lifecycle config", () => {
  test("fails closed when the bucket or transport is absent", () => {
    expect(() => runtimeWorkerProductionLifecycleConfigFromEnv({})).toThrow(
      "WORKLIN_RUNTIME_WORKER_STATE_BUCKET is required",
    );
    expect(() =>
      runtimeWorkerProductionLifecycleConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: "https://storage.googleapis.com",
      }),
    ).toThrow("bucket is invalid");
    expect(() =>
      runtimeWorkerProductionLifecycleConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: "invalid_bucket",
      }),
    ).toThrow("bucket is invalid");
    expect(() =>
      createRuntimeWorkerProductionLifecycleAdapter({ bucket: BUCKET }, null),
    ).toThrow("transport is not configured");
  });

  test("reports Railway bucket metadata as S3 without retaining credentials", () => {
    const rawEnv = {
      WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
      BUCKET,
      ACCESS_KEY_ID: "railway-access-key",
      SECRET_ACCESS_KEY: "railway-secret-key-value",
      REGION: "auto",
      ENDPOINT: "https://storage.railway.app",
    };
    const config = runtimeWorkerProductionLifecycleConfigFromEnv(rawEnv);
    const transportConfig =
      runtimeWorkerProductionTransportConfigFromEnv(rawEnv);
    expect(config).toEqual({ provider: "s3", bucket: BUCKET });
    expect(transportConfig).toMatchObject(config);
    expect(JSON.stringify(config)).not.toContain("railway-access-key");
  });
});

describe("runtime worker production lifecycle adapter", () => {
  test("exports only a tenant-scoped redacted bundle and verifies remote metadata", async () => {
    const policies: string[] = [];
    const objects = new Map<string, RuntimeWorkerStateObject>();
    const transport = makeTransport({
      exportRedactedVBundle: async ({
        tenant,
        workerStackId,
        objectKey,
        credentialPolicy,
        leaseGeneration,
        stateGeneration,
      }) => {
        policies.push(credentialPolicy);
        const object = objectFor(tenant, generationFromKey(objectKey));
        objects.set(objectKey, object);
        return receiptFor({
          tenant,
          workerStackId,
          object,
          leaseGeneration,
          stateGeneration,
        });
      },
      headObject: async ({ objectKey }) => {
        const object = objects.get(objectKey);
        return object ? headFor(object) : null;
      },
    });

    const object = await adapter(transport).storage.export({
      tenant: tenantA,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      currentStateGeneration: 0,
      nextStateGeneration: 1,
      objectKey: buildRuntimeWorkerStateObjectKey(tenantA, 1),
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });

    expect(object).toEqual({
      object: objectFor(tenantA, 1),
      workspaceByteSize: WORKSPACE_BYTES,
    });
    expect(policies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
  });

  test("preserves truthful S3 provider metadata through the lifecycle", async () => {
    const object = objectFor(tenantA, 1, { provider: "s3" });
    const transport = makeTransport({
      exportRedactedVBundle: async ({
        tenant,
        workerStackId,
        leaseGeneration,
        stateGeneration,
      }) =>
        receiptFor({
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration,
          object,
        }),
      headObject: async () => headFor(object),
    });
    const lifecycle = createRuntimeWorkerProductionLifecycleAdapter(
      { provider: "s3", bucket: BUCKET },
      transport,
    );

    expect(
      await lifecycle.storage.export({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        currentStateGeneration: 0,
        nextStateGeneration: 1,
        objectKey: object.objectKey,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).toEqual({ object, workspaceByteSize: WORKSPACE_BYTES });
  });

  test("restores only after object checksum, size, key, and receipt verification", async () => {
    const object = objectFor(tenantA, 3);
    const policies: string[] = [];
    const transport = makeTransport({
      headObject: async () => headFor(object),
      restoreRedactedVBundle: async ({
        tenant,
        workerStackId,
        object: restored,
        credentialPolicy,
        leaseGeneration,
        stateGeneration,
      }) => {
        policies.push(credentialPolicy);
        return restoreReceiptFor({
          tenant,
          workerStackId,
          object: restored,
          leaseGeneration,
          stateGeneration,
        });
      },
    });

    expect(
      await adapter(transport).storage.restore({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: 3,
        object,
        expectedWorkspaceByteSize: WORKSPACE_BYTES,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).toEqual({
      checksumSha256: CHECKSUM,
      workspaceByteSize: WORKSPACE_BYTES,
    });
    expect(policies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
  });

  test("rejects receipts that conflate lease and state generations", async () => {
    const exportObject = objectFor(tenantA, 1);
    await expect(
      adapter(
        makeTransport({
          exportRedactedVBundle: async () =>
            receiptFor({
              tenant: tenantA,
              workerStackId: WORKER,
              object: exportObject,
              leaseGeneration: LEASE_GENERATION + 1,
              stateGeneration: 1,
            }),
          headObject: async () => headFor(exportObject),
        }),
      ).storage.export({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        currentStateGeneration: 0,
        nextStateGeneration: 1,
        objectKey: exportObject.objectKey,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("lease and state generations");

    const restoreObject = objectFor(tenantA, 3);
    await expect(
      adapter(
        makeTransport({
          headObject: async () => headFor(restoreObject),
          restoreRedactedVBundle: async () =>
            restoreReceiptFor({
              tenant: tenantA,
              workerStackId: WORKER,
              object: restoreObject,
              leaseGeneration: LEASE_GENERATION,
              stateGeneration: 4,
            }),
        }),
      ).storage.restore({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: 3,
        object: restoreObject,
        expectedWorkspaceByteSize: WORKSPACE_BYTES,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("lease and state generations");
  });

  test("prepares an empty generation without touching CES credentials", async () => {
    const policies: string[] = [];
    const transport = makeTransport({
      prepareEmptyWorkspace: async ({
        tenant,
        workerStackId,
        credentialPolicy,
        leaseGeneration,
      }) => {
        policies.push(credentialPolicy);
        return {
          status: "prepared_empty",
          tenant,
          workerStackId,
          leaseGeneration,
          remainingTenantPaths: 0,
          credentialsTouched: false,
        };
      },
    });

    expect(
      await adapter(transport).storage.restore({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: 0,
        object: null,
        expectedWorkspaceByteSize: 0,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).toEqual({ checksumSha256: null, workspaceByteSize: 0 });
    expect(policies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
  });

  test("rejects symlinks, traversal, and credential namespaces", async () => {
    const unsafeEntries: RuntimeWorkerVBundleEntry[][] = [
      [
        {
          path: "workspace/link",
          kind: "symlink",
          linkTarget: "../outside",
          checksumSha256: "b".repeat(64),
          byteSize: 0,
        },
      ],
      [
        {
          path: "workspace/%252e%252e/outside",
          kind: "file",
          checksumSha256: "b".repeat(64),
          byteSize: 1,
        },
      ],
      [
        {
          path: "workspace/%252525252525252e%252525252525252e/outside",
          kind: "file",
          checksumSha256: "b".repeat(64),
          byteSize: 1,
        },
      ],
      [
        {
          path: "workspace/credentials/provider-key",
          kind: "file",
          checksumSha256: "b".repeat(64),
          byteSize: 1,
        },
      ],
      [
        {
          path: "workspace/config%00.json",
          kind: "file",
          checksumSha256: "b".repeat(64),
          byteSize: 1,
        },
      ],
    ];

    for (const entries of unsafeEntries) {
      const objects = new Map<string, RuntimeWorkerStateObject>();
      const transport = makeTransport({
        exportRedactedVBundle: async ({
          tenant,
          workerStackId,
          objectKey,
          leaseGeneration,
          stateGeneration,
        }) => {
          const object = objectFor(tenant, generationFromKey(objectKey));
          objects.set(objectKey, object);
          return receiptFor({
            tenant,
            workerStackId,
            object,
            entries,
            leaseGeneration,
            stateGeneration,
          });
        },
        headObject: async ({ objectKey }) => {
          const object = objects.get(objectKey);
          return object ? headFor(object) : null;
        },
      });
      await expect(
        adapter(transport).storage.export({
          tenant: tenantA,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          currentStateGeneration: 0,
          nextStateGeneration: 1,
          objectKey: buildRuntimeWorkerStateObjectKey(tenantA, 1),
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects cross-tenant receipts and objects", async () => {
    const wrongObject = objectFor(tenantB, 1);
    const transport = makeTransport({
      exportRedactedVBundle: async () =>
        receiptFor({
          tenant: tenantB,
          workerStackId: WORKER,
          object: wrongObject,
        }),
      headObject: async () => headFor(wrongObject),
    });
    await expect(
      adapter(transport).storage.export({
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        currentStateGeneration: 0,
        nextStateGeneration: 1,
        objectKey: buildRuntimeWorkerStateObjectKey(tenantA, 1),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("tenant generation namespace");
  });

  test("rejects credentials and unredacted receipts", async () => {
    const object = objectFor(tenantA, 1);
    for (const receipt of [
      receiptFor({
        tenant: tenantA,
        workerStackId: WORKER,
        object,
        credentialsIncluded: 1,
      }),
      receiptFor({
        tenant: tenantA,
        workerStackId: WORKER,
        object,
        secretsRedacted: false,
      }),
    ]) {
      const transport = makeTransport({
        exportRedactedVBundle: async () => receipt,
        headObject: async () => headFor(object),
      });
      await expect(
        adapter(transport).storage.export({
          tenant: tenantA,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          currentStateGeneration: 0,
          nextStateGeneration: 1,
          objectKey: buildRuntimeWorkerStateObjectKey(tenantA, 1),
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow("exclude credentials");
    }
  });

  test("rejects remote checksum and size mismatches", async () => {
    const object = objectFor(tenantA, 2);
    for (const head of [
      headFor(objectFor(tenantA, 2, { checksumSha256: "d".repeat(64) })),
      headFor(objectFor(tenantA, 2, { byteSize: object.byteSize + 1 })),
    ]) {
      const transport = makeTransport({
        headObject: async () => head,
        restoreRedactedVBundle: async () =>
          restoreReceiptFor({
            tenant: tenantA,
            workerStackId: WORKER,
            object,
          }),
      });
      await expect(
        adapter(transport).storage.restore({
          tenant: tenantA,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          stateGeneration: 2,
          object,
          expectedWorkspaceByteSize: WORKSPACE_BYTES,
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow("metadata verification failed");
    }
  });

  test("accepts idempotent sanitization only when no tenant paths or credentials were touched", async () => {
    let callCount = 0;
    const goodTransport = makeTransport({
      sanitizeWorkspace: async ({
        tenant,
        workerStackId,
        leaseGeneration,
      }) => ({
        status: callCount++ === 0 ? "sanitized" : "already_sanitized",
        tenant,
        workerStackId,
        leaseGeneration,
        remainingTenantPaths: 0,
        credentialsTouched: false,
      }),
    });
    const lifecycle = adapter(goodTransport);
    const input = {
      assistant: { id: tenantA.assistantId, org_id: tenantA.orgId },
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    };
    await lifecycle.sanitize(input);
    await lifecycle.sanitize(input);
    expect(callCount).toBe(2);

    const unsafeTransport = makeTransport({
      sanitizeWorkspace: async ({
        tenant,
        workerStackId,
        leaseGeneration,
      }) => ({
        status: "sanitized",
        tenant,
        workerStackId,
        leaseGeneration,
        remainingTenantPaths: 1,
        credentialsTouched: false,
      }),
    });
    await expect(adapter(unsafeTransport).sanitize(input)).rejects.toThrow(
      "sanitization could not be verified",
    );
  });

  test("verifies the exact worker generation authority revocation receipt", async () => {
    const calls: Array<{
      tenant: RuntimeWorkerStateTenant;
      workerStackId: string;
      leaseGeneration: number;
    }> = [];
    const lifecycle = adapter(
      makeTransport({
        revokeLeaseAuthority: async (input) => {
          calls.push(input);
          return {
            status: "revoked",
            workerStackId: input.workerStackId,
            leaseGeneration: input.leaseGeneration,
          };
        },
      }),
    );
    const input = {
      assistant: { id: tenantA.assistantId, org_id: tenantA.orgId },
      workerStackId: WORKER,
      leaseGeneration: 7,
    };
    await lifecycle.revokeAuthority(input);
    expect(calls).toEqual([
      {
        tenant: tenantA,
        workerStackId: WORKER,
        leaseGeneration: 7,
      },
    ]);

    const mismatched = adapter(
      makeTransport({
        revokeLeaseAuthority: async ({ workerStackId, leaseGeneration }) => ({
          status: "revoked",
          workerStackId,
          leaseGeneration: leaseGeneration + 1,
        }),
      }),
    );
    await expect(mismatched.revokeAuthority(input)).rejects.toThrow(
      "revocation could not be verified",
    );
  });
});
