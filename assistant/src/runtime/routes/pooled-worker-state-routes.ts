import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";

import { z } from "zod";

import {
  installPooledRuntimeNeutralConfig,
  invalidateConfigCache,
  releasePooledRuntimeNeutralConfigForAssignment,
} from "../../config/loader.js";
import {
  bootstrapPooledByokInference,
  POOLED_BYOK_INFERENCE_PROVIDERS,
  type PooledByokInferenceProvider,
} from "../../config/pooled-byok-bootstrap.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import { runAsyncSqlite } from "../../memory/db-async-query.js";
import { getDb, getSqlite, resetDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { ensurePromptFiles } from "../../prompts/system-prompt.js";
import {
  createNodePooledWorkspaceFileSystem,
  createPooledWorkspaceSanitizer,
  type PooledWorkspaceSanitizeReceipt,
} from "../../services/pooled-workspace-sanitizer.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir, getWorkspaceHooksDir } from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import { WORKSPACE_MIGRATIONS } from "../../workspace/migrations/registry.js";
import {
  loadCheckpoints,
  runWorkspaceMigrations,
} from "../../workspace/migrations/runner.js";
import type { WorkspaceMigration } from "../../workspace/migrations/types.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import type { AuthContext } from "../auth/types.js";
import { validateGcsSignedUrl } from "../migrations/gcs-signed-url.js";
import {
  exportPooledWorkerState,
  type PooledStateExportArtifact,
  type PooledStateExportInput,
} from "../migrations/pooled-state-export.js";
import {
  assertPooledStateSignedObjectUrl,
  normalizePooledStateStorageBinding,
  type PooledStateProvider,
  type PooledStateS3UrlStyle,
  type PooledStateStorageBinding,
  type PooledStateStorageBindingInput,
} from "../migrations/pooled-state-signed-url.js";
import { DefaultPathResolver } from "../migrations/vbundle-import-analyzer.js";
import { streamCommitImport } from "../migrations/vbundle-streaming-importer.js";
import {
  getProductionPooledRuntimeDrainFence,
  type PooledRuntimeDrainController,
  type PooledRuntimeDrainProof,
  type PooledRuntimeLeaseIdentity,
  pooledRuntimeLeaseIdentityFromAuth,
} from "../pooled-runtime-drain-fence.js";
import { resetPooledRuntimeTenantProcessState } from "../pooled-runtime-tenant-state.js";
import {
  assertPooledWorkspaceQuotaAssignment,
  installPooledWorkspaceQuotaForAssignment,
} from "../pooled-workspace-quota.js";
import {
  BadGatewayError,
  BadRequestError,
  ForbiddenError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("pooled-worker-state-routes");
const STATE_FORMAT = "vbundle-v1" as const;
const CONTENT_TYPE = "application/octet-stream";
const DEFAULT_UPLOAD_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_STATE_BUNDLE_BYTES = 16 * 1_024 * 1_024 * 1_024;
const REVIEWED_POOLED_WORKSPACE_MIGRATION_TAIL =
  "103-upgrade-quality-profile-to-opus-4-8";
const POOLED_UNSAFE_WORKSPACE_MIGRATIONS = new Set([
  "003-seed-device-id",
  "006-services-config",
  "011-backfill-installation-id",
  "014-migrate-to-workspace-volume",
  "016-extract-feature-flags-to-protected",
  "018-rekey-compound-credential-keys",
  "021-move-signals-to-workspace",
  "022-move-hooks-to-workspace",
  "023-move-config-files-to-workspace",
  "024-move-runtime-files-to-workspace",
  "059-move-pid-to-workspace",
  "061-move-backup-key-to-workspace",
  "080-restrict-vercel-api-token-metadata",
  "081-backfill-bash-allowed-tools-for-injection-credentials",
]);

type EnvLike = Record<string, string | undefined>;

const exportBodySchema = z
  .object({
    lease_generation: z.number().int().positive(),
    state_generation: z.number().int().positive(),
    bundle_id: z.uuid(),
    created_at: z.iso.datetime({ offset: true }),
    upload_url: z.url(),
    workspace_quota_bytes: z.number().int().nonnegative(),
    archive_overhead_bytes: z.number().int().positive(),
  })
  .strict();

const leaseGenerationBodySchema = z
  .object({
    lease_generation: z.number().int().positive(),
  })
  .strict();

const prepareEmptyBodySchema = z
  .object({
    lease_generation: z.number().int().positive(),
    workspace_quota_bytes: z.number().int().nonnegative(),
    archive_overhead_bytes: z.number().int().positive(),
    inference_provider: z.enum(POOLED_BYOK_INFERENCE_PROVIDERS).optional(),
  })
  .strict();

const restoreBodySchema = z
  .object({
    lease_generation: z.number().int().positive(),
    state_generation: z.number().int().positive(),
    bundle_id: z.uuid(),
    download_url: z.url(),
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byte_size: z.number().int().positive().max(MAX_STATE_BUNDLE_BYTES),
    workspace_byte_size: z.number().int().nonnegative().nullable(),
    workspace_quota_bytes: z.number().int().nonnegative(),
    archive_overhead_bytes: z.number().int().positive(),
    inference_provider: z.enum(POOLED_BYOK_INFERENCE_PROVIDERS).optional(),
  })
  .strict();

export interface PooledWorkerRuntimeBinding extends PooledStateStorageBindingInput {
  workerStackId: string;
}

type TrustedPooledWorkerRuntimeBinding = PooledStateStorageBinding & {
  workerStackId: string;
};

export interface PooledWorkerStateUploaderInput {
  uploadUrl: string;
  objectKey?: string;
  tempPath: string;
  byteSize: number;
  maxByteSize: number;
  abortSignal?: AbortSignal;
}

export type PooledWorkerStateUploader = (
  input: PooledWorkerStateUploaderInput,
) => Promise<void>;

export interface PooledWorkerStateRestoreInput {
  downloadUrl: string;
  expectedChecksumSha256: string;
  expectedByteSize: number;
  expectedWorkspaceByteSize: number | null;
  workspaceQuotaBytes: number;
  archiveOverheadBytes: number;
  expectedBundleId: string;
  stateGeneration: number;
  identity: PooledRuntimeLeaseIdentity;
  storageBinding?: PooledStateStorageBinding;
  abortSignal?: AbortSignal;
}

export interface PooledWorkerStateRestoreReceipt {
  checksumSha256: string;
  byteSize: number;
  workspaceByteSize: number;
  filesRestored: number;
  credentialsImported: 0;
  secretsMaterialized: false;
}

export interface PooledWorkerStateRouteDependencies {
  exportState: (
    input: PooledStateExportInput,
  ) => Promise<PooledStateExportArtifact>;
  uploadState: PooledWorkerStateUploader;
  workspaceDir: () => string;
  assistantName: () => string;
  runtimeVersion: () => string;
  checkpoint: () => Promise<void>;
  resetTenantProcessState: () => void;
  drainFence: PooledRuntimeDrainController;
  restoreState: (
    input: PooledWorkerStateRestoreInput,
  ) => Promise<PooledWorkerStateRestoreReceipt>;
  sanitizeWorkspace: (
    identity: PooledRuntimeLeaseIdentity,
    proof: PooledRuntimeDrainProof,
  ) => Promise<PooledWorkspaceSanitizeReceipt>;
  bootstrapWorkspace: (
    identity: PooledRuntimeLeaseIdentity,
    input: PooledWorkspaceBootstrapInput,
  ) => Promise<void>;
  installWorkspaceQuota: (
    identity: PooledRuntimeLeaseIdentity,
    workspaceDir: string,
    quotaBytes: number,
  ) => number;
  assertWorkspaceQuota: (
    identity: PooledRuntimeLeaseIdentity,
    workspaceDir: string,
    quotaBytes: number,
  ) => void;
}

export type PooledWorkspaceBootstrapInput =
  | {
      mode: "restored";
      inferenceProvider?: PooledByokInferenceProvider;
    }
  | {
      mode: "empty";
      inferenceProvider?: PooledByokInferenceProvider;
    };

export interface PooledWorkerStateObjectReceipt {
  tenant: {
    orgId: string;
    assistantId: string;
  };
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
  object: {
    provider: PooledStateProvider;
    bucket: string;
    objectKey: string;
    checksumSha256: string;
    byteSize: number;
    format: typeof STATE_FORMAT;
  };
  workspaceByteSize: number;
  entries: ReadonlyArray<{
    path: string;
    kind: "file";
    checksumSha256: string;
    byteSize: number;
  }>;
  credentialsIncluded: 0;
  secretsRedacted: true;
}

export interface PooledWorkerDestructiveMutationAdapter {
  readonly registeredRoutes: readonly RouteDefinition[];
  restore(input: {
    authContext?: AuthContext;
    leaseGeneration: number;
  }): Promise<never>;
  sanitize(input: { authContext?: AuthContext }): Promise<never>;
}

export function pooledWorkerRuntimeBindingFromEnv(
  rawEnv: EnvLike,
): PooledWorkerRuntimeBinding | null {
  if (
    rawEnv.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED?.trim().toLowerCase() !==
    "true"
  ) {
    return null;
  }

  const workerStackId = rawEnv.WORKLIN_RUNTIME_WORKER_STACK_ID?.trim() ?? "";
  const stateBucket = rawEnv.WORKLIN_RUNTIME_WORKER_STATE_BUCKET?.trim() ?? "";
  assertOpaqueId(workerStackId, "worker stack");
  const stateProvider =
    rawEnv.WORKLIN_RUNTIME_WORKER_STATE_PROVIDER?.trim().toLowerCase() ?? "gcs";
  if (stateProvider !== "gcs" && stateProvider !== "s3") {
    throw new Error("Pooled worker state provider is invalid.");
  }
  const storage = normalizePooledStateStorageBinding({
    stateProvider,
    stateBucket,
    ...(stateProvider === "s3"
      ? {
          stateEndpoint:
            rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT?.trim(),
          stateRegion: rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_REGION?.trim(),
          stateUrlStyle:
            rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE?.trim() as
              | PooledStateS3UrlStyle
              | undefined,
        }
      : {}),
  });
  return Object.freeze({ workerStackId, ...storage });
}

export function buildPooledWorkerStateObjectKey(
  organizationId: string,
  assistantId: string,
  generation: number,
): string {
  assertOpaqueId(organizationId, "organization");
  assertOpaqueId(assistantId, "assistant");
  if (
    organizationId === "." ||
    organizationId === ".." ||
    assistantId === "." ||
    assistantId === ".."
  ) {
    throw new Error("Pooled state tenant id cannot be a path segment.");
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Pooled state generation is invalid.");
  }
  return [
    "tenant-state",
    encodeURIComponent(organizationId),
    encodeURIComponent(assistantId),
    `generation-${generation}.vbundle`,
  ].join("/");
}

export function createPooledWorkerStateRoutes(
  binding: PooledWorkerRuntimeBinding,
  dependencies?: PooledWorkerStateRouteDependencies,
): RouteDefinition[] {
  const trustedBinding: TrustedPooledWorkerRuntimeBinding = Object.freeze({
    workerStackId: assertOpaqueId(binding.workerStackId, "worker stack"),
    ...normalizePooledStateStorageBinding(binding),
  });
  const routeDependencies =
    dependencies ?? productionDependencies(trustedBinding);

  const exportRoute: RouteDefinition = {
    operationId: "internal_pooled_worker_state_export",
    endpoint: "internal/pooled-worker/state/export",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Export pooled worker state",
    description:
      "Drains tenant work and uploads a credential-free workspace snapshot to its signed state-object URL.",
    tags: ["internal"],
    requestBody: exportBodySchema,
    responseBody: pooledStateReceiptSchema,
    handler: (args) =>
      handlePooledWorkerStateExport(args, trustedBinding, routeDependencies),
  };

  return [
    exportRoute,
    {
      operationId: "internal_pooled_worker_state_restore",
      endpoint: "internal/pooled-worker/state/restore",
      method: "POST",
      policy: {
        requiredScopes: ["internal.write"],
        allowedPrincipalTypes: GATEWAY_PRINCIPALS,
      },
      summary: "Restore pooled worker state",
      description:
        "Restores one credential-free tenant generation from its exact signed state-object URL.",
      tags: ["internal"],
      requestBody: restoreBodySchema,
      responseBody: pooledRestoreReceiptSchema,
      handler: (args) =>
        handlePooledWorkerStateRestore(args, trustedBinding, routeDependencies),
    },
    {
      operationId: "internal_pooled_worker_prepare_empty",
      endpoint: "internal/pooled-worker/state/prepare-empty",
      method: "POST",
      policy: {
        requiredScopes: ["internal.write"],
        allowedPrincipalTypes: GATEWAY_PRINCIPALS,
      },
      summary: "Prepare an empty pooled worker",
      description:
        "Sanitizes a quarantined worker under its new generation before activating an empty tenant workspace.",
      tags: ["internal"],
      requestBody: prepareEmptyBodySchema,
      responseBody: pooledSanitizeReceiptSchema,
      handler: (args) =>
        handlePooledWorkerPrepareEmpty(args, trustedBinding, routeDependencies),
    },
    {
      operationId: "internal_pooled_worker_state_sanitize",
      endpoint: "internal/pooled-worker/state/sanitize",
      method: "POST",
      policy: {
        requiredScopes: ["internal.write"],
        allowedPrincipalTypes: GATEWAY_PRINCIPALS,
      },
      summary: "Sanitize a drained pooled worker",
      description:
        "Deletes the drained tenant workspace while the same authenticated lease generation still holds the worker.",
      tags: ["internal"],
      requestBody: leaseGenerationBodySchema,
      responseBody: pooledSanitizeReceiptSchema,
      handler: (args) =>
        handlePooledWorkerStateSanitize(
          args,
          trustedBinding,
          routeDependencies,
        ),
    },
  ];
}

export function createUnavailablePooledWorkerMutationAdapter(): PooledWorkerDestructiveMutationAdapter {
  const unavailable = async (): Promise<never> => {
    throw new ServiceUnavailableError(
      "Pooled workspace restore and sanitization require an exclusive worker lease and process/session fence.",
    );
  };
  return Object.freeze({
    registeredRoutes: Object.freeze([]),
    restore: unavailable,
    sanitize: unavailable,
  });
}

export function createGcsPooledWorkerStateUploader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
): PooledWorkerStateUploader {
  return createPooledWorkerStateUploaderWithValidation(
    ({ uploadUrl }) => {
      if (!validateLegacyGcsUrl(uploadUrl)) {
        throw new BadRequestError("Pooled state upload URL is invalid.");
      }
    },
    fetchImpl,
    timeoutMs,
  );
}

function createBoundPooledWorkerStateUploader(
  binding: PooledStateStorageBinding,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
): PooledWorkerStateUploader {
  return createPooledWorkerStateUploaderWithValidation(
    ({ uploadUrl, objectKey }) => {
      if (!objectKey) {
        throw new BadRequestError("Pooled state object key is required.");
      }
      try {
        assertPooledStateSignedObjectUrl(uploadUrl, binding, objectKey);
      } catch {
        throw new BadRequestError("Pooled state upload URL is invalid.");
      }
    },
    fetchImpl,
    timeoutMs,
  );
}

function createPooledWorkerStateUploaderWithValidation(
  validate: (input: PooledWorkerStateUploaderInput) => void,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): PooledWorkerStateUploader {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Pooled state upload timeout is invalid.");
  }

  return async (input) => {
    validate(input);
    const { uploadUrl, tempPath, byteSize, maxByteSize, abortSignal } = input;
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize < 1 ||
      !Number.isSafeInteger(maxByteSize) ||
      maxByteSize < 1 ||
      byteSize > maxByteSize
    ) {
      throw new BadRequestError("Pooled state upload size is invalid.");
    }
    const combined = abortableTimeout(abortSignal, timeoutMs);
    const fileStream = createReadStream(tempPath);
    const body = Readable.toWeb(
      fileStream,
    ) as unknown as ReadableStream<Uint8Array>;
    try {
      const response = await fetchImpl(uploadUrl, {
        method: "PUT",
        body,
        duplex: "half",
        redirect: "error",
        headers: {
          "Content-Type": CONTENT_TYPE,
          "Content-Length": String(byteSize),
        },
        signal: combined.signal,
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new BadGatewayError(
          `Pooled state upload failed with status ${response.status}.`,
        );
      }
    } catch (error) {
      if (error instanceof BadGatewayError) throw error;
      throw new BadGatewayError("Pooled state upload failed.");
    } finally {
      combined.cleanup();
      fileStream.destroy();
    }
  };
}

