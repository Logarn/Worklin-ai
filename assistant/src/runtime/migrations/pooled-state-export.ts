import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { sanitizeConfigForTransfer } from "../../config/sanitize-for-transfer.js";
import type { AuthContext } from "../auth/types.js";
import {
  streamExportVBundle,
  type StreamExportVBundleResult,
} from "./vbundle-builder.js";
import type { ManifestType } from "./vbundle-validator.js";

const POOLED_SKIP_DIRS = [
  "credentials",
  "secrets",
  "gateway-secrets",
  "data/credentials",
  "data/secrets",
  "logs",
] as const;

const POOLED_SKIP_FILES = [
  ".gateway.key",
  ".runtime-token",
  "guardian-token.json",
] as const;

export interface VerifiedPooledStateServiceContext {
  organizationId: string;
  assistantId: string;
  serviceId: "gateway";
  requestId: string;
}

export interface PooledStateExportInput {
  authContext: AuthContext;
  workspaceDir: string;
  workerStackId: string;
  generation: number;
  bundleId: string;
  createdAt: Date;
  assistantName: string;
  runtimeVersion: string;
  checkpoint?: () => void | Promise<void>;
}

export interface PooledStateFileReceipt {
  path: string;
  checksumSha256: string;
  byteSize: number;
}

export interface PooledStateExportReceipt {
  tenant: {
    organizationId: string;
    assistantId: string;
  };
  workerStackId: string;
  generation: number;
  bundleId: string;
  createdAt: string;
  files: readonly PooledStateFileReceipt[];
  checksumSha256: string;
  manifestChecksumSha256: string;
  byteSize: number;
  credentialsIncluded: 0;
  secretsRedacted: true;
}

export interface PooledStateExportArtifact {
  tempPath: string;
  manifest: ManifestType;
  receipt: PooledStateExportReceipt;
  cleanup: () => Promise<void>;
}

/**
 * Build a credential-free workspace snapshot for the pooled-worker transport.
 *
 * This is intentionally not a public migration route. The caller must pass
 * an AuthContext produced by verified JWT middleware; only a gateway service
 * token with a signed tenant binding and internal.write is accepted.
 */
export async function exportPooledWorkerState(
  input: PooledStateExportInput,
): Promise<PooledStateExportArtifact> {
  const service = requireVerifiedPooledStateServiceContext(input.authContext);
  assertExportInput(input);

  let result: StreamExportVBundleResult | undefined;
  try {
    result = await streamExportVBundle({
      assistant: {
        id: service.assistantId,
        name: input.assistantName,
        runtime_version: input.runtimeVersion,
      },
      origin: {
        mode: "managed",
      },
      compatibility: {
        min_runtime_version: input.runtimeVersion,
        max_runtime_version: null,
      },
      exportOptions: {
        include_logs: false,
        include_browser_state: false,
        include_memory_vectors: false,
      },
      secretsRedacted: true,
      workspaceDir: input.workspaceDir,
      checkpoint: input.checkpoint,
      credentials: [],
      additionalSkipDirs: POOLED_SKIP_DIRS,
      additionalSkipFiles: POOLED_SKIP_FILES,
      rejectSymlinks: true,
      bundleId: input.bundleId,
      createdAt: input.createdAt,
      tarMtimeSeconds: Math.floor(input.createdAt.getTime() / 1000),
      sortEntries: true,
      configSanitizer: sanitizePooledStateConfig,
    });

    const files = validatePooledManifest(result.manifest);
    const checksumSha256 = await hashFileSha256(result.tempPath);
    return {
      tempPath: result.tempPath,
      manifest: result.manifest,
      receipt: {
        tenant: {
          organizationId: service.organizationId,
          assistantId: service.assistantId,
        },
        workerStackId: input.workerStackId,
        generation: input.generation,
        bundleId: result.manifest.bundle_id,
        createdAt: result.manifest.created_at,
        files,
        checksumSha256,
        manifestChecksumSha256: result.manifest.checksum,
        byteSize: result.size,
        credentialsIncluded: 0,
        secretsRedacted: true,
      },
      cleanup: result.cleanup,
    };
  } catch (error) {
    await result?.cleanup().catch(() => {});
    throw error;
  }
}

