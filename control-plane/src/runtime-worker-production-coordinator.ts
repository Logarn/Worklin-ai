import type { Database } from "bun:sqlite";

import {
  releaseDispatchedRuntimeWorker,
  runtimeWorkerPoolConfigFromEnv,
  type RuntimeWorkerPoolConfig,
} from "./runtime-worker-dispatcher.js";
import type { RuntimeWorkerStackRow } from "./runtime-worker-leases.js";
import {
  createRuntimeWorkerProductionLifecycleAdapter,
  runtimeWorkerProductionLifecycleConfigFromEnv,
  type RuntimeWorkerProductionTransport,
} from "./runtime-worker-production-lifecycle.js";
import {
  createRuntimeWorkerProductionTransportFromEnv,
  runtimeWorkerWorkspaceStorageLimitsFromEnv,
  type RuntimeWorkerBootstrapInferenceProvider,
  type RuntimeWorkerLeaseAuthorization,
  type RuntimeWorkerLeaseAuthorizationProvider,
  type RuntimeWorkerProductionTransportDependencies,
  type RuntimeWorkerStateTransportOperation,
} from "./runtime-worker-production-transport.js";
import { tenantRuntimeAdmissionConfigFromEnv } from "./tenant-runtime-admission.js";
import {
  getTenantRuntimeStorageQuotaBytes,
  maximumTenantRuntimeStorageQuotaBytes,
  tenantRuntimeOperationsConfigFromEnv,
} from "./tenant-runtime-operations.js";
import {
  RuntimeWorkerRequestRouter,
  type DedicatedRuntimeRequestRoute,
  type RuntimeWorkerRequestFinishResult,
  type RuntimeWorkerRequestRouteResult,
  type RuntimeWorkerOperatorRecoveryCandidate,
  type RuntimeWorkerRestartRecoveryResult,
  type RuntimeWorkerRouteIdentity,
  type RuntimeWorkerRouteTimer,
} from "./runtime-worker-request-router.js";
import {
  mintRuntimeWorkerLeaseServiceToken,
  resolveActiveRuntimeWorkerLeaseServiceBinding,
  type RuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import { runtimeWorkerOperatorRecoveryConfigFromEnv } from "./runtime-worker-operator-recovery.js";
import type { RuntimeWorkerCoordinatorOwnershipLiveness } from "./runtime-worker-coordinator-ownership.js";

type EnvLike = Record<string, string | undefined>;

const POOL_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_POOL_ENABLED";
const TRANSPORT_ENABLE_ENV =
  "WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED";
const ACTOR_SIGNING_SECRET_ENV = ["ACTOR_TOKEN_SIGNING", "KEY"].join("_");

const TRANSPORT_OPERATIONS = new Set<RuntimeWorkerStateTransportOperation>([
  "export",
  "restore",
  "prepare_empty",
  "sanitize",
  "revoke",
]);

interface ActiveAuthorizationRow extends RuntimeWorkerStackRow {
  user_id: string;
  org_id: string;
  assistant_id: string;
  lease_token: string;
  lease_generation: number;
  lease_expires_at: number;
}

export interface RuntimeWorkerProductionCoordinatorConfig {
  enabled: boolean;
  pool: RuntimeWorkerPoolConfig;
}

export type RuntimeWorkerProductionTransportFactory = (
  rawEnv: EnvLike,
  dependencies: RuntimeWorkerProductionTransportDependencies,
) => RuntimeWorkerProductionTransport | null;

export interface RuntimeWorkerProductionCoordinatorDependencies {
  timer?: RuntimeWorkerRouteTimer;
  transportFactory?: RuntimeWorkerProductionTransportFactory;
  fetch?: typeof fetch;
  transportRandomId?: () => string;
  leaseTokenFactory?: () => string;
  requestHandleFactory?: () => string;
  onLeaseReady?: ConstructorParameters<
    typeof RuntimeWorkerRequestRouter
  >[0]["onLeaseReady"];
  nowMs?: () => number;
  nowIso?: () => string;
  reportBackgroundFailure?: (code: "pooled_runtime_timer_failed") => void;
  resolveBootstrapInferenceProvider?: (
    authorization: RuntimeWorkerLeaseAuthorization,
  ) => RuntimeWorkerBootstrapInferenceProvider | null;
  resolveWorkspaceQuotaBytes?: (
    authorization: RuntimeWorkerLeaseAuthorization,
  ) => number;
  coordinatorOwnership?: RuntimeWorkerCoordinatorOwnershipLiveness;
}

export class RuntimeWorkerProductionCoordinator {
  constructor(
    readonly config: RuntimeWorkerProductionCoordinatorConfig,
    private readonly router: RuntimeWorkerRequestRouter,
  ) {}

  routeRequest(input: {
    identity: RuntimeWorkerRouteIdentity;
    dedicatedRoute: DedicatedRuntimeRequestRoute;
  }): Promise<RuntimeWorkerRequestRouteResult> {
    return this.router.routeRequest(input);
  }

  finishRequest(input: {
    requestHandle: string;
    identity: RuntimeWorkerRouteIdentity;
  }): Promise<RuntimeWorkerRequestFinishResult> {
    return this.router.finishRequest(input);
  }

  runTenantConfigurationMutation<T>(input: {
    identity: RuntimeWorkerRouteIdentity;
    mutation: () => Promise<T>;
  }) {
    return this.router.runTenantConfigurationMutation(input);
  }

  fenceCoordinatorOwnership() {
    return this.router.fenceCoordinatorOwnership();
  }

  listOperatorRecoveryCandidates(): RuntimeWorkerOperatorRecoveryCandidate[] {
    return this.router.listOperatorRecoveryCandidates();
  }

  recoverRestartQuarantine(input: {
    binding: RuntimeWorkerLeaseServiceBinding;
  }): Promise<RuntimeWorkerRestartRecoveryResult> {
    return this.router.recoverRestartQuarantine(input);
  }

  discardQuarantinedState(input: {
    binding: RuntimeWorkerLeaseServiceBinding;
  }): Promise<RuntimeWorkerRestartRecoveryResult> {
    return this.router.discardQuarantinedState(input);
  }
}

export function runtimeWorkerProductionCoordinatorConfigFromEnv(
  rawEnv: EnvLike,
): RuntimeWorkerProductionCoordinatorConfig {
  const enabled = strictBooleanEnv(POOL_ENABLE_ENV, rawEnv[POOL_ENABLE_ENV]);
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      pool: runtimeWorkerPoolConfigFromEnv({
        ...rawEnv,
        [POOL_ENABLE_ENV]: "false",
      }),
    });
  }

  const pool = runtimeWorkerPoolConfigFromEnv({
    ...rawEnv,
    [POOL_ENABLE_ENV]: "true",
  });
  if (
    !pool.enabled ||
    pool.candidateStackIds.length === 0 ||
    pool.maxConcurrentLeases < 1
  ) {
    throw new Error(
      "Pooled runtime production capacity must include at least one worker.",
    );
  }
  if (pool.leaseTtlMs < 3) {
    throw new Error("Pooled runtime production lease TTL is too short.");
  }
  if (!strictBooleanEnv(TRANSPORT_ENABLE_ENV, rawEnv[TRANSPORT_ENABLE_ENV])) {
    throw new Error(
      `${TRANSPORT_ENABLE_ENV} must be enabled with the runtime worker pool.`,
    );
  }
  const signingKey = rawEnv[ACTOR_SIGNING_SECRET_ENV]?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/iu.test(signingKey)) {
    throw new Error(`${ACTOR_SIGNING_SECRET_ENV} must be 64 hex characters.`);
  }
  runtimeWorkerOperatorRecoveryConfigFromEnv(rawEnv, true);
  const admission = tenantRuntimeAdmissionConfigFromEnv(rawEnv);
  const operations = tenantRuntimeOperationsConfigFromEnv(rawEnv);
  if (!admission.enabled) {
    throw new Error(
      "WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED must be enabled with the runtime worker pool.",
    );
  }
  for (const [enabled, name] of [
    [operations.enabled, "WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED"],
    [
      operations.storageQuotaEnforcementEnabled,
      "WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED",
    ],
    [operations.usageMetricsEnabled, "WORKLIN_TENANT_USAGE_METRICS_ENABLED"],
    [
      operations.idleSuspensionEnabled,
      "WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED",
    ],
    [
      operations.capacityAlertsEnabled,
      "WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED",
    ],
  ] as const) {
    if (!enabled) {
      throw new Error(`${name} must be enabled with the runtime worker pool.`);
    }
  }
  runtimeWorkerWorkspaceStorageLimitsFromEnv(
    rawEnv,
    operations.defaultStorageQuotaBytes,
  );

  return Object.freeze({ enabled: true, pool });
}