function validateLegacyGcsUrl(rawUrl: string): boolean {
  return validateGcsSignedUrl(rawUrl).ok;
}

async function handlePooledWorkerStateExport(
  args: RouteHandlerArgs,
  binding: TrustedPooledWorkerRuntimeBinding,
  dependencies: PooledWorkerStateRouteDependencies,
): Promise<PooledWorkerStateObjectReceipt> {
  const parsed = exportBodySchema.safeParse(args.body);
  if (!parsed.success) {
    throw new BadRequestError(
      "Pooled state export requires a generation-bound object and authoritative workspace limits.",
    );
  }

  const tenant = requireGatewayTenant(args.authContext);
  const identity = requireBoundLease(
    args.authContext,
    binding,
    parsed.data.lease_generation,
  );
  const objectKey = buildPooledWorkerStateObjectKey(
    tenant.organizationId,
    tenant.assistantId,
    parsed.data.state_generation,
  );
  assertSignedObjectUrl(parsed.data.upload_url, binding, objectKey);
  const objectByteLimit = safeByteSum(
    parsed.data.workspace_quota_bytes,
    parsed.data.archive_overhead_bytes,
  );

  dependencies.drainFence.beginDrain(identity);
  return dependencies.drainFence.withDrainingMutation(identity, async () => {
    let artifact: PooledStateExportArtifact | undefined;
    try {
      const workspaceDir = dependencies.workspaceDir();
      dependencies.assertWorkspaceQuota(
        identity,
        workspaceDir,
        parsed.data.workspace_quota_bytes,
      );
      artifact = await dependencies.exportState({
        authContext: args.authContext!,
        workspaceDir,
        workerStackId: binding.workerStackId,
        generation: parsed.data.state_generation,
        bundleId: parsed.data.bundle_id,
        createdAt: new Date(parsed.data.created_at),
        assistantName: dependencies.assistantName(),
        runtimeVersion: dependencies.runtimeVersion(),
        workspaceQuotaBytes: parsed.data.workspace_quota_bytes,
        archiveOverheadBytes: parsed.data.archive_overhead_bytes,
        checkpoint: dependencies.checkpoint,
      });
      assertArtifactTenant(
        artifact,
        tenant,
        binding,
        parsed.data.state_generation,
        parsed.data.workspace_quota_bytes,
        objectByteLimit,
      );

      await dependencies.uploadState({
        uploadUrl: parsed.data.upload_url,
        objectKey,
        tempPath: artifact.tempPath,
        byteSize: artifact.receipt.byteSize,
        maxByteSize: objectByteLimit,
        abortSignal: args.abortSignal,
      });

      return {
        tenant: {
          orgId: tenant.organizationId,
          assistantId: tenant.assistantId,
        },
        workerStackId: binding.workerStackId,
        leaseGeneration: identity.generation,
        stateGeneration: parsed.data.state_generation,
        object: {
          provider: binding.stateProvider,
          bucket: binding.stateBucket,
          objectKey,
          checksumSha256: artifact.receipt.checksumSha256,
          byteSize: artifact.receipt.byteSize,
          format: STATE_FORMAT,
        },
        workspaceByteSize: artifact.receipt.workspaceByteSize,
        entries: artifact.receipt.files.map((file) => ({
          path: file.path,
          kind: "file" as const,
          checksumSha256: file.checksumSha256,
          byteSize: file.byteSize,
        })),
        credentialsIncluded: 0 as const,
        secretsRedacted: true as const,
      };
    } catch (error) {
      dependencies.drainFence.quarantineAssignment(identity);
      throw error;
    } finally {
      if (artifact) {
        await artifact.cleanup().catch((error) => {
          log.warn(
            { error },
            "Failed to clean up pooled state export artifact",
          );
        });
      }
    }
  });
}

