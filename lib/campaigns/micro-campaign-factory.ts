import { Prisma } from "@prisma/client";
import {
  CAMPAIGN_OPPORTUNITY_STATUSES,
  CAMPAIGN_OPPORTUNITY_VERSION,
} from "@/lib/campaigns/opportunity-engine";
import { MICRO_SEGMENT_DEFINITION_VERSION } from "@/lib/customers/micro-segment-definitions";
import {
  findCampaignPlaybookForRecommendation,
  getPlaybookById,
  type WorklinPlaybook,
} from "@/lib/playbooks";
import { prisma } from "@/lib/prisma";

export const MICRO_CAMPAIGN_PACKAGE_VERSION = "micro_campaign_factory_v0";
export const MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS = "package_only";
export const MICRO_CAMPAIGN_PACKAGE_STATUSES = ["prepared", "blocked", "needs_review"] as const;
export const MICRO_CAMPAIGN_PACKAGE_TYPES = [
  "campaign",
  "flow",
  "suppression",
  "policy",
  "lifecycle",
  "review",
] as const;
export const MICRO_CAMPAIGN_APPROVAL_STATUSES = [
  "not_requested",
  "audience_review_required",
  "policy_required",
  "suppression_review_required",
  "review_required",
] as const;

type MicroCampaignPackageStatus = (typeof MICRO_CAMPAIGN_PACKAGE_STATUSES)[number];
type MicroCampaignPackageType = (typeof MICRO_CAMPAIGN_PACKAGE_TYPES)[number];
type MicroCampaignApprovalStatus = (typeof MICRO_CAMPAIGN_APPROVAL_STATUSES)[number];

type StoredOpportunity = Awaited<ReturnType<typeof prisma.campaignOpportunityStore.findMany>>[number];
type StoredMicroSegmentDefinition = Awaited<ReturnType<typeof prisma.microSegmentDefinitionStore.findMany>>[number];
type StoredPackage = Awaited<ReturnType<typeof prisma.microCampaignPackageStore.findMany>>[number];

export type MicroCampaignPackageComputeInput = {
  opportunityKey?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  opportunityType?: string | null;
  limit?: number | string | null;
  persist?: boolean | string | null;
  includeZeroAudience?: boolean | string | null;
  includePolicySuppression?: boolean | string | null;
};

export type MicroCampaignPackageListInput = {
  packageKey?: string | null;
  opportunityKey?: string | null;
  microSegmentDefinitionKey?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  packageType?: string | null;
  approvalStatus?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        opportunityKey: string | null;
        timeframeDays: number | null;
        opportunityStatus: string | null;
        opportunityType: MicroCampaignPackageType | null;
        limit: number;
        persist: boolean;
        includeZeroAudience: boolean;
        includePolicySuppression: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        packageKey: string | null;
        opportunityKey: string | null;
        microSegmentDefinitionKey: string | null;
        timeframeDays: number | null;
        status: MicroCampaignPackageStatus | null;
        packageType: MicroCampaignPackageType | null;
        approvalStatus: MicroCampaignApprovalStatus | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type PackageBundle = {
  packageKey: string;
  packageVersion: string;
  opportunityKey: string;
  opportunityId: string | null;
  opportunityVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: MicroCampaignPackageStatus;
  packageType: MicroCampaignPackageType;
  name: string;
  description: string;
  priority: number;
  confidence: string;
  activationStatus: typeof MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS;
  approvalStatus: MicroCampaignApprovalStatus;
  sourceOpportunity: Record<string, unknown>;
  linkedMicroSegment: Record<string, unknown>;
  audienceLogic: Record<string, unknown>;
  messageAngle: Record<string, unknown>;
  productOfferDirection: Record<string, unknown>;
  subjectCopyBriefDirection: Record<string, unknown>;
  qaRisks: Record<string, unknown>;
  approvalReadiness: Record<string, unknown>;
  blockedNextActions: Record<string, unknown>;
  futureArtifact: Record<string, unknown>;
  plannerHandoff: Record<string, unknown>;
  briefHandoff: Record<string, unknown>;
  sourceSummary: Record<string, unknown>;
  caveats: string[];
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
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

function parsePackageType(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_PACKAGE_TYPES.includes(cleaned as MicroCampaignPackageType)
    ? (cleaned as MicroCampaignPackageType)
    : undefined;
}

function parseOpportunityStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return CAMPAIGN_OPPORTUNITY_STATUSES.includes(cleaned as (typeof CAMPAIGN_OPPORTUNITY_STATUSES)[number])
    ? cleaned
    : undefined;
}

function parsePackageStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_PACKAGE_STATUSES.includes(cleaned as MicroCampaignPackageStatus)
    ? (cleaned as MicroCampaignPackageStatus)
    : undefined;
}

function parseApprovalStatus(value: unknown) {
  const cleaned = cleanString(value, 80)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_CAMPAIGN_APPROVAL_STATUSES.includes(cleaned as MicroCampaignApprovalStatus)
    ? (cleaned as MicroCampaignApprovalStatus)
    : undefined;
}

