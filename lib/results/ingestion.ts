import { Prisma } from "@prisma/client";
import { z } from "zod";
import { serializeRecommendationOutcome } from "@/lib/recommendations/outcomes";
import { prisma } from "@/lib/prisma";

export const RESULT_LEARNING_SIGNALS = [
  "worked",
  "underperformed",
  "needs_more_data",
  "risky",
  "inconclusive",
] as const;

export type ResultLearningSignal = (typeof RESULT_LEARNING_SIGNALS)[number];

type RecommendationResultRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  recommendationOutcomeId: string | null;
  workflowRunId: string | null;
  campaignMemoryId: string | null;
  externalPlatform: string | null;
  externalId: string | null;
  resultType: string;
  status: string;
  timeframeStart: Date | null;
  timeframeEnd: Date | null;
  metrics: Prisma.JsonValue | null;
  summary: string | null;
  learningSignal: string;
  learningStatus: string;
  lessons: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type RecommendationOutcomeRow = Parameters<typeof serializeRecommendationOutcome>[0];

export type NormalizedResultMetrics = {
  revenue: number | null;
  orders: number | null;
  conversions: number | null;
  recipients: number | null;
  delivered: number | null;
  sent: number | null;
  revenuePerRecipient: number | null;
  openRate: number | null;
  clickRate: number | null;
  conversionRate: number | null;
  unsubscribeRate: number | null;
  spamComplaintRate: number | null;
};

export type ResultIngestionInput = {
  sourceType: string;
  sourceId: string;
  recommendationOutcomeId?: string | null;
  workflowRunId?: string | null;
  campaignMemoryId?: string | null;
  externalPlatform?: string | null;
  externalId?: string | null;
  resultType?: string | null;
  status?: string | null;
  timeframeStart?: string | null;
  timeframeEnd?: string | null;
  metrics?: Record<string, unknown> | null;
  summary?: string | null;
  metadata?: unknown;
};

export type ResultIngestionResponse = {
  ok: true;
  result: ReturnType<typeof serializeRecommendationResult>;
  learningSignal: ResultLearningSignal;
  linkedRecommendationOutcome: {
    updated: boolean;
    reason: string | null;
    outcome: ReturnType<typeof serializeRecommendationOutcome> | null;
  };
  campaignMemoryUpdated: false;
  caveats: string[];
  metadata: {
    stateOnly: true;
    externalActionsTaken: false;
    campaignMemoryIntegration: "deferred" | "not_requested";
  };
};

const MAX_TEXT_LENGTH = 4000;
const MAX_METADATA_TEXT_LENGTH = 600;
const MAX_METADATA_ARRAY_ITEMS = 12;
const MAX_METADATA_OBJECT_KEYS = 24;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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

const resultIngestionSchema = z
  .object({
    sourceType: z.string().trim().min(1, "sourceType is required.").max(120),
    sourceId: z.string().trim().min(1, "sourceId is required.").max(200),
    recommendationOutcomeId: z.string().trim().min(1).max(200).optional().nullable(),
    workflowRunId: z.string().trim().min(1).max(200).optional().nullable(),
    campaignMemoryId: z.string().trim().min(1).max(200).optional().nullable(),
    externalPlatform: z.string().trim().min(1).max(80).optional().nullable(),
    externalId: z.string().trim().min(1).max(200).optional().nullable(),
    resultType: z.string().trim().min(1).max(80).optional().nullable(),
    status: z.string().trim().min(1).max(80).optional().nullable(),
    timeframeStart: z.string().trim().min(1).optional().nullable(),
    timeframeEnd: z.string().trim().min(1).optional().nullable(),
    metrics: z.record(z.string(), z.unknown()).optional().nullable(),
    summary: z.string().trim().min(1).max(MAX_TEXT_LENGTH).optional().nullable(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: string | null | undefined, max = 240) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function cleanSlugValue(value: string | null | undefined, fallback: string, max = 80) {
  const cleaned = cleanString(value, max)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_.:]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
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
  return /raw|payload|response|full.*audit|audit.*output|klaviyo.*body|headers?/i.test(key);
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

function parseDate(value: string | null | undefined, field: string, issues: string[]) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    issues.push(`${field} must be a valid date string.`);
    return null;
  }
  return parsed;
}

