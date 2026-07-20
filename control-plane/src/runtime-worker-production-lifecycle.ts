import {
  buildRuntimeWorkerStateObjectKey,
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  RUNTIME_WORKER_STATE_FORMAT,
  RUNTIME_WORKER_STATE_PROVIDER,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import type { RuntimeWorkerLifecycleAdapter } from "./runtime-worker-dispatcher.js";

type EnvLike = Record<string, string | undefined>;

const STATE_CONTENT_TYPE = "application/octet-stream";

export interface RuntimeWorkerProductionLifecycleConfig {
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
  object: RuntimeWorkerStateObject;
  entries: readonly RuntimeWorkerVBundleEntry[];
  credentialsIncluded: number;
  secretsRedacted: boolean;
}

export interface RuntimeWorkerObjectHead {
  provider: typeof RUNTIME_WORKER_STATE_PROVIDER;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  byteSize: number;
  contentType: typeof STATE_CONTENT_TYPE;
}

export interface RuntimeWorkerSanitizeReceipt {
  status: "sanitized" | "already_sanitized";
  workerStackId: string;
  remainingTenantPaths: number;
  credentialsTouched: false;
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
    provider: typeof RUNTIME_WORKER_STATE_PROVIDER;
    bucket: string;
    objectKey: string;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerVBundleReceipt>;
  restoreRedactedVBundle(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    object: RuntimeWorkerStateObject;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerVBundleReceipt>;
  prepareEmptyWorkspace(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerSanitizeReceipt>;
  headObject(input: {
    provider: typeof RUNTIME_WORKER_STATE_PROVIDER;
    bucket: string;
    objectKey: string;
  }): Promise<RuntimeWorkerObjectHead | null>;
  sanitizeWorkspace(input: {
    tenant: RuntimeWorkerStateTenant;
    workerStackId: string;
    credentialPolicy: typeof RUNTIME_WORKER_STATE_CREDENTIAL_POLICY;
  }): Promise<RuntimeWorkerSanitizeReceipt>;
}

export function runtimeWorkerProductionLifecycleConfigFromEnv(
  rawEnv: EnvLike,
): RuntimeWorkerProductionLifecycleConfig {
  const bucket = rawEnv.WORKLIN_RUNTIME_WORKER_STATE_BUCKET?.trim() ?? "";
  if (!bucket) {
    throw new Error(
      "WORKLIN_RUNTIME_WORKER_STATE_BUCKET is required for pooled worker state.",
    );
  }
  assertBucket(bucket);
  return { bucket };
}

export function createRuntimeWorkerProductionLifecycleAdapter(
  config: RuntimeWorkerProductionLifecycleConfig,
  transport: RuntimeWorkerProductionTransport | null | undefined,
): RuntimeWorkerLifecycleAdapter {
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
        generation,
        object,
        credentialPolicy,
      }) => {
        assertCredentialPolicy(credentialPolicy);
        assertTenant(tenant);
        assertWorkerStackId(workerStackId);
        assertGeneration(generation, true);

        if (object === null) {
          if (generation !== 0) {
            throw new Error(
              "A non-empty pooled state generation requires an object.",
            );
          }
          const receipt = await transport.prepareEmptyWorkspace({
            tenant,
            workerStackId,
            credentialPolicy,
          });
          assertSanitizeReceipt(receipt, workerStackId);
          return { checksumSha256: null };
        }

        const expected = assertStateObject(
          tenant,
          generation,
          object,
          bucket,
        );
        await assertRemoteObject(transport, expected);
        const receipt = await transport.restoreRedactedVBundle({
          tenant,
          workerStackId,
          object: expected,
          credentialPolicy,
        });
        assertVBundleReceipt({
          receipt,
          tenant,
          workerStackId,
          expectedObject: expected,
        });
        return { checksumSha256: expected.checksumSha256 };
      },
      export: async ({
        tenant,
        workerStackId,
        currentGeneration,
        nextGeneration,
        objectKey,
        credentialPolicy,
      }) => {
        assertCredentialPolicy(credentialPolicy);
        assertTenant(tenant);
        assertWorkerStackId(workerStackId);
        assertGeneration(currentGeneration, true);
        assertGeneration(nextGeneration, false);
        if (nextGeneration !== currentGeneration + 1) {
          throw new Error("Pooled state export generation is not monotonic.");
        }
        const expectedKey = buildRuntimeWorkerStateObjectKey(
          tenant,
          nextGeneration,
        );
        if (objectKey !== expectedKey) {
          throw new Error(
            "Pooled state export object is outside the tenant namespace.",
          );
        }

        const receipt = await transport.exportRedactedVBundle({
          tenant,
          workerStackId,
          provider: RUNTIME_WORKER_STATE_PROVIDER,
          bucket,
          objectKey: expectedKey,
          credentialPolicy,
        });
        const object = assertStateObject(
          tenant,
          nextGeneration,
          receipt.object,
          bucket,
        );
        assertVBundleReceipt({
          receipt,
          tenant,
          workerStackId,
          expectedObject: object,
        });
        await assertRemoteObject(transport, object);
        return object;
      },
    },
    sanitize: async ({
      assistant,
      workerStackId,
      credentialPolicy,
    }) => {
      assertCredentialPolicy(credentialPolicy);
      const tenant = {
        orgId: assistant.org_id,
        assistantId: assistant.id,
      };
      assertTenant(tenant);
      assertWorkerStackId(workerStackId);
      const receipt = await transport.sanitizeWorkspace({
        tenant,
        workerStackId,
        credentialPolicy,
      });
      assertSanitizeReceipt(receipt, workerStackId);
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
  expectedObject: RuntimeWorkerStateObject;
}): void {
  const { receipt, tenant, workerStackId, expectedObject } = input;
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
  for (const entry of receipt.entries) assertSafeVBundleEntry(entry);
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
    segments.some(
      (segment) => segment.toLowerCase() === "credentials",
    )
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
): RuntimeWorkerStateObject {
  if (
    object.provider !== RUNTIME_WORKER_STATE_PROVIDER ||
    object.format !== RUNTIME_WORKER_STATE_FORMAT ||
    object.bucket !== bucket
  ) {
    throw new Error("Pooled state object provider, format, or bucket is invalid.");
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
    provider: RUNTIME_WORKER_STATE_PROVIDER,
    bucket,
    objectKey: expectedKey,
    checksumSha256: object.checksumSha256.toLowerCase(),
    byteSize: object.byteSize,
    format: RUNTIME_WORKER_STATE_FORMAT,
  };
}

function assertObjectHead(head: RuntimeWorkerObjectHead): void {
  if (
    head.provider !== RUNTIME_WORKER_STATE_PROVIDER ||
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

function assertSanitizeReceipt(
  receipt: RuntimeWorkerSanitizeReceipt,
  workerStackId: string,
): void {
  if (
    (receipt.status !== "sanitized" &&
      receipt.status !== "already_sanitized") ||
    receipt.workerStackId !== workerStackId ||
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
  if (
    !Number.isSafeInteger(generation) ||
    generation < (allowZero ? 0 : 1)
  ) {
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