export function parseMicroCampaignPackageComputeInput(
  input: MicroCampaignPackageComputeInput = {},
): ParsedComputeInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_COMPUTE_LIMIT, "limit", MAX_LIMIT);
  const persist = parseBoolean(input.persist, true);
  const includeZeroAudience = parseBoolean(input.includeZeroAudience, false);
  const includePolicySuppression = parseBoolean(input.includePolicySuppression, true);
  const opportunityType = parsePackageType(input.opportunityType);
  const status = parseOpportunityStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!persist.ok) issues.push("persist must be true or false.");
  if (!includeZeroAudience.ok) issues.push("includeZeroAudience must be true or false.");
  if (!includePolicySuppression.ok) issues.push("includePolicySuppression must be true or false.");
  if (opportunityType === undefined) {
    issues.push("opportunityType must be campaign, flow, suppression, policy, lifecycle, or review.");
  }
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length ||
    !timeframeDays.ok ||
    !limit.ok ||
    !persist.ok ||
    !includeZeroAudience.ok ||
    !includePolicySuppression.ok ||
    opportunityType === undefined ||
    status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          opportunityKey: cleanString(input.opportunityKey, 180),
          timeframeDays: timeframeDays.value,
          opportunityStatus: status,
          opportunityType,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          persist: persist.value,
          includeZeroAudience: includeZeroAudience.value,
          includePolicySuppression: includePolicySuppression.value,
        },
      };
}

export function parseMicroCampaignPackageListInput(input: MicroCampaignPackageListInput = {}): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIMIT);
  const status = parsePackageStatus(input.status);
  const packageType = parsePackageType(input.packageType);
  const approvalStatus = parseApprovalStatus(input.approvalStatus);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (status === undefined) issues.push("status must be prepared, blocked, or needs_review.");
  if (packageType === undefined) {
    issues.push("packageType must be campaign, flow, suppression, policy, lifecycle, or review.");
  }
  if (approvalStatus === undefined) {
    issues.push("approvalStatus must be not_requested, audience_review_required, policy_required, suppression_review_required, or review_required.");
  }

  return issues.length || !timeframeDays.ok || !limit.ok || status === undefined || packageType === undefined || approvalStatus === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          packageKey: cleanString(input.packageKey, 180),
          opportunityKey: cleanString(input.opportunityKey, 180),
          microSegmentDefinitionKey: cleanString(input.microSegmentDefinitionKey, 180),
          timeframeDays: timeframeDays.value,
          status,
          packageType,
          approvalStatus,
          limit: limit.value ?? DEFAULT_LIST_LIMIT,
        },
      };
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

function audienceCount(opportunity: StoredOpportunity) {
  const estimate = recordValue(opportunity.audienceEstimate);
  return numberValue(estimate.count, numberValue(estimate.estimatedAudienceSize));
}

function microSegmentDefinitionKey(opportunity: StoredOpportunity) {
  return cleanString(recordValue(opportunity.linkedMicroSegment).definitionKey, 180);
}

function packageTypeFromOpportunity(opportunity: StoredOpportunity): MicroCampaignPackageType {
  return parsePackageType(opportunity.opportunityType) ?? "review";
}

function compactPlaybook(playbook: WorklinPlaybook | null) {
  if (!playbook) return null;
  return {
    id: playbook.id,
    name: playbook.name,
    type: playbook.type,
    objective: playbook.objective,
    targetAudience: playbook.targetAudience,
    contentSuggestions: playbook.contentSuggestions.slice(0, 4),
    offerRules: playbook.offerRules.slice(0, 4),
    qaRisks: playbook.qaRisks.slice(0, 4),
    permissionLevel: playbook.permissionLevel,
    keyMetric: playbook.keyMetric,
  };
}

function playbookForOpportunity(opportunity: StoredOpportunity) {
  const packageType = packageTypeFromOpportunity(opportunity);
  const campaignType = opportunity.recommendedCampaignType;
  const normalized = `${campaignType} ${opportunity.name}`.toLowerCase();

  if (packageType === "flow") {
    if (normalized.includes("replenishment") || normalized.includes("restock")) return getPlaybookById("replenishment");
    if (normalized.includes("cross")) return getPlaybookById("cross_sell");
    if (normalized.includes("winback") || normalized.includes("churn")) return getPlaybookById("winback");
    return null;
  }

  if (packageType === "suppression") return null;

  const mappedCampaignType = normalized.includes("vip")
    ? "VIP early access"
    : normalized.includes("winback") || normalized.includes("churn") || normalized.includes("dormant")
      ? "At-risk winback"
      : normalized.includes("discount protection") || normalized.includes("full_price")
        ? "Educational email"
        : "Product spotlight";

  return findCampaignPlaybookForRecommendation({
    campaignType: mappedCampaignType,
    title: opportunity.name,
    metadata: { noDiscount: normalized.includes("full_price") || normalized.includes("discount protection") },
  });
}

function packageStatusFor(input: {
  opportunity: StoredOpportunity;
  count: number;
  qualifyingLogicAvailable: boolean;
}): MicroCampaignPackageStatus {
  const { opportunity, count, qualifyingLogicAvailable } = input;
  const type = packageTypeFromOpportunity(opportunity);
  if (type === "policy" || type === "suppression") return "blocked";
  if (type === "review") return "needs_review";
  if (count < 1) return "needs_review";
  if (!qualifyingLogicAvailable) return "needs_review";
  return opportunity.status === "unavailable" ? "needs_review" : "prepared";
}