function numberFrom(input: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      return input[key];
    }
  }
  return null;
}

function parseNonNegativeNumber(value: unknown, field: string, issues: string[]) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    issues.push(`${field} must be a valid number.`);
    return null;
  }
  if (parsed < 0) {
    issues.push(`${field} cannot be negative.`);
    return null;
  }
  return parsed;
}

function parseNonNegativeInt(value: unknown, field: string, issues: string[]) {
  const parsed = parseNonNegativeNumber(value, field, issues);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) {
    issues.push(`${field} must be a whole number.`);
    return null;
  }
  return parsed;
}

function parseRate(value: unknown, field: string, issues: string[]) {
  const parsed = parseNonNegativeNumber(value, field, issues);
  if (parsed === null) return null;
  if (parsed > 100) {
    issues.push(`${field} must be between 0 and 1, or between 0 and 100 as a percentage.`);
    return null;
  }
  return parsed > 1 ? parsed / 100 : parsed;
}

function roundMetric(value: number | null, decimals = 6) {
  return value === null ? null : Number(value.toFixed(decimals));
}

function normalizeMetrics(input: Record<string, unknown> | null | undefined) {
  const metrics = input ?? {};
  const issues: string[] = [];
  const revenue = parseNonNegativeNumber(numberFrom(metrics, ["revenue", "attributedRevenue"]), "revenue", issues);
  const orders = parseNonNegativeInt(numberFrom(metrics, ["orders"]), "orders", issues);
  const conversions = parseNonNegativeInt(
    numberFrom(metrics, ["conversions", "converted"]),
    "conversions",
    issues,
  ) ?? orders;
  const recipients = parseNonNegativeInt(numberFrom(metrics, ["recipients", "audienceSize"]), "recipients", issues);
  const delivered = parseNonNegativeInt(numberFrom(metrics, ["delivered"]), "delivered", issues);
  const sent = parseNonNegativeInt(numberFrom(metrics, ["sent"]), "sent", issues);
  const denominator = recipients ?? delivered ?? sent;
  const providedRevenuePerRecipient = parseNonNegativeNumber(
    numberFrom(metrics, ["revenuePerRecipient", "rpr"]),
    "revenuePerRecipient",
    issues,
  );
  const revenuePerRecipient =
    providedRevenuePerRecipient ??
    (revenue !== null && denominator ? revenue / Math.max(1, denominator) : null);
  const openRate = parseRate(numberFrom(metrics, ["openRate", "openedRate"]), "openRate", issues);
  const clickRate = parseRate(numberFrom(metrics, ["clickRate", "clickedRate"]), "clickRate", issues);
  const providedConversionRate = parseRate(
    numberFrom(metrics, ["conversionRate", "convertedRate"]),
    "conversionRate",
    issues,
  );
  const conversionRate =
    providedConversionRate ??
    (conversions !== null && denominator ? conversions / Math.max(1, denominator) : null);
  const unsubscribeRate = parseRate(
    numberFrom(metrics, ["unsubscribeRate", "unsubscribedRate"]),
    "unsubscribeRate",
    issues,
  );
  const spamComplaintRate = parseRate(
    numberFrom(metrics, ["spamComplaintRate", "complaintRate"]),
    "spamComplaintRate",
    issues,
  );

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      revenue: roundMetric(revenue, 2),
      orders,
      conversions,
      recipients,
      delivered,
      sent,
      revenuePerRecipient: roundMetric(revenuePerRecipient, 6),
      openRate: roundMetric(openRate),
      clickRate: roundMetric(clickRate),
      conversionRate: roundMetric(conversionRate),
      unsubscribeRate: roundMetric(unsubscribeRate),
      spamComplaintRate: roundMetric(spamComplaintRate),
    } satisfies NormalizedResultMetrics,
  };
}

function hasAnyMetric(metrics: NormalizedResultMetrics) {
  return Object.values(metrics).some((value) => value !== null);
}

function resultStatusIndicatesFailure(status: string) {
  return ["failed", "failure", "error", "underperformed", "lost", "cancelled", "canceled"].includes(status);
}

