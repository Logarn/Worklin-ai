import { Prisma } from "@prisma/client";
import {
  computeMicroCampaignPackages,
  MICRO_CAMPAIGN_APPROVAL_STATUSES,
  MICRO_CAMPAIGN_PACKAGE_STATUSES,
  MICRO_CAMPAIGN_PACKAGE_TYPES,
  MICRO_CAMPAIGN_PACKAGE_VERSION,
} from "@/lib/campaigns/micro-campaign-factory";
import { prisma } from "@/lib/prisma";

export const MICRO_CAMPAIGN_ARBITRATION_VERSION = "micro_campaign_arbitration_v0";
export const MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS = "advisory_only";
export const MICRO_CAMPAIGN_ARBITRATION_DECISIONS = ["advance", "wait", "suppress", "block", "needs_review"] as const;
export const MICRO_CAMPAIGN_ARBITRATION_CONFIDENCE = ["high", "medium", "low"] as const;

type MicroCampaignPackageStatus = (typeof MICRO_CAMPAIGN_PACKAGE_STATUSES)[number];
type MicroCampaignPackageType = (typeof MICRO_CAMPAIGN_PACKAGE_TYPES)[number];
type MicroCampaignApprovalStatus = (typeof MICRO_CAMPAIGN_APPROVAL_STATUSES)[number];
type MicroCampaignArbitrationDecision = (typeof MICRO_CAMPAIGN_ARBITRATION_DECISIONS)[number];
type MicroCampaignArbitrationConfidence = (typeof MICRO_CAMPAIGN_ARBITRATION_CONFIDENCE)[number];

type StoredMicroCampaignPackage = Awaited<ReturnType<typeof prisma.microCampaignPackageStore.findMany>>[number];
type StoredArbitration = Awaited<ReturnType<typeof prisma.microCampaignArbitrationStore.findMany>>[number];

export type MicroCampaignArbitrationComputeInput = {
  packageKey?: string | null;
  opportunityKey?: string | null;
  microSegmentDefinitionKey?: string | null;
  timeframeDays?: number | string | null;
  packageStatus?: string | null;
  packageType?: string | null;
  approvalStatus?: string | null;
  limit?: number | string | null;
  persist?: boolean | string | null;
};

export type MicroCampaignArbitrationListInput = {
  arbitrationKey?: string | null;
  packageKey?: string | null;
  opportunityKey?: string | null;
  microSegmentDefinitionKey?: string | null;
  timeframeDays?: number | string | null;
  decision?: string | null;
  packageStatus?: string | null;
  packageType?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        packageKey: string | null;
        opportunityKey: string | null;
        microSegmentDefinitionKey: string | null;
        timeframeDays: number | null;
        packageStatus: MicroCampaignPackageStatus | null;
        packageType: MicroCampaignPackageType | null;
        approvalStatus: MicroCampaignApprovalStatus | null;
        limit: number;
        persist: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        arbitrationKey: string | null;
        packageKey: string | null;
        opportunityKey: string | null;
        microSegmentDefinitionKey: string | null;
        timeframeDays: number | null;
        decision: MicroCampaignArbitrationDecision | null;
        packageStatus: MicroCampaignPackageStatus | null;
        packageType: MicroCampaignPackageType | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type PackageSourceMode = "persisted_micro_campaign_packages" | "computed_micro_campaign_package_fallback";

type NormalizedMicroCampaignPackage = {
  id: string | null;
  packageKey: string;
  packageVersion: string;
  opportunityKey: string | null;
  opportunityId: string | null;
  timeframeDays: number;
  computedAt: string;
  status: MicroCampaignPackageStatus;
  packageType: MicroCampaignPackageType;
  approvalStatus: MicroCampaignApprovalStatus;
  name: string;
  description: string;
  priority: number;
  confidence: string;
  sourceOpportunity: Record<string, unknown>;
  linkedMicroSegment: Record<string, unknown>;
  audienceLogic: Record<string, unknown>;
  messageAngle: Record<string, unknown>;
  productOfferDirection: Record<string, unknown>;
  futureArtifact: Record<string, unknown>;
  caveats: string[];
  metadata: Record<string, unknown>;
};

type ArbitrationSignals = {
  packageKey: string;
  policyPackage: boolean;
  suppressionPackage: boolean;
  fatigueGuardrail: boolean;
  fullPriceProtection: boolean;
  vipLifecycleSave: boolean;
  replenishmentDueNow: boolean;
  secondPurchaseSpecific: boolean;
  productEntryCrossSell: boolean;
  recentBuyerSpecific: boolean;
  genericPromo: boolean;
  discountHeavyPromo: boolean;
  specificLifecycleIntent: boolean;
  needsPolicyBeforeBrief: boolean;
  readyForBrief: boolean;
};

export type ArbitrationTestCandidate = Pick<
  NormalizedMicroCampaignPackage,
  | "packageKey"
  | "opportunityKey"
  | "status"
  | "packageType"
  | "approvalStatus"
  | "name"
  | "description"
  | "priority"
  | "confidence"
  | "sourceOpportunity"
  | "linkedMicroSegment"
  | "messageAngle"
  | "futureArtifact"
  | "caveats"
> & {
  id?: string | null;
  timeframeDays?: number;
  computedAt?: string;
  opportunityId?: string | null;
  audienceLogic?: Record<string, unknown>;
  productOfferDirection?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type ArbitrationBundle = {
  arbitrationKey: string;
  arbitrationVersion: string;
  packageKey: string;
  packageId: string | null;
  opportunityKey: string | null;
  opportunityId: string | null;
  microSegmentDefinitionKey: string | null;
  identityId: string | null;
  worklinCustomerId: string | null;
  shopifyCustomerId: string | null;
  klaviyoProfileId: string | null;
  timeframeDays: number;
  computedAt: string;
  decision: MicroCampaignArbitrationDecision;
  priority: number;
  rank: number;
  confidence: MicroCampaignArbitrationConfidence;
  activationStatus: typeof MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS;
  packageType: MicroCampaignPackageType;
  packageStatus: MicroCampaignPackageStatus;
  frequencyStatus: Record<string, unknown>;
  cooldownRecommendation: Record<string, unknown>;
  guardrailFlags: Record<string, unknown>;
  winningReason: string;
  losingReasons: string[];
  conflictNotes: string[];
  suppressedPackageKeys: string[];
  suppressedByPackageKeys: string[];
  recommendedNextStep: string;
  sourcePackage: Record<string, unknown>;
  sourceOpportunity: Record<string, unknown>;
  sourceMicroSegment: Record<string, unknown>;
  caveats: string[];
  externalActionTaken: false;
  canGoLiveNow: false;
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
};

type CandidateDecisionContext = {
  fatigueGuardrailKeys: string[];
  policyGuardrailKeys: string[];
  recentBuyerSpecificKeys: string[];
  replenishmentKeys: string[];
  topAdvanceKey: string | null;
};

type CandidateDecisionResult = {
  packageKey: string;
  decision: MicroCampaignArbitrationDecision;
  winningReason: string;
  losingReasons: string[];
  conflictNotes: string[];
  suppressedByPackageKeys: string[];
  recommendedNextStep: string;
  frequencyStatus: Record<string, unknown>;
  cooldownRecommendation: Record<string, unknown>;
  confidence: MicroCampaignArbitrationConfidence;
  priority: number;
};

const DEFAULT_COMPUTE_LIMIT = 25;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TIMEFRAME_DAYS = 730;

function cleanString(value: unknown, max = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseInteger(value: unknown, fallback: number | null, inputName: string, max: number) {
  if (value === undefined || value === null || value === "") {
    return fallback === null
      ? { ok: true as const, value: null }
      : { ok: true as const, value: fallback };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, issue: `${inputName} must be a positive whole number.` };
  }
  return { ok: true as const, value: Math.min(parsed, max) };
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") return { ok: true as const, value: fallback };
  if (typeof value === "boolean") return { ok: true as const, value };
  const cleaned = cleanString(value, 20)?.toLowerCase();
  if (["true", "1", "yes"].includes(cleaned ?? "")) return { ok: true as const, value: true };
  if (["false", "0", "no"].includes(cleaned ?? "")) return { ok: true as const, value: false };
  return { ok: false as const, issue: `${String(value)} must be true or false.` };
}

function parsePackageStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_PACKAGE_STATUSES.includes(cleaned as MicroCampaignPackageStatus)
    ? (cleaned as MicroCampaignPackageStatus)
    : undefined;
}

function parsePackageType(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_PACKAGE_TYPES.includes(cleaned as MicroCampaignPackageType)
    ? (cleaned as MicroCampaignPackageType)
    : undefined;
}

function parseApprovalStatus(value: unknown) {
  const cleaned = cleanString(value, 80)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_APPROVAL_STATUSES.includes(cleaned as MicroCampaignApprovalStatus)
    ? (cleaned as MicroCampaignApprovalStatus)
    : undefined;
}

function parseDecision(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_ARBITRATION_DECISIONS.includes(cleaned as MicroCampaignArbitrationDecision)
    ? (cleaned as MicroCampaignArbitrationDecision)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function uniqueStrings(items: Array<string | null | undefined>) {
  return Array.from(new Set(items.filter((item): item is string => Boolean(item?.trim()))));
}

function countBy<T extends string | null | undefined>(items: T[]) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isArbitrationStoreUnavailableError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2021";
  }

  const message = errorMessage(error);
  return /MicroCampaignArbitrationStore|micro_campaign_arbitration_store/i.test(message) &&
    /does not exist|not exist|missing/i.test(message);
}