async function handlePooledWorkerStateRestore(
  args: RouteHandlerArgs,
  binding: TrustedPooledWorkerRuntimeBinding,
  dependencies: PooledWorkerStateRouteDependencies,
) {
  const parsed = restoreBodySchema.safeParse(args.body);
  if (!parsed.success) {
    throw new BadRequestError(
      "Pooled state restore requires a generation-bound object and authoritative workspace limits.",
    );
  }
  const tenant = requireGatewayTenant(args.authContext);
  const identity = requireBoundLease(
    args.authContext,
    binding,
    parsed.data.lease_generation,
  );
  const objectKey = buildPooledWorkerStateObjectKey(
    tenant.organizationId,
    tenant.assistantId,
    parsed.data.state_generation,
  );
  assertSignedObjectUrl(parsed.data.download_url, binding, objectKey);
  const objectByteLimit = safeByteSum(
    parsed.data.workspace_quota_bytes,
    parsed.data.archive_overhead_bytes,
  );
  if (
    parsed.data.byte_size > objectByteLimit ||
    (parsed.data.workspace_byte_size !== null &&
      parsed.data.workspace_byte_size > parsed.data.workspace_quota_bytes)
  ) {
    throw new BadRequestError(
      "Pooled state object exceeds the authoritative workspace limits.",
    );
  }

  dependencies.drainFence.beginAssignmentMutation(identity);
  try {
    await dependencies.drainFence.proveAssignmentMutationQuiescent(identity);
    dependencies.resetTenantProcessState();
    const restored = await dependencies.restoreState({
      downloadUrl: parsed.data.download_url,
      expectedChecksumSha256: parsed.data.checksum_sha256,
      expectedByteSize: parsed.data.byte_size,
      expectedWorkspaceByteSize: parsed.data.workspace_byte_size,
      workspaceQuotaBytes: parsed.data.workspace_quota_bytes,
      archiveOverheadBytes: parsed.data.archive_overhead_bytes,
      expectedBundleId: parsed.data.bundle_id,
      stateGeneration: parsed.data.state_generation,
      identity,
      storageBinding: binding,
      abortSignal: args.abortSignal,
    });
    if (
      restored.checksumSha256 !== parsed.data.checksum_sha256 ||
      restored.byteSize !== parsed.data.byte_size ||
      restored.workspaceByteSize > parsed.data.workspace_quota_bytes ||
      (parsed.data.workspace_byte_size !== null &&
        restored.workspaceByteSize !== parsed.data.workspace_byte_size) ||
      restored.credentialsImported !== 0 ||
      restored.secretsMaterialized !== false
    ) {
      throw new ServiceUnavailableError(
        "Pooled state restore receipt did not match the requested credential-free object.",
      );
    }
    await dependencies.bootstrapWorkspace(identity, {
      mode: "restored",
      ...(parsed.data.inference_provider
        ? { inferenceProvider: parsed.data.inference_provider }
        : {}),
    });
    const installedWorkspaceByteSize = dependencies.installWorkspaceQuota(
      identity,
      dependencies.workspaceDir(),
      parsed.data.workspace_quota_bytes,
    );
    if (installedWorkspaceByteSize !== restored.workspaceByteSize) {
      throw new ServiceUnavailableError(
        "Pooled workspace changed size during restore bootstrap.",
      );
    }
    dependencies.drainFence.activateAssignment(identity);
    return {
      status: "restored" as const,
      tenant: identity.tenant,
      workerStackId: identity.workerStackId,
      leaseGeneration: identity.generation,
      stateGeneration: parsed.data.state_generation,
      object: {
        provider: binding.stateProvider,
        bucket: binding.stateBucket,
        objectKey,
        checksumSha256: restored.checksumSha256,
        byteSize: restored.byteSize,
        format: STATE_FORMAT,
      },
      workspaceByteSize: installedWorkspaceByteSize,
      filesRestored: restored.filesRestored,
      credentialsImported: 0 as const,
      secretsMaterialized: false as const,
    };
  } catch (error) {
    dependencies.drainFence.quarantineAssignment(identity);
    throw error;
  }
}

