export interface PooledVoiceTenant {
  orgId: string;
  assistantId: string;
}

export interface PooledVoiceLeaseIdentity {
  tenant: PooledVoiceTenant;
  workerStackId: string;
  generation: number;
}

export interface PooledVoiceSanitizationProof {
  tenant: PooledVoiceTenant;
  workerStackId: string;
  activeVoiceSessionCount: 0;
}

type PooledVoiceLeaseResolver = () => PooledVoiceLeaseIdentity | null;

interface ActivePooledVoiceSession {
  tenant: PooledVoiceTenant | null;
  lease: PooledVoiceLeaseIdentity | null;
  expiresAtMs: number;
}

interface SanitizationFence {
  tenant: PooledVoiceTenant;
  workerStackId: string;
}

const activeSessions = new Map<string, ActivePooledVoiceSession>();
const sanitizationFences = new Map<string, SanitizationFence>();
let authoritativeLeaseResolver: PooledVoiceLeaseResolver | null = null;

function pooledVoiceLeaseFencingEnabled(): boolean {
  const runtimeMode = process.env.WORKLIN_RUNTIME_MODE?.trim().toLowerCase();
  return (
    runtimeMode === "pooled" ||
    runtimeMode === "pooled_worker" ||
    Boolean(process.env.WORKLIN_RUNTIME_WORKER_STACK_ID?.trim()) ||
    process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED?.trim().toLowerCase() ===
      "true" ||
    process.env.WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED?.trim().toLowerCase() ===
      "true"
  );
}

