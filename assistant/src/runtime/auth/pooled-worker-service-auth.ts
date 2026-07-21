import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { parseSub } from "./subject.js";
import type { RuntimeWorkerLeaseClaim, TokenClaims } from "./types.js";

const MAX_SERVICE_TOKEN_TTL_SECONDS = 30;
const MAX_AUTHORITY_FILE_BYTES = 16 * 1_024;

export interface PooledWorkerLeaseBinding {
  organizationId: string;
  userId: string;
  assistantId: string;
  workerStackId: string;
  leaseGeneration: number;
  leaseExpiresAtMs: number;
}

export interface PooledWorkerLeaseAuthority {
  resolveActiveLease(workerStackId: string): PooledWorkerLeaseBinding | null;
}

export type PooledWorkerServiceAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "pooled_worker_identity_missing"
        | "pooled_worker_lease_claim_missing"
        | "pooled_worker_lease_claim_malformed"
        | "pooled_worker_lease_worker_mismatch"
        | "pooled_worker_lease_authority_unavailable"
        | "pooled_worker_lease_inactive"
        | "pooled_worker_lease_binding_mismatch"
        | "pooled_worker_lease_generation_stale"
        | "pooled_worker_lease_expired";
      unavailable: boolean;
    };

export function createPooledWorkerLeaseFileAuthority(
  authorityFile: string,
  expectedWorkerStackId: string,
): PooledWorkerLeaseAuthority {
  const path = assertAuthorityPath(authorityFile);
  const workerStackId = assertOpaqueId(expectedWorkerStackId, "worker stack");
  return Object.freeze({
    resolveActiveLease: (requestedWorkerStackId: string) => {
      if (requestedWorkerStackId !== workerStackId) return null;
      return readAuthorityFile(path, workerStackId);
    },
  });
}

export function assertPooledWorkerLeaseAuthorityFile(
  authorityFile: string,
  expectedWorkerStackId: string,
): void {
  const authority = createPooledWorkerLeaseFileAuthority(
    authorityFile,
    expectedWorkerStackId,
  );
  authority.resolveActiveLease(expectedWorkerStackId);
}

export function validatePooledWorkerServiceAuthorization(input: {
  claims: TokenClaims;
  pooledRuntime: boolean;
  expectedWorkerStackId: string;
  nowSeconds?: number;
  authority?: PooledWorkerLeaseAuthority | null;
}): PooledWorkerServiceAuthResult {
  if (!input.pooledRuntime) {
    return { ok: true };
  }

  const subject = parseSub(input.claims.sub);
  if (
    !subject.ok ||
    (subject.principalType !== "svc_gateway" &&
      subject.principalType !== "actor")
  ) {
    return { ok: true };
  }

  const workerStackId = input.expectedWorkerStackId.trim();
  if (!workerStackId) {
    return denied("pooled_worker_identity_missing", true);
  }

  const rawClaim = (
    input.claims as TokenClaims & { pooled_worker_lease?: unknown }
  ).pooled_worker_lease;
  if (rawClaim === undefined) {
    return denied("pooled_worker_lease_claim_missing", false);
  }
  const claim = normalizeClaim(rawClaim);
  if (!claim || !hasConsistentTokenEnvelope(input.claims, claim, subject)) {
    return denied("pooled_worker_lease_claim_malformed", false);
  }
  if (claim.worker_stack_id !== workerStackId) {
    return denied("pooled_worker_lease_worker_mismatch", false);
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(nowSeconds) ||
    input.claims.exp <= nowSeconds ||
    claim.lease_expires_at <= nowSeconds
  ) {
    return denied("pooled_worker_lease_expired", false);
  }

  const authority = input.authority;
  if (!authority) {
    return denied("pooled_worker_lease_authority_unavailable", true);
  }

  let active: PooledWorkerLeaseBinding | null;
  try {
    active = authority.resolveActiveLease(workerStackId);
  } catch {
    return denied("pooled_worker_lease_authority_unavailable", true);
  }
  if (!active || active.leaseExpiresAtMs <= nowSeconds * 1_000) {
    return denied("pooled_worker_lease_inactive", false);
  }
  if (claim.lease_generation !== active.leaseGeneration) {
    return denied("pooled_worker_lease_generation_stale", false);
  }
  if (
    claim.organization_id !== active.organizationId ||
    claim.user_id !== active.userId ||
    claim.assistant_id !== active.assistantId ||
    claim.worker_stack_id !== active.workerStackId ||
    claim.lease_expires_at !== Math.floor(active.leaseExpiresAtMs / 1_000)
  ) {
    return denied("pooled_worker_lease_binding_mismatch", false);
  }

  return { ok: true };
}