function resultStatusIndicatesSuccess(status: string) {
  return ["success", "succeeded", "won"].includes(status);
}

function learningSignalFor(metrics: NormalizedResultMetrics, status: string) {
  const reasons: string[] = [];
  const recipients = metrics.recipients ?? metrics.delivered ?? metrics.sent;
  const hasConversions = Boolean((metrics.orders ?? metrics.conversions ?? 0) > 0 || (metrics.revenue ?? 0) > 0);

  if (!hasAnyMetric(metrics)) {
    reasons.push("No normalized performance metrics were provided.");
    return { signal: "needs_more_data" as const, reasons };
  }

  if ((metrics.spamComplaintRate ?? 0) >= 0.001) {
    reasons.push("Spam complaint rate met or exceeded 0.1%.");
    return { signal: "risky" as const, reasons };
  }

  if ((metrics.unsubscribeRate ?? 0) >= 0.01) {
    reasons.push("Unsubscribe rate met or exceeded 1%.");
    return { signal: "risky" as const, reasons };
  }

  if (resultStatusIndicatesFailure(status)) {
    reasons.push(`Result status was ${status}.`);
    return { signal: "underperformed" as const, reasons };
  }

  if (hasConversions) {
    reasons.push("Revenue, orders, or conversions were recorded.");
    if ((metrics.revenuePerRecipient ?? 0) >= 0.05) {
      reasons.push("Revenue per recipient was at least 0.05.");
    }
    if ((metrics.clickRate ?? 0) >= 0.02) {
      reasons.push("Click rate was at least 2%.");
    }
    return { signal: "worked" as const, reasons };
  }

  if (resultStatusIndicatesSuccess(status)) {
    reasons.push(`Result status was ${status}.`);
    return { signal: "worked" as const, reasons };
  }

  if (recipients !== null && recipients >= 100) {
    if ((metrics.clickRate ?? 0) > 0 && (metrics.clickRate ?? 0) < 0.01) {
      reasons.push("At least 100 recipients were observed and click rate was below 1%.");
      return { signal: "underperformed" as const, reasons };
    }

    if ((metrics.openRate ?? 0) > 0 && (metrics.openRate ?? 0) < 0.1) {
      reasons.push("At least 100 recipients were observed and open rate was below 10%.");
      return { signal: "underperformed" as const, reasons };
    }
  }

  reasons.push("Metrics were present but not decisive enough for a positive or negative learning.");
  return { signal: "inconclusive" as const, reasons };
}

function learningStatusFor(signal: ResultLearningSignal) {
  if (signal === "needs_more_data") return "needs_more_data";
  if (signal === "inconclusive") return "inconclusive";
  return "learned";
}

function lessonsFor(input: {
  signal: ResultLearningSignal;
  reasons: string[];
  metrics: NormalizedResultMetrics;
  sourceType: string;
  sourceId: string;
}) {
  const guidanceBySignal: Record<ResultLearningSignal, string> = {
    worked: "Prefer similar recommendation patterns when the account context matches.",
    underperformed: "Avoid repeating this recommendation pattern without changing the audience, offer, timing, or creative.",
    needs_more_data: "Collect more performance data before treating this as a durable learning.",
    risky: "Treat this pattern as risky and review audience fit, frequency, and copy before recommending again.",
    inconclusive: "Keep as a weak signal only; do not overfit future recommendations to this result.",
  };

  return toPrismaJson({
    signal: input.signal,
    reasons: input.reasons,
    guidance: guidanceBySignal[input.signal],
    source: {
      type: input.sourceType,
      id: input.sourceId,
    },
    metricsEvaluated: Object.entries(input.metrics)
      .filter(([, value]) => value !== null)
      .map(([key]) => key),
  });
}

function resultMetadataFor(input: ResultIngestionInput, learningSignal: ResultLearningSignal) {
  return toPrismaJson({
    ...(isRecord(input.metadata) ? input.metadata : input.metadata === undefined ? {} : { value: input.metadata }),
    learningSignal,
    safety: {
      stateOnly: true,
      externalActionsTaken: false,
      klaviyoWrites: false,
      draftsCreated: false,
      sendsOrSchedules: false,
      flowOrSegmentCreation: false,
      profileSync: false,
    },
    ingestedAt: new Date().toISOString(),
  });
}

