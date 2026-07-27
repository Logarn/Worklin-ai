import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { VoiceEngineId } from "../config/schemas/voice.js";
import {
  captureCurrentPooledVoiceLease,
  isCurrentPooledVoiceLease,
  type PooledVoiceLeaseIdentity,
  registerActivePooledVoiceSession,
  unregisterActivePooledVoiceSession,
} from "../services/pooled-voice-lease-fence.js";

const TOKEN_TTL_MS = 30 * 60 * 1000;
export const MAX_PROVIDER_TURN_KEYS_PER_SESSION = 256;
const MAX_PROVIDER_TURN_KEY_LENGTH = 256;
const signingKey = randomBytes(32);

export interface ManagedVoiceSessionBinding {
  sessionId: string;
  assistantId: string;
  conversationId: string;
  actorId: string;
  organizationId?: string;
  pooledWorkerLease?: PooledVoiceLeaseIdentity;
  engine: Exclude<VoiceEngineId, "native">;
  expiresAtMs: number;
}

interface TokenPayload extends ManagedVoiceSessionBinding {
  version: 1;
  nonce: string;
}

const activeBySession = new Map<string, ManagedVoiceSessionBinding>();
const activeByActor = new Map<string, string>();
const sessionByProviderConversation = new Map<string, string>();
const providerTurnKeysBySession = new Map<string, Set<string>>();
const highestElevenLabsEventIdBySession = new Map<string, number>();

function removeSessionState(
  sessionId: string,
  binding?: ManagedVoiceSessionBinding,
): void {
  activeBySession.delete(sessionId);
  unregisterActivePooledVoiceSession(sessionId);
  providerTurnKeysBySession.delete(sessionId);
  highestElevenLabsEventIdBySession.delete(sessionId);
  for (const [
    providerConversationId,
    boundSessionId,
  ] of sessionByProviderConversation) {
    if (boundSessionId === sessionId) {
      sessionByProviderConversation.delete(providerConversationId);
    }
  }
  if (binding && activeByActor.get(binding.actorId) === sessionId) {
    activeByActor.delete(binding.actorId);
  }
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", signingKey).update(encodedPayload).digest();
}

function purgeExpired(now = Date.now()): void {
  for (const [sessionId, binding] of activeBySession) {
    if (binding.expiresAtMs > now) continue;
    removeSessionState(sessionId, binding);
  }
}

export function createManagedVoiceSession(
  input: Omit<ManagedVoiceSessionBinding, "expiresAtMs"> & {
    ttlMs?: number;
  },
): { binding: ManagedVoiceSessionBinding; token: string } {
  purgeExpired();
  const existingSessionId = activeByActor.get(input.actorId);
  if (existingSessionId) {
    throw new Error(`voice_session_busy:${existingSessionId}`);
  }

  const tenant = input.organizationId
    ? {
        orgId: input.organizationId,
        assistantId: input.assistantId,
      }
    : null;
  const pooledWorkerLease = captureCurrentPooledVoiceLease(
    tenant,
    input.pooledWorkerLease,
  );
  const binding: ManagedVoiceSessionBinding = {
    sessionId: input.sessionId,
    assistantId: input.assistantId,
    conversationId: input.conversationId,
    actorId: input.actorId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(pooledWorkerLease ? { pooledWorkerLease } : {}),
    engine: input.engine,
    expiresAtMs: Date.now() + (input.ttlMs ?? TOKEN_TTL_MS),
  };
  const payload: TokenPayload = {
    version: 1,
    nonce: randomBytes(16).toString("hex"),
    ...binding,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  const token = `${encodedPayload}.${encode(sign(encodedPayload))}`;
  if (binding.expiresAtMs > Date.now()) {
    registerActivePooledVoiceSession({
      sessionId: binding.sessionId,
      tenant,
      lease: pooledWorkerLease,
      expiresAtMs: binding.expiresAtMs,
    });
  }
  activeBySession.set(binding.sessionId, binding);
  activeByActor.set(binding.actorId, binding.sessionId);
  return { binding, token };
}

export function verifyManagedVoiceSessionToken(
  token: string,
): ManagedVoiceSessionBinding | null {
  purgeExpired();
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra) return null;

  const expected = sign(payloadPart);
  const actual = Buffer.from(signaturePart, "base64url");
  if (
    encode(actual) !== signaturePart ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as TokenPayload;
  } catch {
    return null;
  }
  if (
    payload.version !== 1 ||
    payload.expiresAtMs <= Date.now() ||
    !payload.sessionId ||
    !payload.actorId
  ) {
    return null;
  }
  const active = activeBySession.get(payload.sessionId);
  if (
    !active ||
    active.actorId !== payload.actorId ||
    active.engine !== payload.engine ||
    active.assistantId !== payload.assistantId ||
    active.conversationId !== payload.conversationId ||
    active.organizationId !== payload.organizationId ||
    !samePooledWorkerLease(
      active.pooledWorkerLease,
      payload.pooledWorkerLease,
    ) ||
    active.expiresAtMs !== payload.expiresAtMs
  ) {
    return null;
  }
  if (!isCurrentPooledVoiceLease(active.pooledWorkerLease)) {
    removeSessionState(active.sessionId, active);
    return null;
  }
  return { ...active };
}