function normalizeClaim(value: unknown): RuntimeWorkerLeaseClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Partial<RuntimeWorkerLeaseClaim>;
  if (
    claim.version !== 1 ||
    claim.issuer_service_id !== "runtime_dispatcher" ||
    !isOpaqueId(claim.organization_id) ||
    !isOpaqueId(claim.user_id) ||
    !isOpaqueId(claim.assistant_id) ||
    !isOpaqueId(claim.worker_stack_id) ||
    !Number.isSafeInteger(claim.lease_generation) ||
    (claim.lease_generation ?? 0) < 1 ||
    !Number.isSafeInteger(claim.lease_expires_at) ||
    (claim.lease_expires_at ?? 0) < 1
  ) {
    return null;
  }
  return claim as RuntimeWorkerLeaseClaim;
}

function hasConsistentTokenEnvelope(
  claims: TokenClaims,
  lease: RuntimeWorkerLeaseClaim,
  subject: Extract<ReturnType<typeof parseSub>, { ok: true }>,
): boolean {
  if (
    Number.isSafeInteger(claims.iat) &&
    typeof claims.jti === "string" &&
    claims.jti.length > 0 &&
    claims.exp > (claims.iat ?? Number.MAX_SAFE_INTEGER) &&
    claims.exp - (claims.iat ?? 0) <= MAX_SERVICE_TOKEN_TTL_SECONDS &&
    claims.exp <= lease.lease_expires_at
  ) {
    if (subject.principalType === "svc_gateway") {
      const service = claims.service_tenant_context;
      return (
        subject.assistantId === DAEMON_INTERNAL_ASSISTANT_ID &&
        (claims.scope_profile === "gateway_service_v1" ||
          claims.scope_profile === "gateway_ingress_v1") &&
        service?.version === 1 &&
        service.service_id === "gateway" &&
        service.organization_id === lease.organization_id &&
        service.assistant_id === lease.assistant_id &&
        service.request_id === claims.jti
      );
    }
    if (subject.principalType === "actor") {
      const tenant = claims.tenant_context;
      return (
        subject.assistantId === DAEMON_INTERNAL_ASSISTANT_ID &&
        !!tenant &&
        tenant.organization_id === lease.organization_id &&
        tenant.user_id === lease.user_id &&
        tenant.assistant_id === lease.assistant_id &&
        tenant.actor_id === subject.actorPrincipalId &&
        tenant.request_id === claims.jti &&
        [
          "actor_client_v1",
          "artifact_viewer_v1",
          "artifact_commenter_v1",
          "artifact_editor_v1",
        ].includes(claims.scope_profile)
      );
    }
  }
  return false;
}

function readAuthorityFile(
  authorityFile: string,
  expectedWorkerStackId: string,
): PooledWorkerLeaseBinding | null {
  const parent = dirname(authorityFile);
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== resolve(parent) ||
    (parentStat.mode & 0o022) !== 0
  ) {
    throw new Error("Pooled worker lease authority directory is unsafe.");
  }

  const descriptor = openSync(
    authorityFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let raw: string;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== parentStat.uid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > MAX_AUTHORITY_FILE_BYTES
    ) {
      throw new Error("Pooled worker lease authority file is unsafe.");
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.worker_stack_id !== expectedWorkerStackId ||
    !Number.isSafeInteger(record.authority_generation) ||
    (record.authority_generation as number) < 0 ||
    !Object.hasOwn(record, "active_lease")
  ) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  if (record.active_lease === null) return null;
  if (
    !record.active_lease ||
    typeof record.active_lease !== "object" ||
    Array.isArray(record.active_lease)
  ) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  const active = record.active_lease as Record<string, unknown>;
  if (
    !isOpaqueId(active.organization_id) ||
    !isOpaqueId(active.user_id) ||
    !isOpaqueId(active.assistant_id) ||
    active.worker_stack_id !== expectedWorkerStackId ||
    !Number.isSafeInteger(active.lease_generation) ||
    (active.lease_generation as number) < 1 ||
    active.lease_generation !== record.authority_generation ||
    !Number.isSafeInteger(active.lease_expires_at_ms) ||
    (active.lease_expires_at_ms as number) < 1
  ) {
    throw new Error("Pooled worker lease authority file is malformed.");
  }
  return Object.freeze({
    organizationId: active.organization_id,
    userId: active.user_id,
    assistantId: active.assistant_id,
    workerStackId: expectedWorkerStackId,
    leaseGeneration: active.lease_generation,
    leaseExpiresAtMs: active.lease_expires_at_ms,
  }) as PooledWorkerLeaseBinding;
}

function assertAuthorityPath(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    value.includes("\u0000")
  ) {
    throw new Error("Pooled worker lease authority path is invalid.");
  }
  return value;
}

function assertOpaqueId(value: string, label: string): string {
  if (!isOpaqueId(value)) {
    throw new Error(`Pooled worker ${label} identity is invalid.`);
  }
  return value;
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function denied(
  reason: Exclude<PooledWorkerServiceAuthResult, { ok: true }>["reason"],
  unavailable: boolean,
): PooledWorkerServiceAuthResult {
  return { ok: false, reason, unavailable };
}
