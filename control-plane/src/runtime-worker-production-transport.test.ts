import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  buildRuntimeWorkerStateBundleId,
  buildRuntimeWorkerStateObjectKey,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import type {
  RuntimeWorkerProductionTransport,
  RuntimeWorkerRestoreReceipt,
  RuntimeWorkerSanitizeReceipt,
  RuntimeWorkerVBundleReceipt,
} from "./runtime-worker-production-lifecycle.js";
import {
  RUNTIME_WORKER_STATE_ROUTE_CONTRACT,
  createRuntimeWorkerProductionTransportFromEnv,
  runtimeWorkerProductionTransportConfigFromEnv,
  type RuntimeWorkerLeaseAuthorization,
  type RuntimeWorkerProductionTransportDependencies,
  type RuntimeWorkerStateTransportOperation,
} from "./runtime-worker-production-transport.js";

const BUCKET = "worklin-runtime-state";
const WORKER = "worker-1";
const TENANT_A = { orgId: "org-a", assistantId: "assistant-a" };
const TENANT_B = { orgId: "org-b", assistantId: "assistant-b" };
const NOW = new Date("2026-07-20T12:34:56.000Z");
const BODY = new TextEncoder().encode("verified pooled state");
const CHECKSUM = createHash("sha256").update(BODY).digest("hex");
const ENTRY_CHECKSUM = "b".repeat(64);
const LEASE_GENERATION = 7;
const STATE_GENERATION = 3;
const WORKSPACE_BYTES = 12;
const WORKSPACE_QUOTA_BYTES = 32_768;
const ARCHIVE_OVERHEAD_BYTES = 32_768;
const BUNDLE_ID = buildRuntimeWorkerStateBundleId(TENANT_A, STATE_GENERATION);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function enabledEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
    WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON:
      serviceAccountJson(privateKey),
    WORKLIN_RUNTIME_WORKER_STATE_SIGNED_URL_TTL_SECONDS: "600",
    WORKLIN_RUNTIME_WORKER_STATE_REQUEST_TIMEOUT_MS: "1000",
    WORKLIN_RUNTIME_WORKER_STATE_MAX_RECEIPT_BYTES: "65536",
    WORKLIN_RUNTIME_WORKER_STATE_MAX_OBJECT_BYTES: "65536",
    WORKLIN_TENANT_STORAGE_QUOTA_BYTES: String(WORKSPACE_QUOTA_BYTES),
    WORKLIN_RUNTIME_WORKER_STATE_ARCHIVE_OVERHEAD_BYTES: String(
      ARCHIVE_OVERHEAD_BYTES,
    ),
    ...overrides,
  };
}

function s3EnabledEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
    WORKLIN_RUNTIME_WORKER_STATE_PROVIDER: "s3",
    WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
    WORKLIN_RUNTIME_WORKER_STATE_S3_ACCESS_KEY_ID: "railway-access-key",
    WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY:
      "railway-secret-key-value",
    WORKLIN_RUNTIME_WORKER_STATE_S3_REGION: "auto",
    WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT: "https://storage.railway.app",
    WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE: "virtual",
    WORKLIN_RUNTIME_WORKER_STATE_SIGNED_URL_TTL_SECONDS: "600",
    WORKLIN_RUNTIME_WORKER_STATE_REQUEST_TIMEOUT_MS: "1000",
    WORKLIN_RUNTIME_WORKER_STATE_MAX_RECEIPT_BYTES: "65536",
    WORKLIN_RUNTIME_WORKER_STATE_MAX_OBJECT_BYTES: "65536",
    WORKLIN_TENANT_STORAGE_QUOTA_BYTES: String(WORKSPACE_QUOTA_BYTES),
    WORKLIN_RUNTIME_WORKER_STATE_ARCHIVE_OVERHEAD_BYTES: String(
      ARCHIVE_OVERHEAD_BYTES,
    ),
    ...overrides,
  };
}

function serviceAccountJson(key: KeyObject): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "runtime-state@example.com",
    private_key: key.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

function objectFor(
  tenant: RuntimeWorkerStateTenant,
  generation = 3,
  overrides: Partial<RuntimeWorkerStateObject> = {},
): RuntimeWorkerStateObject {
  return {
    provider: "gcs",
    bucket: BUCKET,
    objectKey: buildRuntimeWorkerStateObjectKey(tenant, generation),
    checksumSha256: CHECKSUM,
    byteSize: BODY.byteLength,
    format: "vbundle-v1",
    ...overrides,
  };
}

