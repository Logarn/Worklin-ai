import { Prisma } from "@prisma/client";
import type {
  AuditFixRunOutput,
  BlockedAuditFix,
  PreparedAuditFix,
} from "@/lib/audits/fix-run";
import { prisma } from "@/lib/prisma";

export const RECOMMENDATION_OUTCOME_STATUSES = [
  "recommended",
  "prepared",
  "approval_requested",
  "approved",
  "rejected",
  "revision_requested",
  "ignored",
  "blocked",
  "completed",
  "failed",
] as const;

export type RecommendationOutcomeStatus = (typeof RECOMMENDATION_OUTCOME_STATUSES)[number];

type RecommendationOutcomeRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceWorkflowRunId: string | null;
  recommendationId: string | null;
  title: string;
  summary: string | null;
  domain: string | null;
  actionType: string | null;
  targetType: string | null;
  targetId: string | null;
  status: string;
  priority: string | null;
  confidence: number | null;
  approvalId: string | null;
  actionLogId: string | null;
  decisionNote: string | null;
  outcomeNote: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
};

export type TrackRecommendationOutcomeInput = {
  sourceType: string;
  sourceId?: string | null;
  sourceWorkflowRunId?: string | null;
  recommendationId?: string | null;
  title: string;
  summary?: string | null;
  domain?: string | null;
  actionType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  status?: RecommendationOutcomeStatus;
  priority?: string | null;
  confidence?: number | null;
  approvalId?: string | null;
  actionLogId?: string | null;
  decisionNote?: string | null;
  outcomeNote?: string | null;
  metadata?: unknown;
};

export type TransitionRecommendationOutcomeInput = {
  status: string;
  approvalId?: string | null;
  actionLogId?: string | null;
  decisionNote?: string | null;
  outcomeNote?: string | null;
  metadata?: unknown;
};

type ApprovalSnapshot = {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  requestNote?: string | null;
  decisionNote?: string | null;
  decidedAt?: Date | null;
};

const DECISION_STATUSES = new Set<RecommendationOutcomeStatus>([
  "approved",
  "rejected",
  "revision_requested",
  "ignored",
]);
const TERMINAL_STATUSES = new Set<RecommendationOutcomeStatus>(["completed", "failed"]);
const APPROVAL_REQUESTABLE_STATUSES: RecommendationOutcomeStatus[] = ["recommended", "prepared"];
const APPROVAL_TRANSITIONABLE_STATUSES: RecommendationOutcomeStatus[] = [
  "recommended",
  "prepared",
  "approval_requested",
];
const MAX_TEXT_LENGTH = 4000;
const MAX_METADATA_TEXT_LENGTH = 600;
const MAX_METADATA_ARRAY_ITEMS = 12;
const MAX_METADATA_OBJECT_KEYS = 24;
const SENSITIVE_KEY_PATTERNS = [
  ["api[_-]?", "key"],
  ["private[_-]?", "key"],
  ["client[_-]?", "se", "cret"],
  ["se", "cret"],
  ["to", "ken"],
  ["pass", "word"],
  ["author", "ization"],
].map((parts) => parts.join(""));
const SENSITIVE_KEY_PATTERN = new RegExp(SENSITIVE_KEY_PATTERNS.join("|"), "i");
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(${SENSITIVE_KEY_PATTERNS.join("|")})\\s*[:=]\\s*["']?[^"',\\s}]+`,
  "gi",
);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: string | null | undefined, max = 240) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function cleanRequiredString(value: string, field: string, max = 240) {
  const cleaned = cleanString(value, max);
  if (!cleaned) throw new Error(`${field} is required.`);
  return cleaned;
}