export function parseMicroCampaignArbitrationComputeInput(
  input: MicroCampaignArbitrationComputeInput = {},
): ParsedComputeInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_COMPUTE_LIMIT, "limit", MAX_LIMIT);
  const persist = parseBoolean(input.persist, true);
  const packageStatus = parsePackageStatus(input.packageStatus);
  const packageType = parsePackageType(input.packageType);
  const approvalStatus = parseApprovalStatus(input.approvalStatus);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!persist.ok) issues.push("persist must be true or false.");
  if (packageStatus === undefined) issues.push("packageStatus must be prepared, blocked, or needs_review.");
  if (packageType === undefined) {
    issues.push("packageType must be campaign, flow, suppression, policy, lifecycle, or review.");
  }
  if (approvalStatus === undefined) {
    issues.push("approvalStatus must be not_requested, audience_review_required, policy_required, suppression_review_required, or review_required.");
  }

  return issues.length || !timeframeDays.ok || !limit.ok || !persist.ok || packageStatus === undefined || packageType === undefined || approvalStatus === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          packageKey: cleanString(input.packageKey, 180),
          opportunityKey: cleanString(input.opportunityKey, 180),
          microSegmentDefinitionKey: cleanString(input.microSegmentDefinitionKey, 180),
          timeframeDays: timeframeDays.value,
          packageStatus,
          packageType,
          approvalStatus,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          persist: persist.value,
        },
      };
}

export function parseMicroCampaignArbitrationListInput(
  input: MicroCampaignArbitrationListInput = {},
): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIMIT);
  const decision = parseDecision(input.decision);
  const packageStatus = parsePackageStatus(input.packageStatus);
  const packageType = parsePackageType(input.packageType);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (decision === undefined) issues.push("decision must be advance, wait, suppress, block, or needs_review.");
  if (packageStatus === undefined) issues.push("packageStatus must be prepared, blocked, or needs_review.");
  if (packageType === undefined) {
    issues.push("packageType must be campaign, flow, suppression, policy, lifecycle, or review.");
  }

  return issues.length || !timeframeDays.ok || !limit.ok || decision === undefined || packageStatus === undefined || packageType === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          arbitrationKey: cleanString(input.arbitrationKey, 180),
          packageKey: cleanString(input.packageKey, 180),
          opportunityKey: cleanString(input.opportunityKey, 180),
          microSegmentDefinitionKey: cleanString(input.microSegmentDefinitionKey, 180),
          timeframeDays: timeframeDays.value,
          decision,
          packageStatus,
          packageType,
          limit: limit.value ?? DEFAULT_LIST_LIMIT,
        },
      };
}

function compactStoredPackage(record: StoredMicroCampaignPackage): NormalizedMicroCampaignPackage {
  return {
    id: record.id,
    packageKey: record.packageKey,
    packageVersion: record.packageVersion,
    opportunityKey: record.opportunityKey,
    opportunityId: record.opportunityId,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: parsePackageStatus(record.status) ?? "needs_review",
    packageType: parsePackageType(record.packageType) ?? "review",
    approvalStatus: parseApprovalStatus(record.approvalStatus) ?? "review_required",
    name: record.name,
    description: record.description,
    priority: record.priority,
    confidence: record.confidence,
    sourceOpportunity: recordValue(record.sourceOpportunity),
    linkedMicroSegment: recordValue(record.linkedMicroSegment),
    audienceLogic: recordValue(record.audienceLogic),
    messageAngle: recordValue(record.messageAngle),
    productOfferDirection: recordValue(record.productOfferDirection),
    futureArtifact: recordValue(record.futureArtifact),
    caveats: asStringArray(record.caveats),
    metadata: recordValue(record.metadata),
  };
}

function compactComputedPackage(value: unknown): NormalizedMicroCampaignPackage | null {
  const record = recordValue(value);
  const packageKey = cleanString(record.packageKey, 180);
  if (!packageKey) return null;

  return {
    id: cleanString(record.persistedRecordId, 220),
    packageKey,
    packageVersion: cleanString(record.packageVersion, 120) ?? MICRO_CAMPAIGN_PACKAGE_VERSION,
    opportunityKey: cleanString(record.opportunityKey, 180),
    opportunityId: cleanString(record.opportunityId, 220),
    timeframeDays: numberValue(record.timeframeDays, 90),
    computedAt: cleanString(record.computedAt, 80) ?? new Date().toISOString(),
    status: parsePackageStatus(record.status) ?? "needs_review",
    packageType: parsePackageType(record.packageType) ?? "review",
    approvalStatus: parseApprovalStatus(record.approvalStatus) ?? "review_required",
    name: cleanString(record.name, 240) ?? packageKey,
    description: cleanString(record.description, 1200) ?? "",
    priority: numberValue(record.priority, 50),
    confidence: cleanString(record.confidence, 40) ?? "medium",
    sourceOpportunity: recordValue(record.sourceOpportunity),
    linkedMicroSegment: recordValue(record.linkedMicroSegment),
    audienceLogic: recordValue(record.audienceLogic),
    messageAngle: recordValue(record.messageAngle),
    productOfferDirection: recordValue(record.productOfferDirection),
    futureArtifact: recordValue(record.futureArtifact),
    caveats: asStringArray(record.caveats),
    metadata: recordValue(record.metadata),
  };
}

