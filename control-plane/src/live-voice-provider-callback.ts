interface ManagedVoiceRoutingPayload {
  version?: unknown;
  assistantId?: unknown;
  sessionId?: unknown;
  expiresAtMs?: unknown;
}

export interface ManagedVoiceRoutingHint {
  assistantId: string;
  sessionId: string;
  expiresAtMs: number;
}

/**
 * Decode a managed-voice session token for routing only.
 *
 * The control-plane cannot verify this token because the HMAC key and active
 * session lease intentionally live inside the assistant runtime. The runtime
 * remains the authority and validates the complete signed token before it
 * starts a turn. Callers must additionally match this hint to an authenticated
 * session lease that the control-plane already holds; the decoded fields alone
 * never authorize a request.
 */
export function managedVoiceRoutingHintFromToken(
  token: string,
  nowMs = Date.now(),
): ManagedVoiceRoutingHint | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra) return null;

  let payload: ManagedVoiceRoutingPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as ManagedVoiceRoutingPayload;
  } catch {
    return null;
  }

  if (
    payload.version !== 1 ||
    !validOpaqueId(payload.assistantId) ||
    !validOpaqueId(payload.sessionId) ||
    typeof payload.expiresAtMs !== "number" ||
    !Number.isSafeInteger(payload.expiresAtMs) ||
    payload.expiresAtMs <= nowMs
  ) {
    return null;
  }

  return {
    assistantId: payload.assistantId,
    sessionId: payload.sessionId,
    expiresAtMs: payload.expiresAtMs,
  };
}

export function assistantIdFromManagedVoiceRoutingToken(
  token: string,
  nowMs = Date.now(),
): string | null {
  return managedVoiceRoutingHintFromToken(token, nowMs)?.assistantId ?? null;
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