async function handlePooledWorkerPrepareEmpty(
  args: RouteHandlerArgs,
  binding: TrustedPooledWorkerRuntimeBinding,
  dependencies: PooledWorkerStateRouteDependencies,
) {
  const parsed = prepareEmptyBodySchema.safeParse(args.body);
  if (!parsed.success) {
    throw new BadRequestError(
      "Pooled empty preparation requires a lease generation and authoritative workspace limits.",
    );
  }
  requireGatewayTenant(args.authContext);
  const identity = requireBoundLease(
    args.authContext,
    binding,
    parsed.data.lease_generation,
  );
  safeByteSum(
    parsed.data.workspace_quota_bytes,
    parsed.data.archive_overhead_bytes,
  );
  dependencies.drainFence.beginAssignmentMutation(identity);
  try {
    const proof =
      await dependencies.drainFence.proveAssignmentMutationQuiescent(identity);
    dependencies.resetTenantProcessState();
    const receipt = await dependencies.sanitizeWorkspace(identity, proof);
    assertSanitizeReceipt(receipt, identity);
    await dependencies.bootstrapWorkspace(identity, {
      mode: "empty",
      ...(parsed.data.inference_provider
        ? { inferenceProvider: parsed.data.inference_provider }
        : {}),
    });
    dependencies.installWorkspaceQuota(
      identity,
      dependencies.workspaceDir(),
      parsed.data.workspace_quota_bytes,
    );
    dependencies.drainFence.activateAssignment(identity);
    return {
      status: "prepared_empty" as const,
      tenant: identity.tenant,
      workerStackId: identity.workerStackId,
      leaseGeneration: identity.generation,
      remainingTenantPaths: 0 as const,
      credentialsTouched: false as const,
    };
  } catch (error) {
    dependencies.drainFence.quarantineAssignment(identity);
    throw error;
  }
}

