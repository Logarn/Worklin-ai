import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";

import {
  discardQuarantinedDispatchedRuntimeWorker,
  dispatchRuntimeWorker,
  renewDispatchedRuntimeWorker,
  type RuntimeWorkerLifecycleLeaseHeartbeatOptions,
  type RuntimeWorkerLifecycleAdapter,
  type RuntimeWorkerPoolConfig,
  type RuntimeWorkerReleaseResult,
} from "./runtime-worker-dispatcher.js";
import type {
  RuntimeWorkerLease,
  RuntimeWorkerLeaseAssistant,
} from "./runtime-worker-leases.js";
import {
  mintRuntimeWorkerLeaseServiceToken,
  mintRuntimeWorkerLeaseActorToken,
  type RuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import {
  ensureRuntimeWorkerStateCheckpointSchema,
  getRuntimeWorkerStateCheckpoint,
} from "./runtime-worker-state-checkpoints.js";

export interface DedicatedRuntimeRequestRoute {
  gatewayUrl: string;
  actorToken: string;
}

export interface RuntimeWorkerRouteIdentity {
  organizationId: string;
  userId: string;
  assistantId: string;
  actorId: string;
}

export interface RuntimeWorkerRouteTimer {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RuntimeWorkerRouteReleaseInput {
  db: Database;
  assistant: RuntimeWorkerLeaseAssistant;
  leaseToken: string;
  nowMs: number;
  nowIso: () => string;
  lifecycle: RuntimeWorkerLifecycleAdapter;
  lifecycleHeartbeat: RuntimeWorkerLifecycleLeaseHeartbeatOptions & {
    config: RuntimeWorkerPoolConfig;
  };
}

export interface RuntimeWorkerRouteRevocationInput {
  binding: RuntimeWorkerLeaseServiceBinding;
}

export interface RuntimeWorkerRequestRouterOptions {
  db: Database;
  poolConfig: RuntimeWorkerPoolConfig;
  lifecycle?: RuntimeWorkerLifecycleAdapter;
  masterActorSigningKey?: string;
  releaseLease?: (
    input: RuntimeWorkerRouteReleaseInput,
  ) => Promise<RuntimeWorkerReleaseResult>;
  revokeLeaseTokens?: (
    input: RuntimeWorkerRouteRevocationInput,
  ) => Promise<void>;
  timer?: RuntimeWorkerRouteTimer;
  nowMs?: () => number;
  nowIso?: () => string;
  leaseTokenFactory?: () => string;
  requestHandleFactory?: () => string;
  onLeaseReady?: (input: {
    identity: RuntimeWorkerRouteIdentity;
    workerStackId: string;
    leaseToken: string;
    leaseGeneration: number;
    stateGeneration: number;
    observedBytes: number;
    observedAtMs: number;
  }) => void | Promise<void>;
  coordinatorOwnership?: { isLive(): boolean };
  idleReleaseDelayMs?: number;
  renewIntervalMs?: number;
}

export type RuntimeWorkerRouteUnavailableReason =
  | "coordinator_dependencies_unavailable"
  | "coordinator_ownership_lost"
  | "invalid_identity"
  | "tenant_mismatch"
  | "empty_capacity"
  | "no_ready_workers"
  | "capacity_exhausted"
  | "assistant_not_found"
  | "assistant_busy"
  | "state_lifecycle_unavailable"
  | "state_restore_failed"
  | "state_quarantined"
  | "worker_unavailable"
  | "lease_lost"
  | "actor_token_unavailable"
  | "restart_quarantined"
  | "orphaned_expired_lease";

export type RuntimeWorkerRequestRouteResult =
  | {
      mode: "dedicated";
      route: DedicatedRuntimeRequestRoute;
    }
  | {
      mode: "pooled";
      gatewayUrl: string;
      actorToken: string;
      actorTokenExpiresAtSeconds: number;
      gatewayIngressToken: string;
      requestHandle: string;
      binding: RuntimeWorkerLeaseServiceBinding;
    }
  | {
      mode: "unavailable";
      reason: RuntimeWorkerRouteUnavailableReason;
      retryAfterMs: number | null;
    };

export type RuntimeWorkerRequestFinishResult =
  | { status: "unknown_request" }
  | { status: "route_handle_mismatch" }
  | { status: "active"; activeRequestCount: number }
  | { status: "release_scheduled" }
  | { status: "released" }
  | {
      status: "release_failed";
      reason:
        | RuntimeWorkerReleaseResult["status"]
        | "revocation_failed"
        | "release_callback_failed"
        | "coordinator_ownership_lost";
    };

export type RuntimeWorkerRestartRecoveryResult =
  | { status: "recovered" }
  | { status: "not_quarantined" }
  | { status: "binding_mismatch" }
  | { status: "in_process_active" }
  | {
      status: "recovery_failed";
      reason: RuntimeWorkerReleaseResult["status"] | "release_callback_failed";
      retryBinding?: RuntimeWorkerLeaseServiceBinding;
    };

export interface RuntimeWorkerOperatorRecoveryCandidate {
  binding: RuntimeWorkerLeaseServiceBinding;
  recoveryKind:
    | "active_restart_lease"
    | "expired_restart_lease"
    | "quarantined_state";
  checkpointFailureCode: string | null;
  inProcessActive: boolean;
}

export interface RuntimeWorkerCoordinatorFenceResult {
  status: "fenced";
  abortedRequestHandles: string[];
  quarantinedWorkerCount: number;
  revocationFailureCount: number;
}

export type RuntimeWorkerTenantConfigurationMutationResult<T> =
  | { status: "applied"; value: T }
  | {
      status: "rejected";
      reason: "active_requests";
      activeRequestCount: number;
    }
  | {
      status: "unavailable";
      reason:
        | "coordinator_dependencies_unavailable"
        | "coordinator_ownership_lost"
        | "invalid_identity"
        | "tenant_mismatch"
        | "restart_quarantined"
        | "worker_release_failed";
    };

interface AssistantOwnerRow {
  id: string;
  org_id: string;
  user_id: string;
}

interface PersistedLeaseRow {
  runtime_stack_id: string;
  assistant_id: string;
  org_id: string;
  lease_token: string;
  lease_generation: number;
  lease_expires_at: number;
  user_id: string;
}

interface PersistedRecoveryCandidateRow extends PersistedLeaseRow {
  checkpoint_status: string | null;
  checkpoint_failure_code: string | null;
}

interface ActiveRequest {
  identity: RuntimeWorkerRouteIdentity;
  entryKey: string;
}

interface RouteEntry {
  key: string;
  assistant: RuntimeWorkerLeaseAssistant;
  userId: string;
  leaseToken: string;
  assignment: RuntimeWorkerLease;
  activeRequestHandles: Set<string>;
  renewTimer: unknown | null;
  idleReleaseTimer: unknown | null;
  blockedReason: RuntimeWorkerRouteUnavailableReason | null;
}

function tenantKey(identity: RuntimeWorkerRouteIdentity): string {
  return JSON.stringify([identity.organizationId, identity.assistantId]);
}

function validOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validIdentity(identity: RuntimeWorkerRouteIdentity): boolean {
  return (
    validOpaqueId(identity.organizationId) &&
    validOpaqueId(identity.userId) &&
    validOpaqueId(identity.assistantId) &&
    validOpaqueId(identity.actorId)
  );
}

function sameIdentity(
  left: RuntimeWorkerRouteIdentity,
  right: RuntimeWorkerRouteIdentity,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.userId === right.userId &&
    left.assistantId === right.assistantId &&
    left.actorId === right.actorId
  );
}

function bindingForEntry(entry: RouteEntry): RuntimeWorkerLeaseServiceBinding {
  return {
    organizationId: entry.assistant.org_id,
    userId: entry.userId,
    assistantId: entry.assistant.id,
    workerStackId: entry.assignment.stack.id,
    leaseGeneration: entry.assignment.lease.lease_generation,
    leaseExpiresAtMs: entry.assignment.lease.lease_expires_at ?? 0,
  };
}

function dependencyFailure(
  options: RuntimeWorkerRequestRouterOptions,
): boolean {
  if (!options.poolConfig.enabled) return false;
  const renewIntervalMs =
    options.renewIntervalMs ?? Math.floor(options.poolConfig.leaseTtlMs / 3);
  const idleReleaseDelayMs =
    options.idleReleaseDelayMs ??
    Math.min(1_000, Math.max(0, options.poolConfig.leaseTtlMs - 1));
  return (
    !options.lifecycle ||
    !options.masterActorSigningKey ||
    !/^[0-9a-f]{64}$/i.test(options.masterActorSigningKey) ||
    !options.releaseLease ||
    !options.revokeLeaseTokens ||
    !options.timer ||
    !options.coordinatorOwnership ||
    !Number.isSafeInteger(renewIntervalMs) ||
    renewIntervalMs < 1 ||
    renewIntervalMs >= options.poolConfig.leaseTtlMs ||
    !Number.isSafeInteger(idleReleaseDelayMs) ||
    idleReleaseDelayMs < 0 ||
    idleReleaseDelayMs >= options.poolConfig.leaseTtlMs
  );
}

export class RuntimeWorkerRequestRouter {
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly leaseTokenFactory: () => string;
  private readonly requestHandleFactory: () => string;
  private readonly renewIntervalMs: number;
  private readonly idleReleaseDelayMs: number;
  private readonly unavailableDependencies: boolean;
  private readonly entries = new Map<string, RouteEntry>();
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly serialTails = new Map<string, Promise<void>>();
  private ownershipFenced = false;

  constructor(private readonly options: RuntimeWorkerRequestRouterOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.nowIso =
      options.nowIso ?? (() => new Date(this.nowMs()).toISOString());
    this.leaseTokenFactory = options.leaseTokenFactory ?? randomUUID;
    this.requestHandleFactory = options.requestHandleFactory ?? randomUUID;
    this.renewIntervalMs =
      options.renewIntervalMs ?? Math.floor(options.poolConfig.leaseTtlMs / 3);
    this.idleReleaseDelayMs =
      options.idleReleaseDelayMs ??
      Math.min(1_000, Math.max(0, options.poolConfig.leaseTtlMs - 1));
    this.unavailableDependencies = dependencyFailure(options);
  }

  async routeRequest(input: {
    identity: RuntimeWorkerRouteIdentity;
    dedicatedRoute: DedicatedRuntimeRequestRoute;
  }): Promise<RuntimeWorkerRequestRouteResult> {
    if (!this.options.poolConfig.enabled) {
      return { mode: "dedicated", route: input.dedicatedRoute };
    }
    if (this.unavailableDependencies) {
      return {
        mode: "unavailable",
        reason: "coordinator_dependencies_unavailable",
        retryAfterMs: null,
      };
    }
    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return {
        mode: "unavailable",
        reason: "coordinator_ownership_lost",
        retryAfterMs: null,
      };
    }
    if (!validIdentity(input.identity)) {
      return {
        mode: "unavailable",
        reason: "invalid_identity",
        retryAfterMs: null,
      };
    }

    return this.exclusive(tenantKey(input.identity), () =>
      this.routePooledRequest(input.identity),
    );
  }

  async fenceCoordinatorOwnership(): Promise<RuntimeWorkerCoordinatorFenceResult> {
    this.ownershipFenced = true;
    const entries = [...this.entries.values()];
    const abortedRequestHandles = [...this.activeRequests.keys()];
    for (const entry of entries) {
      this.cancelRenewal(entry);
      this.cancelIdleRelease(entry);
      entry.blockedReason = "coordinator_ownership_lost";
    }
    this.activeRequests.clear();
    this.entries.clear();

    let revocationFailureCount = 0;
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await this.options.revokeLeaseTokens?.({
            binding: bindingForEntry(entry),
          });
        } catch {
          revocationFailureCount += 1;
        }
      }),
    );
    return {
      status: "fenced",
      abortedRequestHandles,
      quarantinedWorkerCount: entries.length,
      revocationFailureCount,
    };
  }

  async runTenantConfigurationMutation<T>(input: {
    identity: RuntimeWorkerRouteIdentity;
    mutation: () => Promise<T>;
  }): Promise<RuntimeWorkerTenantConfigurationMutationResult<T>> {
    if (!this.options.poolConfig.enabled || this.unavailableDependencies) {
      return {
        status: "unavailable",
        reason: "coordinator_dependencies_unavailable",
      };
    }
    if (!validIdentity(input.identity)) {
      return { status: "unavailable", reason: "invalid_identity" };
    }
    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return { status: "unavailable", reason: "coordinator_ownership_lost" };
    }

    const key = tenantKey(input.identity);
    return this.exclusive(key, async () => {
      if (!this.coordinatorOwnershipIsLive()) {
        await this.fenceCoordinatorOwnership();
        return {
          status: "unavailable",
          reason: "coordinator_ownership_lost",
        };
      }
      const owner = this.getAssistantOwner(input.identity.assistantId);
      if (
        !owner ||
        owner.org_id !== input.identity.organizationId ||
        owner.user_id !== input.identity.userId
      ) {
        return { status: "unavailable", reason: "tenant_mismatch" };
      }

      const entry = this.entries.get(key);
      if (entry && entry.activeRequestHandles.size > 0) {
        return {
          status: "rejected",
          reason: "active_requests",
          activeRequestCount: entry.activeRequestHandles.size,
        };
      }
      if (entry) {
        const released = await this.releaseEntry(entry);
        if (released.status !== "released") {
          return {
            status: "unavailable",
            reason:
              released.status === "release_failed" &&
              released.reason === "coordinator_ownership_lost"
                ? "coordinator_ownership_lost"
                : "worker_release_failed",
          };
        }
      }

      if (this.getPersistedLease(input.identity.assistantId)) {
        return { status: "unavailable", reason: "restart_quarantined" };
      }
      if (!this.coordinatorOwnershipIsLive()) {
        await this.fenceCoordinatorOwnership();
        return {
          status: "unavailable",
          reason: "coordinator_ownership_lost",
        };
      }

      const value = await input.mutation();
      if (!this.coordinatorOwnershipIsLive()) {
        await this.fenceCoordinatorOwnership();
        return {
          status: "unavailable",
          reason: "coordinator_ownership_lost",
        };
      }
      return { status: "applied", value };
    });
  }

  async finishRequest(input: {
    requestHandle: string;
    identity: RuntimeWorkerRouteIdentity;
  }): Promise<RuntimeWorkerRequestFinishResult> {
    if (!this.options.poolConfig.enabled) return { status: "unknown_request" };
    const request = this.activeRequests.get(input.requestHandle);
    const coordinationKey = request?.entryKey ?? tenantKey(input.identity);
    return this.exclusive(coordinationKey, async () => {
      const request = this.activeRequests.get(input.requestHandle);
      if (!request) return { status: "unknown_request" };
      if (!sameIdentity(request.identity, input.identity)) {
        return { status: "route_handle_mismatch" };
      }
      const entry = this.entries.get(request.entryKey);
      if (!entry || !entry.activeRequestHandles.has(input.requestHandle)) {
        return { status: "unknown_request" };
      }

      this.activeRequests.delete(input.requestHandle);
      entry.activeRequestHandles.delete(input.requestHandle);
      if (entry.activeRequestHandles.size > 0) {
        return {
          status: "active",
          activeRequestCount: entry.activeRequestHandles.size,
        };
      }

      this.cancelRenewal(entry);
      try {
        this.scheduleIdleRelease(entry);
        return { status: "release_scheduled" };
      } catch {
        return this.releaseEntry(entry);
      }
    });
  }

  listOperatorRecoveryCandidates(): RuntimeWorkerOperatorRecoveryCandidate[] {
    if (
      !this.options.poolConfig.enabled ||
      this.unavailableDependencies ||
      !this.coordinatorOwnershipIsLive()
    ) {
      return [];
    }
    ensureRuntimeWorkerStateCheckpointSchema(this.options.db);
    const nowMs = this.nowMs();
    return this.options.db
      .query<PersistedRecoveryCandidateRow, []>(
        `SELECT
           lease.runtime_stack_id,
           lease.assistant_id,
           lease.org_id,
           lease.lease_token,
           lease.lease_generation,
           lease.lease_expires_at,
           assistant.user_id,
           checkpoint.status AS checkpoint_status,
           checkpoint.failure_code AS checkpoint_failure_code
         FROM runtime_worker_leases AS lease
         JOIN assistants AS assistant
           ON assistant.id = lease.assistant_id
          AND assistant.org_id = lease.org_id
         LEFT JOIN runtime_worker_state_checkpoints AS checkpoint
           ON checkpoint.org_id = lease.org_id
          AND checkpoint.assistant_id = lease.assistant_id
         WHERE lease.lease_token IS NOT NULL
         ORDER BY lease.runtime_stack_id`,
      )
      .all()
      .map((row) => {
        const identity: RuntimeWorkerRouteIdentity = {
          organizationId: row.org_id,
          userId: row.user_id,
          assistantId: row.assistant_id,
          actorId: "operator-recovery-inspection",
        };
        return {
          binding: bindingForPersistedLease(row),
          recoveryKind:
            row.checkpoint_status === "quarantined"
              ? "quarantined_state"
              : row.lease_expires_at <= nowMs
                ? "expired_restart_lease"
                : "active_restart_lease",
          checkpointFailureCode: row.checkpoint_failure_code,
          inProcessActive: this.entries.has(tenantKey(identity)),
        };
      });
  }

  /**
   * Explicit operator recovery for a persisted lease left behind after a
   * control-plane restart.
   *
   * Ordinary routing never resumes such a lease because this process cannot
   * prove that the previous coordinator is gone. An operator must present the
   * exact binding observed through the authenticated operator surface. The
   * release callback then
   * performs worker drain/export/sanitize/revocation and an exact DB CAS.
   */
  async recoverRestartQuarantine(input: {
    binding: RuntimeWorkerLeaseServiceBinding;
  }): Promise<RuntimeWorkerRestartRecoveryResult> {
    const identity: RuntimeWorkerRouteIdentity = {
      organizationId: input.binding.organizationId,
      userId: input.binding.userId,
      assistantId: input.binding.assistantId,
      actorId: "operator-recovery",
    };
    if (
      this.unavailableDependencies ||
      !this.coordinatorOwnershipIsLive() ||
      !validIdentity(identity) ||
      !validOpaqueId(input.binding.workerStackId) ||
      !Number.isSafeInteger(input.binding.leaseGeneration) ||
      input.binding.leaseGeneration < 1 ||
      !Number.isSafeInteger(input.binding.leaseExpiresAtMs) ||
      input.binding.leaseExpiresAtMs < 1
    ) {
      return { status: "binding_mismatch" };
    }

    const key = tenantKey(identity);
    return this.exclusive(key, async () => {
      if (this.entries.has(key)) return { status: "in_process_active" };
      const persisted = this.getPersistedLease(input.binding.assistantId);
      if (!persisted) return { status: "not_quarantined" };
      if (!persistedLeaseMatchesBinding(persisted, input.binding)) {
        return { status: "binding_mismatch" };
      }
      let row = persisted;
      if (row.lease_expires_at <= this.nowMs()) {
        const reactivated = this.reactivateExpiredRecoveryLease(row);
        if (!reactivated) return { status: "binding_mismatch" };
        row = reactivated;
      }

      let released: RuntimeWorkerReleaseResult;
      try {
        released = await this.options.releaseLease!({
          db: this.options.db,
          assistant: {
            id: row.assistant_id,
            org_id: row.org_id,
          },
          leaseToken: row.lease_token,
          nowMs: this.nowMs(),
          nowIso: this.nowIso,
          lifecycle: this.options.lifecycle!,
          lifecycleHeartbeat: this.lifecycleHeartbeatOptions(),
        });
      } catch {
        return {
          status: "recovery_failed",
          reason: "release_callback_failed",
          retryBinding: bindingForPersistedLease(row),
        };
      }
      if (released.status === "released") return { status: "recovered" };
      const retryRow = this.getPersistedLease(row.assistant_id);
      return {
        status: "recovery_failed",
        reason: released.status,
        ...(retryRow
          ? { retryBinding: bindingForPersistedLease(retryRow) }
          : {}),
      };
    });
  }

  /**
   * Explicit data-loss recovery for a checkpoint already marked quarantined.
   * Only uncheckpointed live worker state is discarded; the last durable
   * checkpoint object and generation remain intact for the next restore.
   */
  async discardQuarantinedState(input: {
    binding: RuntimeWorkerLeaseServiceBinding;
  }): Promise<RuntimeWorkerRestartRecoveryResult> {
    const identity: RuntimeWorkerRouteIdentity = {
      organizationId: input.binding.organizationId,
      userId: input.binding.userId,
      assistantId: input.binding.assistantId,
      actorId: "operator-quarantine-recovery",
    };
    if (
      this.unavailableDependencies ||
      !this.coordinatorOwnershipIsLive() ||
      !validIdentity(identity) ||
      !validOpaqueId(input.binding.workerStackId) ||
      !Number.isSafeInteger(input.binding.leaseGeneration) ||
      input.binding.leaseGeneration < 1 ||
      !Number.isSafeInteger(input.binding.leaseExpiresAtMs) ||
      input.binding.leaseExpiresAtMs < 1
    ) {
      return { status: "binding_mismatch" };
    }

    const key = tenantKey(identity);
    return this.exclusive(key, async () => {
      if (this.entries.has(key)) return { status: "in_process_active" };
      const persisted = this.getPersistedLease(input.binding.assistantId);
      if (!persisted) return { status: "not_quarantined" };
      if (!persistedLeaseMatchesBinding(persisted, input.binding)) {
        return { status: "binding_mismatch" };
      }
      let row = persisted;
      if (row.lease_expires_at <= this.nowMs()) {
        const reactivated = this.reactivateExpiredRecoveryLease(row);
        if (!reactivated) return { status: "binding_mismatch" };
        row = reactivated;
      }

      let discarded;
      try {
        discarded = await discardQuarantinedDispatchedRuntimeWorker(
          this.options.db,
          {
            id: row.assistant_id,
            org_id: row.org_id,
          },
          row.lease_token,
          {
            workerStackId: row.runtime_stack_id,
            leaseGeneration: row.lease_generation,
          },
          this.nowMs(),
          this.nowIso,
          this.options.lifecycle,
          this.lifecycleHeartbeatOptions(),
        );
      } catch {
        return {
          status: "recovery_failed",
          reason: "release_callback_failed",
          retryBinding: bindingForPersistedLease(row),
        };
      }
      if (discarded.status === "released") return { status: "recovered" };
      if (
        discarded.status === "not_quarantined" ||
        discarded.status === "binding_mismatch"
      ) {
        return { status: discarded.status };
      }
      const retryRow = this.getPersistedLease(row.assistant_id);
      return {
        status: "recovery_failed",
        reason: discarded.status,
        ...(retryRow
          ? { retryBinding: bindingForPersistedLease(retryRow) }
          : {}),
      };
    });
  }

  private async routePooledRequest(
    identity: RuntimeWorkerRouteIdentity,
  ): Promise<RuntimeWorkerRequestRouteResult> {
    const owner = this.getAssistantOwner(identity.assistantId);
    if (
      !owner ||
      owner.org_id !== identity.organizationId ||
      owner.user_id !== identity.userId
    ) {
      return {
        mode: "unavailable",
        reason: "tenant_mismatch",
        retryAfterMs: null,
      };
    }

    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return {
        mode: "unavailable",
        reason: "coordinator_ownership_lost",
        retryAfterMs: null,
      };
    }

    const key = tenantKey(identity);
    let entry = this.entries.get(key);
    if (entry?.blockedReason) {
      return {
        mode: "unavailable",
        reason: entry.blockedReason,
        retryAfterMs: null,
      };
    }
    if (entry) {
      this.cancelIdleRelease(entry);
      const renewed = this.renewEntry(entry);
      if (renewed !== null) {
        entry.blockedReason = renewed;
        return { mode: "unavailable", reason: renewed, retryAfterMs: null };
      }
    } else {
      const recovered = await this.recoverPersistedLease(identity);
      if (recovered.kind === "unavailable") {
        return {
          mode: "unavailable",
          reason: recovered.reason,
          retryAfterMs: null,
        };
      }
      if (recovered.kind === "entry") {
        entry = recovered.entry;
        this.entries.set(key, entry);
      } else {
        let leaseToken: string;
        let dispatched;
        try {
          leaseToken = this.leaseTokenFactory();
          dispatched = await dispatchRuntimeWorker(
            this.options.db,
            { id: identity.assistantId, org_id: identity.organizationId },
            this.options.poolConfig,
            leaseToken,
            this.nowMs(),
            this.nowIso,
            this.options.lifecycle,
            this.lifecycleHeartbeatOptions(),
          );
        } catch {
          return {
            mode: "unavailable",
            reason: "worker_unavailable",
            retryAfterMs: null,
          };
        }
        if (dispatched.status !== "leased") {
          return {
            mode: "unavailable",
            reason:
              dispatched.status === "disabled"
                ? "coordinator_dependencies_unavailable"
                : dispatched.reason,
            retryAfterMs:
              dispatched.status === "unavailable"
                ? dispatched.retryAfterMs
                : null,
          };
        }
        if (this.options.onLeaseReady) {
          const checkpoint = getRuntimeWorkerStateCheckpoint(this.options.db, {
            orgId: identity.organizationId,
            assistantId: identity.assistantId,
          });
          try {
            if (
              !checkpoint ||
              checkpoint.status !== "ready" ||
              checkpoint.worker_stack_id !== dispatched.assignment.stack.id ||
              checkpoint.restored_generation !== checkpoint.generation ||
              !Number.isSafeInteger(checkpoint.generation) ||
              checkpoint.generation < 0 ||
              checkpoint.workspace_bytes === null ||
              !Number.isSafeInteger(checkpoint.workspace_bytes) ||
              checkpoint.workspace_bytes < 0
            ) {
              throw new Error(
                "Pooled runtime storage observation is unavailable.",
              );
            }
            await this.options.onLeaseReady({
              identity: { ...identity },
              workerStackId: dispatched.assignment.stack.id,
              leaseToken,
              leaseGeneration: dispatched.assignment.lease.lease_generation,
              stateGeneration: checkpoint.generation,
              observedBytes: checkpoint.workspace_bytes,
              observedAtMs: this.nowMs(),
            });
          } catch {
            await this.releaseUnroutableLease(identity, leaseToken);
            return {
              mode: "unavailable",
              reason: "worker_unavailable",
              retryAfterMs: null,
            };
          }
        }
        entry = {
          key,
          assistant: {
            id: identity.assistantId,
            org_id: identity.organizationId,
          },
          userId: identity.userId,
          leaseToken,
          assignment: dispatched.assignment,
          activeRequestHandles: new Set(),
          renewTimer: null,
          idleReleaseTimer: null,
          blockedReason: null,
        };
        this.entries.set(key, entry);
      }
    }

    let requestHandle: string;
    try {
      requestHandle = this.uniqueRequestHandle();
    } catch {
      if (entry.activeRequestHandles.size === 0) await this.releaseEntry(entry);
      return {
        mode: "unavailable",
        reason: "coordinator_dependencies_unavailable",
        retryAfterMs: null,
      };
    }
    let minted;
    let gatewayIngress;
    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return {
        mode: "unavailable",
        reason: "coordinator_ownership_lost",
        retryAfterMs: null,
      };
    }
    try {
      minted = mintRuntimeWorkerLeaseActorToken(
        this.options.db,
        {
          organizationId: identity.organizationId,
          userId: identity.userId,
          assistantId: identity.assistantId,
          actorId: identity.actorId,
          requestId: requestHandle,
          workerStackId: entry.assignment.stack.id,
          leaseToken: entry.leaseToken,
        },
        this.options.masterActorSigningKey!,
        this.nowMs(),
      );
      gatewayIngress = mintRuntimeWorkerLeaseServiceToken(
        this.options.db,
        {
          organizationId: identity.organizationId,
          userId: identity.userId,
          assistantId: identity.assistantId,
          workerStackId: entry.assignment.stack.id,
          leaseToken: entry.leaseToken,
          scopeProfile: "gateway_ingress_v1",
        },
        this.options.masterActorSigningKey!,
        this.nowMs(),
      );
    } catch {
      if (entry.activeRequestHandles.size === 0) await this.releaseEntry(entry);
      return {
        mode: "unavailable",
        reason: "actor_token_unavailable",
        retryAfterMs: null,
      };
    }

    entry.activeRequestHandles.add(requestHandle);
    this.activeRequests.set(requestHandle, { identity, entryKey: key });
    try {
      this.scheduleRenewal(entry);
    } catch {
      entry.activeRequestHandles.delete(requestHandle);
      this.activeRequests.delete(requestHandle);
      if (entry.activeRequestHandles.size === 0) await this.releaseEntry(entry);
      return {
        mode: "unavailable",
        reason: "coordinator_dependencies_unavailable",
        retryAfterMs: null,
      };
    }

    const gatewayUrl = entry.assignment.stack.gateway_url;
    if (!gatewayUrl) {
      entry.activeRequestHandles.delete(requestHandle);
      this.activeRequests.delete(requestHandle);
      if (entry.activeRequestHandles.size === 0) await this.releaseEntry(entry);
      return {
        mode: "unavailable",
        reason: "worker_unavailable",
        retryAfterMs: null,
      };
    }
    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return {
        mode: "unavailable",
        reason: "coordinator_ownership_lost",
        retryAfterMs: null,
      };
    }
    return {
      mode: "pooled",
      gatewayUrl,
      actorToken: minted.token,
      actorTokenExpiresAtSeconds: minted.expiresAtSeconds,
      gatewayIngressToken: gatewayIngress.token,
      requestHandle,
      binding: minted.binding,
    };
  }

  private coordinatorOwnershipIsLive(): boolean {
    if (this.ownershipFenced) return false;
    try {
      return this.options.coordinatorOwnership?.isLive() === true;
    } catch {
      return false;
    }
  }

  private getAssistantOwner(assistantId: string): AssistantOwnerRow | null {
    return (
      this.options.db
        .query<
          AssistantOwnerRow,
          [string]
        >("SELECT id, org_id, user_id FROM assistants WHERE id = ?")
        .get(assistantId) ?? null
    );
  }

  private getPersistedLease(assistantId: string): PersistedLeaseRow | null {
    return (
      this.options.db
        .query<PersistedLeaseRow, [string]>(
          `SELECT
             lease.runtime_stack_id,
             lease.assistant_id,
             lease.org_id,
             lease.lease_token,
             lease.lease_generation,
             lease.lease_expires_at,
             assistant.user_id
           FROM runtime_worker_leases AS lease
           JOIN assistants AS assistant
             ON assistant.id = lease.assistant_id
            AND assistant.org_id = lease.org_id
           WHERE lease.assistant_id = ?
             AND lease.lease_token IS NOT NULL`,
        )
        .get(assistantId) ?? null
    );
  }

  /**
   * Grants a bounded cleanup-only lease to the exact expired generation named
   * by an operator recovery request. Ordinary routing remains blocked because
   * no in-process RouteEntry is created.
   */
  private reactivateExpiredRecoveryLease(
    row: PersistedLeaseRow,
  ): PersistedLeaseRow | null {
    const nowMs = this.nowMs();
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      row.lease_expires_at > nowMs ||
      nowMs > Number.MAX_SAFE_INTEGER - this.options.poolConfig.leaseTtlMs
    ) {
      return null;
    }
    const nextExpiry = nowMs + this.options.poolConfig.leaseTtlMs;
    const updated = this.options.db
      .query(
        `UPDATE runtime_worker_leases
         SET lease_expires_at = ?, updated_at = ?
         WHERE runtime_stack_id = ?
           AND assistant_id = ?
           AND org_id = ?
           AND lease_token = ?
           AND lease_generation = ?
           AND lease_expires_at = ?
           AND lease_expires_at <= ?`,
      )
      .run(
        nextExpiry,
        this.nowIso(),
        row.runtime_stack_id,
        row.assistant_id,
        row.org_id,
        row.lease_token,
        row.lease_generation,
        row.lease_expires_at,
        nowMs,
      );
    if (updated.changes !== 1) return null;
    const reactivated = this.getPersistedLease(row.assistant_id);
    return reactivated &&
      reactivated.runtime_stack_id === row.runtime_stack_id &&
      reactivated.lease_token === row.lease_token &&
      reactivated.lease_generation === row.lease_generation &&
      reactivated.lease_expires_at === nextExpiry
      ? reactivated
      : null;
  }

  private async recoverPersistedLease(
    identity: RuntimeWorkerRouteIdentity,
  ): Promise<
    | { kind: "none" }
    | { kind: "entry"; entry: RouteEntry }
    | { kind: "unavailable"; reason: RuntimeWorkerRouteUnavailableReason }
  > {
    const row = this.getPersistedLease(identity.assistantId);
    if (!row) return { kind: "none" };
    if (
      row.org_id !== identity.organizationId ||
      row.user_id !== identity.userId ||
      row.assistant_id !== identity.assistantId
    ) {
      return { kind: "unavailable", reason: "tenant_mismatch" };
    }
    if (row.lease_expires_at <= this.nowMs()) {
      return { kind: "unavailable", reason: "orphaned_expired_lease" };
    }

    return { kind: "unavailable", reason: "restart_quarantined" };
  }

  private renewEntry(
    entry: RouteEntry,
  ): RuntimeWorkerRouteUnavailableReason | null {
    const renewed = renewDispatchedRuntimeWorker(
      this.options.db,
      entry.assistant,
      this.options.poolConfig,
      entry.leaseToken,
      this.nowMs(),
      this.nowIso,
      this.options.lifecycle,
    );
    if (renewed.status === "renewed") {
      entry.assignment = renewed.assignment;
      return null;
    }
    return renewed.status === "lease_lost"
      ? "lease_lost"
      : "worker_unavailable";
  }

  private lifecycleHeartbeatOptions(): RuntimeWorkerLifecycleLeaseHeartbeatOptions & {
    config: RuntimeWorkerPoolConfig;
  } {
    return {
      config: this.options.poolConfig,
      timer: this.options.timer!,
      nowMs: this.nowMs,
      nowIso: this.nowIso,
      intervalMs: this.renewIntervalMs,
    };
  }

  private scheduleRenewal(entry: RouteEntry): void {
    if (entry.renewTimer !== null || entry.activeRequestHandles.size === 0)
      return;
    entry.renewTimer = this.options.timer!.schedule(async () => {
      await this.exclusive(entry.key, async () => {
        entry.renewTimer = null;
        if (
          this.entries.get(entry.key) !== entry ||
          entry.activeRequestHandles.size === 0 ||
          entry.blockedReason
        ) {
          return;
        }
        if (!this.coordinatorOwnershipIsLive()) {
          await this.fenceCoordinatorOwnership();
          return;
        }
        const failure = this.renewEntry(entry);
        if (failure) {
          entry.blockedReason = failure;
          try {
            await this.options.revokeLeaseTokens!({
              binding: bindingForEntry(entry),
            });
          } catch {
            entry.blockedReason = "worker_unavailable";
          }
          return;
        }
        try {
          this.scheduleRenewal(entry);
        } catch {
          entry.blockedReason = "coordinator_dependencies_unavailable";
          try {
            await this.options.revokeLeaseTokens!({
              binding: bindingForEntry(entry),
            });
          } catch {
            entry.blockedReason = "worker_unavailable";
          }
        }
      });
    }, this.renewIntervalMs);
  }

  private cancelRenewal(entry: RouteEntry): void {
    if (entry.renewTimer === null) return;
    this.options.timer!.cancel(entry.renewTimer);
    entry.renewTimer = null;
  }

  private scheduleIdleRelease(entry: RouteEntry): void {
    if (entry.idleReleaseTimer !== null) return;
    entry.idleReleaseTimer = this.options.timer!.schedule(async () => {
      await this.exclusive(entry.key, async () => {
        entry.idleReleaseTimer = null;
        if (
          this.entries.get(entry.key) !== entry ||
          entry.activeRequestHandles.size !== 0
        ) {
          return;
        }
        if (!this.coordinatorOwnershipIsLive()) {
          await this.fenceCoordinatorOwnership();
          return;
        }
        await this.releaseEntry(entry);
      });
    }, this.idleReleaseDelayMs);
  }

  private cancelIdleRelease(entry: RouteEntry): void {
    if (entry.idleReleaseTimer === null) return;
    this.options.timer!.cancel(entry.idleReleaseTimer);
    entry.idleReleaseTimer = null;
  }

  private async releaseEntry(
    entry: RouteEntry,
  ): Promise<RuntimeWorkerRequestFinishResult> {
    if (entry.activeRequestHandles.size !== 0) {
      return {
        status: "active",
        activeRequestCount: entry.activeRequestHandles.size,
      };
    }
    if (!this.coordinatorOwnershipIsLive()) {
      await this.fenceCoordinatorOwnership();
      return {
        status: "release_failed",
        reason: "coordinator_ownership_lost",
      };
    }
    this.cancelRenewal(entry);
    this.cancelIdleRelease(entry);
    let released: RuntimeWorkerReleaseResult;
    try {
      released = await this.options.releaseLease!({
        db: this.options.db,
        assistant: entry.assistant,
        leaseToken: entry.leaseToken,
        nowMs: this.nowMs(),
        nowIso: this.nowIso,
        lifecycle: this.options.lifecycle!,
        lifecycleHeartbeat: this.lifecycleHeartbeatOptions(),
      });
    } catch {
      entry.blockedReason = "worker_unavailable";
      return { status: "release_failed", reason: "release_callback_failed" };
    }
    if (released.status === "released") {
      this.entries.delete(entry.key);
      return { status: "released" };
    }
    if (released.status === "state_quarantined") {
      // No request handles remain and the durable checkpoint now blocks all
      // routing. Remove the in-process entry so explicit operator cleanup can
      // sanitize/revoke the exact persisted generation without a restart.
      this.entries.delete(entry.key);
    }
    entry.blockedReason =
      released.status === "lease_lost" ? "lease_lost" : "worker_unavailable";
    return { status: "release_failed", reason: released.status };
  }

  private uniqueRequestHandle(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.requestHandleFactory();
      if (validOpaqueId(candidate) && !this.activeRequests.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique pooled request handle.");
  }

  private async releaseUnroutableLease(
    identity: RuntimeWorkerRouteIdentity,
    leaseToken: string,
  ): Promise<void> {
    try {
      await this.options.releaseLease!({
        db: this.options.db,
        assistant: {
          id: identity.assistantId,
          org_id: identity.organizationId,
        },
        leaseToken,
        nowMs: this.nowMs(),
        nowIso: this.nowIso,
        lifecycle: this.options.lifecycle!,
        lifecycleHeartbeat: this.lifecycleHeartbeatOptions(),
      });
    } catch {
      // The persisted lease remains fail-closed and cannot be reassigned.
    }
  }

  private async exclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serialTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.serialTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.serialTails.get(key) === current) {
        this.serialTails.delete(key);
      }
    }
  }
}

function persistedLeaseMatchesBinding(
  row: PersistedLeaseRow,
  binding: RuntimeWorkerLeaseServiceBinding,
): boolean {
  return (
    row.org_id === binding.organizationId &&
    row.user_id === binding.userId &&
    row.assistant_id === binding.assistantId &&
    row.runtime_stack_id === binding.workerStackId &&
    row.lease_generation === binding.leaseGeneration &&
    row.lease_expires_at === binding.leaseExpiresAtMs
  );
}

function bindingForPersistedLease(
  row: PersistedLeaseRow,
): RuntimeWorkerLeaseServiceBinding {
  return {
    organizationId: row.org_id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    workerStackId: row.runtime_stack_id,
    leaseGeneration: row.lease_generation,
    leaseExpiresAtMs: row.lease_expires_at,
  };
}