function receiptFor(
  tenant: RuntimeWorkerStateTenant,
  workerStackId = WORKER,
  object = objectFor(tenant),
  leaseGeneration = LEASE_GENERATION,
  stateGeneration = STATE_GENERATION,
): RuntimeWorkerVBundleReceipt {
  return {
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
    object,
    workspaceByteSize: WORKSPACE_BYTES,
    entries: [
      {
        path: "workspace/config.json",
        kind: "file",
        checksumSha256: ENTRY_CHECKSUM,
        byteSize: 12,
      },
    ],
    credentialsIncluded: 0,
    secretsRedacted: true,
  };
}

function restoreReceiptFor(
  tenant: RuntimeWorkerStateTenant,
  workerStackId = WORKER,
  object = objectFor(tenant),
  leaseGeneration = LEASE_GENERATION,
  stateGeneration = STATE_GENERATION,
): RuntimeWorkerRestoreReceipt {
  return {
    status: "restored",
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
    object,
    workspaceByteSize: WORKSPACE_BYTES,
    filesRestored: 2,
    credentialsImported: 0,
    secretsMaterialized: false,
  };
}

function sanitizeReceiptFor(
  status: RuntimeWorkerSanitizeReceipt["status"],
  tenant: RuntimeWorkerStateTenant = TENANT_A,
  workerStackId = WORKER,
  leaseGeneration = LEASE_GENERATION,
): RuntimeWorkerSanitizeReceipt {
  return {
    status,
    tenant,
    workerStackId,
    leaseGeneration,
    remainingTenantPaths: 0,
    credentialsTouched: false,
  };
}

function authorization(
  tenant: RuntimeWorkerStateTenant = TENANT_A,
  workerStackId = WORKER,
  overrides: Partial<RuntimeWorkerLeaseAuthorization> = {},
): RuntimeWorkerLeaseAuthorization {
  return {
    bearerToken: "signed.lease.token",
    expiresAtMs: NOW.getTime() + 30_000,
    binding: {
      organizationId: tenant.orgId,
      userId: "user-1",
      assistantId: tenant.assistantId,
      workerStackId,
      leaseGeneration: 7,
      leaseExpiresAtMs: NOW.getTime() + 60_000,
    },
    stack: {
      id: workerStackId,
      status: "active",
      provider: "pooled_worker",
      gateway_url: "https://worker.example.com",
      public_ingress_url: null,
      workspace_volume_ref: "volume-1",
      service_ref: "service-1",
      actor_signing_key_scope: "runtime_v1:worker-1",
    },
    ...overrides,
  };
}

function makeTransport(
  dependencies: Partial<RuntimeWorkerProductionTransportDependencies> = {},
): RuntimeWorkerProductionTransport {
  const value = createRuntimeWorkerProductionTransportFromEnv(enabledEnv(), {
    authorizeLease:
      dependencies.authorizeLease ??
      (async ({ tenant, workerStackId }) =>
        authorization(tenant, workerStackId)),
    resolveWorkspaceQuotaBytes:
      dependencies.resolveWorkspaceQuotaBytes ?? (() => WORKSPACE_QUOTA_BYTES),
    ...(dependencies.resolveBootstrapInferenceProvider
      ? {
          resolveBootstrapInferenceProvider:
            dependencies.resolveBootstrapInferenceProvider,
        }
      : {}),
    fetch: dependencies.fetch ?? fetch,
    now: dependencies.now ?? (() => new Date(NOW)),
  });
  if (!value) throw new Error("Expected enabled transport.");
  return value;
}

