import {
  createHash,
  createPrivateKey,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";

import { S3Client } from "bun";

import {
  RUNTIME_WORKER_STATE_CREDENTIAL_POLICY,
  RUNTIME_WORKER_STATE_DEFAULT_PROVIDER,
  RUNTIME_WORKER_STATE_FORMAT,
  buildRuntimeWorkerStateBundleId,
  buildRuntimeWorkerStateObjectKey,
  isRuntimeWorkerStateProvider,
  type RuntimeWorkerStateObject,
  type RuntimeWorkerStateProvider,
  type RuntimeWorkerStateTenant,
} from "./runtime-worker-state-checkpoints.js";
import type {
  RuntimeWorkerLeaseRevokeReceipt,
  RuntimeWorkerObjectHead,
  RuntimeWorkerProductionTransport,
  RuntimeWorkerRestoreReceipt,
  RuntimeWorkerSanitizeReceipt,
  RuntimeWorkerVBundleEntry,
  RuntimeWorkerVBundleReceipt,
} from "./runtime-worker-production-lifecycle.js";
import {
  RUNTIME_WORKER_POOL_PROVIDER,
  type RuntimeWorkerStackRow,
} from "./runtime-worker-leases.js";
import type { RuntimeWorkerLeaseServiceBinding } from "./runtime-worker-service-tokens.js";

type EnvLike = Record<string, string | undefined>;

const ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED";
const PROVIDER_ENV = "WORKLIN_RUNTIME_WORKER_STATE_PROVIDER";
const BUCKET_ENV = "WORKLIN_RUNTIME_WORKER_STATE_BUCKET";
const SERVICE_ACCOUNT_ENV =
  "WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON";
const S3_ACCESS_ID_ENV = [
  "WORKLIN_RUNTIME_WORKER_STATE_S3",
  "ACCESS",
  "KEY",
  "ID",
].join("_");
const S3_SECRET_ENV = [
  "WORKLIN_RUNTIME_WORKER_STATE_S3",
  "SECRET",
  "ACCESS",
  "KEY",
].join("_");
const S3_REGION_ENV = "WORKLIN_RUNTIME_WORKER_STATE_S3_REGION";
const S3_ENDPOINT_ENV = "WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT";
const S3_URL_STYLE_ENV = "WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE";
const URL_TTL_ENV = "WORKLIN_RUNTIME_WORKER_STATE_SIGNED_URL_TTL_SECONDS";
const REQUEST_TIMEOUT_ENV = "WORKLIN_RUNTIME_WORKER_STATE_REQUEST_TIMEOUT_MS";
const MAX_RECEIPT_BYTES_ENV = "WORKLIN_RUNTIME_WORKER_STATE_MAX_RECEIPT_BYTES";
const MAX_OBJECT_BYTES_ENV = "WORKLIN_RUNTIME_WORKER_STATE_MAX_OBJECT_BYTES";
const ARCHIVE_OVERHEAD_BYTES_ENV =
  "WORKLIN_RUNTIME_WORKER_STATE_ARCHIVE_OVERHEAD_BYTES";
const TENANT_STORAGE_QUOTA_BYTES_ENV = "WORKLIN_TENANT_STORAGE_QUOTA_BYTES";

const DEFAULT_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_RECEIPT_BYTES = 1 * 1024 * 1024;
export const DEFAULT_RUNTIME_WORKER_ARCHIVE_OVERHEAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_TENANT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
const ABSOLUTE_MAX_OBJECT_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const CONTENT_TYPE = "application/octet-stream";
const GCS_HOST = "storage.googleapis.com";
const GCS_SCOPE_SERVICE = "storage";
const GCS_SCOPE_REGION = "auto";
const GCS_ALGORITHM = "GOOG4-RSA-SHA256";
const GCS_REQUEST_TYPE = "goog4_request";

export const RUNTIME_WORKER_STATE_ROUTE_CONTRACT = Object.freeze({
  export: "/v1/internal/pooled-worker/state/export",
  restore: "/v1/internal/pooled-worker/state/restore",
  prepareEmpty: "/v1/internal/pooled-worker/state/prepare-empty",
  sanitize: "/v1/internal/pooled-worker/state/sanitize",
  revoke: "/v1/internal/pooled-worker/lease/revoke",
});

export type RuntimeWorkerStateTransportOperation =
  | "export"
  | "restore"
  | "prepare_empty"
  | "sanitize"
  | "revoke";

/**
 * Providers the pooled worker can configure structurally before its first
 * request. The control plane sends only this non-secret provider label; the
 * request-scoped credential capability remains the only way to resolve the
 * corresponding API key.
 */
export const RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS = Object.freeze([
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openrouter",
] as const);

export type RuntimeWorkerBootstrapInferenceProvider =
  (typeof RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS)[number];

const BOOTSTRAP_INFERENCE_PROVIDER_SET = new Set<string>(
  RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS,
);

export interface RuntimeWorkerLeaseAuthorization {
  bearerToken: string;
  expiresAtMs: number;
  binding: RuntimeWorkerLeaseServiceBinding;
  stack: RuntimeWorkerStackRow;
}

export type RuntimeWorkerLeaseAuthorizationProvider = (input: {
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  operation: RuntimeWorkerStateTransportOperation;
}) => Promise<RuntimeWorkerLeaseAuthorization>;

interface GcsServiceAccount {
  clientEmail: string;
  signingMaterial: KeyObject;
}

export interface RuntimeWorkerProductionTransportConfig {
  provider: RuntimeWorkerStateProvider;
  bucket: string;
  endpoint?: string;
  region?: string;
  urlStyle?: S3UrlStyle;
  signedUrlTtlSeconds: number;
  requestTimeoutMs: number;
  maxReceiptBytes: number;
  maxObjectBytes: number;
  workspaceArchiveOverheadBytes: number;
}

export interface RuntimeWorkerWorkspaceStorageLimits {
  defaultWorkspaceQuotaBytes: number;
  workspaceArchiveOverheadBytes: number;
  maxObjectBytes: number;
}

export interface RuntimeWorkerProductionTransportDependencies {
  authorizeLease: RuntimeWorkerLeaseAuthorizationProvider;
  resolveBootstrapInferenceProvider?: (
    authorization: RuntimeWorkerLeaseAuthorization,
  ) => RuntimeWorkerBootstrapInferenceProvider | null;
  resolveWorkspaceQuotaBytes?: (
    authorization: RuntimeWorkerLeaseAuthorization,
  ) => number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface ParsedProductionTransportConfig {
  publicConfig: RuntimeWorkerProductionTransportConfig;
  signer: StateObjectUrlSigner;
}

type S3UrlStyle = "path" | "virtual";

interface StateObjectSignInput {
  method: "GET" | "HEAD" | "PUT";
  objectKey: string;
  expiresSeconds: number;
  now: Date;
  contentType?: typeof CONTENT_TYPE;
}

type StateObjectUrlSigner = (input: StateObjectSignInput) => URL;
type GcsV4SignInput = StateObjectSignInput & { bucket: string };

interface RequestJsonInput {
  tenant: RuntimeWorkerStateTenant;
  workerStackId: string;
  operation: RuntimeWorkerStateTransportOperation;
  leaseGeneration: number;
  route: string;
  body:
    | Readonly<Record<string, unknown>>
    | ((
        authorization: RuntimeWorkerLeaseAuthorization,
      ) => Readonly<Record<string, unknown>>);
}

export function runtimeWorkerProductionTransportConfigFromEnv(
  rawEnv: EnvLike,
): RuntimeWorkerProductionTransportConfig | null {
  return parseProductionTransportConfig(rawEnv)?.publicConfig ?? null;
}

export function createRuntimeWorkerProductionTransportFromEnv(
  rawEnv: EnvLike,
  dependencies: RuntimeWorkerProductionTransportDependencies,
): RuntimeWorkerProductionTransport | null {
  const parsed = parseProductionTransportConfig(rawEnv);
  if (!parsed) return null;
  return createRuntimeWorkerProductionTransport(
    parsed.publicConfig,
    parsed.signer,
    dependencies,
  );
}

function createRuntimeWorkerProductionTransport(
  config: RuntimeWorkerProductionTransportConfig,
  signer: StateObjectUrlSigner,
  dependencies: RuntimeWorkerProductionTransportDependencies,
): RuntimeWorkerProductionTransport {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const requestJson = createWorkerRequestJson(
    config,
    dependencies.authorizeLease,
    fetchImpl,
    now,
  );

  const transport: RuntimeWorkerProductionTransport = {
    exportRedactedVBundle: async (input) => {
      assertTransportConstants(
        input.provider,
        config.provider,
        input.credentialPolicy,
      );
      assertBucketBinding(input.bucket, config.bucket);
      assertGeneration(input.leaseGeneration, "lease");
      assertGeneration(input.stateGeneration, "state");
      const observedStateGeneration = assertTenantObjectKey(
        input.tenant,
        input.objectKey,
      );
      if (observedStateGeneration !== input.stateGeneration) {
        throw new Error(
          "Pooled worker state object does not match its state generation.",
        );
      }
      const uploadUrl = signer({
        method: "PUT",
        objectKey: input.objectKey,
        expiresSeconds: config.signedUrlTtlSeconds,
        now: now(),
        contentType: CONTENT_TYPE,
      });
      const bundleId = buildRuntimeWorkerStateBundleId(
        input.tenant,
        input.stateGeneration,
        config.provider,
      );
      const receipt = parseVBundleReceipt(
        await requestJson({
          tenant: input.tenant,
          workerStackId: input.workerStackId,
          operation: "export",
          leaseGeneration: input.leaseGeneration,
          route: RUNTIME_WORKER_STATE_ROUTE_CONTRACT.export,
          body: (authorization) => ({
            lease_generation: input.leaseGeneration,
            state_generation: input.stateGeneration,
            bundle_id: bundleId,
            created_at: now().toISOString(),
            upload_url: uploadUrl.href,
            ...workspaceLimitBody(config, dependencies, authorization),
          }),
        }),
        config.provider,
      );
      assertReceiptBinding(receipt, input.tenant, input.workerStackId, {
        provider: config.provider,
        bucket: config.bucket,
        objectKey: input.objectKey,
        leaseGeneration: input.leaseGeneration,
        stateGeneration: input.stateGeneration,
      });
      return receipt;
    },

    restoreRedactedVBundle: async (input) => {
      assertCredentialPolicy(input.credentialPolicy);
      assertGeneration(input.leaseGeneration, "lease");
      assertGeneration(input.stateGeneration, "state");
      const observedStateGeneration = assertStateObjectBinding(
        input.tenant,
        input.object,
        config.bucket,
        config.provider,
      );
      if (observedStateGeneration !== input.stateGeneration) {
        throw new Error(
          "Pooled worker state object does not match its state generation.",
        );
      }
      const downloadUrl = signer({
        method: "GET",
        objectKey: input.object.objectKey,
        expiresSeconds: config.signedUrlTtlSeconds,
        now: now(),
      });
      const receipt = parseRestoreReceipt(
        await requestJson({
          tenant: input.tenant,
          workerStackId: input.workerStackId,
          operation: "restore",
          leaseGeneration: input.leaseGeneration,
          route: RUNTIME_WORKER_STATE_ROUTE_CONTRACT.restore,
          body: (authorization) => {
            const inferenceProvider = canonicalBootstrapInferenceProvider(
              dependencies.resolveBootstrapInferenceProvider?.(authorization) ??
                null,
            );
            return {
              lease_generation: input.leaseGeneration,
              state_generation: input.stateGeneration,
              bundle_id: buildRuntimeWorkerStateBundleId(
                input.tenant,
                input.stateGeneration,
                config.provider,
              ),
              download_url: downloadUrl.href,
              checksum_sha256: input.object.checksumSha256,
              byte_size: input.object.byteSize,
              workspace_byte_size: input.expectedWorkspaceByteSize,
              ...workspaceLimitBody(config, dependencies, authorization),
              ...(inferenceProvider
                ? { inference_provider: inferenceProvider }
                : {}),
            };
          },
        }),
        config.provider,
      );
      assertReceiptBinding(receipt, input.tenant, input.workerStackId, {
        provider: config.provider,
        bucket: config.bucket,
        objectKey: input.object.objectKey,
        leaseGeneration: input.leaseGeneration,
        stateGeneration: input.stateGeneration,
      });
      assertSameObject(receipt.object, input.object);
      return receipt;
    },

    prepareEmptyWorkspace: async (input) => {
      assertCredentialPolicy(input.credentialPolicy);
      assertGeneration(input.leaseGeneration, "lease");
      const receipt = parseSanitizeReceipt(
        await requestJson({
          tenant: input.tenant,
          workerStackId: input.workerStackId,
          operation: "prepare_empty",
          leaseGeneration: input.leaseGeneration,
          route: RUNTIME_WORKER_STATE_ROUTE_CONTRACT.prepareEmpty,
          body: (authorization) => {
            const inferenceProvider = canonicalBootstrapInferenceProvider(
              dependencies.resolveBootstrapInferenceProvider?.(authorization) ??
                null,
            );
            return {
              lease_generation: input.leaseGeneration,
              ...workspaceLimitBody(config, dependencies, authorization),
              ...(inferenceProvider
                ? { inference_provider: inferenceProvider }
                : {}),
            };
          },
        }),
      );
      assertSanitizeBinding(
        receipt,
        input.tenant,
        input.workerStackId,
        input.leaseGeneration,
      );
      return receipt;
    },

    headObject: async (input) => {
      assertProvider(input.provider, config.provider);
      assertBucketBinding(input.bucket, config.bucket);
      assertStateObjectKey(input.objectKey);
      return verifyRemoteObject({
        config,
        signer,
        fetchImpl,
        now,
        objectKey: input.objectKey,
      });
    },

    sanitizeWorkspace: async (input) => {
      assertCredentialPolicy(input.credentialPolicy);
      assertGeneration(input.leaseGeneration, "lease");
      const receipt = parseSanitizeReceipt(
        await requestJson({
          tenant: input.tenant,
          workerStackId: input.workerStackId,
          operation: "sanitize",
          leaseGeneration: input.leaseGeneration,
          route: RUNTIME_WORKER_STATE_ROUTE_CONTRACT.sanitize,
          body: {
            lease_generation: input.leaseGeneration,
          },
        }),
      );
      assertSanitizeBinding(
        receipt,
        input.tenant,
        input.workerStackId,
        input.leaseGeneration,
      );
      return receipt;
    },

    revokeLeaseAuthority: async (input) => {
      assertGeneration(input.leaseGeneration, "lease");
      const receipt = parseLeaseRevokeReceipt(
        await requestJson({
          tenant: input.tenant,
          workerStackId: input.workerStackId,
          operation: "revoke",
          leaseGeneration: input.leaseGeneration,
          route: RUNTIME_WORKER_STATE_ROUTE_CONTRACT.revoke,
          body: {
            worker_stack_id: input.workerStackId,
            lease_generation: input.leaseGeneration,
          },
        }),
      );
      if (
        receipt.workerStackId !== input.workerStackId ||
        receipt.leaseGeneration !== input.leaseGeneration
      ) {
        throw new Error(
          "Pooled worker lease revocation receipt does not match.",
        );
      }
      return receipt;
    },
  };
  return Object.freeze(transport);
}

function parseProductionTransportConfig(
  rawEnv: EnvLike,
): ParsedProductionTransportConfig | null {
  const enabled = rawEnv[ENABLE_ENV];
  if (enabled === undefined || enabled.trim() === "") return null;
  const normalized = enabled.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return null;
  if (!["1", "true", "yes", "on"].includes(normalized)) {
    throw new Error(`${ENABLE_ENV} must be a boolean.`);
  }

  const provider = configuredStateProvider(rawEnv);
  const bucket =
    firstNonEmptyEnv(rawEnv, BUCKET_ENV, provider === "s3" ? "BUCKET" : "") ??
    "";
  assertBucket(bucket);
  const signedUrlTtlSeconds = positiveIntegerEnv(
    URL_TTL_ENV,
    rawEnv[URL_TTL_ENV],
    DEFAULT_URL_TTL_SECONDS,
  );
  if (signedUrlTtlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new Error(`${URL_TTL_ENV} exceeds the signed URL maximum.`);
  }
  const requestTimeoutMs = positiveIntegerEnv(
    REQUEST_TIMEOUT_ENV,
    rawEnv[REQUEST_TIMEOUT_ENV],
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (requestTimeoutMs >= signedUrlTtlSeconds * 1_000) {
    throw new Error(
      `${REQUEST_TIMEOUT_ENV} must be shorter than the signed URL lifetime.`,
    );
  }
  const maxReceiptBytes = positiveIntegerEnv(
    MAX_RECEIPT_BYTES_ENV,
    rawEnv[MAX_RECEIPT_BYTES_ENV],
    DEFAULT_MAX_RECEIPT_BYTES,
  );
  const { workspaceArchiveOverheadBytes, maxObjectBytes } =
    runtimeWorkerWorkspaceStorageLimitsFromEnv(rawEnv);

  const common = {
    provider,
    bucket,
    signedUrlTtlSeconds,
    requestTimeoutMs,
    maxReceiptBytes,
    maxObjectBytes,
    workspaceArchiveOverheadBytes,
  };
  if (provider === "gcs") {
    const serviceAccount = parseServiceAccount(rawEnv[SERVICE_ACCOUNT_ENV]);
    const publicConfig = Object.freeze({
      ...common,
      provider: "gcs" as const,
    });
    return {
      publicConfig,
      signer: (input) =>
        signGcsV4Url(serviceAccount, {
          ...input,
          bucket,
        }),
    };
  }

  const parsedS3 = parseS3Config(rawEnv, bucket);
  const publicConfig = Object.freeze({
    ...common,
    provider: "s3" as const,
    endpoint: parsedS3.endpoint.href,
    region: parsedS3.region,
    urlStyle: parsedS3.urlStyle,
  });
  const client = new S3Client({
    bucket,
    accessKeyId: parsedS3.accessKeyId,
    secretAccessKey: parsedS3.secretAccessKey,
    region: parsedS3.region,
    endpoint: s3ClientEndpoint(parsedS3.endpoint, bucket, parsedS3.urlStyle),
    virtualHostedStyle: parsedS3.urlStyle === "virtual",
  });
  return {
    publicConfig,
    signer: (input) => signS3Url(client, publicConfig, input),
  };
}

export function runtimeWorkerWorkspaceStorageLimitsFromEnv(
  rawEnv: EnvLike,
  minimumWorkspaceQuotaBytes?: number,
): RuntimeWorkerWorkspaceStorageLimits {
  const workspaceArchiveOverheadBytes = positiveIntegerEnv(
    ARCHIVE_OVERHEAD_BYTES_ENV,
    rawEnv[ARCHIVE_OVERHEAD_BYTES_ENV],
    DEFAULT_RUNTIME_WORKER_ARCHIVE_OVERHEAD_BYTES,
  );
  const defaultWorkspaceQuotaBytes = nonNegativeIntegerEnv(
    TENANT_STORAGE_QUOTA_BYTES_ENV,
    rawEnv[TENANT_STORAGE_QUOTA_BYTES_ENV],
    DEFAULT_TENANT_STORAGE_QUOTA_BYTES,
  );
  const requiredQuota = Math.max(
    defaultWorkspaceQuotaBytes,
    minimumWorkspaceQuotaBytes ?? 0,
  );
  if (!Number.isSafeInteger(requiredQuota) || requiredQuota < 0) {
    throw new Error("Pooled worker tenant workspace quota is invalid.");
  }
  const minimumObjectBytes = safeByteSum(
    requiredQuota,
    workspaceArchiveOverheadBytes,
    "Pooled state tenant quota and archive overhead",
  );
  const defaultObjectBytes = safeByteSum(
    defaultWorkspaceQuotaBytes,
    workspaceArchiveOverheadBytes,
    "Pooled state default quota and archive overhead",
  );
  const maxObjectBytes = positiveIntegerEnv(
    MAX_OBJECT_BYTES_ENV,
    rawEnv[MAX_OBJECT_BYTES_ENV],
    defaultObjectBytes,
  );
  if (
    maxObjectBytes < minimumObjectBytes ||
    maxObjectBytes > ABSOLUTE_MAX_OBJECT_BYTES
  ) {
    throw new Error(
      `${MAX_OBJECT_BYTES_ENV} must cover every tenant quota plus archive overhead and stay within the worker hard limit.`,
    );
  }
  return {
    defaultWorkspaceQuotaBytes,
    workspaceArchiveOverheadBytes,
    maxObjectBytes,
  };
}

function configuredStateProvider(rawEnv: EnvLike): RuntimeWorkerStateProvider {
  const explicit = rawEnv[PROVIDER_ENV]?.trim().toLowerCase();
  const hasGcsCredentials = Boolean(rawEnv[SERVICE_ACCOUNT_ENV]?.trim());
  const hasCompleteS3Credentials = Boolean(
    firstNonEmptyEnv(rawEnv, S3_ENDPOINT_ENV, "ENDPOINT") &&
    firstNonEmptyEnv(rawEnv, S3_ACCESS_ID_ENV, "ACCESS_KEY_ID") &&
    firstNonEmptyEnv(rawEnv, S3_SECRET_ENV, "SECRET_ACCESS_KEY"),
  );
  const inferred =
    explicit ||
    (hasGcsCredentials
      ? "gcs"
      : hasCompleteS3Credentials
        ? "s3"
        : RUNTIME_WORKER_STATE_DEFAULT_PROVIDER);
  if (!isRuntimeWorkerStateProvider(inferred)) {
    throw new Error(`${PROVIDER_ENV} must be gcs or s3.`);
  }
  return inferred;
}

function firstNonEmptyEnv(
  rawEnv: EnvLike,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    if (!name) continue;
    const value = rawEnv[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseS3Config(
  rawEnv: EnvLike,
  bucket: string,
): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  endpoint: URL;
  urlStyle: S3UrlStyle;
} {
  const accessKeyId =
    firstNonEmptyEnv(rawEnv, S3_ACCESS_ID_ENV, "ACCESS_KEY_ID") ?? "";
  const secretAccessKey =
    firstNonEmptyEnv(rawEnv, S3_SECRET_ENV, "SECRET_ACCESS_KEY") ?? "";
  const region = firstNonEmptyEnv(rawEnv, S3_REGION_ENV, "REGION") ?? "";
  const endpointValue =
    firstNonEmptyEnv(rawEnv, S3_ENDPOINT_ENV, "ENDPOINT") ?? "";
  const rawStyle =
    firstNonEmptyEnv(
      rawEnv,
      S3_URL_STYLE_ENV,
      "URL_STYLE",
      "AWS_S3_URL_STYLE",
    ) ?? "virtual";
  if (
    !/^[A-Za-z0-9._-]{3,256}$/u.test(accessKeyId) ||
    secretAccessKey.length < 8 ||
    secretAccessKey.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(secretAccessKey)
  ) {
    throw new Error("Railway S3 state credentials are invalid.");
  }
  if (
    !/^[A-Za-z0-9._-]{1,64}$/u.test(region) ||
    (rawStyle !== "path" && rawStyle !== "virtual")
  ) {
    throw new Error("Railway S3 state metadata is invalid.");
  }
  const endpoint = parseS3Endpoint(endpointValue);
  if (rawStyle === "virtual" && bucket.includes(".")) {
    throw new Error(
      "Virtual-hosted Railway S3 buckets must be a single DNS label.",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    region,
    endpoint,
    urlStyle: rawStyle,
  };
}

function parseS3Endpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Railway S3 state endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    !isSafeStorageHostname(endpoint.hostname)
  ) {
    throw new Error("Railway S3 state endpoint is invalid.");
  }
  endpoint.pathname = "/";
  return endpoint;
}

function isSafeStorageHostname(hostname: string): boolean {
  return (
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      hostname,
    ) &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local")
  );
}

function parseServiceAccount(raw: string | undefined): GcsServiceAccount {
  if (!raw?.trim()) {
    throw new Error(`${SERVICE_ACCOUNT_ENV} is required when enabled.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${SERVICE_ACCOUNT_ENV} is invalid.`);
  }
  if (!isRecord(value)) {
    throw new Error(`${SERVICE_ACCOUNT_ENV} is invalid.`);
  }
  const clientEmail = value.client_email;
  const privateKeyPem = value.private_key;
  if (
    typeof clientEmail !== "string" ||
    !/^[^\s@]+@[^\s@]+$/u.test(clientEmail) ||
    clientEmail.length > 320 ||
    typeof privateKeyPem !== "string" ||
    !privateKeyPem.includes("PRIVATE KEY")
  ) {
    throw new Error(`${SERVICE_ACCOUNT_ENV} is invalid.`);
  }
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("not RSA");
    }
    return { clientEmail, signingMaterial: privateKey };
  } catch {
    throw new Error(`${SERVICE_ACCOUNT_ENV} is invalid.`);
  }
}

function positiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function safeByteSum(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} exceed the safe integer limit.`);
  }
  return total;
}

function workspaceLimitBody(
  config: RuntimeWorkerProductionTransportConfig,
  dependencies: RuntimeWorkerProductionTransportDependencies,
  authorization: RuntimeWorkerLeaseAuthorization,
): {
  workspace_quota_bytes: number;
  archive_overhead_bytes: number;
} {
  const workspaceQuotaBytes =
    dependencies.resolveWorkspaceQuotaBytes?.(authorization);
  if (
    workspaceQuotaBytes === undefined ||
    !Number.isSafeInteger(workspaceQuotaBytes) ||
    workspaceQuotaBytes < 0
  ) {
    throw new Error("Pooled worker tenant workspace quota is unavailable.");
  }
  const objectLimit = safeByteSum(
    workspaceQuotaBytes,
    config.workspaceArchiveOverheadBytes,
    "Pooled worker tenant quota and archive overhead",
  );
  if (objectLimit > config.maxObjectBytes) {
    throw new Error(
      "Pooled worker tenant workspace quota exceeds the configured object limit.",
    );
  }
  return {
    workspace_quota_bytes: workspaceQuotaBytes,
    archive_overhead_bytes: config.workspaceArchiveOverheadBytes,
  };
}

function signGcsV4Url(
  serviceAccount: GcsServiceAccount,
  input: GcsV4SignInput,
): URL {
  assertBucket(input.bucket);
  assertStateObjectKey(input.objectKey);
  if (
    !Number.isSafeInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    throw new Error("GCS signed URL lifetime is invalid.");
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("GCS signed URL timestamp is invalid.");
  }
  if (input.method === "PUT" && input.contentType !== CONTENT_TYPE) {
    throw new Error("GCS upload content type is invalid.");
  }
  if (input.method !== "PUT" && input.contentType !== undefined) {
    throw new Error("GCS download must not sign an upload content type.");
  }

  const timestamp = gcsTimestamp(input.now);
  const date = timestamp.slice(0, 8);
  const credentialScope = [
    date,
    GCS_SCOPE_REGION,
    GCS_SCOPE_SERVICE,
    GCS_REQUEST_TYPE,
  ].join("/");
  const signedHeaders = input.method === "PUT" ? "content-type;host" : "host";
  const query = new URLSearchParams({
    "X-Goog-Algorithm": GCS_ALGORITHM,
    "X-Goog-Credential": `${serviceAccount.clientEmail}/${credentialScope}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(input.expiresSeconds),
    "X-Goog-SignedHeaders": signedHeaders,
  });
  query.sort();
  const canonicalUri = `/${encodePathSegment(input.bucket)}/${encodeObjectKey(
    input.objectKey,
  )}`;
  const canonicalHeaders =
    input.method === "PUT"
      ? `content-type:${CONTENT_TYPE}\nhost:${GCS_HOST}\n`
      : `host:${GCS_HOST}\n`;
  const canonicalRequest = [
    input.method,
    canonicalUri,
    query.toString(),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    GCS_ALGORITHM,
    timestamp,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signature = signBytes(
    "RSA-SHA256",
    Buffer.from(stringToSign),
    serviceAccount.signingMaterial,
  ).toString("hex");
  query.set("X-Goog-Signature", signature);
  return new URL(`https://${GCS_HOST}${canonicalUri}?${query.toString()}`);
}