async function handlePooledWorkerStateSanitize(
  args: RouteHandlerArgs,
  binding: TrustedPooledWorkerRuntimeBinding,
  dependencies: PooledWorkerStateRouteDependencies,
) {
  const parsed = leaseGenerationBodySchema.safeParse(args.body);
  if (!parsed.success) {
    throw new BadRequestError(
      "Pooled state sanitization requires one lease generation.",
    );
  }
  requireGatewayTenant(args.authContext);
  const identity = requireBoundLease(
    args.authContext,
    binding,
    parsed.data.lease_generation,
  );
  dependencies.drainFence.beginDrain(identity);
  return dependencies.drainFence.withSanitizationMutation(
    identity,
    async (proof) => {
      dependencies.resetTenantProcessState();
      const receipt = await dependencies.sanitizeWorkspace(identity, proof);
      assertSanitizeReceipt(receipt, identity);
      dependencies.drainFence.markSanitized(identity);
      return {
        status: receipt.status,
        tenant: identity.tenant,
        workerStackId: identity.workerStackId,
        leaseGeneration: identity.generation,
        remainingTenantPaths: 0 as const,
        credentialsTouched: false as const,
      };
    },
  );
}

function productionDependencies(
  binding: TrustedPooledWorkerRuntimeBinding,
): PooledWorkerStateRouteDependencies {
  return {
    exportState: exportPooledWorkerState,
    uploadState: createBoundPooledWorkerStateUploader(binding),
    workspaceDir: getWorkspaceDir,
    assistantName: () => getAssistantName() ?? "Assistant",
    runtimeVersion: () => APP_VERSION,
    checkpoint: async () => {
      const result = await runAsyncSqlite("PRAGMA wal_checkpoint(FULL)");
      if (!result.ok) {
        throw new ServiceUnavailableError(
          "Pooled state export could not durably checkpoint workspace data.",
        );
      }
    },
    resetTenantProcessState: resetPooledRuntimeTenantProcessState,
    drainFence: {
      beginDrain: (identity) =>
        getProductionPooledRuntimeDrainFence().beginDrain(identity),
      withDrainingMutation: (identity, operation) =>
        getProductionPooledRuntimeDrainFence().withDrainingMutation(
          identity,
          operation,
        ),
      withSanitizationMutation: (identity, operation) =>
        getProductionPooledRuntimeDrainFence().withSanitizationMutation(
          identity,
          operation,
        ),
      beginAssignmentMutation: (identity) =>
        getProductionPooledRuntimeDrainFence().beginAssignmentMutation(
          identity,
        ),
      proveAssignmentMutationQuiescent: (identity) =>
        getProductionPooledRuntimeDrainFence().proveAssignmentMutationQuiescent(
          identity,
        ),
      activateAssignment: (identity) =>
        getProductionPooledRuntimeDrainFence().activateAssignment(identity),
      quarantineAssignment: (identity) =>
        getProductionPooledRuntimeDrainFence().quarantineAssignment(identity),
      markSanitized: (identity) =>
        getProductionPooledRuntimeDrainFence().markSanitized(identity),
    },
    restoreState: restorePooledWorkerState,
    sanitizeWorkspace: sanitizeProductionPooledWorkspace,
    bootstrapWorkspace: bootstrapPooledWorkspace,
    installWorkspaceQuota: installPooledWorkspaceQuotaForAssignment,
    assertWorkspaceQuota: assertPooledWorkspaceQuotaAssignment,
  };
}