function makeS3Transport(
  dependencies: Partial<RuntimeWorkerProductionTransportDependencies> = {},
  overrides: Record<string, string | undefined> = {},
): RuntimeWorkerProductionTransport {
  const value = createRuntimeWorkerProductionTransportFromEnv(
    s3EnabledEnv(overrides),
    {
      authorizeLease:
        dependencies.authorizeLease ??
        (async ({ tenant, workerStackId }) =>
          authorization(tenant, workerStackId)),
      resolveWorkspaceQuotaBytes:
        dependencies.resolveWorkspaceQuotaBytes ??
        (() => WORKSPACE_QUOTA_BYTES),
      ...(dependencies.resolveBootstrapInferenceProvider
        ? {
            resolveBootstrapInferenceProvider:
              dependencies.resolveBootstrapInferenceProvider,
          }
        : {}),
      fetch: dependencies.fetch ?? fetch,
      now: dependencies.now ?? (() => new Date(NOW)),
    },
  );
  if (!value) throw new Error("Expected enabled S3 transport.");
  return value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("runtime worker production transport configuration", () => {
  test("is disabled by default and rejects invalid enabled configuration", () => {
    expect(runtimeWorkerProductionTransportConfigFromEnv({})).toBeNull();
    expect(
      runtimeWorkerProductionTransportConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "false",
        WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON:
          "not inspected while disabled",
      }),
    ).toBeNull();
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv({
        WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "perhaps",
      }),
    ).toThrow("must be a boolean");
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON: undefined,
        }),
      ),
    ).toThrow("is required when enabled");
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON:
            '{"client_email":"invalid"}',
        }),
      ),
    ).toThrow("is invalid");
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_REQUEST_TIMEOUT_MS: "600000",
          WORKLIN_RUNTIME_WORKER_STATE_SIGNED_URL_TTL_SECONDS: "600",
        }),
      ),
    ).toThrow("must be shorter");
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        enabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_MAX_OBJECT_BYTES: "65535",
        }),
      ),
    ).toThrow("must cover every tenant quota");
  });

  test("returns only non-secret operational configuration", () => {
    const config = runtimeWorkerProductionTransportConfigFromEnv(enabledEnv());
    expect(config).toEqual({
      provider: "gcs",
      bucket: BUCKET,
      signedUrlTtlSeconds: 600,
      requestTimeoutMs: 1000,
      maxReceiptBytes: 65536,
      maxObjectBytes: 65536,
      workspaceArchiveOverheadBytes: ARCHIVE_OVERHEAD_BYTES,
    });
    expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(config)).not.toContain("gserviceaccount");
  });

  test("maps Railway bucket variables into non-secret S3 metadata", () => {
    const secret = "railway-secret-key-value";
    const config = runtimeWorkerProductionTransportConfigFromEnv(
      s3EnabledEnv({
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: undefined,
        WORKLIN_RUNTIME_WORKER_STATE_S3_ACCESS_KEY_ID: undefined,
        WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY: undefined,
        WORKLIN_RUNTIME_WORKER_STATE_S3_REGION: undefined,
        WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT: undefined,
        WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE: undefined,
        BUCKET,
        ACCESS_KEY_ID: "railway-access-key",
        SECRET_ACCESS_KEY: secret,
        REGION: "auto",
        ENDPOINT: "https://storage.railway.app",
        URL_STYLE: "virtual",
      }),
    );
    expect(config).toEqual({
      provider: "s3",
      bucket: BUCKET,
      endpoint: "https://storage.railway.app/",
      region: "auto",
      urlStyle: "virtual",
      signedUrlTtlSeconds: 600,
      requestTimeoutMs: 1000,
      maxReceiptBytes: 65536,
      maxObjectBytes: 65536,
      workspaceArchiveOverheadBytes: ARCHIVE_OVERHEAD_BYTES,
    });
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(JSON.stringify(config)).not.toContain("railway-access-key");
  });

  test("rejects unsafe Railway S3 endpoint and incomplete credentials", () => {
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        s3EnabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT: "http://127.0.0.1:9000",
        }),
      ),
    ).toThrow("endpoint is invalid");
    expect(() =>
      runtimeWorkerProductionTransportConfigFromEnv(
        s3EnabledEnv({
          WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY: undefined,
        }),
      ),
    ).toThrow("credentials are invalid");
  });
});