function s3ClientEndpoint(
  endpoint: URL,
  bucket: string,
  urlStyle: S3UrlStyle,
): string {
  if (urlStyle === "path") return endpoint.origin;
  if (
    endpoint.hostname === bucket ||
    endpoint.hostname.startsWith(`${bucket}.`)
  ) {
    return endpoint.origin;
  }
  return `https://${bucket}.${endpoint.hostname}`;
}

function signS3Url(
  client: S3Client,
  config: RuntimeWorkerProductionTransportConfig & {
    provider: "s3";
    endpoint: string;
    region: string;
    urlStyle: S3UrlStyle;
  },
  input: StateObjectSignInput,
): URL {
  assertStateObjectKey(input.objectKey);
  if (
    !Number.isSafeInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > MAX_SIGNED_URL_TTL_SECONDS ||
    Number.isNaN(input.now.getTime())
  ) {
    throw new Error("S3 signed URL lifetime or timestamp is invalid.");
  }
  if (input.method === "PUT" && input.contentType !== CONTENT_TYPE) {
    throw new Error("S3 upload content type is invalid.");
  }
  if (input.method !== "PUT" && input.contentType !== undefined) {
    throw new Error("S3 download must not sign an upload content type.");
  }
  const signed = new URL(
    client.presign(input.objectKey, {
      method: input.method,
      expiresIn: input.expiresSeconds,
      ...(input.contentType ? { type: input.contentType } : {}),
    }),
  );
  assertS3SignedUrl(signed, config, input);
  return signed;
}