/**
 * Bring a verified sanitized or restored workspace to the current request-ready
 * schema without starting daemon background subsystems.
 */
export async function bootstrapPooledWorkspace(
  _identity?: PooledRuntimeLeaseIdentity,
  input: PooledWorkspaceBootstrapInput = { mode: "restored" },
): Promise<void> {
  resetDb();
  releasePooledRuntimeNeutralConfigForAssignment();
  try {
    initializeDb({
      failOnMigrationError: true,
      useTestTemplate: false,
    });
    assertPooledWorkspaceDatabaseReady();
    ensurePromptFiles();
    const migrations = pooledWorkspaceMigrations();
    await runWorkspaceMigrations(getWorkspaceDir(), migrations);
    assertPooledWorkspaceMigrationsReady(migrations);
    bootstrapPooledByokInference(getDb(), input.inferenceProvider);
    assertTenantNeutralWorkspaceDefaults();
  } catch (error) {
    resetDb();
    installPooledRuntimeNeutralConfig();
    log.error({ err: error }, "Pooled workspace bootstrap failed");
    throw new ServiceUnavailableError(
      "Pooled workspace could not be initialized for this assignment.",
    );
  }
}

function assertPooledWorkspaceDatabaseReady(): void {
  const sqlite = getSqlite();
  const integrity = sqlite.query("PRAGMA quick_check").get() as Record<
    string,
    unknown
  > | null;
  if (!integrity || Object.values(integrity)[0] !== "ok") {
    throw new Error("Pooled workspace database failed its integrity check.");
  }

  for (const [table, requiredColumns] of [
    [
      "conversations",
      ["id", "origin_channel", "surfaced_at", "inference_profile_session_id"],
    ],
    ["messages", ["id", "conversation_id", "client_message_id"]],
    [
      "tool_invocations",
      ["id", "skill_id", "arg_bytes", "inference_profile_source"],
    ],
  ] as const) {
    const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map(({ name }) => name));
    if (requiredColumns.some((column) => !names.has(column))) {
      throw new Error("Pooled workspace database schema is incomplete.");
    }
  }

  const artifactRegistry = sqlite
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'",
    )
    .get() as { present: number } | null;
  if (artifactRegistry?.present !== 1) {
    throw new Error("Pooled workspace database schema is incomplete.");
  }
}

function pooledWorkspaceMigrations(): WorkspaceMigration[] {
  if (
    WORKSPACE_MIGRATIONS.at(-1)?.id !== REVIEWED_POOLED_WORKSPACE_MIGRATION_TAIL
  ) {
    throw new Error(
      "Pooled workspace migrations changed without a bootstrap safety review.",
    );
  }
  return WORKSPACE_MIGRATIONS.filter(
    ({ id }) => !POOLED_UNSAFE_WORKSPACE_MIGRATIONS.has(id),
  );
}

function assertPooledWorkspaceMigrationsReady(
  migrations: readonly WorkspaceMigration[],
): void {
  const checkpoints = loadCheckpoints(getWorkspaceDir());
  const incomplete = migrations
    .map(({ id }) => id)
    .filter((id) => {
      const entry = checkpoints.applied[id];
      return (
        !entry || (entry.status !== undefined && entry.status !== "completed")
      );
    });
  if (incomplete.length > 0) {
    throw new Error("Pooled workspace migrations did not reach current state.");
  }
}

function assertTenantNeutralWorkspaceDefaults(): void {
  for (const relativePath of ["IDENTITY.md", "SOUL.md"]) {
    if (!readFileSync(join(getWorkspaceDir(), relativePath), "utf8").trim()) {
      throw new Error(
        `Required pooled workspace default is empty: ${relativePath}`,
      );
    }
  }
  if (!existsSync(join(getWorkspaceDir(), "users", "default.md"))) {
    throw new Error("Required pooled workspace default persona is missing.");
  }
}