function outcomeMetadataForResult(existing: Prisma.JsonValue | null, result: RecommendationResultRow) {
  const base = isRecord(existing) ? existing : existing ? { previousMetadata: existing } : {};

  return toPrismaJson({
    ...base,
    lastResult: {
      id: result.id,
      resultType: result.resultType,
      status: result.status,
      learningSignal: result.learningSignal,
      summary: result.summary,
      metrics: result.metrics,
      ingestedAt: result.createdAt.toISOString(),
    },
    safety: {
      ...(isRecord(base.safety) ? base.safety : {}),
      stateOnly: true,
      externalActionsTaken: false,
      klaviyoWrites: false,
      draftsCreated: false,
      sendsOrSchedules: false,
      flowOrSegmentCreation: false,
      profileSync: false,
    },
  });
}

function nextOutcomeStatusForResult(signal: ResultLearningSignal, resultStatus: string) {
  if (signal === "worked" || resultStatusIndicatesSuccess(resultStatus)) return "completed";
  if (signal === "underperformed" || signal === "risky" || resultStatusIndicatesFailure(resultStatus)) return "failed";
  return null;
}

async function updateLinkedRecommendationOutcome(input: {
  recommendationOutcomeId: string | null;
  result: RecommendationResultRow;
  learningSignal: ResultLearningSignal;
  resultStatus: string;
  summary: string | null;
}) {
  if (!input.recommendationOutcomeId) {
    return {
      updated: false,
      reason: "No recommendationOutcomeId was provided.",
      outcome: null as ReturnType<typeof serializeRecommendationOutcome> | null,
    };
  }

  const existing = await prisma.recommendationOutcome.findUnique({
    where: { id: input.recommendationOutcomeId },
  });

  if (!existing) {
    return {
      updated: false,
      reason: "No linked RecommendationOutcome was found.",
      outcome: null as ReturnType<typeof serializeRecommendationOutcome> | null,
    };
  }

  const preservedStatuses = new Set(["blocked", "rejected", "revision_requested", "ignored", "completed", "failed"]);
  if (preservedStatuses.has(existing.status)) {
    return {
      updated: false,
      reason: `RecommendationOutcome is ${existing.status}; result ingestion does not overwrite preserved states.`,
      outcome: serializeRecommendationOutcome(existing),
    };
  }

  const nextStatus = nextOutcomeStatusForResult(input.learningSignal, input.resultStatus);
  if (!nextStatus) {
    return {
      updated: false,
      reason: "Learning signal did not produce a safe RecommendationOutcome status transition.",
      outcome: serializeRecommendationOutcome(existing),
    };
  }

  const updated = await prisma.recommendationOutcome.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      outcomeNote: cleanString(
        input.summary ??
          `Result ${input.result.id} produced learning signal ${input.learningSignal}.`,
        MAX_TEXT_LENGTH,
      ),
      metadata: outcomeMetadataForResult(existing.metadata, input.result),
      completedAt: existing.completedAt ?? new Date(),
    },
  });

  return {
    updated: true,
    reason: null,
    outcome: serializeRecommendationOutcome(updated),
  };
}

export function parseResultIngestionRequest(input: unknown):
  | { ok: true; data: ResultIngestionInput }
  | { ok: false; issues: string[] } {
  const parsed = resultIngestionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const field = issue.path.join(".");
        return field ? `${field}: ${issue.message}` : issue.message;
      }),
    };
  }

  const issues: string[] = [];
  const timeframeStart = parseDate(parsed.data.timeframeStart, "timeframeStart", issues);
  const timeframeEnd = parseDate(parsed.data.timeframeEnd, "timeframeEnd", issues);
  const metrics = normalizeMetrics(parsed.data.metrics);

  if (timeframeStart && timeframeEnd && timeframeEnd < timeframeStart) {
    issues.push("timeframeEnd must be after timeframeStart.");
  }

  if (!metrics.ok) {
    issues.push(...metrics.issues);
  }

  if (issues.length) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...parsed.data,
      timeframeStart: timeframeStart?.toISOString() ?? null,
      timeframeEnd: timeframeEnd?.toISOString() ?? null,
      metrics: metrics.metrics,
    },
  };
}

