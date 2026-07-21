import { createHash, timingSafeEqual } from "node:crypto";

import type { RuntimeWorkerLeaseServiceBinding } from "./runtime-worker-service-tokens.js";

type EnvLike = Record<string, string | undefined>;

export const RUNTIME_WORKER_OPERATOR_RECOVERY_PATH =
  "/internal/v1/runtime-workers/operator-recovery";
export const RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN_ENV =
  "WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN";
export const RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION =
  "DISCARD_UNCHECKPOINTED_RUNTIME_STATE";

export interface RuntimeWorkerOperatorRecoveryConfig {
  enabled: boolean;
  tokenDigest: Buffer | null;
}

export type RuntimeWorkerOperatorRecoveryRequest =
  | {
      action: "release_restart_lease";
      binding: RuntimeWorkerLeaseServiceBinding;
    }
  | {
      action: "discard_quarantined_state";
      binding: RuntimeWorkerLeaseServiceBinding;
      confirmation: typeof RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION;
    };

export function runtimeWorkerOperatorRecoveryConfigFromEnv(
  rawEnv: EnvLike,
  poolEnabled: boolean,
): RuntimeWorkerOperatorRecoveryConfig {
  if (!poolEnabled) {
    return Object.freeze({ enabled: false, tokenDigest: null });
  }
  const token = rawEnv[RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN_ENV] ?? "";
  if (
    token.length < 32 ||
    token.length > 512 ||
    !/^[A-Za-z0-9._~-]+$/u.test(token)
  ) {
    throw new Error(
      `${RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN_ENV} must be a 32-512 character opaque bearer token when pooled runtimes are enabled.`,
    );
  }
  return Object.freeze({
    enabled: true,
    tokenDigest: digestToken(token),
  });
}

export function authorizeRuntimeWorkerOperatorRecovery(
  config: RuntimeWorkerOperatorRecoveryConfig,
  authorization: string | undefined,
): boolean {
  if (!config.enabled || !config.tokenDigest || !authorization) return false;
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/u.exec(authorization);
  if (!match?.[1]) return false;
  return timingSafeEqual(digestToken(match[1]), config.tokenDigest);
}

export function parseRuntimeWorkerOperatorRecoveryRequest(
  value: unknown,
): RuntimeWorkerOperatorRecoveryRequest | null {
  if (!isRecord(value)) return null;
  const action = value.action;
  if (
    action !== "release_restart_lease" &&
    action !== "discard_quarantined_state"
  ) {
    return null;
  }
  const allowedTopLevel =
    action === "discard_quarantined_state"
      ? new Set(["action", "binding", "confirmation"])
      : new Set(["action", "binding"]);
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) return null;

  const binding = parseBinding(value.binding);
  if (!binding) return null;
  if (action === "release_restart_lease") {
    return { action, binding };
  }
  if (
    value.confirmation !== RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION
  ) {
    return null;
  }
  return {
    action,
    binding,
    confirmation: RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION,
  };
}

function parseBinding(value: unknown): RuntimeWorkerLeaseServiceBinding | null {
  if (!isRecord(value)) return null;
  const keys = [
    "organizationId",
    "userId",
    "assistantId",
    "workerStackId",
    "leaseGeneration",
    "leaseExpiresAtMs",
  ] as const;
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !(keys as readonly string[]).includes(key),
    )
  ) {
    return null;
  }
  const {
    organizationId,
    userId,
    assistantId,
    workerStackId,
    leaseGeneration,
    leaseExpiresAtMs,
  } = value;
  if (
    !validOpaqueId(organizationId) ||
    !validOpaqueId(userId) ||
    !validOpaqueId(assistantId) ||
    !validOpaqueId(workerStackId) ||
    !Number.isSafeInteger(leaseGeneration) ||
    (leaseGeneration as number) < 1 ||
    !Number.isSafeInteger(leaseExpiresAtMs) ||
    (leaseExpiresAtMs as number) < 1
  ) {
    return null;
  }
  return {
    organizationId,
    userId,
    assistantId,
    workerStackId,
    leaseGeneration: leaseGeneration as number,
    leaseExpiresAtMs: leaseExpiresAtMs as number,
  };
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