export async function restorePooledWorkerState(
  input: PooledWorkerStateRestoreInput,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
): Promise<PooledWorkerStateRestoreReceipt> {
  const objectByteLimit = safeByteSum(
    input.workspaceQuotaBytes,
    input.archiveOverheadBytes,
  );
  try {
    if (input.storageBinding) {
      assertPooledStateSignedObjectUrl(
        input.downloadUrl,
        input.storageBinding,
        buildPooledWorkerStateObjectKey(
          input.identity.tenant.orgId,
          input.identity.tenant.assistantId,
          input.stateGeneration,
        ),
      );
    } else if (!validateGcsSignedUrl(input.downloadUrl).ok) {
      throw new Error("invalid GCS URL");
    }
  } catch {
    throw new BadRequestError("Pooled state download URL is invalid.");
  }
  if (
    !Number.isSafeInteger(input.expectedByteSize) ||
    input.expectedByteSize < 1 ||
    input.expectedByteSize > MAX_STATE_BUNDLE_BYTES ||
    input.expectedByteSize > objectByteLimit ||
    !Number.isSafeInteger(input.workspaceQuotaBytes) ||
    input.workspaceQuotaBytes < 0 ||
    !Number.isSafeInteger(input.archiveOverheadBytes) ||
    input.archiveOverheadBytes < 1 ||
    (input.expectedWorkspaceByteSize !== null &&
      (!Number.isSafeInteger(input.expectedWorkspaceByteSize) ||
        input.expectedWorkspaceByteSize < 0 ||
        input.expectedWorkspaceByteSize > input.workspaceQuotaBytes)) ||
    !/^[a-f0-9]{64}$/u.test(input.expectedChecksumSha256)
  ) {
    throw new BadRequestError("Pooled state object receipt is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Pooled state download timeout is invalid.");
  }

  const combined = abortableTimeout(input.abortSignal, timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetchImpl(input.downloadUrl, {
      method: "GET",
      redirect: "error",
      headers: { Accept: CONTENT_TYPE },
      signal: combined.signal,
    });
  } catch {
    combined.cleanup();
    throw new BadGatewayError("Pooled state download failed.");
  }
  if (!upstream.ok || !upstream.body) {
    combined.cleanup();
    await upstream.body?.cancel().catch(() => {});
    throw new BadGatewayError(
      `Pooled state download failed with status ${upstream.status}.`,
    );
  }
  const contentLength = upstream.headers.get("content-length");
  if (
    contentLength !== null &&
    Number(contentLength) !== input.expectedByteSize
  ) {
    combined.cleanup();
    await upstream.body.cancel().catch(() => {});
    throw new BadGatewayError(
      "Pooled state download length did not match its signed receipt.",
    );
  }

  const source = Readable.fromWeb(
    upstream.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  let observedBytes = 0;
  const hash = createHash("sha256");
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      observedBytes += chunk.byteLength;
      if (observedBytes > input.expectedByteSize) {
        callback(new Error("Pooled state download exceeded its signed size."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (observedBytes !== input.expectedByteSize) {
        callback(
          new Error("Pooled state download ended before its signed size."),
        );
        return;
      }
      const observedChecksum = hash.digest("hex");
      if (observedChecksum !== input.expectedChecksumSha256) {
        callback(
          new Error(
            "Pooled state download checksum did not match its receipt.",
          ),
        );
        return;
      }
      callback();
    },
  });
  source.on("error", (error) => verifier.destroy(error));
  source.pipe(verifier);

  try {
    const workspaceDir = getWorkspaceDir();
    // Startup may have opened the empty worker database before the first
    // assignment arrives. Close that handle before the atomic bundle commit
    // replaces workspace files, otherwise Bun/SQLite can remain attached to
    // the unlinked pre-restore inode and serve stale tenant state.
    resetDb();
    const result = await streamCommitImport({
      source: verifier,
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        getWorkspaceHooksDir(),
      ),
      workspaceDir,
      maxBundleBytes: input.workspaceQuotaBytes,
    });
    if (!result.ok) {
      throw new ServiceUnavailableError(
        `Pooled state restore failed validation or commit (${result.reason}).`,
      );
    }
    if (
      result.report.manifest.bundle_id !== input.expectedBundleId ||
      result.report.manifest.assistant.id !==
        input.identity.tenant.assistantId ||
      result.report.manifest.secrets_redacted !== true
    ) {
      throw new ServiceUnavailableError(
        "Pooled state bundle identity or redaction metadata did not match the active lease.",
      );
    }
    const workspaceByteSize = result.report.manifest.contents.reduce(
      (total, entry) => safeByteSum(total, entry.size_bytes),
      0,
    );
    if (
      workspaceByteSize > input.workspaceQuotaBytes ||
      (input.expectedWorkspaceByteSize !== null &&
        workspaceByteSize !== input.expectedWorkspaceByteSize)
    ) {
      throw new ServiceUnavailableError(
        "Pooled state workspace size did not match its authoritative limits.",
      );
    }
    invalidateConfigCache();
    return {
      checksumSha256: input.expectedChecksumSha256,
      byteSize: observedBytes,
      workspaceByteSize,
      filesRestored: result.report.summary.total_files,
      credentialsImported: 0,
      secretsMaterialized: false,
    };
  } catch (error) {
    verifier.destroy();
    source.destroy();
    if (
      error instanceof ServiceUnavailableError ||
      error instanceof BadGatewayError
    ) {
      throw error;
    }
    throw new BadGatewayError("Pooled state restore stream failed.");
  } finally {
    combined.cleanup();
    source.destroy();
    verifier.destroy();
  }
}

async function sanitizeProductionPooledWorkspace(
  identity: PooledRuntimeLeaseIdentity,
  proof: PooledRuntimeDrainProof,
): Promise<PooledWorkspaceSanitizeReceipt> {
  const workspaceDir = getWorkspaceDir();
  const cesSecurityPath = process.env.CREDENTIAL_SECURITY_DIR?.trim();
  const gatewaySecurityPath = process.env.GATEWAY_SECURITY_DIR?.trim();
  if (!cesSecurityPath || !gatewaySecurityPath) {
    throw new ServiceUnavailableError(
      "Pooled workspace sanitization requires explicit CES and gateway security paths.",
    );
  }

  resetDb();
  const sanitizer = createPooledWorkspaceSanitizer({
    proofGuard: {
      resolveCurrentTenantWorkspace: async () => ({
        tenant: identity.tenant,
        workerStackId: identity.workerStackId,
        workspaceRoot: dirname(workspaceDir),
        tenantWorkspacePath: workspaceDir,
      }),
      withExclusiveSanitizationProofs: async (requested, operation) => {
        if (
          requested.tenant.orgId !== identity.tenant.orgId ||
          requested.tenant.assistantId !== identity.tenant.assistantId ||
          requested.workerStackId !== identity.workerStackId ||
          requested.generation !== identity.generation
        ) {
          throw new ForbiddenError(
            "Pooled workspace mutation proof belongs to another lease.",
          );
        }
        return operation(proof);
      },
    },
    fileSystem: createNodePooledWorkspaceFileSystem(),
    cesSecurityPaths: [cesSecurityPath],
    gatewaySecurityPaths: [gatewaySecurityPath],
  });
  return sanitizer.sanitize({
    tenant: identity.tenant,
    workerStackId: identity.workerStackId,
    generation: identity.generation,
  });
}