export function requireVerifiedPooledStateServiceContext(
  authContext: AuthContext,
): VerifiedPooledStateServiceContext {
  const service = authContext.serviceTenantContext;
  if (
    authContext.principalType !== "svc_gateway" ||
    authContext.scopeProfile !== "gateway_service_v1" ||
    !authContext.scopes.has("internal.write") ||
    authContext.subject !== "svc:gateway:self" ||
    !service ||
    service.version !== 1 ||
    service.serviceId !== "gateway" ||
    !service.organizationId ||
    !service.assistantId ||
    !service.requestId
  ) {
    throw new Error(
      "Verified gateway tenant context is required for pooled state export.",
    );
  }
  return {
    organizationId: assertOpaqueId(service.organizationId, "organization"),
    assistantId: assertOpaqueId(service.assistantId, "assistant"),
    serviceId: "gateway",
    requestId: assertOpaqueId(service.requestId, "request"),
  };
}

export function sanitizePooledStateConfig(configJson: string): string {
  const transferred = sanitizeConfigForTransfer(configJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(transferred);
  } catch {
    throw new Error("Pooled state export rejected invalid workspace config.");
  }
  return `${JSON.stringify(stripSecretConfigValues(parsed), null, 2)}\n`;
}

function stripSecretConfigValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSecretConfigValues(entry));
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretConfigKey(key)) continue;
    output[key] = stripSecretConfigValues(entry);
  }
  return output;
}

function isSecretConfigKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    compact.includes("password") ||
    compact.endsWith("secret") ||
    compact.endsWith("apikey") ||
    compact.endsWith("privatekey") ||
    compact.endsWith("signingkey") ||
    compact.endsWith("credential") ||
    compact.endsWith("accesstoken") ||
    compact.endsWith("refreshtoken") ||
    compact.endsWith("token")
  );
}

function validatePooledManifest(
  manifest: ManifestType,
): readonly PooledStateFileReceipt[] {
  if (!manifest.secrets_redacted) {
    throw new Error("Pooled state manifest must be secret-redacted.");
  }
  const files = manifest.contents.map((entry) => {
    if (entry.link_target !== undefined) {
      throw new Error("Pooled state export rejected a symlink entry.");
    }
    assertSafeWorkspacePath(entry.path);
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error("Pooled state manifest contains an invalid checksum.");
    }
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0) {
      throw new Error("Pooled state manifest contains an invalid file size.");
    }
    return {
      path: entry.path,
      checksumSha256: entry.sha256,
      byteSize: entry.size_bytes,
    };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function assertSafeWorkspacePath(path: string): void {
  const normalized = path.replace(/\\/gu, "/");
  if (
    path !== path.trim() ||
    path.length > 4_096 ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000")
  ) {
    throw new Error("Pooled state export contains an invalid workspace path.");
  }
  const segments = decodedSegments(normalized);
  if (
    segments[0] !== "workspace" ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f]/u.test(segment),
    ) ||
    segments.some((segment) =>
      [
        "credentials",
        "secrets",
        "gateway-secrets",
        ".backup.key",
        ".gateway.key",
        ".runtime-token",
        "guardian-token.json",
      ].includes(segment.toLowerCase()),
    )
  ) {
    throw new Error(
      "Pooled state export contains traversal or a secret namespace.",
    );
  }
}

function decodedSegments(path: string): string[] {
  const output: string[] = [];
  for (const rawSegment of path.split("/")) {
    let segment = rawSegment;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const decoded = decodeURIComponent(segment);
        if (decoded === segment) break;
        segment = decoded;
      } catch {
        throw new Error(
          "Pooled state export contains malformed path encoding.",
        );
      }
    }
    let furtherDecoded: string;
    try {
      furtherDecoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Pooled state export contains malformed path encoding.");
    }
    if (furtherDecoded !== segment) {
      throw new Error("Pooled state export contains excessive path encoding.");
    }
    output.push(...segment.replace(/\\/gu, "/").split("/"));
  }
  return output;
}

async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertExportInput(input: PooledStateExportInput): void {
  const lexicalWorkspace = resolve(input.workspaceDir);
  if (
    !isAbsolute(input.workspaceDir) ||
    input.workspaceDir !== lexicalWorkspace ||
    !lstatSync(lexicalWorkspace).isDirectory() ||
    lstatSync(lexicalWorkspace).isSymbolicLink() ||
    realpathSync(lexicalWorkspace) !== lexicalWorkspace
  ) {
    throw new Error(
      "Pooled state workspace must be a canonical absolute directory.",
    );
  }
  assertOpaqueId(input.workerStackId, "worker stack");
  assertOpaqueId(input.assistantName, "assistant name");
  assertOpaqueId(input.runtimeVersion, "runtime version");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error("Pooled state generation is invalid.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.bundleId,
    )
  ) {
    throw new Error("Pooled state bundle id must be a UUID.");
  }
  if (!Number.isFinite(input.createdAt.getTime())) {
    throw new Error("Pooled state creation time is invalid.");
  }
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
