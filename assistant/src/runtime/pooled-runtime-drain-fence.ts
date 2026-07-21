import { isPooledWorkerRuntime } from "../config/env.js";
import type { AuthContext } from "./auth/types.js";
import {
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
} from "./routes/errors.js";

export interface PooledRuntimeLeaseIdentity {
  tenant: {
    orgId: string;
    assistantId: string;
  };
  workerStackId: string;
  generation: number;
}

export interface PooledRuntimeQuiescenceProof {
  activeTenantProcessCount: 0;
  activeTenantSessionCount: 0;
}

export interface PooledRuntimeQuiescenceProbe {
  proveQuiescent(
    identity: PooledRuntimeLeaseIdentity,
  ): Promise<PooledRuntimeQuiescenceProof>;
}

export interface PooledRuntimeDrainProof extends PooledRuntimeQuiescenceProof {
  tenant: PooledRuntimeLeaseIdentity["tenant"];
  workerStackId: string;
  generation: number;
  leaseDraining: true;
  activeTenantRequestCount: 0;
}

type DrainPhase =
  | "unbound"
  | "accepting"
  | "draining"
  | "mutating"
  | "quarantined"
  | "sanitized";

interface DrainState {
  phase: DrainPhase;
  identity: PooledRuntimeLeaseIdentity | null;
  activeRequests: number;
  activeSessions: number;
  maxGeneration: number;
}

export interface PooledRuntimeDrainController {
  beginDrain(identity: PooledRuntimeLeaseIdentity): void;
  withDrainingMutation<T>(
    identity: PooledRuntimeLeaseIdentity,
    operation: (proof: PooledRuntimeDrainProof) => Promise<T>,
  ): Promise<T>;
  withSanitizationMutation<T>(
    identity: PooledRuntimeLeaseIdentity,
    operation: (proof: PooledRuntimeDrainProof) => Promise<T>,
  ): Promise<T>;
  beginAssignmentMutation(identity: PooledRuntimeLeaseIdentity): void;
  proveAssignmentMutationQuiescent(
    identity: PooledRuntimeLeaseIdentity,
  ): Promise<PooledRuntimeDrainProof>;
  activateAssignment(identity: PooledRuntimeLeaseIdentity): void;
  quarantineAssignment(identity: PooledRuntimeLeaseIdentity): void;
  markSanitized(identity: PooledRuntimeLeaseIdentity): void;
}

const DESTRUCTIVE_OPERATION_IDS = new Set([
  "internal_pooled_worker_state_export",
  "internal_pooled_worker_state_restore",
  "internal_pooled_worker_prepare_empty",
  "internal_pooled_worker_state_sanitize",
]);

export class PooledRuntimeDrainFence implements PooledRuntimeDrainController {
  private readonly state: DrainState = {
    phase: "unbound",
    identity: null,
    activeRequests: 0,
    activeSessions: 0,
    maxGeneration: 0,
  };

  constructor(
    private readonly enabled: () => boolean,
    private readonly quiescenceProbe: PooledRuntimeQuiescenceProbe | null,
  ) {}

  acquireOrdinaryRequest(authContext: AuthContext | undefined): () => void {
    if (!this.enabled()) return () => {};
    return this.acquireActivity(requireLeaseIdentity(authContext), "request");
  }

  acquireOrdinarySession(authContext: AuthContext | undefined): () => void {
    if (!this.enabled()) return () => {};
    return this.acquireActivity(requireLeaseIdentity(authContext), "session");
  }

  beginDrain(identity: PooledRuntimeLeaseIdentity): void {
    if (!this.enabled()) {
      throw new ServiceUnavailableError(
        "Pooled runtime drain fencing is disabled.",
      );
    }
    const trusted = normalizeIdentity(identity);
    if (this.state.phase === "accepting") {
      this.assertCurrentIdentity(trusted);
      this.state.phase = "draining";
      return;
    }
    if (this.state.phase === "draining") {
      this.assertCurrentIdentity(trusted);
      return;
    }
    if (this.state.phase === "sanitized") {
      this.assertCurrentIdentity(trusted);
      return;
    }
    throw new ConflictError(
      "Pooled runtime is not in an active assignment that can begin draining.",
    );
  }