export function createRuntimeWorkerProductionCoordinatorFromEnv(
  db: Database,
  rawEnv: EnvLike,
  dependencies: RuntimeWorkerProductionCoordinatorDependencies = {},
): RuntimeWorkerProductionCoordinator {
  const config = runtimeWorkerProductionCoordinatorConfigFromEnv(rawEnv);
  if (!config.enabled) {
    return new RuntimeWorkerProductionCoordinator(
      config,
      new RuntimeWorkerRequestRouter({
        db,
        poolConfig: config.pool,
      }),
    );
  }

  const masterActorSigningKey = rawEnv[ACTOR_SIGNING_SECRET_ENV]!.trim();
  const tenantOperations = tenantRuntimeOperationsConfigFromEnv(rawEnv);
  runtimeWorkerWorkspaceStorageLimitsFromEnv(
    rawEnv,
    maximumTenantRuntimeStorageQuotaBytes(db, tenantOperations),
  );
  const nowMs = dependencies.nowMs ?? Date.now;
  const coordinatorOwnership = dependencies.coordinatorOwnership;
  if (!coordinatorOwnership || !coordinatorOwnership.isLive()) {
    throw new Error(
      "Pooled runtime production coordinator requires live singleton ownership.",
    );
  }
  const authorizeLease = createRuntimeWorkerLeaseAuthorizationProvider({
    db,
    masterActorSigningKey,
    nowMs,
    coordinatorOwnership,
  });
  const transportFactory =
    dependencies.transportFactory ??
    createRuntimeWorkerProductionTransportFromEnv;
  const transport = transportFactory(rawEnv, {
    authorizeLease,
    ...(dependencies.resolveBootstrapInferenceProvider
      ? {
          resolveBootstrapInferenceProvider:
            dependencies.resolveBootstrapInferenceProvider,
        }
      : {}),
    resolveWorkspaceQuotaBytes:
      dependencies.resolveWorkspaceQuotaBytes ??
      ((authorization) => {
        const quotaBytes = getTenantRuntimeStorageQuotaBytes(
          db,
          tenantOperations,
          {
            organizationId: authorization.binding.organizationId,
            userId: authorization.binding.userId,
            assistantId: authorization.binding.assistantId,
          },
        );
        if (quotaBytes === null) {
          throw new Error(
            "Pooled worker tenant workspace quota is unavailable.",
          );
        }
        return quotaBytes;
      }),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    now: () => new Date(nowMs()),
    ...(dependencies.transportRandomId
      ? { randomId: dependencies.transportRandomId }
      : {}),
  });
  if (!transport) {
    throw new Error("Pooled runtime production transport is unavailable.");
  }
  const lifecycle = createRuntimeWorkerProductionLifecycleAdapter(
    runtimeWorkerProductionLifecycleConfigFromEnv(rawEnv),
    transport,
  );
  const timer =
    dependencies.timer ??
    createRuntimeWorkerProductionTimer(dependencies.reportBackgroundFailure);
  const nowIso = dependencies.nowIso ?? (() => new Date(nowMs()).toISOString());
  const router = new RuntimeWorkerRequestRouter({
    db,
    poolConfig: config.pool,
    lifecycle,
    masterActorSigningKey,
    releaseLease: (input) =>
      releaseDispatchedRuntimeWorker(
        input.db,
        input.assistant,
        input.leaseToken,
        input.nowMs,
        input.nowIso,
        input.lifecycle,
        input.lifecycleHeartbeat,
      ),
    revokeLeaseTokens: ({ binding }) =>
      lifecycle.revokeAuthority({
        assistant: {
          id: binding.assistantId,
          org_id: binding.organizationId,
        },
        workerStackId: binding.workerStackId,
        leaseGeneration: binding.leaseGeneration,
      }),
    timer,
    coordinatorOwnership,
    nowMs,
    nowIso,
    ...(dependencies.leaseTokenFactory
      ? { leaseTokenFactory: dependencies.leaseTokenFactory }
      : {}),
    ...(dependencies.requestHandleFactory
      ? { requestHandleFactory: dependencies.requestHandleFactory }
      : {}),
    ...(dependencies.onLeaseReady
      ? { onLeaseReady: dependencies.onLeaseReady }
      : {}),
  });
  return new RuntimeWorkerProductionCoordinator(config, router);
}