describe("runtime worker Railway S3 production transport", () => {
  test("presigns one exact virtual-hosted PUT without exposing credentials", async () => {
    const observed: Record<string, unknown>[] = [];
    const object = objectFor(TENANT_A, STATE_GENERATION, { provider: "s3" });
    const transport = makeS3Transport({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        observed.push((await request.json()) as Record<string, unknown>);
        return jsonResponse(receiptFor(TENANT_A, WORKER, object));
      }) as typeof fetch,
    });

    await transport.exportRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      provider: "s3",
      bucket: BUCKET,
      objectKey: object.objectKey,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });

    const upload = new URL(String(observed[0]?.upload_url));
    expect(upload.origin).toBe(`https://${BUCKET}.storage.railway.app`);
    expect(upload.pathname).toBe(`/${object.objectKey}`);
    expect(upload.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(upload.searchParams.get("X-Amz-Credential")).toContain(
      "/auto/s3/aws4_request",
    );
    expect(upload.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(upload.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(upload.searchParams.get("X-Amz-Signature")).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(upload.href).not.toContain("railway-secret-key-value");
    expect(observed[0]?.bundle_id).toBe(
      buildRuntimeWorkerStateBundleId(TENANT_A, STATE_GENERATION, "s3"),
    );
  });

  test("supports explicit path style and rejects a cross-tenant key before signing", async () => {
    const observed: Record<string, unknown>[] = [];
    const object = objectFor(TENANT_A, STATE_GENERATION, { provider: "s3" });
    const transport = makeS3Transport(
      {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          observed.push((await request.json()) as Record<string, unknown>);
          return jsonResponse(receiptFor(TENANT_A, WORKER, object));
        }) as typeof fetch,
      },
      { WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE: "path" },
    );

    await transport.exportRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      provider: "s3",
      bucket: BUCKET,
      objectKey: object.objectKey,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });
    const upload = new URL(String(observed[0]?.upload_url));
    expect(upload.origin).toBe("https://storage.railway.app");
    expect(upload.pathname).toBe(`/${BUCKET}/${object.objectKey}`);

    await expect(
      transport.exportRedactedVBundle({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: STATE_GENERATION,
        provider: "s3",
        bucket: BUCKET,
        objectKey: buildRuntimeWorkerStateObjectKey(TENANT_B, STATE_GENERATION),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("outside the tenant namespace");
    expect(observed).toHaveLength(1);
  });

  test("presigns exact GET and HEAD URLs for restore and verification", async () => {
    const object = objectFor(TENANT_A, STATE_GENERATION, { provider: "s3" });
    let downloadUrl = "";
    const restoring = makeS3Transport({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as Record<string, unknown>;
        downloadUrl = String(body.download_url);
        return jsonResponse(restoreReceiptFor(TENANT_A, WORKER, object));
      }) as typeof fetch,
    });
    await restoring.restoreRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      object,
      expectedWorkspaceByteSize: WORKSPACE_BYTES,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });
    const download = new URL(downloadUrl);
    expect(download.origin).toBe(`https://${BUCKET}.storage.railway.app`);
    expect(download.pathname).toBe(`/${object.objectKey}`);
    expect(download.searchParams.get("X-Amz-SignedHeaders")).toBe("host");

    const storageRequests: Request[] = [];
    const verifying = makeS3Transport({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        storageRequests.push(request);
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(BODY.byteLength),
            },
          });
        }
        return new Response(BODY, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(BODY.byteLength),
          },
        });
      }) as typeof fetch,
    });
    expect(
      await verifying.headObject({
        provider: "s3",
        bucket: BUCKET,
        objectKey: object.objectKey,
      }),
    ).toMatchObject({ provider: "s3", checksumSha256: CHECKSUM });
    expect(storageRequests.map(({ method }) => method)).toEqual([
      "HEAD",
      "GET",
    ]);
    expect(
      storageRequests.every(
        ({ url, redirect }) =>
          new URL(url).origin === `https://${BUCKET}.storage.railway.app` &&
          redirect === "error",
      ),
    ).toBe(true);
  });
});

