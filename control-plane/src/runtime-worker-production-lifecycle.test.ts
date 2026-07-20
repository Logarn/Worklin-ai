import { describe, expect, test } from "bun:test";

import {
  createRuntimeWorkerProductionLifecycleAdapter,
  runtimeWorkerProductionLifecycleConfigFromEnv,
  type RuntimeWorkerObjectHead,
  type RuntimeWorkerProductionTransport,
  type RuntimeWorkerVBundleEntry,
  type RuntimeWorkerVBundleReceipt,
} from "./runtime-worker-production-lifecycle.js";
import {
  buildRuntimeWorkerStateObjectKey,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";

const tenantA = { orgId: "org-a", assistantId: "assistant-a" };
const tenantB = { orgId: "org-b", assistantId: "assistant-b" };
const BUCKET = "worklin-runtime-state";
const CHECKSUM = "a".repeat(64);
const WORKER = "worker-1";

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
}): RuntimeWorkerVBundleReceipt {
  return {
    tenant: input.tenant,
    workerStackId: input.workerStackId,
    object: input.object,
    entries: input.entries ?? safeEntries(),
    credentialsIncluded: input.credentialsIncluded ?? 0,
    secretsRedacted: input.secretsRedacted ?? true,
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
    }) => {
      const object = objectFor(tenant, generationFromKey(objectKey));
      objects.set(objectKey, object);
      return receiptFor({ tenant, workerStackId, object });
    },
    restoreRedactedVBundle: async ({
      tenant,
      workerStackId,
      object,
    }) => receiptFor({ tenant, workerStackId, object }),
    prepareEmptyWorkspace: async ({ workerStackId }) => ({
      status: "already_sanitized",
      workerStackId,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    }),
    headObject: async ({ objectKey }) => {
      const object = objects.get(objectKey);
      return object ? headFor(object) : null;
    },
    sanitizeWorkspace: async ({ workerStackId }) => ({
      status: "sanitized",
      workerStackId,
      remainingTenantPaths: 0,
      credentialsTouched: false,
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
      createRuntimeWorkerProductionLifecycleAdapter(
        { bucket: BUCKET },
        null,
      ),
    ).toThrow("transport is not configured");
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
      }) => {
        policies.push(credentialPolicy);
        const object = objectFor(tenant, generationFromKey(objectKey));
        objects.set(objectKey, object);
        return receiptFor({ tenant, workerStackId, object });
      },
      headObject: async ({ objectKey }) => {
        const object = objects.get(objectKey);
        return object ? headFor(object) : null;
      },
    });

    const object = await adapter(transport).storage.export({
      tenant: tenantA,
      workerStackId: WORKER,
      currentGeneration: 0,
      nextGeneration: 1,
      objectKey: buildRuntimeWorkerStateObjectKey(tenantA, 1),
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });

    expect(object).toEqual(objectFor(tenantA, 1));
    expect(policies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
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
      }) => {
        policies.push(credentialPolicy);
        return receiptFor({
          tenant,
          workerStackId,
          object: restored,
        });
      },
    });

    expect(
      await adapter(transport).storage.restore({
        tenant: tenantA,
        workerStackId: WORKER,
        generation: 3,
        object,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).toEqual({ checksumSha256: CHECKSUM });
    expect(policies).toEqual([RUNTIME_WORKER_STATE_CREDENTIAL_POLICY]);
  });

  test("prepares an empty generation without touching CES credentials", async () => {
    const policies: string[] = [];
    const transport = makeTransport({
      prepareEmptyWorkspace: async ({
        workerStackId,
        credentialPolicy,
      }) => {
        policies.push(credentialPolicy);
        return {
          status: "already_sanitized",
          workerStackId,
          remainingTenantPaths: 0,
          credentialsTouched: false,
        };
      },
    });

    expect(
      await adapter(transport).storage.restore({
        tenant: tenantA,
        workerStackId: WORKER,
        generation: 0,
        object: null,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).toEqual({ checksumSha256: null });
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
        }) => {
          const object = objectFor(tenant, generationFromKey(objectKey));
          objects.set(objectKey, object);
          return receiptFor({ tenant, workerStackId, object, entries });
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
          currentGeneration: 0,
          nextGeneration: 1,
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
        currentGeneration: 0,
        nextGeneration: 1,
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
          currentGeneration: 0,
          nextGeneration: 1,
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
          receiptFor({
            tenant: tenantA,
            workerStackId: WORKER,
            object,
          }),
      });
      await expect(
        adapter(transport).storage.restore({
          tenant: tenantA,
          workerStackId: WORKER,
          generation: 2,
          object,
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow("metadata verification failed");
    }
  });

  test("accepts idempotent sanitization only when no tenant paths or credentials were touched", async () => {
    let callCount = 0;
    const goodTransport = makeTransport({
      sanitizeWorkspace: async ({ workerStackId }) => ({
        status: callCount++ === 0 ? "sanitized" : "already_sanitized",
        workerStackId,
        remainingTenantPaths: 0,
        credentialsTouched: false,
      }),
    });
    const lifecycle = adapter(goodTransport);
    const input = {
      assistant: { id: tenantA.assistantId, org_id: tenantA.orgId },
      workerStackId: WORKER,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    };
    await lifecycle.sanitize(input);
    await lifecycle.sanitize(input);
    expect(callCount).toBe(2);

    const unsafeTransport = makeTransport({
      sanitizeWorkspace: async ({ workerStackId }) => ({
        status: "sanitized",
        workerStackId,
        remainingTenantPaths: 1,
        credentialsTouched: false,
      }),
    });
    await expect(adapter(unsafeTransport).sanitize(input)).rejects.toThrow(
      "sanitization could not be verified",
    );
  });
});
