import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { VoiceEngineId } from "../config/schemas/voice.js";

const TOKEN_TTL_MS = 30 * 60 * 1000;
const signingKey = randomBytes(32);

export interface ManagedVoiceSessionBinding {
  sessionId: string;
  assistantId: string;
  conversationId: string;
  actorId: string;
  organizationId?: string;
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

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", signingKey).update(encodedPayload).digest();
}

function purgeExpired(now = Date.now()): void {
  for (const [sessionId, binding] of activeBySession) {
    if (binding.expiresAtMs > now) continue;
    activeBySession.delete(sessionId);
    if (activeByActor.get(binding.actorId) === sessionId) {
      activeByActor.delete(binding.actorId);
    }
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

  const binding: ManagedVoiceSessionBinding = {
    sessionId: input.sessionId,
    assistantId: input.assistantId,
    conversationId: input.conversationId,
    actorId: input.actorId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
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
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
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
    active.expiresAtMs !== payload.expiresAtMs
  ) {
    return null;
  }
  return { ...active };
}

export function releaseManagedVoiceSession(
  sessionId: string,
  actorId?: string,
): boolean {
  purgeExpired();
  const binding = activeBySession.get(sessionId);
  if (!binding || (actorId && binding.actorId !== actorId)) return false;
  activeBySession.delete(sessionId);
  for (const [
    providerConversationId,
    boundSessionId,
  ] of sessionByProviderConversation) {
    if (boundSessionId === sessionId) {
      sessionByProviderConversation.delete(providerConversationId);
    }
  }
  if (activeByActor.get(binding.actorId) === sessionId) {
    activeByActor.delete(binding.actorId);
  }
  return true;
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
  if (!binding || binding.expiresAtMs <= Date.now()) return null;
  return { ...binding };
}

export function resetManagedVoiceSessionsForTesting(): void {
  activeBySession.clear();
  activeByActor.clear();
  sessionByProviderConversation.clear();
}
