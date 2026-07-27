import { isPooledWorkerRuntime } from "../config/env.js";
import {
  measurePooledWorkspaceState,
  pooledStateArchivePathForFile,
  pooledStateSerializedContentByteSize,
} from "./migrations/pooled-state-export.js";
import type { PooledRuntimeLeaseIdentity } from "./pooled-runtime-drain-fence.js";
import { ServiceUnavailableError } from "./routes/errors.js";

interface PooledWorkspaceQuotaAssignment {
  identity: PooledRuntimeLeaseIdentity;
  workspaceDir: string;
  quotaBytes: number;
}

let activeAssignment: PooledWorkspaceQuotaAssignment | null = null;

/**
 * Bind the control-plane-authoritative workspace quota to the authenticated
 * assignment. Installation includes a full export-equivalent scan so an
 * already-oversized restored/bootstrap workspace never becomes request-ready.
 */
export function installPooledWorkspaceQuotaForAssignment(
  identity: PooledRuntimeLeaseIdentity,
  workspaceDir: string,
  quotaBytes: number,
): number {
  assertQuotaBytes(quotaBytes);
  if (activeAssignment) {
    throw new ServiceUnavailableError(
      "Pooled workspace quota state was not cleared before assignment.",
    );
  }
  const measurement = measurePooledWorkspaceState(workspaceDir);
  if (measurement.totalBytes > quotaBytes) {
    throw new ServiceUnavailableError(
      "Pooled workspace exceeds its configured storage quota.",
    );
  }
  activeAssignment = Object.freeze({
    identity: freezeIdentity(identity),
    workspaceDir,
    quotaBytes,
  });
  return measurement.totalBytes;
}

export function assertPooledWorkspaceQuotaAssignment(
  identity: PooledRuntimeLeaseIdentity,
  workspaceDir: string,
  quotaBytes: number,
): void {
  assertQuotaBytes(quotaBytes);
  const assignment = requireActivePooledWorkspaceQuota();
  if (
    !sameIdentity(assignment.identity, identity) ||
    assignment.workspaceDir !== workspaceDir ||
    assignment.quotaBytes !== quotaBytes
  ) {
    throw new ServiceUnavailableError(
      "Pooled workspace quota does not match the active assignment.",
    );
  }
}

/**
 * Exact synchronous preflight for the two pooled filesystem mutation tools.
 * The scan and subsequent write happen in one JS turn, so cumulative writes
 * cannot race each other inside this worker process.
 */
export function assertPooledWorkspaceFileMutationWithinQuota(input: {
  filePath: string;
  content: string;
}): void {
  if (!isPooledWorkerRuntime()) return;
  const assignment = requireActivePooledWorkspaceQuota();
  const archivePath = pooledStateArchivePathForFile(
    assignment.workspaceDir,
    input.filePath,
  );
  if (!archivePath) {
    throw new ServiceUnavailableError(
      "Pooled workspace writes must target quota-accounted tenant state.",
    );
  }

  const measurement = measurePooledWorkspaceState(assignment.workspaceDir);
  const priorBytes = measurement.files.get(archivePath) ?? 0;
  const nextBytes = pooledStateSerializedContentByteSize(
    archivePath,
    input.content,
  );
  const projectedBytes = measurement.totalBytes - priorBytes + nextBytes;
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes < 0) {
    throw new ServiceUnavailableError(
      "Pooled workspace projected storage size is invalid.",
    );
  }
  if (projectedBytes > assignment.quotaBytes) {
    throw new ServiceUnavailableError(
      "Pooled workspace write would exceed its configured storage quota.",
    );
  }
}

export function resetPooledWorkspaceQuotaForTenantAssignment(): void {
  activeAssignment = null;
}

export function getPooledWorkspaceQuotaAssignmentForTesting(): Readonly<{
  identity: PooledRuntimeLeaseIdentity;
  workspaceDir: string;
  quotaBytes: number;
}> | null {
  return activeAssignment;
}

function requireActivePooledWorkspaceQuota(): PooledWorkspaceQuotaAssignment {
  if (!activeAssignment) {
    throw new ServiceUnavailableError(
      "Pooled workspace quota is unavailable for this assignment.",
    );
  }
  return activeAssignment;
}

function assertQuotaBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServiceUnavailableError(
      "Pooled workspace quota is invalid for this assignment.",
    );
  }
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

function freezeIdentity(
  identity: PooledRuntimeLeaseIdentity,
): PooledRuntimeLeaseIdentity {
  return Object.freeze({
    tenant: Object.freeze({ ...identity.tenant }),
    workerStackId: identity.workerStackId,
    generation: identity.generation,
  });
}
