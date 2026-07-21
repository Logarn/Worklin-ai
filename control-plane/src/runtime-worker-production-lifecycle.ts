import {
  buildRuntimeWorkerStateObjectKey,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  RUNTIME_WORKER_STATE_DEFAULT_PROVIDER,
  RUNTIME_WORKER_STATE_FORMAT,
  isRuntimeWorkerStateProvider,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateProvider,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import type { RuntimeWorkerLifecycleAdapter } from "./runtime-worker-dispatcher.js";

type EnvLike = Record<string, string | undefined>;

const STATE_CONTENT_TYPE = "application/octet-stream";

export interface RuntimeWorkerProductionLifecycleConfig {
  provider?: RuntimeWorkerStateProvider;
  bucket: string;
}

export interface RuntimeWorkerVBundleEntry {
  path: string;
  kind: "file" | "symlink";
  checksumSha256: string;
  byteSize: number;
  linkTarget?: string;
}

export interface RuntimeWorkerVBundleReceipt {
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
  object: RuntimeWorkerStateObject;
  workspaceByteSize: number;
  entries: readonly RuntimeWorkerVBundleEntry[];
  credentialsIncluded: number;
  secretsRedacted: boolean;
}

export interface RuntimeWorkerRestoreReceipt {
  status: "restored";
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
  object: RuntimeWorkerStateObject;
  workspaceByteSize: number;
  filesRestored: number;
  credentialsImported: 0;
  secretsMaterialized: false;
}

export interface RuntimeWorkerObjectHead {
  provider: RuntimeWorkerStateProvider;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  byteSize: number;
  contentType: typeof STATE_CONTENT_TYPE;
}

export interface RuntimeWorkerSanitizeReceipt {
  status: "prepared_empty" | "sanitized" | "already_sanitized";
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  remainingTenantPaths: number;
  credentialsTouched: false;
}

export interface RuntimeWorkerLeaseRevokeReceipt {
  status: "revoked" | "already_revoked";
  workerStackId: string;
  leaseGeneration: number;
}

/**
 * Infrastructure boundary still required for production activation.
 *
 * Production implementations must provide credential-excluding `.vbundle`
 * export, verified object-storage metadata, and an idempotent pooled-workspace
 * sanitizer without weakening this adapter's checks.
 */
export interface RuntimeWorkerProductionTransport {
  exportRedactedVBundle(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
    stateGeneration: number;
    provider: RuntimeWorkerStateProvider;
    bucket: string;
    objectKey: string;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerVBundleReceipt>;
  restoreRedactedVBundle(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
    stateGeneration: number;
    object: RuntimeWorkerStateObject;
    expectedWorkspaceByteSize: number | null;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerRestoreReceipt>;
  prepareEmptyWorkspace(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerSanitizeReceipt>;
  headObject(input: {
    provider: RuntimeWorkerStateProvider;
    bucket: string;
    objectKey: string;
  }): Promise<RuntimeWorkerObjectHead | null>;
  sanitizeWorkspace(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerSanitizeReceipt>;
  revokeLeaseAuthority(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
  }): Promise<RuntimeWorkerLeaseRevokeReceipt>;
}

export function runtimeWorkerProductionLifecycleConfigFromEnv(
  rawEnv: EnvLike,
): RuntimeWorkerProductionLifecycleConfig {
  const provider =
    rawEnv.WORKLIN_RUNTIME_WORKER_STATE_PROVIDER?.trim().toLowerCase() ??
    (rawEnv.WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON?.trim()
      ? "gcs"
      : (rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT?.trim() ||
            rawEnv.ENDPOINT?.trim()) &&
          (rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_ACCESS_KEY_ID?.trim() ||
            rawEnv.ACCESS_KEY_ID?.trim()) &&
          (rawEnv.WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY?.trim() ||
            rawEnv.SECRET_ACCESS_KEY?.trim())
        ? "s3"
        : RUNTIME_WORKER_STATE_DEFAULT_PROVIDER);
  if (!isRuntimeWorkerStateProvider(provider)) {
    throw new Error("WORKLIN_RUNTIME_WORKER_STATE_PROVIDER is invalid.");
  }
  const bucket =
    rawEnv.WORKLIN_RUNTIME_WORKER_STATE_BUCKET?.trim() ??
    (provider === "s3" ? rawEnv.BUCKET?.trim() : undefined) ??
    "";
  if (!bucket) {
    throw new Error(
      "WORKLIN_RUNTIME_WORKER_STATE_BUCKET is required for pooled worker state.",
    );
  }
  assertBucket(bucket);
  return { provider, bucket };
}

export function createRuntimeWorkerProductionLifecycleAdapter(
  config: RuntimeWorkerProductionLifecycleConfig,
  transport: RuntimeWorkerProductionTransport | null | undefined,
): RuntimeWorkerLifecycleAdapter {
  const provider = config.provider ?? RUNTIME_WORKER_STATE_DEFAULT_PROVIDER;
  if (!isRuntimeWorkerStateProvider(provider)) {
    throw new Error("Pooled worker state provider is invalid.");
  }
  const bucket = config.bucket.trim();
  assertBucket(bucket);
  if (!transport) {
    throw new Error(
      "Pooled worker production state transport is not configured.",
    );
  }

  return {
    storage: {
      restore: async ({
        tenant,
        workerStackId,
        leaseGeneration,
        stateGeneration,
        object,
        expectedWorkspaceByteSize,
        credentialPolicy,
      }) => {
        assertCredentialPolicy(credentialPolicy);
        assertTenant(tenant);
        assertWorkerStackId(workerStackId);
        assertGeneration(leaseGeneration, false);
        assertGeneration(stateGeneration, true);

        if (object === null) {
          if (stateGeneration !== 0) {
            throw new Error(
              "A non-empty pooled state generation requires an object.",
            );
          }
          const receipt = await transport.prepareEmptyWorkspace({
            tenant,
            workerStackId,
            leaseGeneration,
            credentialPolicy,
          });
          assertSanitizeReceipt({
            receipt,
            tenant,
            workerStackId,
            leaseGeneration,
            expectedStatuses: ["prepared_empty", "already_sanitized"],
          });
          if (
            expectedWorkspaceByteSize !== null &&
            expectedWorkspaceByteSize !== 0
          ) {
            throw new Error(
              "An empty pooled state generation must have zero workspace bytes.",
            );
          }
          return { checksumSha256: null, workspaceByteSize: 0 };
        }

        const expected = assertStateObject(
          tenant,
          stateGeneration,
          object,
          bucket,
          provider,
        );
        await assertRemoteObject(transport, expected);
        const receipt = await transport.restoreRedactedVBundle({
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration,
          object: expected,
          expectedWorkspaceByteSize,
          credentialPolicy,
        });
        assertRestoreReceipt({
          receipt,
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration,
          expectedObject: expected,
          expectedWorkspaceByteSize,
        });
        return {
          checksumSha256: expected.checksumSha256,
          workspaceByteSize: receipt.workspaceByteSize,
        };
      },
      export: async ({
        tenant,
        workerStackId,
        leaseGeneration,
        currentStateGeneration,
        nextStateGeneration,
        objectKey,
        credentialPolicy,
      }) => {
        assertCredentialPolicy(credentialPolicy);
        assertTenant(tenant);
        assertWorkerStackId(workerStackId);
        assertGeneration(leaseGeneration, false);
        assertGeneration(currentStateGeneration, true);
        assertGeneration(nextStateGeneration, false);
        if (nextStateGeneration !== currentStateGeneration + 1) {
          throw new Error("Pooled state export generation is not monotonic.");
        }
        const expectedKey = buildRuntimeWorkerStateObjectKey(
          tenant,
          nextStateGeneration,
        );
        if (objectKey !== expectedKey) {
          throw new Error(
            "Pooled state export object is outside the tenant namespace.",
          );
        }

        const receipt = await transport.exportRedactedVBundle({
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration: nextStateGeneration,
          provider,
          bucket,
          objectKey: expectedKey,
          credentialPolicy,
        });
        const object = assertStateObject(
          tenant,
          nextStateGeneration,
          receipt.object,
          bucket,
          provider,
        );
        assertVBundleReceipt({
          receipt,
          tenant,
          workerStackId,
          leaseGeneration,
          stateGeneration: nextStateGeneration,
          expectedObject: object,
        });
        await assertRemoteObject(transport, object);
        return {
          object,
          workspaceByteSize: receipt.workspaceByteSize,
        };
      },
    },
    sanitize: async ({
      assistant,
      workerStackId,
      leaseGeneration,
      credentialPolicy,
    }) => {
      assertCredentialPolicy(credentialPolicy);
      const tenant = {
        orgId: assistant.org_id,
        assistantId: assistant.id,
      };
      assertTenant(tenant);
      assertWorkerStackId(workerStackId);
      assertGeneration(leaseGeneration, false);
      const receipt = await transport.sanitizeWorkspace({
        tenant,
        workerStackId,
        leaseGeneration,
        credentialPolicy,
      });
      assertSanitizeReceipt({
        receipt,
        tenant,
        workerStackId,
        leaseGeneration,
        expectedStatuses: ["sanitized", "already_sanitized"],
      });
    },
    revokeAuthority: async ({ assistant, workerStackId, leaseGeneration }) => {
      const tenant = {
        orgId: assistant.org_id,
        assistantId: assistant.id,
      };
      assertTenant(tenant);
      assertWorkerStackId(workerStackId);
      assertGeneration(leaseGeneration, false);
      const receipt = await transport.revokeLeaseAuthority({
        tenant,
        workerStackId,
        leaseGeneration,
      });
      if (
        (receipt.status !== "revoked" &&
          receipt.status !== "already_revoked") ||
        receipt.workerStackId !== workerStackId ||
        receipt.leaseGeneration !== leaseGeneration
      ) {
        throw new Error(
          "Pooled worker lease revocation could not be verified.",
        );
      }
    },
  };
}

async function assertRemoteObject(
  transport: RuntimeWorkerProductionTransport,
  expected: RuntimeWorkerStateObject,
): Promise<void> {
  const head = await transport.headObject({
    provider: expected.provider,
    bucket: expected.bucket,
    objectKey: expected.objectKey,
  });
  if (!head) throw new Error("Pooled state object is unavailable.");
  assertObjectHead(head);
  if (
    head.provider !== expected.provider ||
    head.bucket !== expected.bucket ||
    head.objectKey !== expected.objectKey ||
    head.checksumSha256 !== expected.checksumSha256 ||
    head.byteSize !== expected.byteSize
  ) {
    throw new Error("Pooled state object metadata verification failed.");
  }
}

function assertVBundleReceipt(input: {
  receipt: RuntimeWorkerVBundleReceipt;
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
  expectedObject: RuntimeWorkerStateObject;
}): void {
  const {
    receipt,
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
    expectedObject,
  } = input;
  assertReceiptIdentity({
    receipt,
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
  });
  if (
    receipt.object.provider !== expectedObject.provider ||
    receipt.object.bucket !== expectedObject.bucket ||
    receipt.object.objectKey !== expectedObject.objectKey ||
    receipt.object.checksumSha256 !== expectedObject.checksumSha256 ||
    receipt.object.byteSize !== expectedObject.byteSize ||
    receipt.object.format !== expectedObject.format
  ) {
    throw new Error("Pooled state receipt object metadata does not match.");
  }
  if (receipt.credentialsIncluded !== 0 || !receipt.secretsRedacted) {
    throw new Error(
      "Pooled state bundle must exclude credentials and report redaction.",
    );
  }
  let workspaceByteSize = 0;
  for (const entry of receipt.entries) {
    assertSafeVBundleEntry(entry);
    workspaceByteSize = safeByteSum(workspaceByteSize, entry.byteSize);
  }
  if (
    !Number.isSafeInteger(receipt.workspaceByteSize) ||
    receipt.workspaceByteSize < 0 ||
    receipt.workspaceByteSize !== workspaceByteSize
  ) {
    throw new Error(
      "Pooled state receipt workspace size does not match its entries.",
    );
  }
}

function assertRestoreReceipt(input: {
  receipt: RuntimeWorkerRestoreReceipt;
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
  expectedObject: RuntimeWorkerStateObject;
  expectedWorkspaceByteSize: number | null;
}): void {
  const {
    receipt,
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
    expectedObject,
    expectedWorkspaceByteSize,
  } = input;
  if (receipt.status !== "restored") {
    throw new Error("Pooled state restore receipt status is invalid.");
  }
  assertReceiptIdentity({
    receipt,
    tenant,
    workerStackId,
    leaseGeneration,
    stateGeneration,
  });
  if (
    receipt.object.provider !== expectedObject.provider ||
    receipt.object.bucket !== expectedObject.bucket ||
    receipt.object.objectKey !== expectedObject.objectKey ||
    receipt.object.checksumSha256 !== expectedObject.checksumSha256 ||
    receipt.object.byteSize !== expectedObject.byteSize ||
    receipt.object.format !== expectedObject.format
  ) {
    throw new Error(
      "Pooled state restore receipt object metadata does not match.",
    );
  }
  if (
    !Number.isSafeInteger(receipt.workspaceByteSize) ||
    receipt.workspaceByteSize < 0 ||
    (expectedWorkspaceByteSize !== null &&
      receipt.workspaceByteSize !== expectedWorkspaceByteSize) ||
    !Number.isSafeInteger(receipt.filesRestored) ||
    receipt.filesRestored < 0 ||
    receipt.credentialsImported !== 0 ||
    receipt.secretsMaterialized !== false
  ) {
    throw new Error(
      "Pooled state restore must exclude credentials and secret material.",
    );
  }
}

function safeByteSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Pooled state workspace size is invalid.");
  }
  return total;
}

function assertReceiptIdentity(input: {
  receipt: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    leaseGeneration: number;
    stateGeneration: number;
  };
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  stateGeneration: number;
}): void {
  const { receipt, tenant, workerStackId, leaseGeneration, stateGeneration } =
    input;
  assertTenant(receipt.tenant);
  if (
    receipt.tenant.orgId !== tenant.orgId ||
    receipt.tenant.assistantId !== tenant.assistantId
  ) {
    throw new Error("Pooled state receipt belongs to another tenant.");
  }
  if (receipt.workerStackId !== workerStackId) {
    throw new Error("Pooled state receipt belongs to another worker.");
  }
  if (
    receipt.leaseGeneration !== leaseGeneration ||
    receipt.stateGeneration !== stateGeneration
  ) {
    throw new Error(
      "Pooled state receipt does not match its lease and state generations.",
    );
  }
}

function assertSafeVBundleEntry(entry: RuntimeWorkerVBundleEntry): void {
  const path = entry.path.trim();
  if (
    !path ||
    path !== entry.path ||
    path.length > 4_096 ||
    path.includes("\u0000")
  ) {
    throw new Error("Pooled state bundle contains an invalid path.");
  }
  if (entry.kind === "symlink" || entry.linkTarget !== undefined) {
    throw new Error("Pooled state bundles must not contain symlinks.");
  }
  if (entry.kind !== "file") {
    throw new Error("Pooled state bundle contains an unsupported entry.");
  }
  const segments = decodedPathSegments(path);
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/u.test(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f]/u.test(segment),
    ) ||
    segments[0] !== "workspace" ||
    segments.some((segment) => segment.toLowerCase() === "credentials")
  ) {
    throw new Error(
      "Pooled state bundle contains traversal or a forbidden namespace.",
    );
  }
  assertChecksum(entry.checksumSha256);
  if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
    throw new Error("Pooled state bundle entry size is invalid.");
  }
}