function requireGatewayTenant(authContext: AuthContext | undefined): {
  organizationId: string;
  assistantId: string;
} {
  const tenant = authContext?.serviceTenantContext;
  if (
    authContext?.principalType !== "svc_gateway" ||
    authContext.scopeProfile !== "gateway_service_v1" ||
    !authContext.scopes.has("internal.write") ||
    tenant?.serviceId !== "gateway" ||
    !tenant.organizationId
  ) {
    throw new ForbiddenError(
      "Verified gateway tenant context is required for pooled state export.",
    );
  }
  return {
    organizationId: assertOpaqueId(tenant.organizationId, "organization"),
    assistantId: assertOpaqueId(tenant.assistantId, "assistant"),
  };
}

function requireBoundLease(
  authContext: AuthContext | undefined,
  binding: TrustedPooledWorkerRuntimeBinding,
  leaseGeneration: number,
): PooledRuntimeLeaseIdentity {
  const tenant = requireGatewayTenant(authContext);
  const identity = pooledRuntimeLeaseIdentityFromAuth(authContext);
  if (
    identity.tenant.orgId !== tenant.organizationId ||
    identity.tenant.assistantId !== tenant.assistantId ||
    identity.workerStackId !== binding.workerStackId ||
    identity.generation !== leaseGeneration
  ) {
    throw new ForbiddenError(
      "Pooled state operation lease does not match its tenant, worker, or generation.",
    );
  }
  return identity;
}

function assertSanitizeReceipt(
  receipt: PooledWorkspaceSanitizeReceipt,
  identity: PooledRuntimeLeaseIdentity,
): void {
  if (
    receipt.workerStackId !== identity.workerStackId ||
    receipt.generation !== identity.generation ||
    receipt.remainingTenantPaths !== 0 ||
    receipt.credentialsTouched !== false
  ) {
    throw new ServiceUnavailableError(
      "Pooled workspace sanitization receipt did not match the active lease.",
    );
  }
}

function assertArtifactTenant(
  artifact: PooledStateExportArtifact,
  tenant: { organizationId: string; assistantId: string },
  binding: TrustedPooledWorkerRuntimeBinding,
  stateGeneration: number,
  workspaceQuotaBytes: number,
  objectByteLimit: number,
): void {
  const summedWorkspaceBytes = artifact.receipt.files.reduce(
    (total, file) => safeByteSum(total, file.byteSize),
    0,
  );
  if (
    artifact.receipt.tenant.organizationId !== tenant.organizationId ||
    artifact.receipt.tenant.assistantId !== tenant.assistantId ||
    artifact.receipt.workerStackId !== binding.workerStackId ||
    artifact.receipt.generation !== stateGeneration ||
    !Number.isSafeInteger(artifact.receipt.byteSize) ||
    artifact.receipt.byteSize < 1 ||
    artifact.receipt.byteSize > objectByteLimit ||
    artifact.receipt.workspaceByteSize !== summedWorkspaceBytes ||
    artifact.receipt.workspaceByteSize > workspaceQuotaBytes ||
    artifact.receipt.credentialsIncluded !== 0 ||
    artifact.receipt.secretsRedacted !== true
  ) {
    throw new ServiceUnavailableError(
      "Pooled state export receipt did not match the trusted tenant binding.",
    );
  }
}

function assertSignedObjectUrl(
  rawUrl: string,
  binding: PooledStateStorageBinding,
  objectKey: string,
): void {
  try {
    assertPooledStateSignedObjectUrl(rawUrl, binding, objectKey);
  } catch {
    throw new BadRequestError(
      "Pooled state upload URL is outside the tenant generation namespace.",
    );
  }
}

function abortableTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function safeByteSum(left: number, right: number): number {
  const total = left + right;
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    !Number.isSafeInteger(total)
  ) {
    throw new BadRequestError("Pooled workspace byte limit is invalid.");
  }
  return total;
}

function assertOpaqueId(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Pooled state ${label} id is invalid.`);
  }
  return value;
}

const pooledStateReceiptSchema = z.object({
  tenant: z.object({
    orgId: z.string(),
    assistantId: z.string(),
  }),
  workerStackId: z.string(),
  leaseGeneration: z.number().int().positive(),
  stateGeneration: z.number().int().positive(),
  object: z.object({
    provider: z.enum(["gcs", "s3"]),
    bucket: z.string(),
    objectKey: z.string(),
    checksumSha256: z.string(),
    byteSize: z.number().int().positive(),
    format: z.literal(STATE_FORMAT),
  }),
  workspaceByteSize: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.literal("file"),
      checksumSha256: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  ),
  credentialsIncluded: z.literal(0),
  secretsRedacted: z.literal(true),
});

const pooledRestoreReceiptSchema = z.object({
  status: z.literal("restored"),
  tenant: z.object({
    orgId: z.string(),
    assistantId: z.string(),
  }),
  workerStackId: z.string(),
  leaseGeneration: z.number().int().positive(),
  stateGeneration: z.number().int().positive(),
  object: z.object({
    provider: z.enum(["gcs", "s3"]),
    bucket: z.string(),
    objectKey: z.string(),
    checksumSha256: z.string(),
    byteSize: z.number().int().positive(),
    format: z.literal(STATE_FORMAT),
  }),
  workspaceByteSize: z.number().int().nonnegative(),
  filesRestored: z.number().int().nonnegative(),
  credentialsImported: z.literal(0),
  secretsMaterialized: z.literal(false),
});

const pooledSanitizeReceiptSchema = z.object({
  status: z.enum(["prepared_empty", "sanitized", "already_sanitized"]),
  tenant: z.object({
    orgId: z.string(),
    assistantId: z.string(),
  }),
  workerStackId: z.string(),
  leaseGeneration: z.number().int().positive(),
  remainingTenantPaths: z.literal(0),
  credentialsTouched: z.literal(false),
});

export const ROUTES: RouteDefinition[] = (() => {
  try {
    const binding = pooledWorkerRuntimeBindingFromEnv(process.env);
    return binding ? createPooledWorkerStateRoutes(binding) : [];
  } catch (error) {
    log.error(
      { error },
      "Pooled worker state routes are disabled by invalid runtime binding",
    );
    return [];
  }
})();