async function loadSourcePackages(input: {
  packageKey: string | null;
  opportunityKey: string | null;
  microSegmentDefinitionKey: string | null;
  timeframeDays: number | null;
  packageStatus: MicroCampaignPackageStatus | null;
  packageType: MicroCampaignPackageType | null;
  approvalStatus: MicroCampaignApprovalStatus | null;
  limit: number;
}): Promise<{
  packages: NormalizedMicroCampaignPackage[];
  mode: PackageSourceMode;
  caveats: string[];
}> {
  const linkedMicroSegmentFilter = input.microSegmentDefinitionKey
    ? {
        path: ["definitionKey"],
        equals: input.microSegmentDefinitionKey,
      }
    : undefined;

  const persistedWhere: Prisma.MicroCampaignPackageStoreWhereInput = {
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    ...(input.packageKey ? { packageKey: input.packageKey } : {}),
    ...(input.opportunityKey ? { opportunityKey: input.opportunityKey } : {}),
    ...(input.timeframeDays ? { timeframeDays: input.timeframeDays } : {}),
    ...(input.packageStatus ? { status: input.packageStatus } : {}),
    ...(input.packageType ? { packageType: input.packageType } : {}),
    ...(input.approvalStatus ? { approvalStatus: input.approvalStatus } : {}),
    ...(linkedMicroSegmentFilter ? { linkedMicroSegment: linkedMicroSegmentFilter } : {}),
  };

  const persisted = await prisma.microCampaignPackageStore.findMany({
    where: persistedWhere,
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
    take: input.limit,
  });

  if (persisted.length) {
    return {
      packages: persisted.map(compactStoredPackage),
      mode: "persisted_micro_campaign_packages",
      caveats: [],
    };
  }

  const computed = await computeMicroCampaignPackages({
    opportunityKey: input.opportunityKey,
    timeframeDays: input.timeframeDays,
    status: input.packageStatus,
    opportunityType: input.packageType,
    limit: input.limit,
    persist: false,
    includeZeroAudience: true,
    includePolicySuppression: true,
  });

  if (!computed.ok) {
    return {
      packages: [],
      mode: "computed_micro_campaign_package_fallback",
      caveats: ["Micro-campaign packages could not be read or computed for arbitration."],
    };
  }

  const packages = Array.isArray(computed.packages)
    ? computed.packages
        .map((pkg) => compactComputedPackage(pkg))
        .filter((pkg): pkg is NormalizedMicroCampaignPackage => Boolean(pkg))
        .filter((pkg) => {
          if (input.packageKey && pkg.packageKey !== input.packageKey) return false;
          if (input.microSegmentDefinitionKey) {
            const definitionKey = cleanString(recordValue(pkg.linkedMicroSegment).definitionKey, 180);
            if (definitionKey !== input.microSegmentDefinitionKey) return false;
          }
          if (input.approvalStatus && pkg.approvalStatus !== input.approvalStatus) return false;
          return true;
        })
    : [];

  return {
    packages,
    mode: "computed_micro_campaign_package_fallback",
    caveats: [
      "No persisted micro-campaign packages were found; arbitration used an in-memory package compute fallback.",
      "Run POST /api/campaigns/micro-campaigns/compute if you want durable package history before durable arbitration history.",
    ],
  };
}

function deriveSignals(pkg: ArbitrationTestCandidate): ArbitrationSignals {
  const opportunityKey = cleanString(pkg.opportunityKey, 180) ?? "";
  const definitionKey = cleanString(recordValue(pkg.linkedMicroSegment).definitionKey, 180) ?? "";
  const sourceOpportunity = recordValue(pkg.sourceOpportunity);
  const recommendedCampaignType = cleanString(sourceOpportunity.recommendedCampaignType, 180) ?? "";
  const name = `${pkg.name} ${pkg.description} ${recommendedCampaignType} ${opportunityKey} ${definitionKey}`.toLowerCase();
  const readiness = cleanString(recordValue(pkg.futureArtifact).readiness, 80) ?? "";
  const discountHeavyPromo =
    /(promo|discount|offer|winback)/.test(name) ||
    recommendedCampaignType === "targeted_winback_offer";
  const replenishmentDueNow =
    opportunityKey.includes("replenishment_due_now") ||
    definitionKey.includes("replenishment_ready_repeat_buyers") ||
    /replenishment|restock|due-now/.test(name);
  const vipLifecycleSave =
    opportunityKey.includes("vip_churn_save_motion") ||
    definitionKey.includes("vip_customers_at_churn_risk_still_engaged") ||
    /vip.*churn|vip.*save|high-value customers lapse/.test(name);
  const secondPurchaseSpecific =
    opportunityKey.includes("second_purchase") ||
    definitionKey.includes("second_purchase") ||
    /second-purchase|one-time buyers/.test(name);
  const productEntryCrossSell =
    opportunityKey.includes("product_entry_cross_sell") ||
    definitionKey.includes("product_entry_cohort_cross_sell") ||
    /cross-sell|product-entry/.test(name);
  const fullPriceProtection =
    opportunityKey.includes("full_price_discount_protection") ||
    definitionKey.includes("full_price_likely_customers_discount_protection") ||
    /full-price|discount protection/.test(name);
  const fatigueGuardrail =
    opportunityKey.includes("fatigue_suppression") ||
    definitionKey.includes("high_email_fatigue") ||
    /fatigue|suppression risk|holdout/.test(name);
  const suppressionPackage = pkg.packageType === "suppression";
  const policyPackage = pkg.packageType === "policy";
  const recentBuyerSpecific = replenishmentDueNow || secondPurchaseSpecific || productEntryCrossSell;
  const specificLifecycleIntent = replenishmentDueNow || vipLifecycleSave || secondPurchaseSpecific;
  const genericPromo =
    discountHeavyPromo ||
    (pkg.packageType === "campaign" && !specificLifecycleIntent && !productEntryCrossSell);

  return {
    packageKey: pkg.packageKey,
    policyPackage,
    suppressionPackage,
    fatigueGuardrail,
    fullPriceProtection,
    vipLifecycleSave,
    replenishmentDueNow,
    secondPurchaseSpecific,
    productEntryCrossSell,
    recentBuyerSpecific,
    genericPromo,
    discountHeavyPromo,
    specificLifecycleIntent,
    needsPolicyBeforeBrief: readiness === "needs_policy_before_brief" || pkg.approvalStatus === "policy_required",
    readyForBrief: readiness === "ready_for_brief" || booleanValue(recordValue(pkg.messageAngle).readyForBriefGenerator, false),
  };
}

function basePriority(pkg: ArbitrationTestCandidate, signals: ArbitrationSignals) {
  let score = numberValue(pkg.priority, 50);
  if (signals.replenishmentDueNow) score += 45;
  if (signals.vipLifecycleSave) score += 32;
  if (signals.secondPurchaseSpecific) score += 24;
  if (signals.productEntryCrossSell) score += 16;
  if (pkg.packageType === "flow") score += 10;
  if (pkg.packageType === "lifecycle") score += 8;
  if (signals.readyForBrief) score += 5;
  if (signals.needsPolicyBeforeBrief) score -= 4;
  if (signals.genericPromo) score -= 10;
  if (signals.discountHeavyPromo) score -= 4;
  return Math.max(1, Math.round(score));
}

function confidenceFromDecision(input: {
  pkg: ArbitrationTestCandidate;
  decision: MicroCampaignArbitrationDecision;
  signals: ArbitrationSignals;
  suppressedByCount: number;
}): MicroCampaignArbitrationConfidence {
  if (input.decision === "advance" && input.signals.replenishmentDueNow) return "high";
  if (input.decision === "suppress" && input.signals.fatigueGuardrail) return "high";
  if (input.decision === "block" && (input.signals.policyPackage || input.signals.suppressionPackage)) return "high";
  if (input.decision === "needs_review" || input.pkg.status === "needs_review") return "low";
  if (input.suppressedByCount > 1) return "high";
  return input.decision === "advance" ? "medium" : "medium";
}