export function createRuntimeWorkerLeaseAuthorizationProvider(input: {
  db: Database;
  masterActorSigningKey: string;
  nowMs?: () => number;
  coordinatorOwnership: RuntimeWorkerCoordinatorOwnershipLiveness;
}): RuntimeWorkerLeaseAuthorizationProvider {
  if (!/^[0-9a-f]{64}$/iu.test(input.masterActorSigningKey)) {
    throw new Error(`${ACTOR_SIGNING_SECRET_ENV} must be 64 hex characters.`);
  }
  const nowMs = input.nowMs ?? Date.now;

  return async ({
    tenant,
    workerStackId,
    operation,
  }): Promise<RuntimeWorkerLeaseAuthorization> => {
    if (!input.coordinatorOwnership.isLive()) {
      throw new Error("Pooled runtime coordinator ownership is not live.");
    }
    if (
      !validOpaqueId(tenant.orgId) ||
      !validOpaqueId(tenant.assistantId) ||
      !validOpaqueId(workerStackId) ||
      !TRANSPORT_OPERATIONS.has(operation)
    ) {
      throw new Error("Pooled worker lease authorization is invalid.");
    }
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Pooled worker lease authorization time is invalid.");
    }

    const row = getExactActiveAuthorizationRow(
      input.db,
      tenant.orgId,
      tenant.assistantId,
      workerStackId,
      now,
    );
    const active = resolveActiveRuntimeWorkerLeaseServiceBinding(
      input.db,
      workerStackId,
      now,
    );
    if (!row || !active || !sameBinding(row, active)) {
      throw new Error(
        "Pooled worker lease is not active for this exact tenant.",
      );
    }

    const token = mintRuntimeWorkerLeaseServiceToken(
      input.db,
      {
        organizationId: active.organizationId,
        userId: active.userId,
        assistantId: active.assistantId,
        workerStackId: active.workerStackId,
        leaseToken: row.lease_token,
        scopeProfile: "gateway_service_v1",
      },
      input.masterActorSigningKey,
      now,
    );
    if (!sameServiceBinding(token.binding, active)) {
      throw new Error(
        "Pooled worker lease authorization changed while minting.",
      );
    }
    if (!input.coordinatorOwnership.isLive()) {
      throw new Error("Pooled runtime coordinator ownership is not live.");
    }

    return Object.freeze({
      bearerToken: token.token,
      expiresAtMs: token.expiresAtSeconds * 1_000,
      binding: token.binding,
      stack: stackFromAuthorizationRow(row),
    });
  };
}