function assertOpaqueId(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Pooled voice ${label} id is invalid.`);
  }
  return value;
}

function normalizeTenant(tenant: PooledVoiceTenant): PooledVoiceTenant {
  return Object.freeze({
    orgId: assertOpaqueId(tenant.orgId, "organization"),
    assistantId: assertOpaqueId(tenant.assistantId, "assistant"),
  });
}

function normalizeLease(
  lease: PooledVoiceLeaseIdentity,
): PooledVoiceLeaseIdentity {
  if (!Number.isSafeInteger(lease.generation) || lease.generation < 1) {
    throw new Error("Pooled voice lease generation is invalid.");
  }
  return Object.freeze({
    tenant: normalizeTenant(lease.tenant),
    workerStackId: assertOpaqueId(lease.workerStackId, "worker stack"),
    generation: lease.generation,
  });
}

function sameTenant(
  left: PooledVoiceTenant,
  right: PooledVoiceTenant,
): boolean {
  return left.orgId === right.orgId && left.assistantId === right.assistantId;
}

export function samePooledVoiceLease(
  left: PooledVoiceLeaseIdentity,
  right: PooledVoiceLeaseIdentity,
): boolean {
  return (
    sameTenant(left.tenant, right.tenant) &&
    left.workerStackId === right.workerStackId &&
    left.generation === right.generation
  );
}

function resolveAuthoritativeLease(): PooledVoiceLeaseIdentity | null {
  if (!pooledVoiceLeaseFencingEnabled()) return null;
  if (!authoritativeLeaseResolver) {
    throw new Error("Pooled voice lease authority is unavailable.");
  }
  const lease = authoritativeLeaseResolver();
  if (!lease) throw new Error("Pooled voice worker has no active lease.");
  return normalizeLease(lease);
}

export function captureCurrentPooledVoiceLease(
  tenant: PooledVoiceTenant | null,
  authenticatedLease?: PooledVoiceLeaseIdentity,
): PooledVoiceLeaseIdentity | null {
  if (!pooledVoiceLeaseFencingEnabled()) return null;
  if (!tenant) {
    throw new Error("Pooled voice session requires an authenticated tenant.");
  }
  const trustedTenant = normalizeTenant(tenant);
  const lease = resolveAuthoritativeLease();
  if (!lease || !sameTenant(lease.tenant, trustedTenant)) {
    throw new Error(
      "Pooled voice session tenant does not match the active worker lease.",
    );
  }
  if (authenticatedLease) {
    const trustedLease = normalizeLease(authenticatedLease);
    if (
      !sameTenant(trustedLease.tenant, trustedTenant) ||
      !samePooledVoiceLease(trustedLease, lease)
    ) {
      throw new Error(
        "Pooled voice session authentication lease is stale or mismatched.",
      );
    }
    return trustedLease;
  }
  return lease;
}

export function isCurrentPooledVoiceLease(
  lease: PooledVoiceLeaseIdentity | null | undefined,
): boolean {
  if (!lease) return !pooledVoiceLeaseFencingEnabled();
  if (!pooledVoiceLeaseFencingEnabled()) return false;
  try {
    const current = resolveAuthoritativeLease();
    return current !== null && samePooledVoiceLease(current, lease);
  } catch {
    return false;
  }
}

function sessionConflictsWithFence(
  session: ActivePooledVoiceSession,
  fence: SanitizationFence,
): boolean {
  if (!session.lease) return true;
  return (
    session.lease.workerStackId === fence.workerStackId ||
    sameTenant(session.lease.tenant, fence.tenant)
  );
}

function purgeExpiredSessions(nowMs = Date.now()): void {
  for (const [sessionId, session] of activeSessions) {
    if (session.expiresAtMs <= nowMs) activeSessions.delete(sessionId);
  }
}

export function registerActivePooledVoiceSession(input: {
  sessionId: string;
  tenant: PooledVoiceTenant | null;
  lease: PooledVoiceLeaseIdentity | null;
  expiresAtMs: number;
}): void {
  assertOpaqueId(input.sessionId, "session");
  if (
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= Date.now()
  ) {
    throw new Error("Pooled voice session expiry is invalid.");
  }
  const tenant = input.tenant ? normalizeTenant(input.tenant) : null;
  const lease = input.lease ? normalizeLease(input.lease) : null;
  if (lease && (!tenant || !sameTenant(lease.tenant, tenant))) {
    throw new Error("Pooled voice session lease tenant is inconsistent.");
  }
  if (
    pooledVoiceLeaseFencingEnabled() &&
    (!lease || !isCurrentPooledVoiceLease(lease))
  ) {
    throw new Error("Pooled voice session lease is stale or unavailable.");
  }
  const session: ActivePooledVoiceSession = {
    tenant,
    lease,
    expiresAtMs: input.expiresAtMs,
  };
  for (const fence of sanitizationFences.values()) {
    if (sessionConflictsWithFence(session, fence)) {
      throw new Error(
        "Pooled voice session cannot start during workspace sanitization.",
      );
    }
  }
  if (activeSessions.has(input.sessionId)) {
    throw new Error("Pooled voice session id is already active.");
  }
  activeSessions.set(input.sessionId, session);
}

export function unregisterActivePooledVoiceSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export function getPooledVoiceSanitizationProof(input: {
  tenant: PooledVoiceTenant;
  workerStackId: string;
}): PooledVoiceSanitizationProof {
  const fence: SanitizationFence = {
    tenant: normalizeTenant(input.tenant),
    workerStackId: assertOpaqueId(input.workerStackId, "worker stack"),
  };
  purgeExpiredSessions();
  let activeVoiceSessionCount = 0;
  for (const session of activeSessions.values()) {
    if (sessionConflictsWithFence(session, fence)) {
      activeVoiceSessionCount += 1;
    }
  }
  if (activeVoiceSessionCount !== 0) {
    throw new Error(
      "Pooled workspace sanitization requires zero active voice sessions.",
    );
  }
  return Object.freeze({
    tenant: fence.tenant,
    workerStackId: fence.workerStackId,
    activeVoiceSessionCount: 0,
  });
}

export async function withPooledVoiceSanitizationFence<T>(
  input: {
    tenant: PooledVoiceTenant;
    workerStackId: string;
  },
  operation: (proof: PooledVoiceSanitizationProof) => Promise<T>,
): Promise<T> {
  const fence: SanitizationFence = {
    tenant: normalizeTenant(input.tenant),
    workerStackId: assertOpaqueId(input.workerStackId, "worker stack"),
  };
  if (sanitizationFences.has(fence.workerStackId)) {
    throw new Error("Pooled workspace sanitization is already in progress.");
  }
  sanitizationFences.set(fence.workerStackId, fence);
  try {
    const proof = getPooledVoiceSanitizationProof(fence);
    return await operation(proof);
  } finally {
    sanitizationFences.delete(fence.workerStackId);
  }
}

export function installInternalPooledVoiceLeaseAuthority(
  resolver: PooledVoiceLeaseResolver,
): () => void {
  if (!pooledVoiceLeaseFencingEnabled()) {
    throw new Error("Pooled voice lease fencing is disabled.");
  }
  if (authoritativeLeaseResolver) {
    throw new Error("Pooled voice lease authority is already installed.");
  }
  authoritativeLeaseResolver = resolver;
  return () => {
    if (authoritativeLeaseResolver === resolver) {
      authoritativeLeaseResolver = null;
    }
  };
}

export function resetPooledVoiceLeaseFenceForTesting(): void {
  activeSessions.clear();
  sanitizationFences.clear();
  authoritativeLeaseResolver = null;
}
