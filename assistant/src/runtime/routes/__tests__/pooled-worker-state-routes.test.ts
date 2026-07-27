import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { resolveCallSiteConfig } from "../../../config/llm-resolver.js";
import { loadConfig, saveRawConfig } from "../../../config/loader.js";
import {
  createConversation,
  getConversation,
} from "../../../memory/conversation-crud.js";
import { getDb, getSqlite, resetDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { rollbackMemoryMigration } from "../../../memory/migrations/index.js";
import { getConnection } from "../../../providers/inference/connections.js";
import { resolveModelIntent } from "../../../providers/model-intents.js";
import {
  createNodePooledWorkspaceFileSystem,
  createPooledWorkspaceSanitizer,
} from "../../../services/pooled-workspace-sanitizer.js";
import {
  _resetStreamStateForTesting,
  getPersistedSeq,
  getReplayWindow,
  recordPersistedSeq,
  stampAndBuffer,
} from "../../assistant-stream-state.js";
import type { AuthContext, Scope } from "../../auth/types.js";
import type {
  PooledStateExportArtifact,
  PooledStateExportInput,
} from "../../migrations/pooled-state-export.js";
import {
  PooledRuntimeDrainFence,
  type PooledRuntimeLeaseIdentity,
} from "../../pooled-runtime-drain-fence.js";
import {
  bootstrapPooledWorkspace,
  buildPooledWorkerStateObjectKey,
  createGcsPooledWorkerStateUploader,
  createPooledWorkerStateRoutes,
  createUnavailablePooledWorkerMutationAdapter,
  pooledWorkerRuntimeBindingFromEnv,
  type PooledWorkerStateRouteDependencies,
  restorePooledWorkerState,
} from "../pooled-worker-state-routes.js";

const WORKER = "worker-1";
const BUCKET = "worklin-runtime-state";
const ORGANIZATION = "org-1";
const ASSISTANT = "assistant-1";
const CHECKSUM = "a".repeat(64);
const FILE_CHECKSUM = "b".repeat(64);
const BUNDLE_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-07-20T14:00:00.000Z";
const LEASE_GENERATION = 3;
const STATE_GENERATION = 17;
const WORKSPACE_BYTE_SIZE = 12;
const WORKSPACE_QUOTA_BYTES = 1_024 * 1_024;
const ARCHIVE_OVERHEAD_BYTES = 64 * 1_024;
const roots: string[] = [];
const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: ORGANIZATION, assistantId: ASSISTANT },
  workerStackId: WORKER,
  generation: LEASE_GENERATION,
};

afterEach(() => {
  resetDb();
  _resetStreamStateForTesting();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function serviceAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway",
    assistantId: "self",
    scopeProfile: "gateway_service_v1",
    scopes: new Set<Scope>(["internal.write"]),
    policyEpoch: 1,
    serviceTenantContext: {
      version: 1,
      organizationId: ORGANIZATION,
      assistantId: ASSISTANT,
      serviceId: "gateway",
      requestId: "request-1",
    },
    pooledWorkerLease: {
      version: 1,
      organizationId: ORGANIZATION,
      userId: "user-1",
      assistantId: ASSISTANT,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      leaseExpiresAtSeconds: 4_000_000_000,
    },
    ...overrides,
  };
}

function serviceAuthFor(
  identity: PooledRuntimeLeaseIdentity,
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return serviceAuth({
    serviceTenantContext: {
      version: 1,
      organizationId: identity.tenant.orgId,
      assistantId: identity.tenant.assistantId,
      serviceId: "gateway",
      requestId: "request-2",
    },
    pooledWorkerLease: {
      version: 1,
      organizationId: identity.tenant.orgId,
      userId: "user-2",
      assistantId: identity.tenant.assistantId,
      workerStackId: identity.workerStackId,
      leaseGeneration: identity.generation,
      leaseExpiresAtSeconds: 4_000_000_000,
    },
    ...overrides,
  });
}

function signedUrl(
  organizationId = ORGANIZATION,
  assistantId = ASSISTANT,
  generation = STATE_GENERATION,
): string {
  const key = buildPooledWorkerStateObjectKey(
    organizationId,
    assistantId,
    generation,
  );
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://storage.googleapis.com/${BUCKET}/${encodedKey}?X-Goog-Signature=abc`;
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    lease_generation: LEASE_GENERATION,
    state_generation: STATE_GENERATION,
    bundle_id: BUNDLE_ID,
    created_at: CREATED_AT,
    upload_url: signedUrl(),
    workspace_quota_bytes: WORKSPACE_QUOTA_BYTES,
    archive_overhead_bytes: ARCHIVE_OVERHEAD_BYTES,
    ...overrides,
  };
}