function frequencyStatusFor(input: {
  decision: MicroCampaignArbitrationDecision;
  signals: ArbitrationSignals;
  suppressedBy: string[];
}) {
  if (input.decision === "block" && input.signals.policyPackage) {
    return {
      state: "guardrail_only",
      rule: "policy_package_is_not_a_campaign",
      cooldownActive: false,
      recommendedWaitDays: null,
      rationale: "Policy packages should shape future arbitration and approval, not become campaign artifacts.",
    };
  }

  if (input.decision === "block" && input.signals.suppressionPackage) {
    return {
      state: "guardrail_only",
      rule: "suppression_package_is_not_a_campaign",
      cooldownActive: true,
      recommendedWaitDays: 21,
      rationale: "Suppression packages represent holdout logic and should not move into campaign generation.",
    };
  }

  if (input.decision === "suppress" && input.signals.fatigueGuardrail) {
    return {
      state: "suppressed_fatigue_veto",
      rule: "high_fatigue_veto",
      cooldownActive: true,
      recommendedWaitDays: 21,
      rationale: "High fatigue or suppression signals veto marketing sends until a future recheck.",
      suppressedBy: input.suppressedBy,
    };
  }

  if (input.decision === "suppress" && input.signals.genericPromo) {
    return {
      state: "suppressed_generic_promo",
      rule: "specific_lifecycle_or_policy_outranks_generic_promo",
      cooldownActive: true,
      recommendedWaitDays: 14,
      rationale: "Generic promo should not run while more specific lifecycle or policy logic is active.",
      suppressedBy: input.suppressedBy,
    };
  }

  if (input.decision === "wait") {
    return {
      state: "wait_for_higher_priority_path",
      rule: "queue_after_higher_priority_package",
      cooldownActive: true,
      recommendedWaitDays: input.signals.replenishmentDueNow ? 5 : 7,
      rationale: "A higher-priority package should move first; keep this prepared but not active.",
    };
  }

  if (input.decision === "advance") {
    return {
      state: "ready_for_next_safe_step",
      rule: input.signals.replenishmentDueNow
        ? "due_now_replenishment_beats_generic_promo"
        : input.signals.specificLifecycleIntent
          ? "specific_lifecycle_beats_generic_promo"
          : "highest_priority_prepared_package",
      cooldownActive: false,
      recommendedWaitDays: input.signals.replenishmentDueNow ? 5 : 7,
      rationale: "This package is the best next advisory candidate for a future safe downstream path.",
    };
  }

  return {
    state: "review_required",
    rule: "human_review_before_downstream_work",
    cooldownActive: false,
    recommendedWaitDays: null,
    rationale: "Source package status or policy context requires review before any next step.",
  };
}

function nextStepFor(input: {
  decision: MicroCampaignArbitrationDecision;
  signals: ArbitrationSignals;
}) {
  if (input.decision === "advance") {
    return "Keep this package as the next advisory candidate for a future approval/brief/QA path; do not create downstream artifacts automatically.";
  }
  if (input.decision === "wait") {
    return "Hold this package in prepared state until the higher-priority lifecycle or guardrail path clears.";
  }
  if (input.decision === "suppress") {
    return "Suppress this package for now and re-evaluate after the cooldown or guardrail condition changes.";
  }
  if (input.decision === "block" && input.signals.policyPackage) {
    return "Treat this as a policy guardrail only; use it to veto or reshape future promo work rather than creating a campaign.";
  }
  if (input.decision === "block" && input.signals.suppressionPackage) {
    return "Treat this as a suppression guardrail only; use it to hold out broad marketing rather than creating a campaign.";
  }
  return "Review the package and its guardrail context before any future downstream handoff.";
}

function decisionWeight(decision: MicroCampaignArbitrationDecision) {
  if (decision === "advance") return 5;
  if (decision === "block") return 4;
  if (decision === "wait") return 3;
  if (decision === "suppress") return 2;
  return 1;
}

function chooseTopAdvanceKey(
  candidates: Array<{ pkg: ArbitrationTestCandidate; signals: ArbitrationSignals; priority: number }>,
  context: Omit<CandidateDecisionContext, "topAdvanceKey">,
) {
  const eligible = candidates.filter(({ pkg, signals }) => {
    if (pkg.status !== "prepared") return false;
    if (signals.policyPackage || signals.suppressionPackage) return false;
    if (context.fatigueGuardrailKeys.length) return false;
    if (signals.discountHeavyPromo && context.policyGuardrailKeys.length) return false;
    if (signals.genericPromo && context.recentBuyerSpecificKeys.length) return false;
    return true;
  });

  if (!eligible.length) return null;

  eligible.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.pkg.packageKey.localeCompare(right.pkg.packageKey);
  });

  return eligible[0]?.pkg.packageKey ?? null;
}

function decisionForCandidate(
  pkg: ArbitrationTestCandidate,
  signals: ArbitrationSignals,
  priority: number,
  context: CandidateDecisionContext,
): CandidateDecisionResult {
  if (pkg.status === "blocked") {
    return {
      packageKey: pkg.packageKey,
      decision: "block",
      winningReason: "Source package is already blocked and cannot move forward.",
      losingReasons: ["source_package_blocked"],
      conflictNotes: ["Micro-campaign package status is blocked; arbitration preserves that state."],
      suppressedByPackageKeys: [],
      recommendedNextStep: "Review the blocked package context before any future regeneration.",
      frequencyStatus: {
        state: "blocked_source_status",
        rule: "package_status_blocked",
        cooldownActive: true,
        recommendedWaitDays: 14,
      },
      cooldownRecommendation: {
        waitDays: 14,
        reason: "Blocked source package should not move downstream.",
      },
      confidence: "high",
      priority,
    };
  }

  if (signals.policyPackage) {
    return {
      packageKey: pkg.packageKey,
      decision: "block",
      winningReason: "Policy package stays as a guardrail and must not become a campaign artifact.",
      losingReasons: ["policy_package_not_marketing_candidate"],
      conflictNotes: ["Use this package to shape offer arbitration and promo veto rules."],
      suppressedByPackageKeys: [],
      recommendedNextStep: nextStepFor({ decision: "block", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "block", signals, suppressedBy: [] }),
      cooldownRecommendation: {
        waitDays: null,
        reason: "Policy package should persist as advisory guardrail logic.",
      },
      confidence: "high",
      priority,
    };
  }

  if (signals.suppressionPackage) {
    return {
      packageKey: pkg.packageKey,
      decision: "block",
      winningReason: "Suppression package stays as a guardrail and must not become a campaign artifact.",
      losingReasons: ["suppression_package_not_marketing_candidate"],
      conflictNotes: ["Use this package to hold out broad marketing and protect future high-intent moments."],
      suppressedByPackageKeys: [],
      recommendedNextStep: nextStepFor({ decision: "block", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "block", signals, suppressedBy: [] }),
      cooldownRecommendation: {
        waitDays: 21,
        reason: "Suppression package represents a holdout rule, not a send path.",
      },
      confidence: "high",
      priority,
    };
  }

  if (pkg.status === "needs_review") {
    return {
      packageKey: pkg.packageKey,
      decision: "needs_review",
      winningReason: "Package needs review before arbitration can safely advance it.",
      losingReasons: ["source_package_needs_review"],
      conflictNotes: ["Audience or policy readiness is not strong enough for an automatic advance recommendation."],
      suppressedByPackageKeys: [],
      recommendedNextStep: nextStepFor({ decision: "needs_review", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "needs_review", signals, suppressedBy: [] }),
      cooldownRecommendation: {
        waitDays: null,
        reason: "Review the package before any future downstream handoff.",
      },
      confidence: "low",
      priority,
    };
  }

  if (context.fatigueGuardrailKeys.length) {
    const suppressedBy = context.fatigueGuardrailKeys.filter((key) => key !== pkg.packageKey);
    return {
      packageKey: pkg.packageKey,
      decision: "suppress",
      winningReason: "High fatigue or suppression guardrails veto marketing sends for now.",
      losingReasons: ["high_fatigue_veto_beats_marketing_send"],
      conflictNotes: ["Suppress broad or non-essential marketing while fatigue or suppression risk is elevated."],
      suppressedByPackageKeys: suppressedBy,
      recommendedNextStep: nextStepFor({ decision: "suppress", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "suppress", signals: { ...signals, fatigueGuardrail: true }, suppressedBy }),
      cooldownRecommendation: {
        waitDays: 21,
        reason: "Recheck only after fatigue/suppression conditions improve.",
      },
      confidence: "high",
      priority,
    };
  }

  if (signals.discountHeavyPromo && context.policyGuardrailKeys.length) {
    const suppressedBy = context.policyGuardrailKeys.filter((key) => key !== pkg.packageKey);
    return {
      packageKey: pkg.packageKey,
      decision: "suppress",
      winningReason: "Full-price/VIP protection guardrails beat heavy-discount promo logic.",
      losingReasons: ["vip_full_price_discount_protection_veto"],
      conflictNotes: ["Protect likely full-price buyers from unnecessary markdown pressure."],
      suppressedByPackageKeys: suppressedBy,
      recommendedNextStep: nextStepFor({ decision: "suppress", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "suppress", signals, suppressedBy }),
      cooldownRecommendation: {
        waitDays: 14,
        reason: "Revisit only if a later policy explicitly permits a discount-led path.",
      },
      confidence: "high",
      priority,
    };
  }

  if (signals.genericPromo && context.recentBuyerSpecificKeys.length) {
    const suppressedBy = context.recentBuyerSpecificKeys.filter((key) => key !== pkg.packageKey);
    return {
      packageKey: pkg.packageKey,
      decision: "suppress",
      winningReason: "Recent-buyer specific lifecycle paths beat broad promo pressure.",
      losingReasons: ["recent_buyer_specificity_beats_generic_promo"],
      conflictNotes: ["Recent or active buyer packages should move before broad promo logic."],
      suppressedByPackageKeys: suppressedBy,
      recommendedNextStep: nextStepFor({ decision: "suppress", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "suppress", signals, suppressedBy }),
      cooldownRecommendation: {
        waitDays: 14,
        reason: "Generic promo should stay suppressed while a recent-buyer path is active.",
      },
      confidence: "high",
      priority,
    };
  }

  if (signals.genericPromo && context.replenishmentKeys.length) {
    return {
      packageKey: pkg.packageKey,
      decision: "wait",
      winningReason: "Due-now replenishment should move first; generic churn/promo can wait.",
      losingReasons: ["replenishment_due_now_outranks_generic_promo"],
      conflictNotes: ["Replenishment timing creates a more useful and less spammy next action than generic promo."],
      suppressedByPackageKeys: [],
      recommendedNextStep: nextStepFor({ decision: "wait", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "wait", signals, suppressedBy: [] }),
      cooldownRecommendation: {
        waitDays: 7,
        reason: "Re-check after the replenishment path or other specific lifecycle motion clears.",
      },
      confidence: "high",
      priority,
    };
  }

  if (context.topAdvanceKey && context.topAdvanceKey !== pkg.packageKey) {
    return {
      packageKey: pkg.packageKey,
      decision: "wait",
      winningReason: "Another prepared package is the better next action right now.",
      losingReasons: ["higher_priority_package_selected"],
      conflictNotes: ["Keep this package prepared, but do not move it first."],
      suppressedByPackageKeys: [],
      recommendedNextStep: nextStepFor({ decision: "wait", signals }),
      frequencyStatus: frequencyStatusFor({ decision: "wait", signals, suppressedBy: [] }),
      cooldownRecommendation: {
        waitDays: signals.genericPromo ? 7 : 5,
        reason: "Re-evaluate after the higher-priority package path completes or is held.",
      },
      confidence: "medium",
      priority,
    };
  }

  return {
    packageKey: pkg.packageKey,
    decision: "advance",
    winningReason: signals.replenishmentDueNow
      ? "Due-now replenishment beats generic promo because timing is more specific and useful."
      : signals.specificLifecycleIntent
        ? "Specific lifecycle or intent beats generic promo and should move first."
        : "This is the strongest prepared package available right now.",
    losingReasons: [],
    conflictNotes: uniqueStrings([
      signals.discountHeavyPromo ? "Still review discount framing against future policy rules before any downstream brief path." : null,
      signals.readyForBrief ? "Prepared for a future brief path, but no downstream artifact is created here." : null,
    ]),
    suppressedByPackageKeys: [],
    recommendedNextStep: nextStepFor({ decision: "advance", signals }),
    frequencyStatus: frequencyStatusFor({ decision: "advance", signals, suppressedBy: [] }),
    cooldownRecommendation: {
      waitDays: signals.replenishmentDueNow ? 5 : 7,
      reason: "Use a conservative advisory cadence before any later downstream path is enabled.",
    },
    confidence: "medium",
    priority,
  };
}