function decodedPathSegments(path: string): string[] {
  const normalized = path.replace(/\\/gu, "/");
  const rawSegments = normalized.split("/");
  const decoded: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment = rawSegment;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const next = decodeURIComponent(segment);
        if (next === segment) break;
        if (attempt === 7) {
          throw new Error(
            "Pooled state bundle contains excessive path encoding.",
          );
        }
        segment = next;
      } catch {
        throw new Error(
          "Pooled state bundle contains malformed path encoding.",
        );
      }
    }
    decoded.push(...segment.replace(/\\/gu, "/").split("/"));
  }
  return decoded;
}

function assertStateObject(
  tenant: RuntimeWorkerStateTenant,
  generation: number,
  object: RuntimeWorkerStateObject,
  bucket: string,
  provider: RuntimeWorkerStateProvider,
): RuntimeWorkerStateObject {
  if (
    object.provider !== provider ||
    object.format !== RUNTIME_WORKER_STATE_FORMAT ||
    object.bucket !== bucket
  ) {
    throw new Error(
      "Pooled state object provider, format, or bucket is invalid.",
    );
  }
  const expectedKey = buildRuntimeWorkerStateObjectKey(tenant, generation);
  if (object.objectKey !== expectedKey) {
    throw new Error(
      "Pooled state object is outside the tenant generation namespace.",
    );
  }
  assertChecksum(object.checksumSha256);
  if (!Number.isSafeInteger(object.byteSize) || object.byteSize < 1) {
    throw new Error("Pooled state object size is invalid.");
  }
  return {
    provider,
    bucket,
    objectKey: expectedKey,
    checksumSha256: object.checksumSha256.toLowerCase(),
    byteSize: object.byteSize,
    format: RUNTIME_WORKER_STATE_FORMAT,
  };
}

