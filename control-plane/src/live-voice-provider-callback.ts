interface ManagedVoiceRoutingPayload {
  version?: unknown;
  assistantId?: unknown;
  sessionId?: unknown;
  expiresAtMs?: unknown;
}

/**
 * Decode the assistant id from a managed-voice session token for routing only.
 *
 * The control-plane cannot verify this token because the HMAC key and active
 * session lease intentionally live inside the assistant runtime. The runtime
 * remains the authority and validates the complete signed token before it
 * starts a turn. This helper only selects the isolated runtime that should
 * receive the callback.
 */
export function assistantIdFromManagedVoiceRoutingToken(
  token: string,
  nowMs = Date.now(),
): string | null {
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
    typeof payload.assistantId !== "string" ||
    !payload.assistantId.trim() ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId.trim() ||
    typeof payload.expiresAtMs !== "number" ||
    !Number.isFinite(payload.expiresAtMs) ||
    payload.expiresAtMs <= nowMs
  ) {
    return null;
  }

  return payload.assistantId;
}