function prepareEmptyBody(overrides: Record<string, unknown> = {}) {
  return {
    lease_generation: LEASE_GENERATION,
    workspace_quota_bytes: WORKSPACE_QUOTA_BYTES,
    archive_overhead_bytes: ARCHIVE_OVERHEAD_BYTES,
    ...overrides,
  };
}

function restoreBody(overrides: Record<string, unknown> = {}) {
  return {
    lease_generation: LEASE_GENERATION,
    state_generation: STATE_GENERATION,
    bundle_id: BUNDLE_ID,
    download_url: signedUrl(),
    checksum_sha256: CHECKSUM,
    byte_size: 4_096,
    workspace_byte_size: WORKSPACE_BYTE_SIZE,
    workspace_quota_bytes: WORKSPACE_QUOTA_BYTES,
    archive_overhead_bytes: ARCHIVE_OVERHEAD_BYTES,
    ...overrides,
  };
}

function artifact(input: PooledStateExportInput): PooledStateExportArtifact {
  return {
    tempPath: "/tmp/pooled-state-test.vbundle",
    manifest: {
      schema_version: 1,
      bundle_id: input.bundleId,
      created_at: input.createdAt.toISOString(),
      assistant: {
        id: ASSISTANT,
        name: "Worklin",
        runtime_version: "1.0.0",
      },
      origin: { mode: "managed" },
      compatibility: {
        min_runtime_version: "1.0.0",
        max_runtime_version: null,
      },
      export_options: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
      contents: [],
      secrets_redacted: true,
      checksum: FILE_CHECKSUM,
    },
    receipt: {
      tenant: {
        organizationId: ORGANIZATION,
        assistantId: ASSISTANT,
      },
      workerStackId: input.workerStackId,
      generation: input.generation,
      bundleId: input.bundleId,
      createdAt: input.createdAt.toISOString(),
      files: [
        {
          path: "workspace/config.json",
          checksumSha256: FILE_CHECKSUM,
          byteSize: 12,
        },
      ],
      checksumSha256: CHECKSUM,
      manifestChecksumSha256: FILE_CHECKSUM,
      byteSize: 4_096,
      workspaceByteSize: WORKSPACE_BYTE_SIZE,
      credentialsIncluded: 0,
      secretsRedacted: true,
    },
    cleanup: async () => {},
  };
}

async function routeHarness(options: { activate?: boolean } = {}) {
  const exportInputs: PooledStateExportInput[] = [];
  const uploads: Array<{
    uploadUrl: string;
    objectKey?: string;
    tempPath: string;
    byteSize: number;
    maxByteSize: number;
    abortSignal?: AbortSignal;
  }> = [];
  let cleanupCalls = 0;
  const restored: unknown[] = [];
  const sanitized: unknown[] = [];
  const lifecycleEvents: string[] = [];
  const bootstrapInputs: unknown[] = [];
  const drainFence = new PooledRuntimeDrainFence(() => true, {
    proveQuiescent: async () => ({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    }),
  });
  const dependencies: PooledWorkerStateRouteDependencies = {
    exportState: async (input) => {
      exportInputs.push(input);
      const value = artifact(input);
      return {
        ...value,
        cleanup: async () => {
          cleanupCalls += 1;
        },
      };
    },
    uploadState: async (input) => {
      uploads.push(input);
    },
    workspaceDir: () => "/trusted/workspace",
    assistantName: () => "Worklin",
    runtimeVersion: () => "1.0.0",
    checkpoint: async () => {},
    resetTenantProcessState: _resetStreamStateForTesting,
    drainFence,
    restoreState: async (input) => {
      lifecycleEvents.push("restored");
      restored.push(input);
      return {
        checksumSha256: CHECKSUM,
        byteSize: 4_096,
        workspaceByteSize: WORKSPACE_BYTE_SIZE,
        filesRestored: 2,
        credentialsImported: 0,
        secretsMaterialized: false,
      };
    },
    sanitizeWorkspace: async (identity, proof) => {
      lifecycleEvents.push("sanitized");
      sanitized.push({ identity, proof });
      return {
        status:
          sanitized.length === 1
            ? ("sanitized" as const)
            : ("already_sanitized" as const),
        workerStackId: identity.workerStackId,
        generation: identity.generation,
        remainingTenantPaths: 0,
        credentialsTouched: false,
      };
    },
    bootstrapWorkspace: async (_identity, input) => {
      lifecycleEvents.push("initialized");
      bootstrapInputs.push(input);
    },
    installWorkspaceQuota: () => WORKSPACE_BYTE_SIZE,
    assertWorkspaceQuota: () => {},
  };
  const routes = createPooledWorkerStateRoutes(
    { workerStackId: WORKER, stateBucket: BUCKET },
    dependencies,
  );
  const route = routes.find(
    ({ operationId }) => operationId === "internal_pooled_worker_state_export",
  );
  if (!route) throw new Error("Missing pooled worker export route.");
  if (options.activate !== false) {
    drainFence.beginAssignmentMutation(IDENTITY);
    await drainFence.proveAssignmentMutationQuiescent(IDENTITY);
    drainFence.activateAssignment(IDENTITY);
  }
  return {
    routes,
    route,
    exportInputs,
    uploads,
    dependencies,
    cleanupCalls: () => cleanupCalls,
    restored,
    sanitized,
    lifecycleEvents,
    bootstrapInputs,
    drainFence,
  };
}