function approvalStatusFor(opportunity: StoredOpportunity, status: MicroCampaignPackageStatus): MicroCampaignApprovalStatus {
  const type = packageTypeFromOpportunity(opportunity);
  if (type === "policy") return "policy_required";
  if (type === "suppression") return "suppression_review_required";
  if (status === "needs_review") return "audience_review_required";
  if (type === "review") return "review_required";
  return "not_requested";
}

function briefEligible(opportunity: StoredOpportunity, status: MicroCampaignPackageStatus) {
  const type = packageTypeFromOpportunity(opportunity);
  return status === "prepared" && (type === "campaign" || type === "lifecycle");
}

function flowPlanEligible(opportunity: StoredOpportunity, status: MicroCampaignPackageStatus) {
  return status === "prepared" && packageTypeFromOpportunity(opportunity) === "flow";
}

function primaryProductName(direction: Record<string, unknown>) {
  const productTruth = recordValue(direction.productTruth);
  const products = Array.isArray(productTruth.products) ? productTruth.products : [];
  const first = recordValue(products[0]);
  return cleanString(first.name, 160);
}

function buildSubjectAngles(opportunity: StoredOpportunity, productName: string | null) {
  const direction = recordValue(opportunity.recommendedProductOfferMessageDirection);
  const messageAngle = cleanString(direction.messageAngle, 420) ?? "Audience-specific retention message.";
  const product = productName ?? "the next best product";
  const type = packageTypeFromOpportunity(opportunity);

  if (type === "flow") {
    return [
      `Running low? A timely reminder for ${product}`,
      `Your next ${product} restock path`,
      `A helpful nudge before the next purchase window closes`,
    ];
  }

  if (type === "policy") {
    return ["No campaign subject line: package is a policy guardrail, not a campaign brief."];
  }

  if (type === "suppression") {
    return ["No campaign subject line: package is a suppression/holdout guardrail."];
  }

  return [
    `${product}: the next useful step`,
    `A smarter pick for ${opportunity.name.toLowerCase()}`,
    messageAngle.length > 80 ? messageAngle.slice(0, 80) : messageAngle,
  ];
}

function ctaFor(opportunity: StoredOpportunity) {
  const type = packageTypeFromOpportunity(opportunity);
  const normalized = `${opportunity.recommendedCampaignType} ${opportunity.name}`.toLowerCase();
  if (type === "policy") return null;
  if (type === "suppression") return null;
  if (type === "flow") return "Restock now";
  if (normalized.includes("vip")) return "Explore early access";
  if (normalized.includes("winback") || normalized.includes("dormant")) return "Come back and see what's new";
  if (normalized.includes("cross")) return "Find your next match";
  return "Shop the recommendation";
}

function packageDescription(opportunity: StoredOpportunity, status: MicroCampaignPackageStatus) {
  const type = packageTypeFromOpportunity(opportunity);
  if (type === "policy") {
    return "Prepared policy package only. It should inform offer arbitration and approval, not become a campaign brief.";
  }
  if (type === "suppression") {
    return "Prepared suppression package only. It should inform holdouts and collision rules, not become a campaign brief.";
  }
  if (status === "needs_review") {
    return "Prepared package needs audience/source review before it can move into planner or brief generation.";
  }
  return "Prepared micro-campaign package for future planner, brief, QA, and approved draft-only handoff.";
}

function packageFutureArtifact(input: {
  opportunity: StoredOpportunity;
  status: MicroCampaignPackageStatus;
  isBriefEligible: boolean;
  isFlowPlanEligible: boolean;
}) {
  const type = packageTypeFromOpportunity(input.opportunity);
  const sourceArtifact = recordValue(input.opportunity.futureArtifact);
  const sourceArtifactType = cleanString(sourceArtifact.artifactType, 120);
  const artifactType = type === "policy"
    ? "policy_approval_item"
    : type === "suppression"
      ? "suppression_rule_plan"
      : type === "flow"
        ? "flow_branch_plan"
        : input.isBriefEligible
          ? "campaign_brief_seed"
          : sourceArtifactType ?? "review_item";

  return {
    artifactType,
    sourceArtifactType,
    title: cleanString(sourceArtifact.title, 240) ?? input.opportunity.name,
    readiness: input.status,
    shouldBecomeCampaignBrief: input.isBriefEligible,
    shouldBecomeFlowBranchPlan: input.isFlowPlanEligible,
    shouldBecomePolicyApprovalItem: type === "policy",
    shouldBecomeSuppressionRule: type === "suppression",
    campaignBriefCreated: false,
    campaignPlanCreated: false,
    qaRunCreated: false,
    klaviyoDraftCreated: false,
    externalActionTaken: false,
  };
}