function getExactActiveAuthorizationRow(
  db: Database,
  organizationId: string,
  assistantId: string,
  workerStackId: string,
  nowMs: number,
): ActiveAuthorizationRow | null {
  return (
    db
      .query<ActiveAuthorizationRow, [string, string, string, number]>(
        `SELECT
           stack.id,
           stack.status,
           stack.provider,
           stack.gateway_url,
           stack.public_ingress_url,
           stack.workspace_volume_ref,
           stack.service_ref,
           stack.actor_signing_key_scope,
           assistant.user_id,
           lease.org_id,
           lease.assistant_id,
           lease.lease_token,
           lease.lease_generation,
           lease.lease_expires_at
         FROM runtime_worker_leases AS lease
         JOIN assistants AS assistant
           ON assistant.id = lease.assistant_id
          AND assistant.org_id = lease.org_id
         JOIN runtime_stacks AS stack
           ON stack.id = lease.runtime_stack_id
          AND stack.provider = 'pooled_worker'
          AND stack.status = 'active'
         WHERE lease.org_id = ?
           AND lease.assistant_id = ?
           AND lease.runtime_stack_id = ?
           AND lease.lease_token IS NOT NULL
           AND lease.lease_expires_at > ?`,
      )
      .get(organizationId, assistantId, workerStackId, nowMs) ?? null
  );
}

function sameBinding(
  row: ActiveAuthorizationRow,
  binding: RuntimeWorkerLeaseServiceBinding,
): boolean {
  return (
    row.org_id === binding.organizationId &&
    row.user_id === binding.userId &&
    row.assistant_id === binding.assistantId &&
    row.id === binding.workerStackId &&
    row.lease_generation === binding.leaseGeneration &&
    row.lease_expires_at === binding.leaseExpiresAtMs
  );
}

function sameServiceBinding(
  left: RuntimeWorkerLeaseServiceBinding,
  right: RuntimeWorkerLeaseServiceBinding,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.userId === right.userId &&
    left.assistantId === right.assistantId &&
    left.workerStackId === right.workerStackId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.leaseExpiresAtMs === right.leaseExpiresAtMs
  );
}

function stackFromAuthorizationRow(
  row: ActiveAuthorizationRow,
): RuntimeWorkerStackRow {
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    gateway_url: row.gateway_url,
    public_ingress_url: row.public_ingress_url,
    workspace_volume_ref: row.workspace_volume_ref,
    service_ref: row.service_ref,
    actor_signing_key_scope: row.actor_signing_key_scope,
  };
}

function createRuntimeWorkerProductionTimer(
  reportFailure?: (code: "pooled_runtime_timer_failed") => void,
): RuntimeWorkerRouteTimer {
  return {
    schedule(callback, delayMs) {
      const handle = setTimeout(() => {
        void callback().catch(() => {
          reportFailure?.("pooled_runtime_timer_failed");
        });
      }, delayMs);
      handle.unref?.();
      return handle;
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function strictBooleanEnv(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean.`);
}

function validOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