function assertObjectHead(head: RuntimeWorkerObjectHead): void {
  if (
    !isRuntimeWorkerStateProvider(head.provider) ||
    head.contentType !== STATE_CONTENT_TYPE
  ) {
    throw new Error("Pooled state object content metadata is invalid.");
  }
  assertBucket(head.bucket);
  assertChecksum(head.checksumSha256);
  if (!Number.isSafeInteger(head.byteSize) || head.byteSize < 1) {
    throw new Error("Pooled state remote object size is invalid.");
  }
}

function assertSanitizeReceipt(input: {
  receipt: RuntimeWorkerSanitizeReceipt;
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  leaseGeneration: number;
  expectedStatuses: readonly RuntimeWorkerSanitizeReceipt["status"][];
}): void {
  const { receipt, tenant, workerStackId, leaseGeneration, expectedStatuses } =
    input;
  assertTenant(receipt.tenant);
  if (
    !expectedStatuses.includes(receipt.status) ||
    receipt.tenant.orgId !== tenant.orgId ||
    receipt.tenant.assistantId !== tenant.assistantId ||
    receipt.workerStackId !== workerStackId ||
    receipt.leaseGeneration !== leaseGeneration ||
    receipt.remainingTenantPaths !== 0 ||
    receipt.credentialsTouched !== false
  ) {
    throw new Error("Pooled worker sanitization could not be verified.");
  }
}