function assertS3SignedUrl(
  signed: URL,
  config: RuntimeWorkerProductionTransportConfig & {
    provider: "s3";
    endpoint: string;
    region: string;
    urlStyle: S3UrlStyle;
  },
  input: StateObjectSignInput,
): void {
  const endpoint = parseS3Endpoint(config.endpoint);
  const expectedOrigin = s3ClientEndpoint(
    endpoint,
    config.bucket,
    config.urlStyle,
  );
  const encodedObjectKey = encodeObjectKey(input.objectKey);
  const expectedPath =
    config.urlStyle === "path"
      ? `/${encodePathSegment(config.bucket)}/${encodedObjectKey}`
      : `/${encodedObjectKey}`;
  if (
    signed.protocol !== "https:" ||
    signed.origin !== expectedOrigin ||
    signed.pathname !== expectedPath ||
    signed.username ||
    signed.password ||
    signed.hash ||
    signed.port
  ) {
    throw new Error("S3 signed URL endpoint or object path is invalid.");
  }

  const allowed = new Set([
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
    "response-content-type",
  ]);
  const keys = [...signed.searchParams.keys()];
  if (
    keys.some((key) => !allowed.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw new Error("S3 signed URL query is invalid.");
  }
  const algorithm = signed.searchParams.get("X-Amz-Algorithm");
  const credential = signed.searchParams.get("X-Amz-Credential") ?? "";
  const date = signed.searchParams.get("X-Amz-Date") ?? "";
  const expires = signed.searchParams.get("X-Amz-Expires");
  const signature = signed.searchParams.get("X-Amz-Signature") ?? "";
  const signedHeaders = signed.searchParams.get("X-Amz-SignedHeaders");
  const responseType = signed.searchParams.get("response-content-type");
  const credentialParts = credential.split("/");
  if (
    algorithm !== "AWS4-HMAC-SHA256" ||
    !/^\d{8}T\d{6}Z$/u.test(date) ||
    expires !== String(input.expiresSeconds) ||
    !/^[a-f0-9]{64}$/u.test(signature) ||
    signedHeaders !== "host" ||
    credentialParts.length !== 5 ||
    !credentialParts[0] ||
    credentialParts[1] !== date.slice(0, 8) ||
    credentialParts[2] !== config.region ||
    credentialParts[3] !== "s3" ||
    credentialParts[4] !== "aws4_request" ||
    (responseType !== null && responseType !== CONTENT_TYPE)
  ) {
    throw new Error("S3 signed URL authorization is invalid.");
  }
}

function createWorkerRequestJson(
  config: RuntimeWorkerProductionTransportConfig,
  authorizeLease: RuntimeWorkerLeaseAuthorizationProvider,
  fetchImpl: typeof fetch,
  now: () => Date,
): (input: RequestJsonInput) => Promise<unknown> {
  return async (input) => {
    assertTenant(input.tenant);
    assertOpaqueId(input.workerStackId, "worker stack");
    let authorization: RuntimeWorkerLeaseAuthorization;
    try {
      authorization = await authorizeLease({
        tenant: input.tenant,
        workerStackId: input.workerStackId,
        operation: input.operation,
      });
    } catch {
      throw new Error("Pooled worker lease authorization failed.");
    }
    assertLeaseAuthorization(
      authorization,
      input.tenant,
      input.workerStackId,
      input.leaseGeneration,
      now().getTime(),
    );
    const target = buildWorkerRoute(authorization.stack, input.route);
    const body =
      typeof input.body === "function" ? input.body(authorization) : input.body;
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: "POST",
        redirect: "error",
        signal: timeout,
        headers: {
          Authorization: `Bearer ${authorization.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Pooled worker state request failed.");
    }
    if (response.status !== 200) {
      await discardResponse(response);
      throw new Error(
        `Pooled worker state request failed with status ${response.status}.`,
      );
    }
    if (
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      await discardResponse(response);
      throw new Error("Pooled worker state receipt content type is invalid.");
    }
    return readBoundedJson(response, config.maxReceiptBytes);
  };
}

function canonicalBootstrapInferenceProvider(
  value: unknown,
): RuntimeWorkerBootstrapInferenceProvider | null {
  if (value === null || value === undefined) return null;
  if (!isRuntimeWorkerBootstrapInferenceProvider(value)) {
    throw new Error("Pooled worker bootstrap inference provider is invalid.");
  }
  return value;
}

export function isRuntimeWorkerBootstrapInferenceProvider(
  value: unknown,
): value is RuntimeWorkerBootstrapInferenceProvider {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    BOOTSTRAP_INFERENCE_PROVIDER_SET.has(value)
  );
}

function assertLeaseAuthorization(
  authorization: RuntimeWorkerLeaseAuthorization,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  leaseGeneration: number,
  nowMs: number,
): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !authorization ||
    typeof authorization.bearerToken !== "string" ||
    !/^[A-Za-z0-9._~-]+$/u.test(authorization.bearerToken) ||
    !Number.isSafeInteger(authorization.expiresAtMs) ||
    authorization.expiresAtMs <= nowMs
  ) {
    throw new Error("Pooled worker lease authorization is invalid.");
  }
  const { binding, stack } = authorization;
  if (
    binding.organizationId !== tenant.orgId ||
    binding.assistantId !== tenant.assistantId ||
    binding.workerStackId !== workerStackId ||
    binding.leaseGeneration !== leaseGeneration ||
    !Number.isSafeInteger(binding.leaseExpiresAtMs) ||
    binding.leaseExpiresAtMs <= nowMs ||
    authorization.expiresAtMs > binding.leaseExpiresAtMs ||
    stack.id !== workerStackId ||
    stack.provider !== RUNTIME_WORKER_POOL_PROVIDER ||
    stack.status !== "active" ||
    !stack.gateway_url ||
    !stack.service_ref
  ) {
    throw new Error(
      "Pooled worker lease authorization does not match the request.",
    );
  }
}

function buildWorkerRoute(stack: RuntimeWorkerStackRow, route: string): URL {
  let gateway: URL;
  try {
    gateway = new URL(stack.gateway_url ?? "");
  } catch {
    throw new Error("Pooled worker gateway URL is invalid.");
  }
  if (
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    (gateway.pathname !== "/" && gateway.pathname !== "")
  ) {
    throw new Error("Pooled worker gateway URL is invalid.");
  }
  const railwayPrivateHttp =
    gateway.protocol === "http:" &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+railway\.internal$/u.test(
      gateway.hostname,
    ) &&
    /^[1-9]\d{0,4}$/u.test(gateway.port) &&
    Number(gateway.port) <= 65_535;
  if (gateway.protocol !== "https:" && !railwayPrivateHttp) {
    throw new Error("Pooled worker gateway URL is invalid.");
  }
  if (!route.startsWith("/v1/internal/")) {
    throw new Error("Pooled worker state route is invalid.");
  }
  return new URL(route, gateway);
}

async function verifyRemoteObject(input: {
  config: RuntimeWorkerProductionTransportConfig;
  signer: StateObjectUrlSigner;
  fetchImpl: typeof fetch;
  now: () => Date;
  objectKey: string;
}): Promise<RuntimeWorkerObjectHead | null> {
  const headUrl = input.signer({
    method: "HEAD",
    objectKey: input.objectKey,
    expiresSeconds: input.config.signedUrlTtlSeconds,
    now: input.now(),
  });
  let head: Response;
  try {
    head = await input.fetchImpl(headUrl, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(input.config.requestTimeoutMs),
    });
  } catch {
    throw new Error("Pooled state object verification failed.");
  }
  if (head.status === 404) {
    await discardResponse(head);
    return null;
  }
  if (head.status !== 200) {
    await discardResponse(head);
    throw new Error(
      `Pooled state object verification failed with status ${head.status}.`,
    );
  }
  const byteSize = parseContentLength(
    head.headers.get("content-length"),
    input.config.maxObjectBytes,
  );
  assertExactContentType(head.headers.get("content-type"));
  await discardResponse(head);

  const getUrl = input.signer({
    method: "GET",
    objectKey: input.objectKey,
    expiresSeconds: input.config.signedUrlTtlSeconds,
    now: input.now(),
  });
  let response: Response;
  try {
    response = await input.fetchImpl(getUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(input.config.requestTimeoutMs),
    });
  } catch {
    throw new Error("Pooled state object verification failed.");
  }
  if (response.status !== 200) {
    await discardResponse(response);
    throw new Error(
      `Pooled state object verification failed with status ${response.status}.`,
    );
  }
  assertExactContentType(response.headers.get("content-type"));
  const responseLength = parseContentLength(
    response.headers.get("content-length"),
    input.config.maxObjectBytes,
  );
  if (responseLength !== byteSize) {
    await discardResponse(response);
    throw new Error("Pooled state object size verification failed.");
  }
  const hashed = await hashResponseBody(response, input.config.maxObjectBytes);
  if (hashed.byteSize !== byteSize) {
    throw new Error("Pooled state object size verification failed.");
  }
  return {
    provider: input.config.provider,
    bucket: input.config.bucket,
    objectKey: input.objectKey,
    checksumSha256: hashed.checksumSha256,
    byteSize,
    contentType: CONTENT_TYPE,
  };
}

async function hashResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ checksumSha256: string; byteSize: number }> {
  if (!response.body) {
    throw new Error("Pooled state object body is unavailable.");
  }
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteSize += result.value.byteLength;
      if (byteSize > maxBytes) {
        throw new Error("Pooled state object exceeds the configured limit.");
      }
      hash.update(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.startsWith("Pooled state")) {
      throw error;
    }
    throw new Error("Pooled state object verification failed.");
  } finally {
    reader.releaseLock();
  }
  return { checksumSha256: hash.digest("hex"), byteSize };
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await discardResponse(response);
    throw new Error(
      "Pooled worker state receipt exceeds the configured limit.",
    );
  }
  if (!response.body) {
    throw new Error("Pooled worker state receipt is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        throw new Error(
          "Pooled worker state receipt exceeds the configured limit.",
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.startsWith("Pooled worker")) {
      throw error;
    }
    throw new Error("Pooled worker state receipt could not be read.");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      ),
    );
  } catch {
    throw new Error("Pooled worker state receipt is invalid.");
  }
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function parseVBundleReceipt(
  value: unknown,
  provider: RuntimeWorkerStateProvider,
): RuntimeWorkerVBundleReceipt {
  const record = requireExactRecord(value, [
    "tenant",
    "workerStackId",
    "leaseGeneration",
    "stateGeneration",
    "object",
    "workspaceByteSize",
    "entries",
    "credentialsIncluded",
    "secretsRedacted",
  ]);
  const tenant = parseTenant(record.tenant);
  const workerStackId = requireString(record.workerStackId, "worker stack");
  const object = parseStateObject(record.object, provider);
  if (!Array.isArray(record.entries)) {
    throw new Error("Pooled worker state receipt entries are invalid.");
  }
  const entries = record.entries.map(parseVBundleEntry);
  const workspaceByteSize = requireNonNegativeSafeInteger(
    record.workspaceByteSize,
    "workspace size",
  );
  const summedWorkspaceBytes = entries.reduce(
    (total, entry) =>
      safeByteSum(total, entry.byteSize, "Pooled worker workspace entries"),
    0,
  );
  if (workspaceByteSize !== summedWorkspaceBytes) {
    throw new Error(
      "Pooled worker state receipt workspace size does not match its entries.",
    );
  }
  if (record.credentialsIncluded !== 0 || record.secretsRedacted !== true) {
    throw new Error("Pooled worker state receipt redaction is invalid.");
  }
  return {
    tenant,
    workerStackId,
    leaseGeneration: requirePositiveSafeInteger(
      record.leaseGeneration,
      "lease generation",
    ),
    stateGeneration: requirePositiveSafeInteger(
      record.stateGeneration,
      "state generation",
    ),
    object,
    workspaceByteSize,
    entries,
    credentialsIncluded: 0,
    secretsRedacted: true,
  };
}

function parseRestoreReceipt(
  value: unknown,
  provider: RuntimeWorkerStateProvider,
): RuntimeWorkerRestoreReceipt {
  const record = requireExactRecord(value, [
    "status",
    "tenant",
    "workerStackId",
    "leaseGeneration",
    "stateGeneration",
    "object",
    "workspaceByteSize",
    "filesRestored",
    "credentialsImported",
    "secretsMaterialized",
  ]);
  if (record.status !== "restored") {
    throw new Error("Pooled worker state restore status is invalid.");
  }
  if (
    record.credentialsImported !== 0 ||
    record.secretsMaterialized !== false
  ) {
    throw new Error("Pooled worker state restore redaction is invalid.");
  }
  return {
    status: "restored",
    tenant: parseTenant(record.tenant),
    workerStackId: requireString(record.workerStackId, "worker stack"),
    leaseGeneration: requirePositiveSafeInteger(
      record.leaseGeneration,
      "lease generation",
    ),
    stateGeneration: requirePositiveSafeInteger(
      record.stateGeneration,
      "state generation",
    ),
    object: parseStateObject(record.object, provider),
    workspaceByteSize: requireNonNegativeSafeInteger(
      record.workspaceByteSize,
      "workspace size",
    ),
    filesRestored: requireNonNegativeSafeInteger(
      record.filesRestored,
      "restored file count",
    ),
    credentialsImported: 0,
    secretsMaterialized: false,
  };
}

function parseSanitizeReceipt(value: unknown): RuntimeWorkerSanitizeReceipt {
  const record = requireExactRecord(value, [
    "status",
    "tenant",
    "workerStackId",
    "leaseGeneration",
    "remainingTenantPaths",
    "credentialsTouched",
  ]);
  if (
    record.status !== "prepared_empty" &&
    record.status !== "sanitized" &&
    record.status !== "already_sanitized"
  ) {
    throw new Error("Pooled worker sanitization receipt status is invalid.");
  }
  if (
    record.remainingTenantPaths !== 0 ||
    record.credentialsTouched !== false
  ) {
    throw new Error("Pooled worker sanitization receipt is invalid.");
  }
  return {
    status: record.status,
    tenant: parseTenant(record.tenant),
    workerStackId: requireString(record.workerStackId, "worker stack"),
    leaseGeneration: requirePositiveSafeInteger(
      record.leaseGeneration,
      "lease generation",
    ),
    remainingTenantPaths: 0,
    credentialsTouched: false,
  };
}

function parseLeaseRevokeReceipt(
  value: unknown,
): RuntimeWorkerLeaseRevokeReceipt {
  const record = requireExactRecord(value, [
    "status",
    "worker_stack_id",
    "lease_generation",
  ]);
  if (record.status !== "revoked" && record.status !== "already_revoked") {
    throw new Error("Pooled worker lease revocation status is invalid.");
  }
  return {
    status: record.status,
    workerStackId: requireString(record.worker_stack_id, "worker stack"),
    leaseGeneration: requirePositiveSafeInteger(
      record.lease_generation,
      "lease generation",
    ),
  };
}

function parseTenant(value: unknown): RuntimeWorkerStateTenant {
  const record = requireExactRecord(value, ["orgId", "assistantId"]);
  const tenant = {
    orgId: requireString(record.orgId, "organization"),
    assistantId: requireString(record.assistantId, "assistant"),
  };
  assertTenant(tenant);
  return tenant;
}

function parseStateObject(
  value: unknown,
  provider: RuntimeWorkerStateProvider,
): RuntimeWorkerStateObject {
  const record = requireExactRecord(value, [
    "provider",
    "bucket",
    "objectKey",
    "checksumSha256",
    "byteSize",
    "format",
  ]);
  if (
    record.provider !== provider ||
    record.format !== RUNTIME_WORKER_STATE_FORMAT
  ) {
    throw new Error("Pooled worker state receipt object is invalid.");
  }
  const object: RuntimeWorkerStateObject = {
    provider,
    bucket: requireString(record.bucket, "bucket"),
    objectKey: requireString(record.objectKey, "object key"),
    checksumSha256: requireChecksum(record.checksumSha256),
    byteSize: requirePositiveSafeInteger(record.byteSize, "object size"),
    format: RUNTIME_WORKER_STATE_FORMAT,
  };
  assertBucket(object.bucket);
  assertStateObjectKey(object.objectKey);
  return object;
}

function parseVBundleEntry(value: unknown): RuntimeWorkerVBundleEntry {
  const record = requireExactRecord(value, [
    "path",
    "kind",
    "checksumSha256",
    "byteSize",
  ]);
  if (record.kind !== "file") {
    throw new Error("Pooled worker state receipt entry is invalid.");
  }
  return {
    path: requireString(record.path, "entry path"),
    kind: "file",
    checksumSha256: requireChecksum(record.checksumSha256),
    byteSize: requireNonNegativeSafeInteger(record.byteSize, "entry size"),
  };
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Pooled worker state receipt is invalid.");
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Pooled worker state receipt schema is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Pooled worker state ${label} is invalid.`);
  }
  assertOpaqueId(value, label);
  return value;
}

function requireChecksum(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.toLowerCase())
  ) {
    throw new Error("Pooled worker state checksum is invalid.");
  }
  return value.toLowerCase();
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Pooled worker state ${label} is invalid.`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Pooled worker state ${label} is invalid.`);
  }
  return value as number;
}