describe("pooled worker route binding", () => {
  test("is disabled by default and requires a complete immutable binding", () => {
    expect(pooledWorkerRuntimeBindingFromEnv({})).toBeNull();
    expect(
      pooledWorkerRuntimeBindingFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED: "false",
        WORKLIN_RUNTIME_WORKER_STACK_ID: "untrusted-unused",
      }),
    ).toBeNull();
    expect(() =>
      pooledWorkerRuntimeBindingFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_STACK_ID: WORKER,
      }),
    ).toThrow("bucket is invalid");
    expect(
      pooledWorkerRuntimeBindingFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_STACK_ID: WORKER,
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
      }),
    ).toEqual({
      workerStackId: WORKER,
      stateProvider: "gcs",
      stateBucket: BUCKET,
    });
    expect(
      pooledWorkerRuntimeBindingFromEnv({
        WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_STACK_ID: WORKER,
        WORKLIN_RUNTIME_WORKER_STATE_PROVIDER: "s3",
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: BUCKET,
        WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT: "https://storage.railway.app",
        WORKLIN_RUNTIME_WORKER_STATE_S3_REGION: "auto",
        WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE: "virtual",
      }),
    ).toEqual({
      workerStackId: WORKER,
      stateProvider: "s3",
      stateBucket: BUCKET,
      stateEndpoint: "https://storage.railway.app/",
      stateRegion: "auto",
      stateUrlStyle: "virtual",
    });
  });

  test("registers only gateway-service state lifecycle routes", async () => {
    const harness = await routeHarness();
    const routes = createPooledWorkerStateRoutes(
      { workerStackId: WORKER, stateBucket: BUCKET },
      harness.dependencies,
    );
    expect(routes.map(({ operationId }) => operationId)).toEqual([
      "internal_pooled_worker_state_export",
      "internal_pooled_worker_state_restore",
      "internal_pooled_worker_prepare_empty",
      "internal_pooled_worker_state_sanitize",
    ]);
    expect(routes[0]?.endpoint).toBe("internal/pooled-worker/state/export");
    expect(routes[0]?.isPublic).not.toBe(true);
    expect(routes[0]?.policy).toEqual({
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: ["svc_gateway"],
    });
    expect(
      routes.every(
        (route) =>
          route.isPublic !== true &&
          route.policy?.allowedPrincipalTypes[0] === "svc_gateway",
      ),
    ).toBe(true);
  });
});