export function arbitrateMicroCampaignPackages(candidates: ArbitrationTestCandidate[]) {
  const normalized = candidates.map((pkg) => {
    const signals = deriveSignals(pkg);
    return {
      pkg,
      signals,
      priority: basePriority(pkg, signals),
    };
  });

  const fatigueGuardrailKeys = normalized
    .filter(({ signals }) => signals.suppressionPackage || signals.fatigueGuardrail)
    .map(({ pkg }) => pkg.packageKey);
  const policyGuardrailKeys = normalized
    .filter(({ signals }) => signals.policyPackage || signals.fullPriceProtection)
    .map(({ pkg }) => pkg.packageKey);
  const recentBuyerSpecificKeys = normalized
    .filter(({ signals, pkg }) => pkg.status === "prepared" && signals.recentBuyerSpecific)
    .map(({ pkg }) => pkg.packageKey);
  const replenishmentKeys = normalized
    .filter(({ signals, pkg }) => pkg.status === "prepared" && signals.replenishmentDueNow)
    .map(({ pkg }) => pkg.packageKey);

  const topAdvanceKey = chooseTopAdvanceKey(normalized, {
    fatigueGuardrailKeys,
    policyGuardrailKeys,
    recentBuyerSpecificKeys,
    replenishmentKeys,
  });

  const decisions = normalized.map(({ pkg, signals, priority }) =>
    decisionForCandidate(pkg, signals, priority, {
      fatigueGuardrailKeys,
      policyGuardrailKeys,
      recentBuyerSpecificKeys,
      replenishmentKeys,
      topAdvanceKey,
    }),
  );

  const suppressedKeysBySuppressor = new Map<string, string[]>();
  for (const result of decisions) {
    for (const suppressor of result.suppressedByPackageKeys) {
      const current = suppressedKeysBySuppressor.get(suppressor) ?? [];
      if (!current.includes(result.packageKey)) current.push(result.packageKey);
      suppressedKeysBySuppressor.set(suppressor, current);
    }
  }

  const ranked = normalized
    .map(({ pkg, signals }) => {
      const result = decisions.find((item) => item.packageKey === pkg.packageKey)!;
      return {
        pkg,
        signals,
        ...result,
        suppressedPackageKeys: suppressedKeysBySuppressor.get(pkg.packageKey) ?? [],
      };
    })
    .sort((left, right) => {
      const decisionDiff = decisionWeight(right.decision) - decisionWeight(left.decision);
      if (decisionDiff) return decisionDiff;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.pkg.packageKey.localeCompare(right.pkg.packageKey);
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      confidence: confidenceFromDecision({
        pkg: item.pkg,
        decision: item.decision,
        signals: item.signals,
        suppressedByCount: item.suppressedByPackageKeys.length,
      }),
    }));

  return ranked;
}

function normalizeTestCandidate(candidate: ArbitrationTestCandidate): NormalizedMicroCampaignPackage {
  return {
    id: candidate.id ?? null,
    packageKey: candidate.packageKey,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    opportunityKey: candidate.opportunityKey ?? null,
    opportunityId: candidate.opportunityId ?? null,
    timeframeDays: candidate.timeframeDays ?? 90,
    computedAt: candidate.computedAt ?? new Date().toISOString(),
    status: candidate.status,
    packageType: candidate.packageType,
    approvalStatus: candidate.approvalStatus,
    name: candidate.name,
    description: candidate.description,
    priority: candidate.priority,
    confidence: candidate.confidence,
    sourceOpportunity: candidate.sourceOpportunity,
    linkedMicroSegment: recordValue(candidate.linkedMicroSegment),
    audienceLogic: recordValue(candidate.audienceLogic),
    messageAngle: recordValue(candidate.messageAngle),
    productOfferDirection: recordValue(candidate.productOfferDirection),
    futureArtifact: recordValue(candidate.futureArtifact),
    caveats: candidate.caveats,
    metadata: recordValue(candidate.metadata),
  };
}