describe("runtime worker production export", () => {
  test("allows only exact Railway private HTTP worker origins", async () => {
    const requests: Request[] = [];
    const privateAuthorization = authorization(TENANT_A, WORKER, {
      stack: {
        ...authorization().stack,
        gateway_url: "http://worker-one.railway.internal:7821",
      },
    });
    const transport = makeTransport({
      authorizeLease: async () => privateAuthorization,
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse(receiptFor(TENANT_A));
      }) as typeof fetch,
    });
    await transport.exportRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      provider: "gcs",
      bucket: BUCKET,
      objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, STATE_GENERATION),
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });
    expect(requests[0]?.url).toBe(
      `http://worker-one.railway.internal:7821${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.export}`,
    );

    for (const gatewayUrl of [
      "http://worker-one.railway.internal",
      "http://worker-one.railway.internal.attacker.example:7821",
      "http://127.0.0.1:7821",
      "http://worker.example.com:7821",
      "http://user@worker-one.railway.internal:7821",
      "http://worker-one.railway.internal:7821/base",
    ]) {
      let fetchCalls = 0;
      const invalid = makeTransport({
        authorizeLease: async () =>
          authorization(TENANT_A, WORKER, {
            stack: {
              ...authorization().stack,
              gateway_url: gatewayUrl,
            },
          }),
        fetch: (async () => {
          fetchCalls += 1;
          return jsonResponse(receiptFor(TENANT_A));
        }) as unknown as typeof fetch,
      });
      await expect(
        invalid.exportRedactedVBundle({
          tenant: TENANT_A,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          stateGeneration: STATE_GENERATION,
          provider: "gcs",
          bucket: BUCKET,
          objectKey: buildRuntimeWorkerStateObjectKey(
            TENANT_A,
            STATE_GENERATION,
          ),
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow("gateway URL is invalid");
      expect(fetchCalls).toBe(0);
    }
  });

  test("signs an exact tenant-generation GCS PUT and calls the assigned worker", async () => {
    const calls: Array<{ request: Request; body?: unknown }> = [];
    const transport = makeTransport({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.json();
        calls.push({ request, body });
        return jsonResponse(receiptFor(TENANT_A));
      }) as unknown as typeof fetch,
    });
    const objectKey = buildRuntimeWorkerStateObjectKey(TENANT_A, 3);

    const receipt = await transport.exportRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      provider: "gcs",
      bucket: BUCKET,
      objectKey,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });

    expect(receipt).toEqual(receiptFor(TENANT_A));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe(
      `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.export}`,
    );
    expect(calls[0]?.request.method).toBe("POST");
    expect(calls[0]?.request.headers.get("authorization")).toBe(
      "Bearer signed.lease.token",
    );
    expect(calls[0]?.request.redirect).toBe("error");
    expect(calls[0]?.request.signal).toBeInstanceOf(AbortSignal);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "archive_overhead_bytes",
      "bundle_id",
      "created_at",
      "lease_generation",
      "state_generation",
      "upload_url",
      "workspace_quota_bytes",
    ]);
    expect(body.lease_generation).toBe(LEASE_GENERATION);
    expect(body.state_generation).toBe(STATE_GENERATION);
    expect(body.bundle_id).toBe(BUNDLE_ID);
    expect(body.created_at).toBe(NOW.toISOString());

    const upload = new URL(String(body.upload_url));
    expect(upload.origin).toBe("https://storage.googleapis.com");
    expect(upload.pathname).toBe(`/${BUCKET}/${objectKey}`);
    expect(upload.searchParams.get("X-Goog-Algorithm")).toBe(
      "GOOG4-RSA-SHA256",
    );
    expect(upload.searchParams.get("X-Goog-Date")).toBe("20260720T123456Z");
    expect(upload.searchParams.get("X-Goog-Expires")).toBe("600");
    expect(upload.searchParams.get("X-Goog-SignedHeaders")).toBe(
      "content-type;host",
    );
    expect(upload.searchParams.get("X-Goog-Credential")).toBe(
      "runtime-state@example.com/20260720/auto/storage/goog4_request",
    );
    expect(upload.searchParams.get("X-Goog-Signature")).toMatch(/^[a-f0-9]+$/u);
  });

  test("rejects cross-tenant object keys before authorization or network access", async () => {
    let authorizationCalls = 0;
    let fetchCalls = 0;
    const transport = makeTransport({
      authorizeLease: async () => {
        authorizationCalls += 1;
        return authorization();
      },
      fetch: (async () => {
        fetchCalls += 1;
        return jsonResponse(receiptFor(TENANT_A));
      }) as unknown as typeof fetch,
    });

    await expect(
      transport.exportRedactedVBundle({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: STATE_GENERATION,
        provider: "gcs",
        bucket: BUCKET,
        objectKey: buildRuntimeWorkerStateObjectKey(TENANT_B, 3),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("outside the tenant namespace");
    expect(authorizationCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("rejects cross-tenant and cross-worker lease authorization", async () => {
    for (const invalid of [
      authorization(TENANT_B),
      authorization(TENANT_A, "worker-2"),
      authorization(TENANT_A, WORKER, {
        stack: {
          ...authorization().stack,
          id: "worker-2",
        },
      }),
      authorization(TENANT_A, WORKER, {
        binding: {
          ...authorization().binding,
          leaseGeneration: LEASE_GENERATION + 1,
        },
      }),
    ]) {
      let fetchCalls = 0;
      const transport = makeTransport({
        authorizeLease: async () => invalid,
        fetch: (async () => {
          fetchCalls += 1;
          return jsonResponse(receiptFor(TENANT_A));
        }) as unknown as typeof fetch,
      });
      await expect(
        transport.exportRedactedVBundle({
          tenant: TENANT_A,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          stateGeneration: STATE_GENERATION,
          provider: "gcs",
          bucket: BUCKET,
          objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, 3),
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow("does not match");
      expect(fetchCalls).toBe(0);
    }
  });

  test("rejects redirects, error statuses, and invalid exact receipts", async () => {
    const invalidReceipts: unknown[] = [
      { ...receiptFor(TENANT_A), unexpected: true },
      receiptFor(TENANT_B),
      receiptFor(TENANT_A, "worker-2"),
      { ...receiptFor(TENANT_A), credentialsIncluded: 1 },
      {
        ...receiptFor(TENANT_A),
        object: objectFor(TENANT_A, 4),
      },
      {
        ...receiptFor(TENANT_A),
        leaseGeneration: LEASE_GENERATION + 1,
      },
      {
        ...receiptFor(TENANT_A),
        stateGeneration: STATE_GENERATION + 1,
      },
    ];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example.com" },
      }),
      jsonResponse({ error: "secret should not escape" }, 503),
      new Response(JSON.stringify(receiptFor(TENANT_A)), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      ...invalidReceipts.map((receipt) => jsonResponse(receipt)),
    ];
    for (const response of responses) {
      const transport = makeTransport({
        fetch: (async () => response) as unknown as typeof fetch,
      });
      await expect(
        transport.exportRedactedVBundle({
          tenant: TENANT_A,
          workerStackId: WORKER,
          leaseGeneration: LEASE_GENERATION,
          stateGeneration: STATE_GENERATION,
          provider: "gcs",
          bucket: BUCKET,
          objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, 3),
          credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("runtime worker production restore and sanitization contracts", () => {
  test("uses a signed GET and exact restore contract", async () => {
    const observed: Array<{
      url: string;
      body: Record<string, unknown>;
      operation: RuntimeWorkerStateTransportOperation;
    }> = [];
    const transport = makeTransport({
      authorizeLease: async (input) => {
        observed.push({
          url: "",
          body: {},
          operation: input.operation,
        });
        return authorization(input.tenant, input.workerStackId);
      },
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as Record<string, unknown>;
        const item = observed.at(-1);
        if (item) {
          item.url = request.url;
          item.body = body;
        }
        return jsonResponse(restoreReceiptFor(TENANT_A));
      }) as typeof fetch,
    });
    const object = objectFor(TENANT_A);

    await transport.restoreRedactedVBundle({
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      object,
      expectedWorkspaceByteSize: WORKSPACE_BYTES,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.operation).toBe("restore");
    expect(observed[0]?.url).toBe(
      `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.restore}`,
    );
    expect(Object.keys(observed[0]?.body ?? {}).sort()).toEqual([
      "archive_overhead_bytes",
      "bundle_id",
      "byte_size",
      "checksum_sha256",
      "download_url",
      "lease_generation",
      "state_generation",
      "workspace_byte_size",
      "workspace_quota_bytes",
    ]);
    expect(observed[0]?.body.lease_generation).toBe(LEASE_GENERATION);
    expect(observed[0]?.body.state_generation).toBe(STATE_GENERATION);
    expect(observed[0]?.body.bundle_id).toBe(BUNDLE_ID);
    expect(observed[0]?.body.checksum_sha256).toBe(CHECKSUM);
    expect(observed[0]?.body.byte_size).toBe(BODY.byteLength);
    expect(observed[0]?.body.workspace_byte_size).toBe(WORKSPACE_BYTES);
    const download = new URL(String(observed[0]?.body.download_url));
    expect(download.origin).toBe("https://storage.googleapis.com");
    expect(download.pathname).toBe(`/${BUCKET}/${object.objectKey}`);
    expect(download.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
  });

  test("sends only the lease-bound BYOK provider label for empty and restored assignments", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const bootstrapAuthorizations: RuntimeWorkerLeaseAuthorization[] = [];
    const transport = makeTransport({
      resolveBootstrapInferenceProvider: (leaseAuthorization) => {
        bootstrapAuthorizations.push(leaseAuthorization);
        return "kimi";
      },
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, body: await request.json() });
        if (
          request.url.endsWith(RUNTIME_WORKER_STATE_ROUTE_CONTRACT.restore)
        ) {
          return jsonResponse(restoreReceiptFor(TENANT_A));
        }
        const status = request.url.endsWith(
          RUNTIME_WORKER_STATE_ROUTE_CONTRACT.prepareEmpty,
        )
          ? "prepared_empty"
          : "sanitized";
        return jsonResponse(sanitizeReceiptFor(status));
      }) as typeof fetch,
    });
    const base = {
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    };

    await transport.restoreRedactedVBundle({
      ...base,
      stateGeneration: STATE_GENERATION,
      object: objectFor(TENANT_A),
      expectedWorkspaceByteSize: WORKSPACE_BYTES,
    });
    await transport.prepareEmptyWorkspace(base);
    await transport.sanitizeWorkspace(base);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      url: `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.restore}`,
      body: {
        lease_generation: LEASE_GENERATION,
        state_generation: STATE_GENERATION,
        inference_provider: "kimi",
      },
    });
    expect(requests.slice(1)).toEqual([
      {
        url: `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.prepareEmpty}`,
        body: {
          lease_generation: LEASE_GENERATION,
          workspace_quota_bytes: WORKSPACE_QUOTA_BYTES,
          archive_overhead_bytes: ARCHIVE_OVERHEAD_BYTES,
          inference_provider: "kimi",
        },
      },
      {
        url: `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.sanitize}`,
        body: {
          lease_generation: LEASE_GENERATION,
        },
      },
    ]);
    expect(bootstrapAuthorizations).toEqual([
      authorization(),
      authorization(),
    ]);
  });

  test("omits an unset bootstrap provider and rejects unsupported provider labels before worker I/O", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input, init) => {
      const request = new Request(input, init);
      requests.push((await request.json()) as Record<string, unknown>);
      return jsonResponse(sanitizeReceiptFor("prepared_empty"));
    }) as typeof fetch;
    const base = {
      tenant: TENANT_A,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
    };

    await makeTransport({ fetch: fetchImpl }).prepareEmptyWorkspace(base);
    expect(requests).toEqual([
      {
        lease_generation: LEASE_GENERATION,
        workspace_quota_bytes: WORKSPACE_QUOTA_BYTES,
        archive_overhead_bytes: ARCHIVE_OVERHEAD_BYTES,
      },
    ]);

    const invalid = makeTransport({
      resolveBootstrapInferenceProvider: (() =>
        "openai-compatible") as unknown as RuntimeWorkerProductionTransportDependencies["resolveBootstrapInferenceProvider"],
      fetch: fetchImpl,
    });
    await expect(invalid.prepareEmptyWorkspace(base)).rejects.toThrow(
      "bootstrap inference provider is invalid",
    );
    await expect(
      invalid.restoreRedactedVBundle({
        ...base,
        stateGeneration: STATE_GENERATION,
        object: objectFor(TENANT_A),
        expectedWorkspaceByteSize: WORKSPACE_BYTES,
      }),
    ).rejects.toThrow("bootstrap inference provider is invalid");
    expect(requests).toHaveLength(1);
  });

  test("revokes only the authenticated worker lease generation", async () => {
    const observed: Array<{
      operation: RuntimeWorkerStateTransportOperation;
      url: string;
      body: unknown;
    }> = [];
    const transport = makeTransport({
      authorizeLease: async (input) => {
        observed.push({ operation: input.operation, url: "", body: null });
        return authorization(input.tenant, input.workerStackId);
      },
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const item = observed.at(-1);
        if (item) {
          item.url = request.url;
          item.body = await request.json();
        }
        return jsonResponse({
          status: "revoked",
          worker_stack_id: WORKER,
          lease_generation: 7,
        });
      }) as typeof fetch,
    });

    expect(
      await transport.revokeLeaseAuthority({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: 7,
      }),
    ).toEqual({
      status: "revoked",
      workerStackId: WORKER,
      leaseGeneration: 7,
    });
    expect(observed).toEqual([
      {
        operation: "revoke",
        url: `https://worker.example.com${RUNTIME_WORKER_STATE_ROUTE_CONTRACT.revoke}`,
        body: {
          worker_stack_id: WORKER,
          lease_generation: 7,
        },
      },
    ]);

    const mismatched = makeTransport({
      fetch: (async () =>
        jsonResponse({
          status: "revoked",
          worker_stack_id: WORKER,
          lease_generation: 8,
        })) as unknown as typeof fetch,
    });
    await expect(
      mismatched.revokeLeaseAuthority({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: 7,
      }),
    ).rejects.toThrow("does not match");
  });

  test("fails closed while the destructive runtime routes are absent", async () => {
    const transport = makeTransport({
      fetch: (async () =>
        jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch,
    });
    await expect(
      transport.prepareEmptyWorkspace({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      }),
    ).rejects.toThrow("status 404");
  });
});