function truncate(value: string, max = MAX_METADATA_TEXT_LENGTH) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function redactSensitiveText(value: string) {
  return truncate(value)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(BASIC_AUTH_URL_PATTERN, "$1://[REDACTED]@")
    .replace(GENERIC_AUTH_URL_PATTERN, "://$1:[REDACTED]@")
    .replace(HEADER_CREDENTIAL_PATTERN, `${["Bear", "er"].join("")} [REDACTED]`)
    .replace(PREFIXED_CREDENTIAL_PATTERN, "[REDACTED]");
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key) || /cookie|session|env/i.test(key);
}

function shouldDropMetadataKey(key: string) {
  return /raw|payload|response|full.*audit|audit.*output|klaviyo.*body/i.test(key);
}

function scrubMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ARRAY_ITEMS).map((item) => scrubMetadata(item, depth + 1));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_METADATA_OBJECT_KEYS)) {
      if (shouldDropMetadataKey(key)) continue;
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : scrubMetadata(child, depth + 1);
    }
    return output;
  }

  return String(value);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(scrubMetadata(value ?? null))) as Prisma.InputJsonValue;
}

function normalizeStatus(value: string | null | undefined): RecommendationOutcomeStatus | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  return RECOMMENDATION_OUTCOME_STATUSES.includes(normalized as RecommendationOutcomeStatus)
    ? (normalized as RecommendationOutcomeStatus)
    : null;
}

function isDecisionStatus(status: string) {
  return DECISION_STATUSES.has(status as RecommendationOutcomeStatus);
}

function isTerminalStatus(status: string) {
  return TERMINAL_STATUSES.has(status as RecommendationOutcomeStatus);
}

function preservesExistingDecision(existingStatus: string, incomingStatus: RecommendationOutcomeStatus) {
  if (isDecisionStatus(existingStatus) || isTerminalStatus(existingStatus)) {
    return ["recommended", "prepared", "approval_requested", "blocked"].includes(incomingStatus);
  }
  if (existingStatus === "approval_requested") {
    return incomingStatus === "recommended" || incomingStatus === "prepared";
  }
  if (existingStatus === "blocked") {
    return incomingStatus === "recommended" || incomingStatus === "prepared" || incomingStatus === "approval_requested";
  }
  return false;
}

function nextTrackedStatus(existingStatus: string | null, incomingStatus: RecommendationOutcomeStatus) {
  if (!existingStatus) return incomingStatus;
  return preservesExistingDecision(existingStatus, incomingStatus)
    ? existingStatus
    : incomingStatus;
}