export function previewMicroCampaignArbitrationsFromCandidates(
  candidates: ArbitrationTestCandidate[],
  computedAt = new Date(),
) {
  const normalizedPackages = candidates.map(normalizeTestCandidate);
  const arbitrationResults = arbitrateMicroCampaignPackages(candidates);

  return normalizedPackages.map((pkg) => {
    const decision = arbitrationResults.find((result) => result.pkg.packageKey === pkg.packageKey)!;
    return compactBundle(buildArbitrationBundle({ pkg, decision, computedAt }));
  });
}

function buildArbitrationBundle(input: {
  pkg: NormalizedMicroCampaignPackage;
  decision: ReturnType<typeof arbitrateMicroCampaignPackages>[number];
  computedAt: Date;
}): ArbitrationBundle {
  const definitionKey = cleanString(recordValue(input.pkg.linkedMicroSegment).definitionKey, 180);
  const opportunity = recordValue(input.pkg.sourceOpportunity);
  const sourceMicroSegment = recordValue(input.pkg.linkedMicroSegment);
  const caveats = uniqueStrings([
    ...input.pkg.caveats,
    "Arbitration + Frequency Guardrails v0 is advisory only and package-level; it does not load member lists or execute downstream actions.",
    "Customer-level identity references remain null in v0 because package membership is not expanded into raw customer lists.",
    "No CampaignPlan, CampaignBrief, QA, Klaviyo draft, segment sync, profile sync, flow creation, send, schedule, or external live action is performed here.",
  ]);

  return {
    arbitrationKey: `${input.pkg.packageKey}_arbitration`,
    arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
    packageKey: input.pkg.packageKey,
    packageId: input.pkg.id,
    opportunityKey: input.pkg.opportunityKey,
    opportunityId: input.pkg.opportunityId,
    microSegmentDefinitionKey: definitionKey,
    identityId: null,
    worklinCustomerId: null,
    shopifyCustomerId: null,
    klaviyoProfileId: null,
    timeframeDays: input.pkg.timeframeDays,
    computedAt: input.computedAt.toISOString(),
    decision: input.decision.decision,
    priority: input.decision.priority,
    rank: input.decision.rank,
    confidence: input.decision.confidence,
    activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
    packageType: input.pkg.packageType,
    packageStatus: input.pkg.status,
    frequencyStatus: input.decision.frequencyStatus,
    cooldownRecommendation: input.decision.cooldownRecommendation,
    guardrailFlags: {
      recentBuyerSpecific: input.decision.signals.recentBuyerSpecific,
      replenishmentDueNow: input.decision.signals.replenishmentDueNow,
      highFatigueOrSuppression: input.decision.signals.fatigueGuardrail,
      vipLifecycleSave: input.decision.signals.vipLifecycleSave,
      fullPriceDiscountProtection: input.decision.signals.fullPriceProtection,
      discountHeavyPromo: input.decision.signals.discountHeavyPromo,
      policyPackage: input.decision.signals.policyPackage,
      suppressionPackage: input.decision.signals.suppressionPackage,
      specificLifecycleIntent: input.decision.signals.specificLifecycleIntent,
      genericPromo: input.decision.signals.genericPromo,
    },
    winningReason: input.decision.winningReason,
    losingReasons: input.decision.losingReasons,
    conflictNotes: input.decision.conflictNotes,
    suppressedPackageKeys: input.decision.suppressedPackageKeys,
    suppressedByPackageKeys: input.decision.suppressedByPackageKeys,
    recommendedNextStep: input.decision.recommendedNextStep,
    sourcePackage: {
      id: input.pkg.id,
      packageKey: input.pkg.packageKey,
      packageVersion: input.pkg.packageVersion,
      packageType: input.pkg.packageType,
      packageStatus: input.pkg.status,
      approvalStatus: input.pkg.approvalStatus,
      name: input.pkg.name,
      priority: input.pkg.priority,
      confidence: input.pkg.confidence,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    sourceOpportunity: {
      id: input.pkg.opportunityId,
      opportunityKey: input.pkg.opportunityKey,
      recommendedCampaignType: cleanString(opportunity.recommendedCampaignType, 160),
      opportunityType: cleanString(opportunity.opportunityType, 80),
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    sourceMicroSegment: {
      definitionKey,
      name: cleanString(sourceMicroSegment.name, 240),
      confidence: cleanString(sourceMicroSegment.confidence, 40),
      qualifyingLogicAvailable: booleanValue(sourceMicroSegment.qualifyingLogicAvailable, false),
    },
    caveats,
    externalActionTaken: false,
    canGoLiveNow: false,
    metadata: {
      route: "POST /api/campaigns/arbitrations/compute",
      listRoute: "GET /api/campaigns/arbitrations",
      getRoute: "GET /api/campaigns/arbitrations/[id]",
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      sourcePackageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      campaignPlanCreated: false,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
      klaviyoSegmentCreated: false,
      profileSyncPerformed: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
    },
  };
}

async function persistBundle(bundle: ArbitrationBundle) {
  return prisma.microCampaignArbitrationStore.upsert({
    where: {
      arbitrationKey_timeframeDays_arbitrationVersion: {
        arbitrationKey: bundle.arbitrationKey,
        timeframeDays: bundle.timeframeDays,
        arbitrationVersion: bundle.arbitrationVersion,
      },
    },
    create: {
      arbitrationKey: bundle.arbitrationKey,
      arbitrationVersion: bundle.arbitrationVersion,
      packageKey: bundle.packageKey,
      packageId: bundle.packageId,
      opportunityKey: bundle.opportunityKey,
      opportunityId: bundle.opportunityId,
      microSegmentDefinitionKey: bundle.microSegmentDefinitionKey,
      identityId: bundle.identityId,
      worklinCustomerId: bundle.worklinCustomerId,
      shopifyCustomerId: bundle.shopifyCustomerId,
      klaviyoProfileId: bundle.klaviyoProfileId,
      timeframeDays: bundle.timeframeDays,
      computedAt: new Date(bundle.computedAt),
      decision: bundle.decision,
      priority: bundle.priority,
      rank: bundle.rank,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      packageType: bundle.packageType,
      packageStatus: bundle.packageStatus,
      frequencyStatus: asJson(bundle.frequencyStatus),
      cooldownRecommendation: asJson(bundle.cooldownRecommendation),
      guardrailFlags: asJson(bundle.guardrailFlags),
      winningReason: bundle.winningReason,
      losingReasons: asJson(bundle.losingReasons),
      conflictNotes: asJson(bundle.conflictNotes),
      suppressedPackageKeys: asJson(bundle.suppressedPackageKeys),
      suppressedByPackageKeys: asJson(bundle.suppressedByPackageKeys),
      recommendedNextStep: bundle.recommendedNextStep,
      sourcePackage: asJson(bundle.sourcePackage),
      sourceOpportunity: asJson(bundle.sourceOpportunity),
      sourceMicroSegment: asJson(bundle.sourceMicroSegment),
      caveats: asJson(bundle.caveats),
      externalActionTaken: false,
      canGoLiveNow: false,
      metadata: asJson(bundle.metadata),
    },
    update: {
      packageId: bundle.packageId,
      opportunityKey: bundle.opportunityKey,
      opportunityId: bundle.opportunityId,
      microSegmentDefinitionKey: bundle.microSegmentDefinitionKey,
      computedAt: new Date(bundle.computedAt),
      decision: bundle.decision,
      priority: bundle.priority,
      rank: bundle.rank,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      packageType: bundle.packageType,
      packageStatus: bundle.packageStatus,
      frequencyStatus: asJson(bundle.frequencyStatus),
      cooldownRecommendation: asJson(bundle.cooldownRecommendation),
      guardrailFlags: asJson(bundle.guardrailFlags),
      winningReason: bundle.winningReason,
      losingReasons: asJson(bundle.losingReasons),
      conflictNotes: asJson(bundle.conflictNotes),
      suppressedPackageKeys: asJson(bundle.suppressedPackageKeys),
      suppressedByPackageKeys: asJson(bundle.suppressedByPackageKeys),
      recommendedNextStep: bundle.recommendedNextStep,
      sourcePackage: asJson(bundle.sourcePackage),
      sourceOpportunity: asJson(bundle.sourceOpportunity),
      sourceMicroSegment: asJson(bundle.sourceMicroSegment),
      caveats: asJson(bundle.caveats),
      externalActionTaken: false,
      canGoLiveNow: false,
      metadata: asJson(bundle.metadata),
    },
  });
}

async function persistArbitrationBundles(bundles: ArbitrationBundle[]) {
  try {
    const records = await Promise.all(bundles.map(persistBundle));
    return {
      applied: true,
      records,
      caveat: null,
    };
  } catch (error) {
    if (isArbitrationStoreUnavailableError(error)) {
      return {
        applied: false,
        records: [] as Awaited<ReturnType<typeof persistBundle>>[],
        caveat:
          "Micro-campaign arbitration storage is not available yet; computed arbitration results were returned without durable persistence.",
      };
    }

    throw error;
  }
}

function compactBundle(bundle: ArbitrationBundle) {
  return {
    arbitrationKey: bundle.arbitrationKey,
    arbitrationVersion: bundle.arbitrationVersion,
    packageKey: bundle.packageKey,
    packageId: bundle.packageId,
    opportunityKey: bundle.opportunityKey,
    opportunityId: bundle.opportunityId,
    microSegmentDefinitionKey: bundle.microSegmentDefinitionKey,
    identityId: bundle.identityId,
    worklinCustomerId: bundle.worklinCustomerId,
    shopifyCustomerId: bundle.shopifyCustomerId,
    klaviyoProfileId: bundle.klaviyoProfileId,
    timeframeDays: bundle.timeframeDays,
    computedAt: bundle.computedAt,
    decision: bundle.decision,
    priority: bundle.priority,
    rank: bundle.rank,
    confidence: bundle.confidence,
    activationStatus: bundle.activationStatus,
    packageType: bundle.packageType,
    packageStatus: bundle.packageStatus,
    frequencyStatus: bundle.frequencyStatus,
    cooldownRecommendation: bundle.cooldownRecommendation,
    guardrailFlags: bundle.guardrailFlags,
    winningReason: bundle.winningReason,
    losingReasons: bundle.losingReasons,
    conflictNotes: bundle.conflictNotes,
    suppressedPackageKeys: bundle.suppressedPackageKeys,
    suppressedByPackageKeys: bundle.suppressedByPackageKeys,
    recommendedNextStep: bundle.recommendedNextStep,
    sourcePackage: bundle.sourcePackage,
    sourceOpportunity: bundle.sourceOpportunity,
    sourceMicroSegment: bundle.sourceMicroSegment,
    caveats: bundle.caveats,
    externalActionTaken: false,
    canGoLiveNow: false,
    metadata: bundle.metadata,
    ...(bundle.persistedRecordId ? { persistedRecordId: bundle.persistedRecordId } : {}),
  };
}

function compactStoredArbitration(record: StoredArbitration) {
  return {
    id: record.id,
    arbitrationKey: record.arbitrationKey,
    arbitrationVersion: record.arbitrationVersion,
    packageKey: record.packageKey,
    packageId: record.packageId,
    opportunityKey: record.opportunityKey,
    opportunityId: record.opportunityId,
    microSegmentDefinitionKey: record.microSegmentDefinitionKey,
    identityId: record.identityId,
    worklinCustomerId: record.worklinCustomerId,
    shopifyCustomerId: record.shopifyCustomerId,
    klaviyoProfileId: record.klaviyoProfileId,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    decision: record.decision,
    priority: record.priority,
    rank: record.rank,
    confidence: record.confidence,
    activationStatus: record.activationStatus,
    packageType: record.packageType,
    packageStatus: record.packageStatus,
    frequencyStatus: record.frequencyStatus,
    cooldownRecommendation: record.cooldownRecommendation,
    guardrailFlags: record.guardrailFlags,
    winningReason: record.winningReason,
    losingReasons: record.losingReasons,
    conflictNotes: record.conflictNotes,
    suppressedPackageKeys: record.suppressedPackageKeys,
    suppressedByPackageKeys: record.suppressedByPackageKeys,
    recommendedNextStep: record.recommendedNextStep,
    sourcePackage: record.sourcePackage,
    sourceOpportunity: record.sourceOpportunity,
    sourceMicroSegment: record.sourceMicroSegment,
    caveats: record.caveats,
    externalActionTaken: false,
    canGoLiveNow: false,
    metadata: {
      arbitrationVersion: record.arbitrationVersion,
      activationStatus: record.activationStatus,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function computeMicroCampaignArbitrations(input: MicroCampaignArbitrationComputeInput = {}) {
  const parsed = parseMicroCampaignArbitrationComputeInput(input);
  if (!parsed.ok) return parsed;

  const loaded = await loadSourcePackages(parsed.data);
  const computedAt = new Date();
  const arbitrationResults = arbitrateMicroCampaignPackages(loaded.packages);
  const bundles = loaded.packages.map((pkg) => {
    const decision = arbitrationResults.find((result) => result.pkg.packageKey === pkg.packageKey);
    return buildArbitrationBundle({
      pkg,
      decision: decision!,
      computedAt,
    });
  });
  const persistence = parsed.data.persist
    ? await persistArbitrationBundles(bundles)
    : { applied: false, records: [] as Awaited<ReturnType<typeof persistBundle>>[], caveat: null };
  const persisted = persistence.records;
  const persistedByKey = new Map(persisted.map((record) => [record.packageKey, record]));
  const arbitrations = bundles.map((bundle) => {
    const persistedRecord = persistedByKey.get(bundle.packageKey);
    return compactBundle({
      ...bundle,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });

  const caveats = uniqueStrings([
    ...loaded.caveats,
    ...bundles.flatMap((bundle) => bundle.caveats),
    persistence.caveat,
    !loaded.packages.length ? "No source micro-campaign packages were available for arbitration." : null,
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    computedAt: computedAt.toISOString(),
    persistRequested: parsed.data.persist,
    persisted: persistence.applied,
    summary: {
      sourcePackageMode: loaded.mode,
      sourcePackagesAnalyzed: loaded.packages.length,
      arbitrationsReturned: arbitrations.length,
      arbitrationsPersisted: persisted.length,
      decisionCounts: countBy(bundles.map((bundle) => bundle.decision)),
      packageTypeCounts: countBy(bundles.map((bundle) => bundle.packageType)),
      packageStatusCounts: countBy(bundles.map((bundle) => bundle.packageStatus)),
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      topAdvancePackageKey: bundles.find((bundle) => bundle.decision === "advance")?.packageKey ?? null,
      topSuppressedPackageKeys: bundles
        .filter((bundle) => bundle.decision === "suppress")
        .slice(0, 5)
        .map((bundle) => bundle.packageKey),
    },
    arbitrations,
    sourceStatuses: [
      {
        source: "micro_campaign_packages",
        status: loaded.packages.length ? "available" : "unavailable",
        rowsAnalyzed: loaded.packages.length,
        readOnly: true,
      },
      {
        source: "arbitration_frequency_guardrails",
        status: arbitrations.length ? "available" : "unavailable",
        rowsAnalyzed: arbitrations.length,
        readOnly: true,
      },
    ],
    missingCapabilities: uniqueStrings([
      !loaded.packages.length ? "micro_campaign_packages.available_records" : null,
      "customer_level_package_membership_resolution",
      "approved_arbitration_to_brief_pipeline",
    ]),
    caveats,
    metadata: {
      route: "POST /api/campaigns/arbitrations/compute",
      listRoute: "GET /api/campaigns/arbitrations",
      getRoute: "GET /api/campaigns/arbitrations/[id]",
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      persistRequested: parsed.data.persist,
      persisted: persistence.applied,
      externalActionTaken: false,
      canGoLiveNow: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      campaignPlanCreated: false,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
      klaviyoSegmentCreated: false,
      profileSyncPerformed: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
    },
  };
}

export async function listMicroCampaignArbitrations(input: MicroCampaignArbitrationListInput = {}) {
  const parsed = parseMicroCampaignArbitrationListInput(input);
  if (!parsed.ok) return parsed;

  const where: Prisma.MicroCampaignArbitrationStoreWhereInput = {
    arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
    ...(parsed.data.arbitrationKey ? { arbitrationKey: parsed.data.arbitrationKey } : {}),
    ...(parsed.data.packageKey ? { packageKey: parsed.data.packageKey } : {}),
    ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
    ...(parsed.data.microSegmentDefinitionKey ? { microSegmentDefinitionKey: parsed.data.microSegmentDefinitionKey } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.decision ? { decision: parsed.data.decision } : {}),
    ...(parsed.data.packageStatus ? { packageStatus: parsed.data.packageStatus } : {}),
    ...(parsed.data.packageType ? { packageType: parsed.data.packageType } : {}),
  };

  try {
    const [total, records] = await Promise.all([
      prisma.microCampaignArbitrationStore.count({ where }),
      prisma.microCampaignArbitrationStore.findMany({
        where,
        orderBy: [{ rank: "asc" }, { priority: "desc" }, { computedAt: "desc" }],
        take: parsed.data.limit,
      }),
    ]);

    return {
      ok: true as const,
      readOnly: true,
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      summary: {
        totalMatchingArbitrations: total,
        returnedArbitrations: records.length,
        decisionCounts: countBy(records.map((record) => record.decision)),
        packageTypeCounts: countBy(records.map((record) => record.packageType)),
        packageStatusCounts: countBy(records.map((record) => record.packageStatus)),
        activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      },
      arbitrations: records.map(compactStoredArbitration),
      metadata: {
        route: "GET /api/campaigns/arbitrations",
        limit: parsed.data.limit,
        storeAvailable: true,
        externalActionTaken: false,
        canGoLiveNow: false,
        rawContactFieldsReturned: false,
        rawPayloadsReturned: false,
      },
    };
  } catch (error) {
    if (!isArbitrationStoreUnavailableError(error)) {
      throw error;
    }

    return {
      ok: true as const,
      readOnly: true,
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      summary: {
        totalMatchingArbitrations: 0,
        returnedArbitrations: 0,
        decisionCounts: {},
        packageTypeCounts: {},
        packageStatusCounts: {},
        activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      },
      arbitrations: [],
      caveats: [
        "Micro-campaign arbitration storage is not available yet; run compute in advisory mode or apply the schema before relying on durable list/get history.",
      ],
      metadata: {
        route: "GET /api/campaigns/arbitrations",
        limit: parsed.data.limit,
        storeAvailable: false,
        externalActionTaken: false,
        canGoLiveNow: false,
        rawContactFieldsReturned: false,
        rawPayloadsReturned: false,
      },
    };
  }
}

export async function getMicroCampaignArbitration(
  identifier: string,
  input: Omit<MicroCampaignArbitrationListInput, "arbitrationKey" | "packageKey"> = {},
) {
  const cleaned = cleanString(identifier, 220);
  if (!cleaned) {
    return {
      ok: false as const,
      reason: "invalid_micro_campaign_arbitration_identifier",
      issues: ["A micro-campaign arbitration id, arbitrationKey, or packageKey is required."],
      status: 400,
    };
  }

  const parsed = parseMicroCampaignArbitrationListInput({ ...input, limit: 1 });
  if (!parsed.ok) return parsed;

  let record: StoredArbitration | null = null;
  try {
    record = await prisma.microCampaignArbitrationStore.findFirst({
      where: {
        arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
        ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
        ...(parsed.data.microSegmentDefinitionKey ? { microSegmentDefinitionKey: parsed.data.microSegmentDefinitionKey } : {}),
        ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
        ...(parsed.data.decision ? { decision: parsed.data.decision } : {}),
        ...(parsed.data.packageStatus ? { packageStatus: parsed.data.packageStatus } : {}),
        ...(parsed.data.packageType ? { packageType: parsed.data.packageType } : {}),
        OR: [{ id: cleaned }, { arbitrationKey: cleaned }, { packageKey: cleaned }],
      },
      orderBy: [{ rank: "asc" }, { priority: "desc" }, { computedAt: "desc" }],
    });
  } catch (error) {
    if (!isArbitrationStoreUnavailableError(error)) {
      throw error;
    }

    return {
      ok: false as const,
      reason: "micro_campaign_arbitration_store_unavailable",
      issues: [
        "Micro-campaign arbitration storage is not available yet. Use compute for advisory results or apply the schema before relying on durable get/list APIs.",
      ],
      status: 503,
    };
  }

  if (!record) {
    return {
      ok: false as const,
      reason: "micro_campaign_arbitration_not_found",
      issues: ["No persisted micro-campaign arbitration was found for this id, arbitrationKey, or packageKey."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
    arbitration: compactStoredArbitration(record),
    metadata: {
      route: "GET /api/campaigns/arbitrations/[id]",
      externalActionTaken: false,
      canGoLiveNow: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function microCampaignArbitrationsContextSummary() {
  try {
    const [total, latest, byDecision, byType] = await Promise.all([
      prisma.microCampaignArbitrationStore.count({
        where: { arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION },
      }),
      prisma.microCampaignArbitrationStore.findFirst({
        where: { arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION },
        orderBy: { computedAt: "desc" },
        select: {
          computedAt: true,
          timeframeDays: true,
          decision: true,
          caveats: true,
        },
      }),
      prisma.microCampaignArbitrationStore.groupBy({
        by: ["decision"],
        where: { arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION },
        _count: { decision: true },
      }),
      prisma.microCampaignArbitrationStore.groupBy({
        by: ["packageType"],
        where: { arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION },
        _count: { packageType: true },
      }),
    ]);

    return {
      available: total > 0,
      status: !total ? "unavailable" : latest?.decision ?? "needs_review",
      route: "/api/campaigns/arbitrations",
      computeRoute: "/api/campaigns/arbitrations/compute",
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      totalArbitrations: total,
      latestComputedAt: latest?.computedAt.toISOString() ?? null,
      latestTimeframeDays: latest?.timeframeDays ?? null,
      countsByDecision: Object.fromEntries(byDecision.map((row) => [row.decision, row._count.decision])),
      countsByPackageType: Object.fromEntries(byType.map((row) => [row.packageType, row._count.packageType])),
      detailsOmitted: true,
      detailsReason: "Context pack exposes arbitration status and routes only; use the arbitration API or Tool Runtime read tool for package-level decisions.",
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      caveats: Array.isArray(latest?.caveats)
        ? latest.caveats.slice(0, 4)
        : total
          ? []
          : ["Micro-campaign arbitrations have not been computed yet."],
      externalActionTaken: false,
      canGoLiveNow: false,
      rawContactFieldsReturned: false,
    };
  } catch (error) {
    if (!isArbitrationStoreUnavailableError(error)) {
      throw error;
    }

    return {
      available: false,
      status: "unavailable",
      route: "/api/campaigns/arbitrations",
      computeRoute: "/api/campaigns/arbitrations/compute",
      arbitrationVersion: MICRO_CAMPAIGN_ARBITRATION_VERSION,
      totalArbitrations: 0,
      latestComputedAt: null,
      latestTimeframeDays: null,
      countsByDecision: {},
      countsByPackageType: {},
      detailsOmitted: true,
      detailsReason: "Arbitration storage is not available yet; compute remains advisory-only until the schema is applied.",
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
      caveats: [
        "Micro-campaign arbitration storage is not available yet; compute can still return advisory results without creating downstream artifacts.",
      ],
      externalActionTaken: false,
      canGoLiveNow: false,
      rawContactFieldsReturned: false,
    };
  }
}