describe("runtime worker production object verification", () => {
  test("signs HEAD and GET and verifies type, size, and SHA-256", async () => {
    const calls: Request[] = [];
    const transport = makeTransport({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(BODY.byteLength),
            },
          });
        }
        return new Response(BODY, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(BODY.byteLength),
          },
        });
      }) as typeof fetch,
    });
    const object = objectFor(TENANT_A);

    expect(
      await transport.headObject({
        provider: "gcs",
        bucket: BUCKET,
        objectKey: object.objectKey,
      }),
    ).toEqual({
      provider: "gcs",
      bucket: BUCKET,
      objectKey: object.objectKey,
      checksumSha256: CHECKSUM,
      byteSize: BODY.byteLength,
      contentType: "application/octet-stream",
    });
    expect(calls.map(({ method }) => method)).toEqual(["HEAD", "GET"]);
    expect(calls.every(({ redirect }) => redirect === "error")).toBe(true);
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(
      true,
    );
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/${BUCKET}/${object.objectKey}`,
    );
    expect(
      new URL(calls[0]!.url).searchParams.get("X-Goog-SignedHeaders"),
    ).toBe("host");
    expect(
      new URL(calls[0]!.url).searchParams.get("X-Goog-Signature"),
    ).not.toBe(new URL(calls[1]!.url).searchParams.get("X-Goog-Signature"));
  });

  test("returns null only for HEAD 404 and rejects redirects or metadata mismatches", async () => {
    const objectKey = objectFor(TENANT_A).objectKey;
    const missing = makeTransport({
      fetch: (async () =>
        new Response(null, { status: 404 })) as unknown as typeof fetch,
    });
    expect(
      await missing.headObject({
        provider: "gcs",
        bucket: BUCKET,
        objectKey,
      }),
    ).toBeNull();

    for (const head of [
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example.com" },
      }),
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(BODY.byteLength),
        },
      }),
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "999999",
        },
      }),
    ]) {
      const transport = makeTransport({
        fetch: (async () => head) as unknown as typeof fetch,
      });
      await expect(
        transport.headObject({
          provider: "gcs",
          bucket: BUCKET,
          objectKey,
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects a GET body whose actual size differs from HEAD", async () => {
    let calls = 0;
    const transport = makeTransport({
      fetch: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(BODY.byteLength),
            },
          });
        }
        return new Response(BODY.slice(0, BODY.byteLength - 1), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(BODY.byteLength),
          },
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      transport.headObject({
        provider: "gcs",
        bucket: BUCKET,
        objectKey: objectFor(TENANT_A).objectKey,
      }),
    ).rejects.toThrow("size verification failed");
  });
});

describe("runtime worker production transport secret handling", () => {
  test("does not include provider errors, signed URLs, tokens, or credentials in failures", async () => {
    const privateKeyPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const providerSecret = "provider-secret-value";
    const leaseSecret = "lease-secret-value";
    const transport = createRuntimeWorkerProductionTransportFromEnv(
      enabledEnv(),
      {
        authorizeLease: async () => {
          throw new Error(`${leaseSecret} ${privateKeyPem}`);
        },
        fetch: (async () => {
          throw new Error(
            `https://storage.googleapis.com/${BUCKET}/state?X-Goog-Signature=${providerSecret}`,
          );
        }) as unknown as typeof fetch,
        now: () => new Date(NOW),
      },
    )!;

    let message = "";
    try {
      await transport.exportRedactedVBundle({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: STATE_GENERATION,
        provider: "gcs",
        bucket: BUCKET,
        objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, 3),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Pooled worker lease authorization failed.");
    expect(message).not.toContain(leaseSecret);
    expect(message).not.toContain(providerSecret);
    expect(message).not.toContain("PRIVATE KEY");
    expect(message).not.toContain("X-Goog-Signature");

    const fetchTransport = makeTransport({
      fetch: (async () => {
        throw new Error(
          `https://storage.googleapis.com/${BUCKET}/state?X-Goog-Signature=${providerSecret}`,
        );
      }) as unknown as typeof fetch,
    });
    let fetchMessage = "";
    try {
      await fetchTransport.exportRedactedVBundle({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: STATE_GENERATION,
        provider: "gcs",
        bucket: BUCKET,
        objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, 3),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      });
    } catch (error) {
      fetchMessage = error instanceof Error ? error.message : String(error);
    }
    expect(fetchMessage).toBe("Pooled worker state request failed.");
    expect(fetchMessage).not.toContain(providerSecret);
    expect(fetchMessage).not.toContain("X-Goog-Signature");
  });

  test("does not leak Railway S3 keys or signed URLs through worker failures", async () => {
    const secret = "railway-secret-key-value";
    const transport = makeS3Transport({
      fetch: (async () => {
        throw new Error(
          `${secret} https://${BUCKET}.storage.railway.app/state?X-Amz-Signature=private`,
        );
      }) as unknown as typeof fetch,
    });
    let message = "";
    try {
      await transport.exportRedactedVBundle({
        tenant: TENANT_A,
        workerStackId: WORKER,
        leaseGeneration: LEASE_GENERATION,
        stateGeneration: STATE_GENERATION,
        provider: "s3",
        bucket: BUCKET,
        objectKey: buildRuntimeWorkerStateObjectKey(TENANT_A, STATE_GENERATION),
        credentialPolicy: RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Pooled worker state request failed.");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("X-Amz-Signature");
    expect(message).not.toContain("railway-access-key");
  });
});