function sourceIdFor(input: TrackRecommendationOutcomeInput) {
  return (
    cleanString(input.sourceId, 200) ??
    cleanString(input.sourceWorkflowRunId, 200) ??
    cleanString(input.recommendationId, 200) ??
    "manual"
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "recommendation";
}

function stableRecommendationIdFor(input: TrackRecommendationOutcomeInput, sourceId: string) {
  const explicit = cleanString(input.recommendationId, 200);
  if (explicit) return explicit;

  const basis = [
    input.sourceType,
    sourceId,
    input.targetType,
    input.targetId,
    input.domain,
    input.actionType,
    input.title,
  ]
    .map((item) => cleanString(item, 200))
    .filter((item): item is string => Boolean(item))
    .join(":");

  return `fallback_${slugify(basis)}`;
}

function metadataForTrack(existing: Prisma.JsonValue | null, incoming: unknown) {
  const base = isRecord(existing) ? existing : existing ? { previousMetadata: existing } : {};
  const next = isRecord(incoming) ? incoming : incoming === undefined ? {} : { value: incoming };

  return toPrismaJson({
    ...base,
    ...next,
    safety: {
      ...(isRecord(base.safety) ? base.safety : {}),
      ...(isRecord(next.safety) ? next.safety : {}),
      stateOnly: true,
      externalActionsTaken: false,
      klaviyoWrites: false,
      draftsCreated: false,
      sendsOrSchedules: false,
      flowOrSegmentCreation: false,
    },
    lastTrackedAt: new Date().toISOString(),
  });
}

function dateFieldsForStatus(status: string, existing?: RecommendationOutcomeRow | null) {
  const now = new Date();
  return {
    decidedAt: isDecisionStatus(status) ? existing?.decidedAt ?? now : existing?.decidedAt ?? null,
    completedAt: isTerminalStatus(status) ? existing?.completedAt ?? now : existing?.completedAt ?? null,
  };
}

function naturalKey(input: TrackRecommendationOutcomeInput) {
  const sourceWorkflowRunId = cleanString(input.sourceWorkflowRunId, 200);
  const sourceId = sourceIdFor(input);
  const recommendationId = stableRecommendationIdFor(input, sourceId);
  return sourceWorkflowRunId && recommendationId
    ? { sourceWorkflowRunId, recommendationId }
    : null;
}

async function findExistingOutcome(input: TrackRecommendationOutcomeInput) {
  const key = naturalKey(input);
  if (!key) {
    const sourceType = cleanString(input.sourceType, 120);
    if (!sourceType) return null;

    const sourceId = sourceIdFor(input);
    const recommendationId = stableRecommendationIdFor(input, sourceId);

    return prisma.recommendationOutcome.findFirst({
      where: {
        sourceType,
        sourceId,
        sourceWorkflowRunId: null,
        recommendationId,
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  return prisma.recommendationOutcome.findUnique({
    where: {
      sourceWorkflowRunId_recommendationId: key,
    },
  });
}

export function isRecommendationOutcomeStatus(value: string) {
  return Boolean(normalizeStatus(value));
}

export function normalizeRecommendationOutcomeStatus(value: string) {
  return normalizeStatus(value);
}

export function serializeRecommendationOutcome(outcome: RecommendationOutcomeRow) {
  return {
    id: outcome.id,
    sourceType: outcome.sourceType,
    sourceId: outcome.sourceId,
    sourceWorkflowRunId: outcome.sourceWorkflowRunId,
    recommendationId: outcome.recommendationId,
    title: outcome.title,
    summary: outcome.summary,
    domain: outcome.domain,
    actionType: outcome.actionType,
    targetType: outcome.targetType,
    targetId: outcome.targetId,
    status: outcome.status,
    priority: outcome.priority,
    confidence: outcome.confidence,
    approvalId: outcome.approvalId,
    actionLogId: outcome.actionLogId,
    decisionNote: outcome.decisionNote,
    outcomeNote: outcome.outcomeNote,
    metadata: outcome.metadata,
    createdAt: outcome.createdAt.toISOString(),
    updatedAt: outcome.updatedAt.toISOString(),
    decidedAt: outcome.decidedAt?.toISOString() ?? null,
    completedAt: outcome.completedAt?.toISOString() ?? null,
  };
}

function metadataForTransition(existing: Prisma.JsonValue | null, incoming: unknown, status: RecommendationOutcomeStatus) {
  const base = isRecord(existing) ? existing : existing ? { previousMetadata: existing } : {};
  const next = isRecord(incoming) ? incoming : incoming === undefined ? {} : { transitionMetadata: incoming };

  return toPrismaJson({
    ...base,
    lastTransition: {
      ...next,
      status,
      stateOnly: true,
      externalActionsTaken: false,
      transitionedAt: new Date().toISOString(),
    },
    safety: {
      ...(isRecord(base.safety) ? base.safety : {}),
      stateOnly: true,
      externalActionsTaken: false,
      klaviyoWrites: false,
      draftsCreated: false,
      sendsOrSchedules: false,
      flowOrSegmentCreation: false,
    },
  });
}

export async function transitionRecommendationOutcome(id: string, input: TransitionRecommendationOutcomeInput):
  Promise<
    | { ok: true; changed: boolean; outcome: RecommendationOutcomeRow }
    | { ok: false; status: 400 | 404 | 409; error: string; issues: string[] }
  > {
  const cleanId = cleanString(id, 200);
  if (!cleanId) {
    return { ok: false, status: 400, error: "Invalid recommendation outcome request", issues: ["outcome id is required."] };
  }

  const nextStatus = normalizeStatus(input.status);
  if (!nextStatus) {
    return {
      ok: false,
      status: 400,
      error: "Invalid recommendation outcome transition",
      issues: [`status must be one of: ${RECOMMENDATION_OUTCOME_STATUSES.join(", ")}.`],
    };
  }

  const existing = await prisma.recommendationOutcome.findUnique({ where: { id: cleanId } });
  if (!existing) {
    return { ok: false, status: 404, error: "Recommendation outcome not found", issues: [] };
  }

  if (isTerminalStatus(existing.status) && existing.status !== nextStatus) {
    return {
      ok: false,
      status: 409,
      error: "Invalid recommendation outcome transition",
      issues: [
        `Outcome is already ${existing.status}. Terminal completed/failed outcomes cannot transition to ${nextStatus}. No external action was attempted.`,
      ],
    };
  }

  const dates = dateFieldsForStatus(nextStatus, existing);
  const outcome = await prisma.recommendationOutcome.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      ...(input.approvalId !== undefined ? { approvalId: cleanString(input.approvalId, 200) } : {}),
      ...(input.actionLogId !== undefined ? { actionLogId: cleanString(input.actionLogId, 200) } : {}),
      ...(input.decisionNote !== undefined ? { decisionNote: cleanString(input.decisionNote, MAX_TEXT_LENGTH) } : {}),
      ...(input.outcomeNote !== undefined ? { outcomeNote: cleanString(input.outcomeNote, MAX_TEXT_LENGTH) } : {}),
      metadata: metadataForTransition(existing.metadata, input.metadata, nextStatus),
      decidedAt: dates.decidedAt,
      completedAt: dates.completedAt,
    },
  });

  return { ok: true, changed: existing.status !== outcome.status, outcome };
}

export async function trackRecommendationOutcome(input: TrackRecommendationOutcomeInput) {
  const status = normalizeStatus(input.status) ?? "recommended";
  const sourceType = cleanRequiredString(input.sourceType, "sourceType", 120);
  const sourceId = sourceIdFor(input);
  const recommendationId = stableRecommendationIdFor(input, sourceId);
  const title = cleanRequiredString(input.title, "title", 240);
  const existing = await findExistingOutcome(input);
  const nextStatus = nextTrackedStatus(existing?.status ?? null, status);
  const dates = dateFieldsForStatus(nextStatus, existing);

  if (existing) {
    const outcome = await prisma.recommendationOutcome.update({
      where: { id: existing.id },
      data: {
        sourceType,
        sourceId,
        sourceWorkflowRunId: cleanString(input.sourceWorkflowRunId, 200),
        recommendationId,
        title,
        summary: cleanString(input.summary, MAX_TEXT_LENGTH),
        domain: cleanString(input.domain, 80),
        actionType: cleanString(input.actionType, 120),
        targetType: cleanString(input.targetType, 120),
        targetId: cleanString(input.targetId, 200),
        status: nextStatus,
        priority: cleanString(input.priority, 40),
        confidence: input.confidence ?? null,
        ...(input.approvalId !== undefined ? { approvalId: cleanString(input.approvalId, 200) } : {}),
        ...(input.actionLogId !== undefined ? { actionLogId: cleanString(input.actionLogId, 200) } : {}),
        ...(input.decisionNote !== undefined ? { decisionNote: cleanString(input.decisionNote, MAX_TEXT_LENGTH) } : {}),
        ...(input.outcomeNote !== undefined ? { outcomeNote: cleanString(input.outcomeNote, MAX_TEXT_LENGTH) } : {}),
        metadata: metadataForTrack(existing.metadata, input.metadata),
        decidedAt: dates.decidedAt,
        completedAt: dates.completedAt,
      },
    });

    return { created: false, outcome };
  }

  try {
    const outcome = await prisma.recommendationOutcome.create({
      data: {
        sourceType,
        sourceId,
        sourceWorkflowRunId: cleanString(input.sourceWorkflowRunId, 200),
        recommendationId,
        title,
        summary: cleanString(input.summary, MAX_TEXT_LENGTH),
        domain: cleanString(input.domain, 80),
        actionType: cleanString(input.actionType, 120),
        targetType: cleanString(input.targetType, 120),
        targetId: cleanString(input.targetId, 200),
        status: nextStatus,
        priority: cleanString(input.priority, 40),
        confidence: input.confidence ?? null,
        approvalId: cleanString(input.approvalId, 200),
        actionLogId: cleanString(input.actionLogId, 200),
        decisionNote: cleanString(input.decisionNote, MAX_TEXT_LENGTH),
        outcomeNote: cleanString(input.outcomeNote, MAX_TEXT_LENGTH),
        metadata: metadataForTrack(null, input.metadata),
        decidedAt: dates.decidedAt,
        completedAt: dates.completedAt,
      },
    });

    return { created: true, outcome };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raceExisting = await findExistingOutcome(input);
      if (raceExisting) return trackRecommendationOutcome(input);
    }

    throw error;
  }
}

function preparedFixOutcomeInput(input: {
  fix: PreparedAuditFix;
  output: AuditFixRunOutput;
  workflowRunId: string;
  actionLogId?: string | null;
}): TrackRecommendationOutcomeInput {
  return {
    sourceType: "audit-fix-run",
    sourceId: input.output.sourceWorkflowId,
    sourceWorkflowRunId: input.workflowRunId,
    recommendationId: input.fix.id,
    title: input.fix.title,
    summary: input.fix.whyItMatters,
    domain: input.fix.fixType,
    actionType: "safe_prepare",
    targetType: input.fix.fixType,
    targetId: input.fix.sourceIssueId ?? input.fix.id,
    status: "prepared",
    priority: input.fix.priority,
    actionLogId: input.actionLogId,
    metadata: {
      source: "audit_fix_run.preparedFixes",
      sourceIssueId: input.fix.sourceIssueId,
      riskLevel: input.fix.riskLevel,
      approvalRequired: input.fix.approvalRequired,
      canGoLiveNow: input.fix.canGoLiveNow,
      externalActionTaken: input.fix.externalActionTaken,
      suggestedNextStep: input.fix.suggestedNextStep,
      futureToolNeeded: input.fix.futureToolNeeded,
      dependencies: input.fix.dependencies,
      whatRemainsBlocked: input.fix.whatRemainsBlocked,
      evidence: input.fix.evidence,
      caveats: input.fix.caveats,
      preparedPackage: input.fix.whatWorklinPrepared,
    },
  };
}

function blockedFixOutcomeInput(input: {
  fix: BlockedAuditFix;
  output: AuditFixRunOutput;
  workflowRunId: string;
  actionLogId?: string | null;
}): TrackRecommendationOutcomeInput {
  return {
    sourceType: "audit-fix-run",
    sourceId: input.output.sourceWorkflowId,
    sourceWorkflowRunId: input.workflowRunId,
    recommendationId: input.fix.id,
    title: input.fix.title,
    summary: input.fix.reason,
    domain: input.fix.fixType,
    actionType: "blocked_live_capability",
    targetType: input.fix.fixType,
    targetId: input.fix.sourceIssueId ?? input.fix.id,
    status: "blocked",
    priority: input.fix.priority,
    actionLogId: input.actionLogId,
    outcomeNote: input.fix.safeAlternative,
    metadata: {
      source: "audit_fix_run.blockedFixes",
      sourceIssueId: input.fix.sourceIssueId,
      riskLevel: input.fix.riskLevel,
      missingCapability: input.fix.missingCapability,
      safeAlternative: input.fix.safeAlternative,
      futureRoadmapLink: input.fix.futureRoadmapLink,
      canGoLiveNow: input.fix.canGoLiveNow,
      externalActionTaken: input.fix.externalActionTaken,
      evidence: input.fix.evidence,
      caveats: input.fix.caveats,
    },
  };
}

export async function trackAuditFixRunOutcomes(input: {
  workflowRunId: string | null;
  output: AuditFixRunOutput;
  actionLogId?: string | null;
}) {
  if (!input.workflowRunId) {
    return {
      ok: false as const,
      warning: "Recommendation outcomes were not tracked because the audit-fix-run WorkflowRun was not persisted.",
    };
  }

  try {
    const items = [
      ...input.output.preparedFixes.map((fix) => preparedFixOutcomeInput({
        fix,
        output: input.output,
        workflowRunId: input.workflowRunId!,
        actionLogId: input.actionLogId,
      })),
      ...input.output.blockedFixes.map((fix) => blockedFixOutcomeInput({
        fix,
        output: input.output,
        workflowRunId: input.workflowRunId!,
        actionLogId: input.actionLogId,
      })),
    ];
    const tracked = [];

    for (const item of items) {
      tracked.push(await trackRecommendationOutcome(item));
    }

    return {
      ok: true as const,
      count: tracked.length,
      created: tracked.filter((item) => item.created).length,
      updated: tracked.filter((item) => !item.created).length,
      outcomes: tracked.map((item) => serializeRecommendationOutcome(item.outcome)),
    };
  } catch (error) {
    console.warn("Recommendation outcome tracking skipped", error);
    return {
      ok: false as const,
      warning: "Recommendation outcome tracking failed, but the prepared fix package was preserved.",
    };
  }
}

function approvalWorkflowRunId(approval: ApprovalSnapshot) {
  return ["audit-fix-run", "workflow-run", "flow-package", "audience-package"].includes(approval.targetType)
    ? approval.targetId
    : null;
}

function approvalTargetWhere(approval: ApprovalSnapshot, statuses: RecommendationOutcomeStatus[]) {
  const workflowRunId = approvalWorkflowRunId(approval);
  const status = { in: statuses };

  return workflowRunId
    ? { sourceWorkflowRunId: workflowRunId, status }
    : {
        targetType: approval.targetType,
        targetId: approval.targetId,
        status,
      };
}

export async function syncRecommendationOutcomesForApprovalRequest(
  approval: ApprovalSnapshot,
  actionLogId?: string | null,
) {
  try {
    const result = await prisma.recommendationOutcome.updateMany({
      where: approvalTargetWhere(approval, APPROVAL_REQUESTABLE_STATUSES),
      data: {
        status: "approval_requested",
        approvalId: approval.id,
        actionLogId: cleanString(actionLogId, 200),
        decisionNote: cleanString(approval.requestNote, MAX_TEXT_LENGTH),
      },
    });

    return { ok: true as const, updated: result.count };
  } catch (error) {
    console.warn("Recommendation outcome approval request sync skipped", error);
    return {
      ok: false as const,
      warning: "Recommendation outcome approval sync failed, but approval state was preserved.",
    };
  }
}

export async function syncRecommendationOutcomesForApprovalTransition(
  approval: ApprovalSnapshot,
  nextStatus: "approved" | "rejected" | "revision_requested",
  actionLogId?: string | null,
) {
  try {
    const decidedAt = approval.decidedAt ?? new Date();
    const result = await prisma.recommendationOutcome.updateMany({
      where: {
        ...approvalTargetWhere(approval, APPROVAL_TRANSITIONABLE_STATUSES),
        OR: [
          { approvalId: approval.id },
          { approvalId: null },
        ],
      },
      data: {
        status: nextStatus,
        approvalId: approval.id,
        actionLogId: cleanString(actionLogId, 200),
        decisionNote: cleanString(approval.decisionNote, MAX_TEXT_LENGTH),
        decidedAt,
      },
    });

    return { ok: true as const, updated: result.count };
  } catch (error) {
    console.warn("Recommendation outcome approval transition sync skipped", error);
    return {
      ok: false as const,
      warning: "Recommendation outcome approval transition sync failed, but approval state was preserved.",
    };
  }
}
