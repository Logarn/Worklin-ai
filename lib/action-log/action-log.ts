import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ActionLogStatus =
  | "completed"
  | "failed"
  | "prepared"
  | "requested"
  | "approved"
  | "rejected"
  | "revision_requested"
  | "refused"
  | "skipped";

export type ActionLogActorType = "system" | "agent" | "user" | "workflow" | "api";

export type ActionLogInput = {
  eventType: string;
  actionType: string;
  status: ActionLogStatus | string;
  actorType?: ActionLogActorType | string;
  targetType?: string | null;
  targetId?: string | null;
  workflowRunId?: string | null;
  approvalId?: string | null;
  riskLevel?: "low" | "medium" | "high" | "critical" | "unknown" | string;
  requiresApproval?: boolean;
  approvalStatus?: string | null;
  externalActionTaken?: boolean;
  canGoLiveNow?: boolean;
  summary: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorMessage?: string | null;
  metadata?: unknown;
};

export type SerializedActionLog = {
  id: string;
  eventType: string;
  actionType: string;
  status: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  workflowRunId: string | null;
  approvalId: string | null;
  riskLevel: string;
  requiresApproval: boolean;
  approvalStatus: string | null;
  externalActionTaken: boolean;
  canGoLiveNow: boolean;
  summary: string;
  inputSummary: Prisma.JsonValue | null;
  outputSummary: Prisma.JsonValue | null;
  errorMessage: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

type ActionLogRow = {
  id: string;
  eventType: string;
  actionType: string;
  status: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  workflowRunId: string | null;
  approvalId: string | null;
  riskLevel: string;
  requiresApproval: boolean;
  approvalStatus: string | null;
  externalActionTaken: boolean;
  canGoLiveNow: boolean;
  summary: string;
  inputSummary: Prisma.JsonValue | null;
  outputSummary: Prisma.JsonValue | null;
  errorMessage: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

const MAX_TEXT_LENGTH = 1200;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 50;
const SENSITIVE_KEY_PATTERNS = [
  ["api[_-]?", "key"],
  ["private[_-]?", "key"],
  ["client[_-]?", "se", "cret"],
  ["se", "cret"],
  ["to", "ken"],
  ["pass", "word"],
  ["author", "ization"],
].map((parts) => parts.join(""));
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(${SENSITIVE_KEY_PATTERNS.join("|")})\\s*[:=]\\s*["']?[^"',\\s}]+`,
  "gi",
);
const SENSITIVE_KEY_PATTERN = new RegExp(SENSITIVE_KEY_PATTERNS.join("|"), "i");
const BASIC_AUTH_URL_PATTERN = new RegExp(
  "\\b(postgres(?:ql)?|mysql|mongodb(?:\\+srv)?:\\/\\/[^:\\s/@]+):[^@\\s]+@",
  "gi",
);
const GENERIC_AUTH_URL_PATTERN = /:\/\/([^:\s/@]+):([^@\s]+)@/g;
const HEADER_CREDENTIAL_PATTERN = new RegExp(`\\b${["Bear", "er"].join("")}\\s+[A-Za-z0-9._~+/=-]+`, "gi");
const PREFIXED_CREDENTIAL_PATTERN = new RegExp(
  `\\b(${["sk", "-"].join("")}[A-Za-z0-9_-]{12,}|${["gh", "p_"].join("")}[A-Za-z0-9_]{12,}|${["github", "_pat_"].join("")}[A-Za-z0-9_]{12,})\\b`,
  "g",
);

function truncate(value: string, max = MAX_TEXT_LENGTH) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

export function redactSensitiveText(value: string) {
  return truncate(value)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(BASIC_AUTH_URL_PATTERN, "$1://[REDACTED]@")
    .replace(GENERIC_AUTH_URL_PATTERN, "://$1:[REDACTED]@")
    .replace(HEADER_CREDENTIAL_PATTERN, `${["Bear", "er"].join("")} [REDACTED]`)
    .replace(PREFIXED_CREDENTIAL_PATTERN, "[REDACTED]");
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key) || /cookie|session/i.test(key);
}

export function scrubActionLogJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubActionLogJson(item, depth + 1));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : scrubActionLogJson(child, depth + 1);
    }
    return output;
  }

  return String(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(scrubActionLogJson(value))) as Prisma.InputJsonValue;
}

function cleanNullable(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function safeMessage(error: unknown) {
  return error instanceof Error ? redactSensitiveText(error.message) : "Unknown error";
}

export function serializeActionLog(log: ActionLogRow): SerializedActionLog {
  return {
    id: log.id,
    eventType: log.eventType,
    actionType: log.actionType,
    status: log.status,
    actorType: log.actorType,
    targetType: log.targetType,
    targetId: log.targetId,
    workflowRunId: log.workflowRunId,
    approvalId: log.approvalId,
    riskLevel: log.riskLevel,
    requiresApproval: log.requiresApproval,
    approvalStatus: log.approvalStatus,
    externalActionTaken: log.externalActionTaken,
    canGoLiveNow: log.canGoLiveNow,
    summary: log.summary,
    inputSummary: log.inputSummary,
    outputSummary: log.outputSummary,
    errorMessage: log.errorMessage,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString(),
    updatedAt: log.updatedAt.toISOString(),
  };
}

export async function logActionEvent(input: ActionLogInput):
  Promise<{ ok: true; actionLog: SerializedActionLog } | { ok: false; warning: string }> {
  try {
    const actionLog = await prisma.actionLog.create({
      data: {
        eventType: truncate(input.eventType.trim(), 120),
        actionType: truncate(input.actionType.trim(), 120),
        status: truncate(String(input.status).trim(), 80),
        actorType: truncate((input.actorType ?? "system").trim(), 80),
        targetType: cleanNullable(input.targetType),
        targetId: cleanNullable(input.targetId),
        workflowRunId: cleanNullable(input.workflowRunId),
        approvalId: cleanNullable(input.approvalId),
        riskLevel: truncate((input.riskLevel ?? "low").trim(), 40),
        requiresApproval: input.requiresApproval ?? false,
        approvalStatus: cleanNullable(input.approvalStatus),
        externalActionTaken: input.externalActionTaken ?? false,
        canGoLiveNow: input.canGoLiveNow ?? false,
        summary: redactSensitiveText(input.summary),
        inputSummary: input.inputSummary === undefined ? Prisma.JsonNull : toJson(input.inputSummary),
        outputSummary: input.outputSummary === undefined ? Prisma.JsonNull : toJson(input.outputSummary),
        errorMessage: input.errorMessage ? redactSensitiveText(input.errorMessage) : null,
        metadata: input.metadata === undefined ? Prisma.JsonNull : toJson(input.metadata),
      },
    });

    return { ok: true, actionLog: serializeActionLog(actionLog) };
  } catch (error) {
    console.warn(`Action log write failed: ${safeMessage(error)}`);
    return { ok: false, warning: "Action logging failed, but the primary response was preserved." };
  }
}

export function actionLogWarningCaveat(result: Awaited<ReturnType<typeof logActionEvent>>) {
  return result.ok
    ? []
    : [{
        message: "Action logging failed, but the primary workflow response was preserved.",
        evidenceType: "caveat" as const,
        severity: "unknown" as const,
      }];
}