export function serializeRecommendationResult(result: RecommendationResultRow) {
  return {
    id: result.id,
    sourceType: result.sourceType,
    sourceId: result.sourceId,
    recommendationOutcomeId: result.recommendationOutcomeId,
    workflowRunId: result.workflowRunId,
    campaignMemoryId: result.campaignMemoryId,
    externalPlatform: result.externalPlatform,
    externalId: result.externalId,
    resultType: result.resultType,
    status: result.status,
    timeframeStart: result.timeframeStart?.toISOString() ?? null,
    timeframeEnd: result.timeframeEnd?.toISOString() ?? null,
    metrics: result.metrics,
    summary: result.summary,
    learningSignal: result.learningSignal,
    learningStatus: result.learningStatus,
    lessons: result.lessons,
    metadata: result.metadata,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  };
}

export async function ingestRecommendationResult(input: ResultIngestionInput): Promise<ResultIngestionResponse> {
  const sourceType = cleanSlugValue(input.sourceType, "unknown", 120);
  const sourceId = cleanString(input.sourceId, 200) ?? "unknown";
  const resultType = cleanSlugValue(input.resultType, "performance");
  const status = cleanSlugValue(input.status, "received");
  const normalizedMetrics = (input.metrics ?? {}) as NormalizedResultMetrics;
  const learning = learningSignalFor(normalizedMetrics, status);
  const learningStatus = learningStatusFor(learning.signal);
  const lessons = lessonsFor({
    signal: learning.signal,
    reasons: learning.reasons,
    metrics: normalizedMetrics,
    sourceType,
    sourceId,
  });

  const result = await prisma.recommendationResult.create({
    data: {
      sourceType,
      sourceId,
      recommendationOutcomeId: cleanString(input.recommendationOutcomeId, 200),
      workflowRunId: cleanString(input.workflowRunId, 200),
      campaignMemoryId: cleanString(input.campaignMemoryId, 200),
      externalPlatform: cleanSlugValue(input.externalPlatform, "", 80) || null,
      externalId: cleanString(input.externalId, 200),
      resultType,
      status,
      timeframeStart: input.timeframeStart ? new Date(input.timeframeStart) : null,
      timeframeEnd: input.timeframeEnd ? new Date(input.timeframeEnd) : null,
      metrics: toPrismaJson(normalizedMetrics),
      summary: cleanString(input.summary, MAX_TEXT_LENGTH),
      learningSignal: learning.signal,
      learningStatus,
      lessons,
      metadata: resultMetadataFor(input, learning.signal),
    },
  });

  const linkedRecommendationOutcome = await updateLinkedRecommendationOutcome({
    recommendationOutcomeId: result.recommendationOutcomeId,
    result,
    learningSignal: learning.signal,
    resultStatus: status,
    summary: result.summary,
  });

  const campaignMemoryIntegration = result.campaignMemoryId ? "deferred" : "not_requested";
  const caveats = [
    ...(!linkedRecommendationOutcome.updated && linkedRecommendationOutcome.reason
      ? [linkedRecommendationOutcome.reason]
      : []),
    ...(campaignMemoryIntegration === "deferred"
      ? ["Campaign Memory was linked by id only; automatic memory writes are deferred for a follow-up."]
      : []),
  ];

  return {
    ok: true,
    result: serializeRecommendationResult(result),
    learningSignal: learning.signal,
    linkedRecommendationOutcome,
    campaignMemoryUpdated: false,
    caveats,
    metadata: {
      stateOnly: true,
      externalActionsTaken: false,
      campaignMemoryIntegration,
    },
  };
}

export function parseResultLimit(value: string | null) {
  if (!value) return { ok: true as const, limit: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, error: "limit must be a positive whole number." };
  }
  return { ok: true as const, limit: Math.min(parsed, MAX_LIMIT) };
}

export function cleanResultFilter(value: string | null, max = 200) {
  return cleanString(value, max);
}
