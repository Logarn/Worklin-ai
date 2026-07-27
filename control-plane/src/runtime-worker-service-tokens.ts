import type { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";

import { deriveRuntimeActorSigningKey } from "./runtime-stacks.js";

const JWT_HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");
const SERVICE_TOKEN_TTL_SECONDS = 30;
const POLICY_EPOCH = 1;

export interface RuntimeWorkerLeaseServiceBinding {
  organizationId: string;
  userId: string;
  assistantId: string;
  workerStackId: string;
  leaseGeneration: number;
  leaseExpiresAtMs: number;
}

export interface RuntimeWorkerLeaseServiceToken {
  token: string;
  binding: RuntimeWorkerLeaseServiceBinding;
  expiresAtSeconds: number;
}

export interface RuntimeWorkerLeaseClaim {
  version: 1;
  issuer_service_id: "runtime_dispatcher";
  organization_id: string;
  user_id: string;
  assistant_id: string;
  worker_stack_id: string;
  lease_generation: number;
  lease_expires_at: number;
}

export interface RuntimeWorkerLeaseActorToken {
  token: string;
  binding: RuntimeWorkerLeaseServiceBinding;
  expiresAtSeconds: number;
}

interface ActiveLeaseRow {
  org_id: string;
  user_id: string;
  assistant_id: string;
  runtime_stack_id: string;
  lease_token: string;
  lease_generation: number;
  lease_expires_at: number;
  actor_signing_key_scope: string;
}

export function resolveActiveRuntimeWorkerLeaseServiceBinding(
  db: Database,
  workerStackId: string,
  nowMs: number,
): RuntimeWorkerLeaseServiceBinding | null {
  const worker = assertOpaqueId(workerStackId, "worker stack");
  assertNow(nowMs);
  const row = getActiveLease(db, worker, nowMs);
  return row ? bindingFromRow(row) : null;
}

export function runtimeWorkerLeaseClaim(
  binding: RuntimeWorkerLeaseServiceBinding,
): RuntimeWorkerLeaseClaim {
  return Object.freeze({
    version: 1,
    issuer_service_id: "runtime_dispatcher",
    organization_id: binding.organizationId,
    user_id: binding.userId,
    assistant_id: binding.assistantId,
    worker_stack_id: binding.workerStackId,
    lease_generation: binding.leaseGeneration,
    lease_expires_at: Math.floor(binding.leaseExpiresAtMs / 1_000),
  });
}

export function mintRuntimeWorkerLeaseServiceToken(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    assistantId: string;
    workerStackId: string;
    leaseToken: string;
    scopeProfile?: "gateway_service_v1" | "gateway_ingress_v1";
  },
  masterSigningKey: string,
  nowMs: number,
): RuntimeWorkerLeaseServiceToken {
  const expected = {
    organizationId: assertOpaqueId(input.organizationId, "organization"),
    userId: assertOpaqueId(input.userId, "user"),
    assistantId: assertOpaqueId(input.assistantId, "assistant"),
    workerStackId: assertOpaqueId(input.workerStackId, "worker stack"),
    leaseToken: assertOpaqueId(input.leaseToken, "lease"),
  };
  assertNow(nowMs);

  const row = getActiveLease(db, expected.workerStackId, nowMs);
  if (
    !row ||
    row.org_id !== expected.organizationId ||
    row.user_id !== expected.userId ||
    row.assistant_id !== expected.assistantId ||
    row.lease_token !== expected.leaseToken ||
    !Number.isSafeInteger(row.lease_generation) ||
    row.lease_generation < 1
  ) {
    throw new Error("Runtime worker lease is not active for this tenant.");
  }

  const nowSeconds = Math.floor(nowMs / 1_000);
  const leaseExpiresAtSeconds = Math.floor(row.lease_expires_at / 1_000);
  const expiresAtSeconds = Math.min(
    nowSeconds + SERVICE_TOKEN_TTL_SECONDS,
    leaseExpiresAtSeconds,
  );
  if (expiresAtSeconds <= nowSeconds) {
    throw new Error("Runtime worker lease expires too soon to mint a token.");
  }

  const binding = bindingFromRow(row);
  const requestId = randomBytes(16).toString("hex");
  const claims = {
    iss: "vellum-auth",
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: input.scopeProfile ?? "gateway_service_v1",
    exp: expiresAtSeconds,
    policy_epoch: POLICY_EPOCH,
    iat: nowSeconds,
    jti: requestId,
    service_tenant_context: {
      version: 1,
      assistant_id: binding.assistantId,
      organization_id: binding.organizationId,
      service_id: "gateway",
      request_id: requestId,
    },
    pooled_worker_lease: runtimeWorkerLeaseClaim(binding),
  } as const;

  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${JWT_HEADER}.${payload}`;
  const workerSigningKey = deriveRuntimeActorSigningKey(
    masterSigningKey,
    row.actor_signing_key_scope,
  );
  const signature = createHmac("sha256", Buffer.from(workerSigningKey, "hex"))
    .update(signingInput)
    .digest("base64url");

  return {
    token: `${signingInput}.${signature}`,
    binding,
    expiresAtSeconds,
  };
}

export function mintRuntimeWorkerLeaseActorToken(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    assistantId: string;
    actorId: string;
    requestId: string;
    workerStackId: string;
    leaseToken: string;
  },
  masterSigningKey: string,
  nowMs: number,
): RuntimeWorkerLeaseActorToken {
  const expected = {
    organizationId: assertOpaqueId(input.organizationId, "organization"),
    userId: assertOpaqueId(input.userId, "user"),
    assistantId: assertOpaqueId(input.assistantId, "assistant"),
    actorId: assertOpaqueId(input.actorId, "actor"),
    requestId: assertOpaqueId(input.requestId, "request"),
    workerStackId: assertOpaqueId(input.workerStackId, "worker stack"),
    leaseToken: assertOpaqueId(input.leaseToken, "lease"),
  };
  assertNow(nowMs);

  const row = getActiveLease(db, expected.workerStackId, nowMs);
  if (
    !row ||
    row.org_id !== expected.organizationId ||
    row.user_id !== expected.userId ||
    row.assistant_id !== expected.assistantId ||
    row.lease_token !== expected.leaseToken ||
    !Number.isSafeInteger(row.lease_generation) ||
    row.lease_generation < 1
  ) {
    throw new Error("Runtime worker lease is not active for this tenant.");
  }

  const nowSeconds = Math.floor(nowMs / 1_000);
  const leaseExpiresAtSeconds = Math.floor(row.lease_expires_at / 1_000);
  const expiresAtSeconds = Math.min(
    nowSeconds + SERVICE_TOKEN_TTL_SECONDS,
    leaseExpiresAtSeconds,
  );
  if (expiresAtSeconds <= nowSeconds) {
    throw new Error("Runtime worker lease expires too soon to mint a token.");
  }

  const binding = bindingFromRow(row);
  const claims = {
    iss: "vellum-auth",
    aud: "vellum-gateway",
    sub: `actor:${binding.assistantId}:${expected.actorId}`,
    scope_profile: "actor_client_v1",
    exp: expiresAtSeconds,
    policy_epoch: POLICY_EPOCH,
    iat: nowSeconds,
    jti: expected.requestId,
    tenant_context: {
      version: 1,
      organization_id: binding.organizationId,
      user_id: binding.userId,
      assistant_id: binding.assistantId,
      actor_id: expected.actorId,
      request_id: expected.requestId,
    },
    pooled_worker_lease: runtimeWorkerLeaseClaim(binding),
  } as const;

  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${JWT_HEADER}.${payload}`;
  const workerSigningKey = deriveRuntimeActorSigningKey(
    masterSigningKey,
    row.actor_signing_key_scope,
  );
  const signature = createHmac("sha256", Buffer.from(workerSigningKey, "hex"))
    .update(signingInput)
    .digest("base64url");

  return {
    token: `${signingInput}.${signature}`,
    binding,
    expiresAtSeconds,
  };
}