  async withDrainingMutation<T>(
    identity: PooledRuntimeLeaseIdentity,
    operation: (proof: PooledRuntimeDrainProof) => Promise<T>,
  ): Promise<T> {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "draining") {
      throw new ConflictError(
        "Pooled runtime mutation requires a generation-bound draining lease.",
      );
    }
    this.assertCurrentIdentity(trusted);
    const proof = await this.proveQuiescent(trusted);
    this.state.phase = "mutating";
    try {
      return await operation(proof);
    } finally {
      if (this.state.phase === "mutating") this.state.phase = "draining";
    }
  }

  async withSanitizationMutation<T>(
    identity: PooledRuntimeLeaseIdentity,
    operation: (proof: PooledRuntimeDrainProof) => Promise<T>,
  ): Promise<T> {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "draining" && this.state.phase !== "sanitized") {
      throw new ConflictError(
        "Pooled runtime sanitization requires a generation-bound draining or sanitized lease.",
      );
    }
    this.assertCurrentIdentity(trusted);
    const priorPhase = this.state.phase;
    const proof = await this.proveQuiescent(trusted);
    this.state.phase = "mutating";
    try {
      return await operation(proof);
    } finally {
      if (this.state.phase === "mutating") this.state.phase = priorPhase;
    }
  }

  beginAssignmentMutation(identity: PooledRuntimeLeaseIdentity): void {
    if (!this.enabled()) {
      throw new ServiceUnavailableError(
        "Pooled runtime drain fencing is disabled.",
      );
    }
    const trusted = normalizeIdentity(identity);
    if (
      this.state.activeRequests !== 0 ||
      this.state.activeSessions !== 0 ||
      this.state.phase === "mutating"
    ) {
      throw new ConflictError(
        "Pooled runtime assignment cannot change while tenant activity is active.",
      );
    }

    if (this.state.phase === "unbound") {
      this.bindAssignment(trusted, "mutating");
      return;
    }
    if (
      this.state.phase === "quarantined" &&
      this.state.identity &&
      sameIdentity(this.state.identity, trusted)
    ) {
      this.state.phase = "mutating";
      return;
    }
    if (
      this.state.phase === "sanitized" &&
      trusted.generation > this.state.maxGeneration
    ) {
      this.bindAssignment(trusted, "mutating");
      return;
    }
    throw new ConflictError(
      "Pooled runtime assignment is stale or the prior tenant was not sanitized.",
    );
  }

  async proveAssignmentMutationQuiescent(
    identity: PooledRuntimeLeaseIdentity,
  ): Promise<PooledRuntimeDrainProof> {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "mutating") {
      throw new ConflictError(
        "Pooled runtime assignment mutation is not active.",
      );
    }
    this.assertCurrentIdentity(trusted);
    return this.proveQuiescent(trusted);
  }

  activateAssignment(identity: PooledRuntimeLeaseIdentity): void {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "mutating") {
      throw new ConflictError(
        "Pooled runtime assignment cannot activate from its current state.",
      );
    }
    this.assertCurrentIdentity(trusted);
    this.state.phase = "accepting";
  }

  quarantineAssignment(identity: PooledRuntimeLeaseIdentity): void {
    const trusted = normalizeIdentity(identity);
    this.assertCurrentIdentity(trusted);
    if (this.state.phase === "mutating") this.state.phase = "quarantined";
  }

  markSanitized(identity: PooledRuntimeLeaseIdentity): void {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "mutating") {
      throw new ConflictError(
        "Pooled runtime sanitization did not hold the mutation fence.",
      );
    }
    this.assertCurrentIdentity(trusted);
    this.state.phase = "sanitized";
  }

  snapshotForTesting(): Readonly<DrainState> {
    return Object.freeze({
      ...this.state,
      identity: this.state.identity
        ? Object.freeze({
            ...this.state.identity,
            tenant: Object.freeze({ ...this.state.identity.tenant }),
          })
        : null,
    });
  }

  private acquireActivity(
    identity: PooledRuntimeLeaseIdentity,
    kind: "request" | "session",
  ): () => void {
    const trusted = normalizeIdentity(identity);
    if (this.state.phase !== "accepting") {
      throw new ServiceUnavailableError(
        "Pooled runtime is quarantined or draining and cannot accept new tenant work.",
      );
    }
    this.assertCurrentIdentity(trusted);
    if (kind === "request") this.state.activeRequests += 1;
    else this.state.activeSessions += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "request") {
        this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
      } else {
        this.state.activeSessions = Math.max(0, this.state.activeSessions - 1);
      }
    };
  }

  private bindAssignment(
    identity: PooledRuntimeLeaseIdentity,
    phase: Extract<DrainPhase, "mutating">,
  ): void {
    this.state.identity = identity;
    this.state.phase = phase;
    this.state.maxGeneration = Math.max(
      this.state.maxGeneration,
      identity.generation,
    );
  }

  private assertCurrentIdentity(identity: PooledRuntimeLeaseIdentity): void {
    if (!this.state.identity || !sameIdentity(this.state.identity, identity)) {
      throw new ForbiddenError(
        "Pooled runtime lease tenant, worker, or generation does not match the active assignment.",
      );
    }
  }

  private async proveQuiescent(
    identity: PooledRuntimeLeaseIdentity,
  ): Promise<PooledRuntimeDrainProof> {
    if (this.state.activeRequests !== 0 || this.state.activeSessions !== 0) {
      throw new ConflictError(
        "Pooled runtime drain requires zero active tenant requests and sessions.",
      );
    }
    if (!this.quiescenceProbe) {
      throw new ServiceUnavailableError(
        "Pooled runtime destructive operations require a runtime-wide quiescence probe covering background jobs, subprocesses, and non-request sessions.",
      );
    }
    const external = await this.quiescenceProbe.proveQuiescent(identity);
    if (
      external.activeTenantProcessCount !== 0 ||
      external.activeTenantSessionCount !== 0
    ) {
      throw new ConflictError(
        "Pooled runtime drain requires zero active tenant processes and sessions.",
      );
    }
    return Object.freeze({
      tenant: identity.tenant,
      workerStackId: identity.workerStackId,
      generation: identity.generation,
      leaseDraining: true,
      activeTenantRequestCount: 0,
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    });
  }
}

