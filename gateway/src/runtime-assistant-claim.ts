import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { getGatewaySecurityDir } from "./paths.js";

const CLAIM_FILE_NAME = "runtime-assistant-claim";
const MAX_ASSISTANT_ID_LENGTH = 256;

export type RuntimeAssistantClaimResult =
  | { ok: true; assistantId: string; claimed: boolean }
  | { ok: false; reason: "invalid" | "claimed_by_another_assistant" };

function claimPath(): string {
  return join(getGatewaySecurityDir(), CLAIM_FILE_NAME);
}

function normalizedAssistantId(value: string): string | null {
  const assistantId = value.trim();
  if (
    !assistantId ||
    assistantId.length > MAX_ASSISTANT_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(assistantId)
  ) {
    return null;
  }
  return assistantId;
}

export function readRuntimeAssistantClaim(): string | null {
  try {
    return normalizedAssistantId(readFileSync(claimPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function claimRuntimeAssistant(
  requestedAssistantId: string,
): RuntimeAssistantClaimResult {
  const assistantId = normalizedAssistantId(requestedAssistantId);
  if (!assistantId) return { ok: false, reason: "invalid" };

  const existing = readRuntimeAssistantClaim();
  if (existing) {
    return existing === assistantId
      ? { ok: true, assistantId: existing, claimed: false }
      : { ok: false, reason: "claimed_by_another_assistant" };
  }

  const destination = claimPath();
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, assistantId, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      linkSync(temporary, destination);
      return { ok: true, assistantId, claimed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = readRuntimeAssistantClaim();
      return winner === assistantId
        ? { ok: true, assistantId: winner, claimed: false }
        : { ok: false, reason: "claimed_by_another_assistant" };
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