function getActiveLease(
  db: Database,
  workerStackId: string,
  nowMs: number,
): ActiveLeaseRow | null {
  return (
    db
      .query<ActiveLeaseRow, [string, number]>(
        `SELECT
           lease.org_id,
           assistant.user_id,
           lease.assistant_id,
           lease.runtime_stack_id,
           lease.lease_token,
           lease.lease_generation,
           lease.lease_expires_at,
           stack.actor_signing_key_scope
         FROM runtime_worker_leases AS lease
         JOIN assistants AS assistant
           ON assistant.id = lease.assistant_id
          AND assistant.org_id = lease.org_id
         JOIN runtime_stacks AS stack
           ON stack.id = lease.runtime_stack_id
          AND stack.provider = 'pooled_worker'
          AND stack.status = 'active'
         WHERE lease.runtime_stack_id = ?
           AND lease.lease_token IS NOT NULL
           AND lease.lease_expires_at > ?`,
      )
      .get(workerStackId, nowMs) ?? null
  );
}

function bindingFromRow(row: ActiveLeaseRow): RuntimeWorkerLeaseServiceBinding {
  return Object.freeze({
    organizationId: row.org_id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    workerStackId: row.runtime_stack_id,
    leaseGeneration: row.lease_generation,
    leaseExpiresAtMs: row.lease_expires_at,
  });
}

function assertOpaqueId(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Runtime worker ${label} identity is invalid.`);
  }
  return value;
}

function assertNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Runtime worker token time is invalid.");
  }
}