let productionQuiescenceProbe: PooledRuntimeQuiescenceProbe | null = null;
let productionFence: PooledRuntimeDrainFence | null = null;

export function installPooledRuntimeQuiescenceProbe(
  probe: PooledRuntimeQuiescenceProbe,
): () => void {
  if (productionQuiescenceProbe) {
    throw new Error("Pooled runtime quiescence probe is already installed.");
  }
  productionQuiescenceProbe = probe;
  productionFence = null;
  return () => {
    if (productionQuiescenceProbe === probe) {
      productionQuiescenceProbe = null;
      productionFence = null;
    }
  };
}

export function getProductionPooledRuntimeDrainFence(): PooledRuntimeDrainFence {
  productionFence ??= new PooledRuntimeDrainFence(
    isPooledWorkerRuntime,
    productionQuiescenceProbe,
  );
  return productionFence;
}

export function acquirePooledRuntimeRouteRequest(
  authContext: AuthContext | undefined,
  operationId: string | undefined,
): () => void {
  if (operationId && DESTRUCTIVE_OPERATION_IDS.has(operationId)) {
    return () => {};
  }
  return getProductionPooledRuntimeDrainFence().acquireOrdinaryRequest(
    authContext,
  );
}

export function acquirePooledRuntimeWebSocketSession(
  authContext: AuthContext | undefined,
): () => void {
  return getProductionPooledRuntimeDrainFence().acquireOrdinarySession(
    authContext,
  );
}

export function pooledRuntimeLeaseIdentityFromAuth(
  authContext: AuthContext | undefined,
): PooledRuntimeLeaseIdentity {
  return requireLeaseIdentity(authContext);
}

export function resetPooledRuntimeDrainFenceForTesting(): void {
  productionQuiescenceProbe = null;
  productionFence = null;
}

function requireLeaseIdentity(
  authContext: AuthContext | undefined,
): PooledRuntimeLeaseIdentity {
  const lease = authContext?.pooledWorkerLease;
  if (!lease) {
    throw new ForbiddenError(
      "Pooled runtime activity requires an authenticated worker lease.",
    );
  }
  return normalizeIdentity({
    tenant: {
      orgId: lease.organizationId,
      assistantId: lease.assistantId,
    },
    workerStackId: lease.workerStackId,
    generation: lease.leaseGeneration,
  });
}

function normalizeIdentity(
  identity: PooledRuntimeLeaseIdentity,
): PooledRuntimeLeaseIdentity {
  if (
    !isOpaqueId(identity.tenant.orgId) ||
    !isOpaqueId(identity.tenant.assistantId) ||
    !isOpaqueId(identity.workerStackId) ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1
  ) {
    throw new ForbiddenError("Pooled runtime lease identity is invalid.");
  }
  return Object.freeze({
    tenant: Object.freeze({ ...identity.tenant }),
    workerStackId: identity.workerStackId,
    generation: identity.generation,
  });
}

function sameIdentity(
  left: PooledRuntimeLeaseIdentity,
  right: PooledRuntimeLeaseIdentity,
): boolean {
  return (
    left.tenant.orgId === right.tenant.orgId &&
    left.tenant.assistantId === right.tenant.assistantId &&
    left.workerStackId === right.workerStackId &&
    left.generation === right.generation
  );
}

function isOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value.length <= 255 &&
    !/[\u0000-\u001f]/u.test(value)
  );
}