function buildPackage(input: {
  opportunity: StoredOpportunity;
  microSegmentDefinition: StoredMicroSegmentDefinition | null;
  computedAt: Date;
}): PackageBundle {
  const { opportunity, microSegmentDefinition } = input;
  const packageType = packageTypeFromOpportunity(opportunity);
  const count = audienceCount(opportunity);
  const qualifyingLogicAvailable = Boolean(microSegmentDefinition);
  const status = packageStatusFor({ opportunity, count, qualifyingLogicAvailable });
  const approvalStatus = approvalStatusFor(opportunity, status);
  const playbook = playbookForOpportunity(opportunity);
  const compactedPlaybook = compactPlaybook(playbook);
  const productDirection = recordValue(opportunity.recommendedProductOfferMessageDirection);
  const productName = primaryProductName(productDirection);
  const segmentKey = microSegmentDefinitionKey(opportunity);
  const isBriefEligible = briefEligible(opportunity, status);
  const isFlowPlanEligible = flowPlanEligible(opportunity, status);
  const subjectAngles = buildSubjectAngles(opportunity, productName);
  const cta = ctaFor(opportunity);
  const packageKey = `${opportunity.opportunityKey}_micro_campaign_package`;
  const useCase = recordValue(opportunity.recommendedUseCase);
  const caveats = uniqueStrings([
    ...asStringArray(opportunity.caveats),
    count < 1 ? "Audience estimate is zero; package is retained for validation but should not move to brief generation yet." : null,
    packageType === "policy" ? "Policy opportunities should not become campaign briefs." : null,
    packageType === "suppression" ? "Suppression opportunities should not become campaign briefs." : null,
    !microSegmentDefinition ? "Source micro-segment qualifying logic was not found in the durable definition store." : null,
    "Micro-Campaign Factory v0 prepares local packages only; it does not create CampaignBrief, CampaignPlan, QA, Klaviyo draft, segment, sync, send, or schedule records.",
  ]);
  const qaRisks = uniqueStrings([
    ...(compactedPlaybook ? asStringArray(compactedPlaybook.qaRisks) : []),
    ...asStringArray(recordValue(opportunity.suppressionCollisionHints).suppressOrDelay),
    "Audience membership must be revalidated before any future activation.",
    "Copy must avoid implying live personalization beyond available Worklin properties.",
    packageType === "policy" ? "Do not turn margin-protection policy into a promotional campaign." : null,
    packageType === "suppression" ? "Do not accidentally include this audience in broad campaigns." : null,
  ]);
  const futureArtifact = packageFutureArtifact({
    opportunity,
    status,
    isBriefEligible,
    isFlowPlanEligible,
  });

  return {
    packageKey,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    opportunityKey: opportunity.opportunityKey,
    opportunityId: opportunity.id,
    opportunityVersion: opportunity.opportunityVersion,
    timeframeDays: opportunity.timeframeDays,
    computedAt: input.computedAt.toISOString(),
    status,
    packageType,
    name: `Micro-campaign package: ${opportunity.name}`,
    description: packageDescription(opportunity, status),
    priority: opportunity.priority,
    confidence: opportunity.confidence,
    activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
    approvalStatus,
    sourceOpportunity: {
      id: opportunity.id,
      opportunityKey: opportunity.opportunityKey,
      opportunityVersion: opportunity.opportunityVersion,
      name: opportunity.name,
      opportunityType: opportunity.opportunityType,
      recommendedCampaignType: opportunity.recommendedCampaignType,
      activationStatus: opportunity.activationStatus,
      externalActionTaken: false,
    },
    linkedMicroSegment: {
      ...recordValue(opportunity.linkedMicroSegment),
      definitionKey: segmentKey,
      qualifyingLogicAvailable,
    },
    audienceLogic: {
      source: "CampaignOpportunityStore + MicroSegmentDefinitionStore",
      microSegmentDefinitionKey: segmentKey,
      qualifyingLogic: microSegmentDefinition?.qualifyingLogic ?? {
        pointer: "MicroSegmentDefinitionStore.qualifyingLogic",
        available: false,
      },
      audienceEstimate: {
        ...recordValue(opportunity.audienceEstimate),
        count,
        memberListReturned: false,
        rawContactFieldsReturned: false,
      },
      inclusion: [
        `Use persisted opportunity ${opportunity.opportunityKey}.`,
        segmentKey ? `Use micro-segment definition ${segmentKey}.` : "Missing linked micro-segment definition key.",
      ],
      exclusions: uniqueStrings([
        "Exclude unsubscribed/suppressed profiles before any future activation.",
        "Exclude customers who collide with higher-priority suppression or policy packages.",
        packageType === "campaign" || packageType === "lifecycle"
          ? "Exclude high fatigue and active replenishment/transactional audiences where relevant."
          : null,
      ]),
      klaviyoNativePossible: Boolean(recordValue(opportunity.linkedMicroSegment).klaviyoNativePossible),
      requiresWorklinProperties: recordValue(opportunity.linkedMicroSegment).requiresWorklinProperties !== false,
    },
    messageAngle: {
      primaryAngle: cleanString(productDirection.messageAngle, 600) ?? opportunity.name,
      whyNow: asStringArray(opportunity.whyNow),
      whyItMatters: asStringArray(opportunity.whyItMatters),
      recommendedChannel: opportunity.recommendedChannel,
      useCase,
      playbook: compactedPlaybook,
    },
    productOfferDirection: {
      productDirection: cleanString(productDirection.productDirection, 700),
      offerDirection: cleanString(productDirection.offerDirection, 700),
      primaryProduct: productName,
      productTruth: recordValue(productDirection.productTruth),
      campaignMemoryFit: recordValue(productDirection.campaignMemoryFit),
    },
    subjectCopyBriefDirection: {
      readyForBriefGenerator: isBriefEligible,
      shouldBecomeCampaignBrief: isBriefEligible,
      shouldBecomeFlowBranchPlan: isFlowPlanEligible,
      shouldBecomePolicyItem: packageType === "policy",
      shouldBecomeSuppressionRule: packageType === "suppression",
      title: isBriefEligible ? opportunity.name : null,
      campaignType: isBriefEligible ? opportunity.recommendedCampaignType : null,
      segment: segmentKey ?? "linked micro-segment",
      goal: isBriefEligible
        ? cleanString(useCase.campaign, 240) ?? "Drive audience-specific retention revenue."
        : "Do not create a campaign brief from this package.",
      subjectLineAngles: subjectAngles,
      previewTextDirection: isBriefEligible
        ? "Preview text should state the audience-specific benefit without exposing internal score labels."
        : "No preview text needed until this becomes an approved campaign/flow artifact.",
      copyBlocks: {
        opener: cleanString(productDirection.messageAngle, 500) ?? "Lead with the audience reason to act.",
        product: productName
          ? `Feature ${productName} where it fits the opportunity.`
          : "Select product slotting from Product Truth before brief generation.",
        offer: cleanString(productDirection.offerDirection, 500) ?? "Use offer only when policy and margin guardrails allow.",
        proof: compactedPlaybook?.contentSuggestions?.[0] ?? "Use proof, product clarity, and one useful reason to click.",
        cta,
      },
      designNotes: compactedPlaybook
        ? `Follow ${compactedPlaybook.name} guidance; keep one primary product/offer path and avoid broad-campaign framing.`
        : "Keep the package focused on audience logic, one message angle, and one next action.",
      campaignBriefCreated: false,
    },
    qaRisks: {
      risks: qaRisks,
      requiredChecksBeforeBrief: uniqueStrings([
        "Confirm audience count is nonzero and current.",
        "Confirm no policy/suppression collision outranks this package.",
        "Confirm brand/offer rules before using incentive language.",
        "Confirm no raw contact fields or member lists are exposed.",
      ]),
      expectedQaPath: isBriefEligible
        ? "Future CampaignBrief should run through existing Brief QA before any draft-only path."
        : "No Brief QA until a human converts this package into an eligible campaign or flow artifact.",
    },
    approvalReadiness: {
      approvalStatus,
      requiresApprovalBeforeDraft: true,
      readyForHumanReview: status === "prepared" || status === "blocked",
      readyForPlanner: isBriefEligible,
      readyForBriefGenerator: isBriefEligible,
      readyForDraftOnlyPath: false,
      reason: approvalStatus === "not_requested"
        ? "Package can be reviewed before a future planner/brief step."
        : "Package needs policy, suppression, or audience review before downstream generation.",
    },
    blockedNextActions: {
      campaignBriefCreation: {
        blocked: !isBriefEligible,
        performed: false,
        reason: isBriefEligible
          ? "Not performed by v0; allowed only after explicit user selection in a future planner/brief step."
          : "Package is policy/suppression/flow/review-only or lacks a usable audience.",
      },
      plannerCreation: {
        blocked: !isBriefEligible,
        performed: false,
        reason: isBriefEligible
          ? "Prepared for future planner handoff; no CampaignPlan was created."
          : "Planner handoff is blocked until this package becomes campaign/lifecycle eligible.",
      },
      qaRun: {
        blocked: true,
        performed: false,
        reason: "Brief QA requires a CampaignBrief record; v0 does not create one.",
      },
      klaviyoDraftCreation: {
        blocked: true,
        performed: false,
        reason: "Draft creation must use the existing approved draft-only path after a brief and QA exist.",
      },
      klaviyoSegmentCreation: { blocked: true, performed: false },
      profileSync: { blocked: true, performed: false },
      sendOrSchedule: { blocked: true, performed: false },
      liveExternalAction: { blocked: true, performed: false },
    },
    futureArtifact,
    plannerHandoff: {
      ready: isBriefEligible,
      routePointer: "/api/planner/generate",
      suggestedPlanItem: isBriefEligible
        ? {
            title: opportunity.name,
            campaignType: opportunity.recommendedCampaignType,
            goal: cleanString(useCase.campaign, 240) ?? "Audience-specific retention lift.",
            segment: segmentKey,
            subjectLineAngle: subjectAngles[0] ?? null,
            primaryProduct: productName,
            why: asStringArray(opportunity.whyNow).join(" "),
            metadata: {
              packageKey,
              opportunityKey: opportunity.opportunityKey,
              playbookId: compactedPlaybook?.id ?? null,
              source: MICRO_CAMPAIGN_PACKAGE_VERSION,
            },
          }
        : null,
      createdPlanId: null,
    },
    briefHandoff: {
      ready: isBriefEligible,
      routePointer: "/api/briefs/generate",
      suggestedPayload: isBriefEligible
        ? {
            title: opportunity.name,
            campaignType: opportunity.recommendedCampaignType,
            segment: segmentKey,
            goal: cleanString(useCase.campaign, 240) ?? "Drive audience-specific retention revenue.",
            subjectLineAngle: subjectAngles[0] ?? null,
            primaryProduct: productName,
            angle: cleanString(productDirection.messageAngle, 800),
            cta,
            designNotes: compactedPlaybook?.qaRisks?.join(" ") ?? null,
            metadata: {
              packageKey,
              opportunityKey: opportunity.opportunityKey,
              playbookId: compactedPlaybook?.id ?? null,
              source: MICRO_CAMPAIGN_PACKAGE_VERSION,
            },
          }
        : null,
      campaignBriefId: null,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
    },
    sourceSummary: {
      opportunityVersion: opportunity.opportunityVersion,
      sourceDefinitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      opportunityStatus: opportunity.status,
      opportunityActivationStatus: opportunity.activationStatus,
      futureArtifact,
      sourceSummary: recordValue(opportunity.sourceSummary),
    },
    caveats,
    metadata: {
      route: "POST /api/campaigns/micro-campaigns/compute",
      listRoute: "GET /api/campaigns/micro-campaigns",
      getRoute: "GET /api/campaigns/micro-campaigns/[id]",
      packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
      preparedOnly: true,
      externalActionTaken: false,
      campaignPlanCreated: false,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
      klaviyoSegmentCreated: false,
      profileSyncPerformed: false,
      campaignCreated: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

async function loadMicroSegmentDefinitions(opportunities: StoredOpportunity[]) {
  const definitionKeys = uniqueStrings(opportunities.map(microSegmentDefinitionKey));
  if (!definitionKeys.length) return new Map<string, StoredMicroSegmentDefinition>();

  const rows = await prisma.microSegmentDefinitionStore.findMany({
    where: {
      definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      definitionKey: { in: definitionKeys },
    },
    orderBy: [{ computedAt: "desc" }],
  });

  const byKey = new Map<string, StoredMicroSegmentDefinition>();
  for (const row of rows) {
    if (!byKey.has(row.definitionKey)) byKey.set(row.definitionKey, row);
  }
  return byKey;
}

async function persistPackage(bundle: PackageBundle) {
  return prisma.microCampaignPackageStore.upsert({
    where: {
      packageKey_timeframeDays_packageVersion: {
        packageKey: bundle.packageKey,
        timeframeDays: bundle.timeframeDays,
        packageVersion: bundle.packageVersion,
      },
    },
    create: {
      packageKey: bundle.packageKey,
      packageVersion: bundle.packageVersion,
      opportunityKey: bundle.opportunityKey,
      opportunityId: bundle.opportunityId,
      opportunityVersion: bundle.opportunityVersion,
      timeframeDays: bundle.timeframeDays,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      packageType: bundle.packageType,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      approvalStatus: bundle.approvalStatus,
      sourceOpportunity: asJson(bundle.sourceOpportunity),
      linkedMicroSegment: asJson(bundle.linkedMicroSegment),
      audienceLogic: asJson(bundle.audienceLogic),
      messageAngle: asJson(bundle.messageAngle),
      productOfferDirection: asJson(bundle.productOfferDirection),
      subjectCopyBriefDirection: asJson(bundle.subjectCopyBriefDirection),
      qaRisks: asJson(bundle.qaRisks),
      approvalReadiness: asJson(bundle.approvalReadiness),
      blockedNextActions: asJson(bundle.blockedNextActions),
      futureArtifact: asJson(bundle.futureArtifact),
      plannerHandoff: asJson(bundle.plannerHandoff),
      briefHandoff: asJson(bundle.briefHandoff),
      sourceSummary: asJson(bundle.sourceSummary),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
    update: {
      opportunityId: bundle.opportunityId,
      opportunityVersion: bundle.opportunityVersion,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      packageType: bundle.packageType,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      approvalStatus: bundle.approvalStatus,
      sourceOpportunity: asJson(bundle.sourceOpportunity),
      linkedMicroSegment: asJson(bundle.linkedMicroSegment),
      audienceLogic: asJson(bundle.audienceLogic),
      messageAngle: asJson(bundle.messageAngle),
      productOfferDirection: asJson(bundle.productOfferDirection),
      subjectCopyBriefDirection: asJson(bundle.subjectCopyBriefDirection),
      qaRisks: asJson(bundle.qaRisks),
      approvalReadiness: asJson(bundle.approvalReadiness),
      blockedNextActions: asJson(bundle.blockedNextActions),
      futureArtifact: asJson(bundle.futureArtifact),
      plannerHandoff: asJson(bundle.plannerHandoff),
      briefHandoff: asJson(bundle.briefHandoff),
      sourceSummary: asJson(bundle.sourceSummary),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
  });
}

function compactPackage(bundle: PackageBundle) {
  return {
    packageKey: bundle.packageKey,
    packageVersion: bundle.packageVersion,
    opportunityKey: bundle.opportunityKey,
    opportunityId: bundle.opportunityId,
    opportunityVersion: bundle.opportunityVersion,
    timeframeDays: bundle.timeframeDays,
    computedAt: bundle.computedAt,
    status: bundle.status,
    packageType: bundle.packageType,
    name: bundle.name,
    description: bundle.description,
    priority: bundle.priority,
    confidence: bundle.confidence,
    activationStatus: bundle.activationStatus,
    approvalStatus: bundle.approvalStatus,
    sourceOpportunity: bundle.sourceOpportunity,
    linkedMicroSegment: bundle.linkedMicroSegment,
    audienceLogic: bundle.audienceLogic,
    messageAngle: bundle.messageAngle,
    productOfferDirection: bundle.productOfferDirection,
    subjectCopyBriefDirection: bundle.subjectCopyBriefDirection,
    qaRisks: bundle.qaRisks,
    approvalReadiness: bundle.approvalReadiness,
    blockedNextActions: bundle.blockedNextActions,
    futureArtifact: bundle.futureArtifact,
    plannerHandoff: bundle.plannerHandoff,
    briefHandoff: bundle.briefHandoff,
    sourceSummary: bundle.sourceSummary,
    caveats: bundle.caveats,
    metadata: bundle.metadata,
    externalActionTaken: false,
    ...(bundle.persistedRecordId ? { persistedRecordId: bundle.persistedRecordId } : {}),
  };
}

function compactStoredPackage(record: StoredPackage) {
  return {
    id: record.id,
    packageKey: record.packageKey,
    packageVersion: record.packageVersion,
    opportunityKey: record.opportunityKey,
    opportunityId: record.opportunityId,
    opportunityVersion: record.opportunityVersion,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: record.status,
    packageType: record.packageType,
    name: record.name,
    description: record.description,
    priority: record.priority,
    confidence: record.confidence,
    activationStatus: record.activationStatus,
    approvalStatus: record.approvalStatus,
    sourceOpportunity: record.sourceOpportunity,
    linkedMicroSegment: record.linkedMicroSegment,
    audienceLogic: record.audienceLogic,
    messageAngle: record.messageAngle,
    productOfferDirection: record.productOfferDirection,
    subjectCopyBriefDirection: record.subjectCopyBriefDirection,
    qaRisks: record.qaRisks,
    approvalReadiness: record.approvalReadiness,
    blockedNextActions: record.blockedNextActions,
    futureArtifact: record.futureArtifact,
    plannerHandoff: record.plannerHandoff,
    briefHandoff: record.briefHandoff,
    sourceSummary: record.sourceSummary,
    caveats: record.caveats,
    metadata: {
      packageVersion: record.packageVersion,
      activationStatus: record.activationStatus,
      externalActionTaken: false,
      campaignPlanCreated: false,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
    externalActionTaken: false,
  };
}

export async function computeMicroCampaignPackages(input: MicroCampaignPackageComputeInput = {}) {
  const parsed = parseMicroCampaignPackageComputeInput(input);
  if (!parsed.ok) return parsed;

  const where: Prisma.CampaignOpportunityStoreWhereInput = {
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.opportunityStatus ? { status: parsed.data.opportunityStatus } : {}),
    ...(parsed.data.opportunityType ? { opportunityType: parsed.data.opportunityType } : {}),
  };
  const sourceOpportunities = await prisma.campaignOpportunityStore.findMany({
    where,
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
    take: parsed.data.limit,
  });
  const filtered = sourceOpportunities.filter((opportunity) => {
    const type = packageTypeFromOpportunity(opportunity);
    const count = audienceCount(opportunity);
    if (!parsed.data.includePolicySuppression && (type === "policy" || type === "suppression")) return false;
    if (!parsed.data.includeZeroAudience && count < 1) return false;
    return true;
  });
  const definitions = await loadMicroSegmentDefinitions(filtered);
  const computedAt = new Date();
  const packages = filtered.map((opportunity) =>
    buildPackage({
      opportunity,
      microSegmentDefinition: definitions.get(microSegmentDefinitionKey(opportunity) ?? "") ?? null,
      computedAt,
    }),
  );
  const persisted = parsed.data.persist ? await Promise.all(packages.map(persistPackage)) : [];
  const persistedByKey = new Map(persisted.map((record) => [record.packageKey, record]));
  const outputPackages = packages.map((pkg) => {
    const persistedRecord = persistedByKey.get(pkg.packageKey);
    return compactPackage({
      ...pkg,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });
  const missingCapabilities = uniqueStrings([
    !sourceOpportunities.length ? "campaign_opportunities.available_records" : null,
    ...packages.flatMap((pkg) => asStringArray(recordValue(pkg.sourceSummary).blockedByMissingCapabilities)),
    "micro_campaign_package_to_planner_handoff",
    "approval_queue_package_review",
    "brief_generation_from_package",
  ]);
  const caveats = uniqueStrings([
    ...packages.flatMap((pkg) => pkg.caveats),
    !sourceOpportunities.length ? "No persisted campaign opportunities were found. Compute campaign opportunities first." : null,
    "Prepared packages are package_only and have not created plans, briefs, QA checks, drafts, segments, syncs, sends, or schedules.",
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    computedAt: computedAt.toISOString(),
    persisted: parsed.data.persist,
    summary: {
      sourceOpportunitiesAnalyzed: sourceOpportunities.length,
      sourceOpportunitiesReturned: filtered.length,
      packagesReturned: outputPackages.length,
      packagesPersisted: persisted.length,
      includeZeroAudience: parsed.data.includeZeroAudience,
      includePolicySuppression: parsed.data.includePolicySuppression,
      statusCounts: countBy(packages.map((pkg) => pkg.status)),
      packageTypeCounts: countBy(packages.map((pkg) => pkg.packageType)),
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
    },
    packages: outputPackages,
    sourceStatuses: [
      {
        source: "campaign_opportunities",
        status: sourceOpportunities.length ? "available" : "unavailable",
        rowsAnalyzed: sourceOpportunities.length,
        readOnly: true,
      },
      {
        source: "micro_segment_definitions",
        status: definitions.size ? "available" : "partial",
        rowsAnalyzed: definitions.size,
        readOnly: true,
      },
      {
        source: "playbooks",
        status: "available",
        readOnly: true,
      },
    ],
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/campaigns/micro-campaigns/compute",
      listRoute: "GET /api/campaigns/micro-campaigns",
      getRoute: "GET /api/campaigns/micro-campaigns/[id]",
      packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
      persist: parsed.data.persist,
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
      externalActionTaken: false,
      campaignPlanCreated: false,
      campaignBriefCreated: false,
      qaRunCreated: false,
      klaviyoDraftCreated: false,
      klaviyoSegmentCreated: false,
      profileSyncPerformed: false,
      campaignCreated: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function listMicroCampaignPackages(input: MicroCampaignPackageListInput = {}) {
  const parsed = parseMicroCampaignPackageListInput(input);
  if (!parsed.ok) return parsed;

  const linkedMicroSegmentFilter = parsed.data.microSegmentDefinitionKey
    ? {
        path: ["definitionKey"],
        equals: parsed.data.microSegmentDefinitionKey,
      }
    : undefined;
  const where: Prisma.MicroCampaignPackageStoreWhereInput = {
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    ...(parsed.data.packageKey ? { packageKey: parsed.data.packageKey } : {}),
    ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.packageType ? { packageType: parsed.data.packageType } : {}),
    ...(parsed.data.approvalStatus ? { approvalStatus: parsed.data.approvalStatus } : {}),
    ...(linkedMicroSegmentFilter ? { linkedMicroSegment: linkedMicroSegmentFilter } : {}),
  };
  const [total, records] = await Promise.all([
    prisma.microCampaignPackageStore.count({ where }),
    prisma.microCampaignPackageStore.findMany({
      where,
      orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
      take: parsed.data.limit,
    }),
  ]);

  return {
    ok: true as const,
    readOnly: true,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    summary: {
      totalMatchingPackages: total,
      returnedPackages: records.length,
      statusCounts: countBy(records.map((record) => record.status)),
      packageTypeCounts: countBy(records.map((record) => record.packageType)),
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
    },
    packages: records.map(compactStoredPackage),
    metadata: {
      route: "GET /api/campaigns/micro-campaigns",
      limit: parsed.data.limit,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function getMicroCampaignPackage(identifier: string, input: Omit<MicroCampaignPackageListInput, "packageKey"> = {}) {
  const cleaned = cleanString(identifier, 220);
  if (!cleaned) {
    return {
      ok: false as const,
      reason: "invalid_micro_campaign_package_identifier",
      issues: ["A micro-campaign package id or packageKey is required."],
      status: 400,
    };
  }
  const parsed = parseMicroCampaignPackageListInput({ ...input, limit: 1 });
  if (!parsed.ok) return parsed;

  const record = await prisma.microCampaignPackageStore.findFirst({
    where: {
      packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
      ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
      ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.packageType ? { packageType: parsed.data.packageType } : {}),
      ...(parsed.data.approvalStatus ? { approvalStatus: parsed.data.approvalStatus } : {}),
      OR: [{ id: cleaned }, { packageKey: cleaned }],
    },
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
  });

  if (!record) {
    return {
      ok: false as const,
      reason: "micro_campaign_package_not_found",
      issues: ["No persisted micro-campaign package was found for this id or packageKey."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    package: compactStoredPackage(record),
    metadata: {
      route: "GET /api/campaigns/micro-campaigns/[id]",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function microCampaignPackagesContextSummary() {
  const [total, latest, byStatus, byType] = await Promise.all([
    prisma.microCampaignPackageStore.count({
      where: { packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION },
    }),
    prisma.microCampaignPackageStore.findFirst({
      where: { packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION },
      orderBy: { computedAt: "desc" },
      select: {
        computedAt: true,
        timeframeDays: true,
        status: true,
        caveats: true,
      },
    }),
    prisma.microCampaignPackageStore.groupBy({
      by: ["status"],
      where: { packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION },
      _count: { status: true },
    }),
    prisma.microCampaignPackageStore.groupBy({
      by: ["packageType"],
      where: { packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION },
      _count: { packageType: true },
    }),
  ]);

  return {
    available: total > 0,
    status: !total ? "unavailable" : latest?.status ?? "needs_review",
    route: "/api/campaigns/micro-campaigns",
    computeRoute: "/api/campaigns/micro-campaigns/compute",
    packageVersion: MICRO_CAMPAIGN_PACKAGE_VERSION,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    totalPackages: total,
    latestComputedAt: latest?.computedAt.toISOString() ?? null,
    latestTimeframeDays: latest?.timeframeDays ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count.status])),
    countsByPackageType: Object.fromEntries(byType.map((row) => [row.packageType, row._count.packageType])),
    detailsOmitted: true,
    detailsReason: "Context pack exposes micro-campaign package status and routes only; use the package API or Tool Runtime read tool for package contents.",
    activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
    caveats: Array.isArray(latest?.caveats)
      ? latest.caveats.slice(0, 4)
      : total
        ? []
        : ["Micro-campaign packages have not been computed yet."],
    externalActionTaken: false,
    rawContactFieldsReturned: false,
  };
}