describe("pooled worker export route", () => {
  test("derives tenant and worker identity from trusted context and config", async () => {
    const harness = await routeHarness();
    const result = await harness.route.handler({
      authContext: serviceAuth(),
      body: requestBody(),
    });

    expect(harness.exportInputs).toHaveLength(1);
    expect(harness.exportInputs[0]).toMatchObject({
      authContext: serviceAuth(),
      workspaceDir: "/trusted/workspace",
      workerStackId: WORKER,
      generation: STATE_GENERATION,
      bundleId: BUNDLE_ID,
      createdAt: new Date(CREATED_AT),
      assistantName: "Worklin",
      runtimeVersion: "1.0.0",
      workspaceQuotaBytes: WORKSPACE_QUOTA_BYTES,
      archiveOverheadBytes: ARCHIVE_OVERHEAD_BYTES,
    });
    expect(harness.uploads).toEqual([
      {
        uploadUrl: signedUrl(),
        objectKey: buildPooledWorkerStateObjectKey(
          ORGANIZATION,
          ASSISTANT,
          STATE_GENERATION,
        ),
        tempPath: "/tmp/pooled-state-test.vbundle",
        byteSize: 4_096,
        maxByteSize: WORKSPACE_QUOTA_BYTES + ARCHIVE_OVERHEAD_BYTES,
        abortSignal: undefined,
      },
    ]);
    expect(result).toEqual({
      tenant: { orgId: ORGANIZATION, assistantId: ASSISTANT },
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      stateGeneration: STATE_GENERATION,
      object: {
        provider: "gcs",
        bucket: BUCKET,
        objectKey: buildPooledWorkerStateObjectKey(
          ORGANIZATION,
          ASSISTANT,
          STATE_GENERATION,
        ),
        checksumSha256: CHECKSUM,
        byteSize: 4_096,
        format: "vbundle-v1",
      },
      workspaceByteSize: WORKSPACE_BYTE_SIZE,
      entries: [
        {
          path: "workspace/config.json",
          kind: "file",
          checksumSha256: FILE_CHECKSUM,
          byteSize: 12,
        },
      ],
      credentialsIncluded: 0,
      secretsRedacted: true,
    });
    expect(harness.cleanupCalls()).toBe(1);
  });

  test("rejects body identity overrides and cross-tenant object URLs before export", async () => {
    for (const body of [
      requestBody({ generation: LEASE_GENERATION }),
      requestBody({ workerStackId: "worker-attacker" }),
      requestBody({ organizationId: "org-attacker" }),
      requestBody({ assistantId: "assistant-attacker" }),
      requestBody({ upload_url: signedUrl("org-attacker") }),
    ]) {
      const harness = await routeHarness();
      await expect(
        harness.route.handler({ authContext: serviceAuth(), body }),
      ).rejects.toThrow();
      expect(harness.exportInputs).toHaveLength(0);
      expect(harness.uploads).toHaveLength(0);
    }
  });

  test("rejects actor and unbound service contexts before reading the workspace", async () => {
    const denied = [
      serviceAuth({ principalType: "actor" }),
      serviceAuth({ serviceTenantContext: undefined }),
      serviceAuth({ scopes: new Set<Scope>() }),
    ];
    for (const authContext of denied) {
      const harness = await routeHarness();
      await expect(
        harness.route.handler({ authContext, body: requestBody() }),
      ).rejects.toThrow("Verified gateway tenant context is required");
      expect(harness.exportInputs).toHaveLength(0);
    }
  });

  test("cleans the artifact and withholds a receipt when upload fails", async () => {
    const harness = await routeHarness();
    harness.dependencies.uploadState = async () => {
      throw new Error("upload unavailable");
    };

    await expect(
      harness.route.handler({
        authContext: serviceAuth(),
        body: requestBody(),
      }),
    ).rejects.toThrow("upload unavailable");
    expect(harness.cleanupCalls()).toBe(1);
  });

  test("rejects a cross-tenant export receipt", async () => {
    const harness = await routeHarness();
    harness.dependencies.exportState = async (input) => {
      const value = artifact(input);
      return {
        ...value,
        receipt: {
          ...value.receipt,
          tenant: {
            organizationId: "org-attacker",
            assistantId: ASSISTANT,
          },
        },
      };
    };

    await expect(
      harness.route.handler({
        authContext: serviceAuth(),
        body: requestBody(),
      }),
    ).rejects.toThrow("did not match the trusted tenant binding");
    expect(harness.uploads).toHaveLength(0);
  });

  test("quarantines an over-quota final manifest before upload", async () => {
    const harness = await routeHarness();
    harness.dependencies.exportState = async (input) => {
      const value = artifact(input);
      return {
        ...value,
        receipt: {
          ...value.receipt,
          files: [
            {
              path: "workspace/oversized.bin",
              checksumSha256: FILE_CHECKSUM,
              byteSize: WORKSPACE_QUOTA_BYTES + 1,
            },
          ],
          workspaceByteSize: WORKSPACE_QUOTA_BYTES + 1,
        },
      };
    };

    await expect(
      harness.route.handler({
        authContext: serviceAuth(),
        body: requestBody(),
      }),
    ).rejects.toThrow("did not match the trusted tenant binding");
    expect(harness.uploads).toHaveLength(0);
    expect(harness.cleanupCalls()).toBe(0);
    expect(harness.drainFence.snapshotForTesting()).toMatchObject({
      phase: "quarantined",
      identity: IDENTITY,
    });
  });
});