function samePooledWorkerLease(
  left: PooledVoiceLeaseIdentity | undefined,
  right: PooledVoiceLeaseIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.tenant.orgId === right.tenant.orgId &&
    left.tenant.assistantId === right.tenant.assistantId &&
    left.workerStackId === right.workerStackId &&
    left.generation === right.generation
  );
}

export function isManagedVoiceSessionBindingCurrent(
  binding: ManagedVoiceSessionBinding,
): boolean {
  const active = activeBySession.get(binding.sessionId);
  if (
    active === undefined ||
    active.actorId !== binding.actorId ||
    active.expiresAtMs !== binding.expiresAtMs ||
    !samePooledWorkerLease(active.pooledWorkerLease, binding.pooledWorkerLease)
  ) {
    return false;
  }
  if (!isCurrentPooledVoiceLease(active.pooledWorkerLease)) {
    removeSessionState(active.sessionId, active);
    return false;
  }
  return true;
}

export function releaseManagedVoiceSession(
  sessionId: string,
  actorId?: string,
): boolean {
  purgeExpired();
  const binding = activeBySession.get(sessionId);
  if (!binding || (actorId && binding.actorId !== actorId)) return false;
  removeSessionState(sessionId, binding);
  return true;
}

export type ManagedVoiceProviderTurnClaim =
  | { status: "accepted"; binding: ManagedVoiceSessionBinding }
  | { status: "invalid" | "limit_exceeded" | "replayed" };

/**
 * Atomically validates a provider callback and consumes its provider-stable
 * request key. A provider retry cannot start a second Worklin turn.
 */
export function claimManagedVoiceProviderTurn(
  token: string,
  requestKey: string,
): ManagedVoiceProviderTurnClaim {
  const binding = verifyManagedVoiceSessionToken(token);
  if (
    !binding ||
    !requestKey ||
    requestKey.length > MAX_PROVIDER_TURN_KEY_LENGTH
  ) {
    return { status: "invalid" };
  }
  const seen =
    providerTurnKeysBySession.get(binding.sessionId) ?? new Set<string>();
  if (seen.has(requestKey)) return { status: "replayed" };
  if (seen.size >= MAX_PROVIDER_TURN_KEYS_PER_SESSION) {
    return { status: "limit_exceeded" };
  }
  seen.add(requestKey);
  providerTurnKeysBySession.set(binding.sessionId, seen);
  return { status: "accepted", binding };
}

export type ManagedVoiceProviderEventClaim =
  | { status: "accepted"; binding: ManagedVoiceSessionBinding }
  | { status: "invalid" | "limit_exceeded" | "replayed" | "stale" };

export function claimManagedVoiceProviderConversationEvent(
  providerConversationId: string,
  eventId: number,
): ManagedVoiceProviderEventClaim {
  if (!Number.isSafeInteger(eventId) || eventId < 0) {
    return { status: "invalid" };
  }
  const binding = getManagedVoiceSessionByProviderConversation(
    providerConversationId,
  );
  if (!binding || binding.engine !== "elevenlabs") {
    return { status: "invalid" };
  }
  const seen =
    providerTurnKeysBySession.get(binding.sessionId) ?? new Set<string>();
  const requestKey = `elevenlabs:event:${eventId}`;
  if (seen.has(requestKey)) return { status: "replayed" };
  const highest =
    highestElevenLabsEventIdBySession.get(binding.sessionId) ?? -1;
  if (eventId <= highest) return { status: "stale" };
  if (seen.size >= MAX_PROVIDER_TURN_KEYS_PER_SESSION) {
    return { status: "limit_exceeded" };
  }
  seen.add(requestKey);
  providerTurnKeysBySession.set(binding.sessionId, seen);
  highestElevenLabsEventIdBySession.set(binding.sessionId, eventId);
  return { status: "accepted", binding };
}

export function bindManagedVoiceProviderConversation(input: {
  token: string;
  sessionId: string;
  actorId: string;
  providerConversationId: string;
}): boolean {
  const binding = verifyManagedVoiceSessionToken(input.token);
  if (
    !binding ||
    binding.engine !== "elevenlabs" ||
    binding.sessionId !== input.sessionId ||
    binding.actorId !== input.actorId
  ) {
    return false;
  }
  const existingSessionId = sessionByProviderConversation.get(
    input.providerConversationId,
  );
  if (existingSessionId && existingSessionId !== input.sessionId) {
    return false;
  }
  sessionByProviderConversation.set(
    input.providerConversationId,
    input.sessionId,
  );
  return true;
}

export function getManagedVoiceSessionByProviderConversation(
  providerConversationId: string,
): ManagedVoiceSessionBinding | null {
  const sessionId = sessionByProviderConversation.get(providerConversationId);
  if (!sessionId) return null;
  const binding = activeBySession.get(sessionId);
  if (!binding || binding.expiresAtMs <= Date.now()) {
    if (binding) removeSessionState(sessionId, binding);
    return null;
  }
  if (!isCurrentPooledVoiceLease(binding.pooledWorkerLease)) {
    removeSessionState(sessionId, binding);
    return null;
  }
  return { ...binding };
}

export function resetManagedVoiceSessionsForTesting(): void {
  for (const sessionId of activeBySession.keys()) {
    unregisterActivePooledVoiceSession(sessionId);
  }
  activeBySession.clear();
  activeByActor.clear();
  sessionByProviderConversation.clear();
  providerTurnKeysBySession.clear();
  highestElevenLabsEventIdBySession.clear();
}