function assertCredentialPolicy(
  policy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
): void {
  if (policy !== RUNTIME_WORKER_STATE_CREDENTIAL_POLICY) {
    throw new Error("Pooled worker credential exclusion policy is required.");
  }
}

function assertTenant(tenant: RuntimeWorkerStateTenant): void {
  assertOpaqueId(tenant.orgId, "organization");
  assertOpaqueId(tenant.assistantId, "assistant");
}

function assertWorkerStackId(workerStackId: string): void {
  assertOpaqueId(workerStackId, "worker stack");
}

function assertOpaqueId(value: string, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Pooled state ${label} id is invalid.`);
  }
}

function assertGeneration(generation: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(generation) || generation < (allowZero ? 0 : 1)) {
    throw new Error("Pooled state generation is invalid.");
  }
}

function assertChecksum(checksum: string): void {
  if (!/^[a-f0-9]{64}$/u.test(checksum.toLowerCase())) {
    throw new Error("Pooled state SHA-256 checksum is invalid.");
  }
}

function assertBucket(bucket: string): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/u.test(bucket) ||
    bucket.includes("..") ||
    bucket.startsWith("goog") ||
    /^(\d{1,3}\.){3}\d{1,3}$/u.test(bucket)
  ) {
    throw new Error("Pooled worker state bucket is invalid.");
  }
}