describe("pooled worker destructive state lifecycle", () => {
  test("clears process-local stream payloads before preparing a tenant assignment", async () => {
    _resetStreamStateForTesting();
    stampAndBuffer({
      id: "old-tenant-event",
      conversationId: "old-tenant-conversation",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "old-tenant-conversation",
        text: "private old tenant payload",
      },
    });
    recordPersistedSeq("old-tenant-conversation", 1);

    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_prepare_empty",
    )!;
    await route.handler({
      authContext: serviceAuth(),
      body: prepareEmptyBody(),
    });

    expect(getReplayWindow(0)).toEqual([]);
    expect(getPersistedSeq("old-tenant-conversation")).toBeNull();
  });

  test("prepares an empty quarantined assignment and activates ordinary work", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_prepare_empty",
    )!;

    await expect(
      route.handler({
        authContext: serviceAuth(),
        body: prepareEmptyBody(),
      }),
    ).resolves.toEqual({
      status: "prepared_empty",
      tenant: IDENTITY.tenant,
      workerStackId: WORKER,
      leaseGeneration: LEASE_GENERATION,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    });
    expect(harness.sanitized).toHaveLength(1);
    expect(harness.lifecycleEvents).toEqual(["sanitized", "initialized"]);
    expect(harness.bootstrapInputs).toEqual([{ mode: "empty" }]);
    const release = harness.drainFence.acquireOrdinaryRequest(serviceAuth());
    release();
  });

  test("rebuilds a tenant-neutral workspace and usable DB only after prior tenant state is gone", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "pooled-empty-bootstrap-")),
    );
    roots.push(root);
    const workspace = join(root, "tenant-workspace");
    const cesSecurity = join(root, "ces-security");
    const gatewaySecurity = join(root, "gateway-security");
    mkdirSync(workspace);
    mkdirSync(cesSecurity);
    mkdirSync(gatewaySecurity);
    writeFileSync(
      join(workspace, "prior-tenant-secret.txt"),
      "tenant-a-private-value",
    );
    writeFileSync(join(workspace, "IDENTITY.md"), "tenant-a-private-identity");

    const priorWorkspace = process.env.VELLUM_WORKSPACE_DIR;
    const priorIsPlatform = process.env.IS_PLATFORM;
    process.env.VELLUM_WORKSPACE_DIR = workspace;
    resetDb();
    try {
      const tenantA: PooledRuntimeLeaseIdentity = {
        tenant: { orgId: "org-a", assistantId: "assistant-a" },
        workerStackId: WORKER,
        generation: 1,
      };
      const sanitizer = createPooledWorkspaceSanitizer({
        proofGuard: {
          resolveCurrentTenantWorkspace: async () => ({
            tenant: tenantA.tenant,
            workerStackId: tenantA.workerStackId,
            workspaceRoot: root,
            tenantWorkspacePath: workspace,
          }),
          withExclusiveSanitizationProofs: async (requested, operation) =>
            operation({
              tenant: requested.tenant,
              workerStackId: requested.workerStackId,
              generation: requested.generation,
              leaseDraining: true,
              activeTenantRequestCount: 0,
              activeTenantProcessCount: 0,
              activeTenantSessionCount: 0,
            }),
        },
        fileSystem: createNodePooledWorkspaceFileSystem(),
        cesSecurityPaths: [cesSecurity],
        gatewaySecurityPaths: [gatewaySecurity],
      });

      const receipt = await sanitizer.sanitize(tenantA);
      expect(receipt.remainingTenantPaths).toBe(0);
      expect(existsSync(join(workspace, "prior-tenant-secret.txt"))).toBe(
        false,
      );

      process.env.IS_PLATFORM = "true";
      await bootstrapPooledWorkspace(tenantA, {
        mode: "empty",
        inferenceProvider: "kimi",
      });

      expect(
        readFileSync(join(workspace, "IDENTITY.md"), "utf8"),
      ).not.toContain("tenant-a-private");
      expect(
        readFileSync(join(workspace, "SOUL.md"), "utf8").length,
      ).toBeGreaterThan(0);
      expect(existsSync(join(workspace, "users", "default.md"))).toBe(true);

      const config = loadConfig();
      expect(config.llm.activeProfile).toBe("custom-balanced");
      const mainAgent = resolveCallSiteConfig("mainAgent", config.llm);
      const background = resolveCallSiteConfig("heartbeatAgent", config.llm);
      expect(mainAgent).toMatchObject({
        provider: "kimi",
        model: resolveModelIntent("kimi", "balanced"),
        provider_connection: "kimi-personal",
      });
      expect(background).toMatchObject({
        provider: "kimi",
        provider_connection: "kimi-personal",
      });
      const connection = getConnection(getDb(), "kimi-personal");
      expect(connection).toMatchObject({
        provider: "kimi",
        auth: {
          type: "api_key",
          credential: "credential/kimi/api_key",
        },
      });
      expect(
        Object.values(config.llm.profiles)
          .filter((profile) => profile.status !== "disabled")
          .some((profile) => profile.provider_connection?.endsWith("-managed")),
      ).toBe(false);

      const tenantBConversation = createConversation("Tenant B first task");
      expect(getConversation(tenantBConversation.id)?.title).toBe(
        "Tenant B first task",
      );
    } finally {
      resetDb();
      if (priorIsPlatform === undefined) {
        delete process.env.IS_PLATFORM;
      } else {
        process.env.IS_PLATFORM = priorIsPlatform;
      }
      if (priorWorkspace === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = priorWorkspace;
      }
    }
  });

  test("migrates restored state before applying the request-bound BYOK provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "pooled-restored-bootstrap-"));
    roots.push(root);
    const workspace = join(root, "tenant-workspace");
    mkdirSync(workspace);

    const priorWorkspace = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspace;
    resetDb();
    try {
      initializeDb({ useTestTemplate: false });
      expect(rollbackMemoryMigration(getDb(), 51)).toContain(
        "migration_conversation_cleaned_at_v1",
      );
      const oldColumns = getSqlite()
        .query("PRAGMA table_info(conversations)")
        .all() as Array<{ name: string }>;
      expect(oldColumns.map(({ name }) => name)).not.toContain(
        "history_stripped_at",
      );
      expect(
        getSqlite()
          .query(
            "SELECT value FROM memory_checkpoints WHERE key = 'migration_conversation_cleaned_at_v1'",
          )
          .get(),
      ).toBeNull();
      saveRawConfig({
        services: { inference: { mode: "your-own" } },
        llm: {
          default: {
            provider: "kimi",
            model: resolveModelIntent("kimi", "balanced"),
          },
          profiles: {
            "custom-balanced": {
              source: "user",
              provider: "kimi",
              model: resolveModelIntent("kimi", "balanced"),
            },
          },
          activeProfile: "custom-balanced",
        },
      });
      resetDb();

      await bootstrapPooledWorkspace(IDENTITY, {
        mode: "restored",
        inferenceProvider: "openai",
      });

      const columns = getSqlite()
        .query("PRAGMA table_info(conversations)")
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toContain("history_stripped_at");
      expect(
        getSqlite()
          .query(
            "SELECT value FROM memory_checkpoints WHERE key = 'migration_conversation_cleaned_at_v1'",
          )
          .get(),
      ).toEqual({ value: "1" });
      const config = loadConfig();
      expect(config.services.inference).not.toHaveProperty("mode");
      expect(resolveCallSiteConfig("mainAgent", config.llm)).toMatchObject({
        provider: "openai",
        provider_connection: "openai-personal",
      });
      expect(getConnection(getDb(), "openai-personal")?.auth).toEqual({
        type: "api_key",
        credential: "credential/openai/api_key",
      });
      expect(
        readFileSync(join(workspace, "IDENTITY.md"), "utf8").trim(),
      ).not.toBe("");
      expect(readFileSync(join(workspace, "SOUL.md"), "utf8").trim()).not.toBe(
        "",
      );
      expect(existsSync(join(workspace, "users", "default.md"))).toBe(true);
    } finally {
      resetDb();
      if (priorWorkspace === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = priorWorkspace;
      }
    }
  }, 30_000);

  test("prepare-empty accepts only lease generation and a validated BYOK provider hint", async () => {
    const accepted = await routeHarness({ activate: false });
    const acceptedRoute = accepted.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_prepare_empty",
    )!;
    await acceptedRoute.handler({
      authContext: serviceAuth(),
      body: prepareEmptyBody({ inference_provider: "kimi" }),
    });
    expect(accepted.bootstrapInputs).toEqual([
      { mode: "empty", inferenceProvider: "kimi" },
    ]);

    for (const body of [
      prepareEmptyBody({ state_generation: STATE_GENERATION }),
      prepareEmptyBody({ generation: LEASE_GENERATION }),
      prepareEmptyBody({ inference_provider: "attacker-provider" }),
    ]) {
      const harness = await routeHarness({ activate: false });
      const route = harness.routes.find(
        ({ operationId }) =>
          operationId === "internal_pooled_worker_prepare_empty",
      )!;
      await expect(
        route.handler({ authContext: serviceAuth(), body }),
      ).rejects.toThrow();
      expect(harness.sanitized).toHaveLength(0);
    }
  });

  test("restores state before applying a validated BYOK provider hint", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;

    await expect(
      route.handler({
        authContext: serviceAuth(),
        body: restoreBody({ inference_provider: "openrouter" }),
      }),
    ).resolves.toMatchObject({
      status: "restored",
      credentialsImported: 0,
      secretsMaterialized: false,
    });
    expect(harness.restored).toHaveLength(1);
    expect(harness.bootstrapInputs).toEqual([
      { mode: "restored", inferenceProvider: "openrouter" },
    ]);
    expect(harness.lifecycleEvents).toEqual(["restored", "initialized"]);
  });

  test("drains, sanitizes, then restores a later tenant generation without accepting stale work", async () => {
    const harness = await routeHarness();
    const exportRoute = harness.route;
    const sanitizeRoute = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_sanitize",
    )!;
    const restoreRoute = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;

    await exportRoute.handler({
      authContext: serviceAuth(),
      body: requestBody(),
    });
    await expect(
      sanitizeRoute.handler({
        authContext: serviceAuth(),
        body: { lease_generation: LEASE_GENERATION },
      }),
    ).resolves.toMatchObject({
      status: "sanitized",
      leaseGeneration: LEASE_GENERATION,
      remainingTenantPaths: 0,
    });
    await expect(
      sanitizeRoute.handler({
        authContext: serviceAuth(),
        body: { lease_generation: LEASE_GENERATION },
      }),
    ).resolves.toMatchObject({
      status: "already_sanitized",
      leaseGeneration: LEASE_GENERATION,
      remainingTenantPaths: 0,
    });
    expect(harness.drainFence.snapshotForTesting()).toMatchObject({
      phase: "sanitized",
      identity: IDENTITY,
    });

    const next: PooledRuntimeLeaseIdentity = {
      tenant: { orgId: "org-2", assistantId: "assistant-2" },
      workerStackId: WORKER,
      generation: 4,
    };
    const nextStateGeneration = STATE_GENERATION + 1;
    await expect(
      restoreRoute.handler({
        authContext: serviceAuthFor(next),
        body: restoreBody({
          lease_generation: next.generation,
          state_generation: nextStateGeneration,
          download_url: signedUrl(
            next.tenant.orgId,
            next.tenant.assistantId,
            nextStateGeneration,
          ),
        }),
      }),
    ).resolves.toMatchObject({
      status: "restored",
      tenant: next.tenant,
      workerStackId: WORKER,
      leaseGeneration: next.generation,
      stateGeneration: nextStateGeneration,
      credentialsImported: 0,
      secretsMaterialized: false,
    });

    expect(() =>
      harness.drainFence.acquireOrdinaryRequest(serviceAuth()),
    ).toThrow("does not match the active assignment");
    const release = harness.drainFence.acquireOrdinaryRequest(
      serviceAuthFor(next),
    );
    release();
  });

  test("rejects stale generations and identity fields before restore I/O", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;

    for (const body of [
      restoreBody({ lease_generation: 2 }),
      restoreBody({ organizationId: ORGANIZATION }),
      restoreBody({ generation: LEASE_GENERATION }),
      restoreBody({ inference_provider: "attacker-provider" }),
    ]) {
      await expect(
        route.handler({ authContext: serviceAuth(), body }),
      ).rejects.toThrow();
    }
    expect(harness.restored).toHaveLength(0);
  });

  test("rejects an over-quota restore receipt before download or activation", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;

    await expect(
      route.handler({
        authContext: serviceAuth(),
        body: restoreBody({
          workspace_quota_bytes: WORKSPACE_BYTE_SIZE - 1,
        }),
      }),
    ).rejects.toThrow("exceeds the authoritative workspace limits");
    expect(harness.restored).toHaveLength(0);
    expect(harness.drainFence.snapshotForTesting().phase).toBe("unbound");
  });

  test("keeps a failed restore quarantined and allows an exact retry", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;
    const body = restoreBody();
    let attempts = 0;
    harness.dependencies.restoreState = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("restore failed");
      return {
        checksumSha256: CHECKSUM,
        byteSize: 4_096,
        workspaceByteSize: WORKSPACE_BYTE_SIZE,
        filesRestored: 1,
        credentialsImported: 0,
        secretsMaterialized: false,
      };
    };

    await expect(
      route.handler({ authContext: serviceAuth(), body }),
    ).rejects.toThrow("restore failed");
    expect(() =>
      harness.drainFence.acquireOrdinaryRequest(serviceAuth()),
    ).toThrow("quarantined");
    await expect(
      route.handler({ authContext: serviceAuth(), body }),
    ).resolves.toMatchObject({ status: "restored" });
  });

  test("quarantines successful restore when request-bound bootstrap fails", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_state_restore",
    )!;
    let bootstrapInput: unknown = null;
    harness.dependencies.bootstrapWorkspace = async (_identity, input) => {
      bootstrapInput = input;
      throw new Error("bootstrap failed");
    };

    await expect(
      route.handler({
        authContext: serviceAuth(),
        body: restoreBody({ inference_provider: "openai" }),
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(bootstrapInput).toEqual({
      mode: "restored",
      inferenceProvider: "openai",
    });
    expect(harness.drainFence.snapshotForTesting()).toMatchObject({
      phase: "quarantined",
      identity: IDENTITY,
    });
    expect(() =>
      harness.drainFence.acquireOrdinaryRequest(serviceAuth()),
    ).toThrow("quarantined");
  });

  test("quarantines a sanitized generation-zero assignment when bootstrap fails", async () => {
    const harness = await routeHarness({ activate: false });
    const route = harness.routes.find(
      ({ operationId }) =>
        operationId === "internal_pooled_worker_prepare_empty",
    )!;
    harness.dependencies.bootstrapWorkspace = async () => {
      throw new Error("bootstrap failed");
    };

    await expect(
      route.handler({
        authContext: serviceAuth(),
        body: prepareEmptyBody({ inference_provider: "openai" }),
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(harness.drainFence.snapshotForTesting()).toMatchObject({
      phase: "quarantined",
      identity: IDENTITY,
    });
    expect(() =>
      harness.drainFence.acquireOrdinaryRequest(serviceAuth()),
    ).toThrow("quarantined");
  });
});

describe("pooled worker upload and destructive boundaries", () => {
  test("uploads with bounded no-redirect PUT semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pooled-route-upload-"));
    roots.push(root);
    const file = join(root, "state.vbundle");
    writeFileSync(file, "state");
    let observed:
      | { url: string | URL | Request; init: RequestInit | undefined }
      | undefined;
    const uploader = createGcsPooledWorkerStateUploader(
      (async (url, init) => {
        observed = { url, init };
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      1_000,
    );

    await uploader({
      uploadUrl: signedUrl(),
      tempPath: file,
      byteSize: 5,
      maxByteSize: 5,
    });

    expect(String(observed?.url)).toBe(signedUrl());
    expect(observed?.init).toMatchObject({
      method: "PUT",
      redirect: "error",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": "5",
      },
    });
    expect(observed?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("uploader rejects non-GCS destinations before opening the artifact", async () => {
    let fetchCalls = 0;
    const uploader = createGcsPooledWorkerStateUploader(
      (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      1_000,
    );

    await expect(
      uploader({
        uploadUrl: "https://example.com/state?X-Goog-Signature=abc",
        tempPath: "/path/does/not/exist",
        byteSize: 5,
        maxByteSize: 5,
      }),
    ).rejects.toThrow("upload URL is invalid");
    expect(fetchCalls).toBe(0);
  });

  test("restorer rejects non-GCS destinations and oversized receipts before fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const base = {
      expectedChecksumSha256: CHECKSUM,
      expectedByteSize: 4_096,
      expectedWorkspaceByteSize: WORKSPACE_BYTE_SIZE,
      workspaceQuotaBytes: WORKSPACE_QUOTA_BYTES,
      archiveOverheadBytes: ARCHIVE_OVERHEAD_BYTES,
      expectedBundleId: BUNDLE_ID,
      stateGeneration: STATE_GENERATION,
      identity: IDENTITY,
    };

    await expect(
      restorePooledWorkerState(
        {
          ...base,
          downloadUrl: "https://example.com/state?X-Goog-Signature=abc",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("download URL is invalid");
    await expect(
      restorePooledWorkerState(
        {
          ...base,
          downloadUrl: signedUrl(),
          expectedByteSize: 17 * 1_024 * 1_024 * 1_024,
        },
        fetchImpl,
      ),
    ).rejects.toThrow("object receipt is invalid");
    expect(fetchCalls).toBe(0);
  });

  test("keeps restore and sanitization unregistered and fails closed", async () => {
    const adapter = createUnavailablePooledWorkerMutationAdapter();
    expect(adapter.registeredRoutes).toEqual([]);
    await expect(
      adapter.restore({
        authContext: serviceAuth(),
        leaseGeneration: LEASE_GENERATION,
      }),
    ).rejects.toThrow("exclusive worker lease and process/session fence");
    await expect(
      adapter.sanitize({ authContext: serviceAuth() }),
    ).rejects.toThrow("exclusive worker lease and process/session fence");
  });
});
