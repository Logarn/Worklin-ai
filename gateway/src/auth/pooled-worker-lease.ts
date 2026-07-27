import { parseSub } from "./subject.js";
import type { RuntimeWorkerLeaseClaim, TokenClaims } from "./types.js";

const MAX_SERVICE_TOKEN_TTL_SECONDS = 30;

export type PooledWorkerLeaseValidation =
  | { ok: true; claim: RuntimeWorkerLeaseClaim | null }
  | { ok: false; reason: string };

export function validatePooledWorkerLeaseClaims(
  claims: TokenClaims,
  expectedWorkerStackId: string | undefined,
): PooledWorkerLeaseValidation {
  const configuredWorker = expectedWorkerStackId?.trim() ?? "";
  const rawClaim = claims.pooled_worker_lease;

  if (!configuredWorker) {
    return rawClaim === undefined
      ? { ok: true, claim: null }
      : { ok: false, reason: "pooled_worker_identity_missing" };
  }
  if (!rawClaim) {
    return { ok: false, reason: "pooled_worker_lease_claim_missing" };
  }
  if (!isValidClaim(rawClaim)) {
    return { ok: false, reason: "pooled_worker_lease_claim_malformed" };
  }
  if (rawClaim.worker_stack_id !== configuredWorker) {
    return { ok: false, reason: "pooled_worker_lease_worker_mismatch" };
  }

  if (
    !Number.isSafeInteger(claims.iat) ||
    typeof claims.jti !== "string" ||
    !claims.jti ||
    claims.exp <= (claims.iat ?? Number.MAX_SAFE_INTEGER) ||
    claims.exp - (claims.iat ?? 0) > MAX_SERVICE_TOKEN_TTL_SECONDS ||
    claims.exp > rawClaim.lease_expires_at
  ) {
    return { ok: false, reason: "pooled_worker_lease_envelope_mismatch" };
  }

  const subject = parseSub(claims.sub);
  if (!subject.ok) {
    return { ok: false, reason: "pooled_worker_lease_subject_mismatch" };
  }
  if (subject.principalType === "svc_gateway") {
    const service = claims.service_tenant_context;
    if (
      subject.assistantId !== "self" ||
      (claims.scope_profile !== "gateway_service_v1" &&
        claims.scope_profile !== "gateway_ingress_v1") ||
      service?.version !== 1 ||
      service.service_id !== "gateway" ||
      service.organization_id !== rawClaim.organization_id ||
      service.assistant_id !== rawClaim.assistant_id ||
      service.request_id !== claims.jti
    ) {
      return { ok: false, reason: "pooled_worker_lease_envelope_mismatch" };
    }
  } else if (subject.principalType === "actor") {
    const tenant = claims.tenant_context;
    if (
      subject.assistantId !== rawClaim.assistant_id ||
      !tenant ||
      tenant.organization_id !== rawClaim.organization_id ||
      tenant.user_id !== rawClaim.user_id ||
      tenant.assistant_id !== rawClaim.assistant_id ||
      tenant.actor_id !== subject.actorPrincipalId ||
      tenant.request_id !== claims.jti ||
      ![
        "actor_client_v1",
        "artifact_viewer_v1",
        "artifact_commenter_v1",
        "artifact_editor_v1",
      ].includes(claims.scope_profile)
    ) {
      return { ok: false, reason: "pooled_worker_lease_envelope_mismatch" };
    }
  } else {
    return { ok: false, reason: "pooled_worker_lease_subject_mismatch" };
  }

  return { ok: true, claim: rawClaim };
}

function isValidClaim(
  claim: RuntimeWorkerLeaseClaim,
): claim is RuntimeWorkerLeaseClaim {
  return (
    claim.version === 1 &&
    claim.issuer_service_id === "runtime_dispatcher" &&
    isOpaqueId(claim.organization_id) &&
    isOpaqueId(claim.user_id) &&
    isOpaqueId(claim.assistant_id) &&
    isOpaqueId(claim.worker_stack_id) &&
    Number.isSafeInteger(claim.lease_generation) &&
    claim.lease_generation >= 1 &&
    Number.isSafeInteger(claim.lease_expires_at) &&
    claim.lease_expires_at >= 1
  );
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