function assertGeneration(value: number, kind: "lease" | "state"): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Pooled worker ${kind} generation is invalid.`);
  }
}

function assertReceiptBinding(
  receipt: RuntimeWorkerVBundleReceipt | RuntimeWorkerRestoreReceipt,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  expected: {
    provider: RuntimeWorkerStateProvider;
    bucket: string;
    objectKey: string;
    leaseGeneration: number;
    stateGeneration: number;
  },
): void {
  if (
    receipt.tenant.orgId !== tenant.orgId ||
    receipt.tenant.assistantId !== tenant.assistantId
  ) {
    throw new Error("Pooled worker state receipt belongs to another tenant.");
  }
  if (receipt.workerStackId !== workerStackId) {
    throw new Error("Pooled worker state receipt belongs to another worker.");
  }
  if (
    receipt.leaseGeneration !== expected.leaseGeneration ||
    receipt.stateGeneration !== expected.stateGeneration
  ) {
    throw new Error(
      "Pooled worker state receipt does not match its lease and state generations.",
    );
  }
  assertStateObjectBinding(
    tenant,
    receipt.object,
    expected.bucket,
    expected.provider,
  );
  if (receipt.object.objectKey !== expected.objectKey) {
    throw new Error(
      "Pooled worker state receipt is outside the expected generation.",
    );
  }
  const observedGeneration = assertStateObjectKey(receipt.object.objectKey);
  if (observedGeneration !== expected.stateGeneration) {
    throw new Error(
      "Pooled worker state receipt is outside the expected generation.",
    );
  }
}

function assertSanitizeBinding(
  receipt: RuntimeWorkerSanitizeReceipt,
  tenant: RuntimeWorkerStateTenant,
  workerStackId: string,
  leaseGeneration: number,
): void {
  if (
    receipt.tenant.orgId !== tenant.orgId ||
    receipt.tenant.assistantId !== tenant.assistantId ||
    receipt.workerStackId !== workerStackId ||
    receipt.leaseGeneration !== leaseGeneration
  ) {
    throw new Error(
      "Pooled worker sanitization receipt does not match its tenant, worker, or lease generation.",
    );
  }
}

function assertSameObject(
  actual: RuntimeWorkerStateObject,
  expected: RuntimeWorkerStateObject,
): void {
  if (
    actual.provider !== expected.provider ||
    actual.bucket !== expected.bucket ||
    actual.objectKey !== expected.objectKey ||
    actual.checksumSha256 !== expected.checksumSha256.toLowerCase() ||
    actual.byteSize !== expected.byteSize ||
    actual.format !== expected.format
  ) {
    throw new Error(
      "Pooled worker state receipt object metadata does not match.",
    );
  }
}

function assertStateObjectBinding(
  tenant: RuntimeWorkerStateTenant,
  object: RuntimeWorkerStateObject,
  bucket: string,
  provider: RuntimeWorkerStateProvider,
): number {
  assertTenant(tenant);
  assertBucketBinding(object.bucket, bucket);
  assertProvider(object.provider, provider);
  if (object.format !== RUNTIME_WORKER_STATE_FORMAT) {
    throw new Error("Pooled worker state format is invalid.");
  }
  requireChecksum(object.checksumSha256);
  requirePositiveSafeInteger(object.byteSize, "object size");
  return assertTenantObjectKey(tenant, object.objectKey);
}

function assertTenantObjectKey(
  tenant: RuntimeWorkerStateTenant,
  objectKey: string,
): number {
  assertTenant(tenant);
  const generation = assertStateObjectKey(objectKey);
  if (buildRuntimeWorkerStateObjectKey(tenant, generation) !== objectKey) {
    throw new Error(
      "Pooled worker state object is outside the tenant namespace.",
    );
  }
  return generation;
}

function assertStateObjectKey(objectKey: string): number {
  if (
    !objectKey ||
    objectKey !== objectKey.trim() ||
    objectKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(objectKey)
  ) {
    throw new Error("Pooled worker state object key is invalid.");
  }
  const match =
    /^tenant-state\/([^/]+)\/([^/]+)\/generation-([1-9]\d*)\.vbundle$/u.exec(
      objectKey,
    );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error("Pooled worker state object key is invalid.");
  }
  for (const encoded of [match[1], match[2]]) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new Error("Pooled worker state object key is invalid.");
    }
    if (!decoded || encodeURIComponent(decoded) !== encoded) {
      throw new Error("Pooled worker state object key is not canonical.");
    }
    if (decoded === "." || decoded === "..") {
      throw new Error("Pooled worker state object key is invalid.");
    }
    assertOpaqueId(decoded, "tenant");
  }
  const generation = Number(match[3]);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Pooled worker state generation is invalid.");
  }
  return generation;
}

function assertTransportConstants(
  provider: string,
  expectedProvider: RuntimeWorkerStateProvider,
  credentialPolicy: string,
): void {
  assertProvider(provider, expectedProvider);
  assertCredentialPolicy(credentialPolicy);
}

function assertProvider(
  provider: string,
  expectedProvider: RuntimeWorkerStateProvider,
): void {
  if (provider !== expectedProvider) {
    throw new Error("Pooled worker state provider is invalid.");
  }
}

function assertCredentialPolicy(policy: string): void {
  if (policy !== RUNTIME_WORKER_STATE_CREDENTIAL_POLICY) {
    throw new Error("Pooled worker credential exclusion policy is required.");
  }
}

function assertBucketBinding(actual: string, expected: string): void {
  assertBucket(actual);
  assertBucket(expected);
  if (actual !== expected) {
    throw new Error("Pooled worker state bucket does not match.");
  }
}

function assertTenant(tenant: RuntimeWorkerStateTenant): void {
  assertOpaqueId(tenant.orgId, "organization");
  assertOpaqueId(tenant.assistantId, "assistant");
}

function assertOpaqueId(value: string, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Pooled worker state ${label} id is invalid.`);
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

function assertExactContentType(contentType: string | null): void {
  if (contentType !== CONTENT_TYPE) {
    throw new Error("Pooled state object content type is invalid.");
  }
}

function parseContentLength(value: string | null, maximum: number): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) {
    throw new Error("Pooled state object size is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error("Pooled state object size exceeds the configured limit.");
  }
  return parsed;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function gcsTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]|\.\d{3}/gu, "")
    .replace(/Z$/u, "Z");
}
