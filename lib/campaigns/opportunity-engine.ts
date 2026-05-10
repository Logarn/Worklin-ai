import { Prisma } from "@prisma/client";
import { CUSTOMER_FEATURE_STORE_VERSION } from "@/lib/customers/feature-store";
import { computeMicroSegmentDefinitions, MICRO_SEGMENT_DEFINITION_VERSION } from "@/lib/customers/micro-segment-definitions";
import { CUSTOMER_SCORING_VERSION } from "@/lib/customers/scoring";
import { getProductPerformanceIntelligence, type ProductPerformanceIntelligenceResult } from "@/lib/products/product-performance-intelligence";
import { prisma } from "@/lib/prisma";

export const CAMPAIGN_OPPORTUNITY_VERSION = "campaign_opportunity_engine_v0";
export const CAMPAIGN_OPPORTUNITY_STATUSES = ["available", "partial", "unavailable"] as const;
export const CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS = "opportunity_only";

type CampaignOpportunityStatus = (typeof CAMPAIGN_OPPORTUNITY_STATUSES)[number];
type OpportunityConfidence = "high" | "medium" | "low";
type OpportunityType = "campaign" | "flow" | "suppression" | "policy" | "lifecycle" | "review";
type SourceDefinitionStatus = "available" | "partial" | "unavailable";
type SourceDefinitionMode = "persisted_micro_segment_definitions" | "computed_micro_segment_fallback";

export type CampaignOpportunityComputeInput = {
  timeframeDays?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
  minAudienceSize?: number | string | null;
  persist?: boolean | string | null;
  includeZeroAudience?: boolean | string | null;
};

export type CampaignOpportunityListInput = {
  opportunityKey?: string | null;
  microSegmentDefinitionKey?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  opportunityType?: string | null;
  recommendedCampaignType?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        timeframeDays: number;
        status: SourceDefinitionStatus | null;
        limit: number;
        minAudienceSize: number;
        persist: boolean;
        includeZeroAudience: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        opportunityKey: string | null;
        microSegmentDefinitionKey: string | null;
        timeframeDays: number | null;
        status: CampaignOpportunityStatus | null;
        opportunityType: OpportunityType | null;
        recommendedCampaignType: string | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type StoredMicroSegmentDefinition = Awaited<ReturnType<typeof prisma.microSegmentDefinitionStore.findMany>>[number];
type StoredCampaignOpportunity = Awaited<ReturnType<typeof prisma.campaignOpportunityStore.findMany>>[number];

type SourceMicroSegmentDefinition = {
  id: string | null;
  definitionKey: string;
  definitionVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: SourceDefinitionStatus;
  name: string;
  description: string;
  priority: number;
  confidence: OpportunityConfidence;
  activationStatus: string;
  audienceEstimate: Record<string, unknown>;
  whyItMatters: string[];
  recommendedUseCases: {
    campaigns: string[];
    flows: string[];
    suppressions: string[];
  };
  productOrOfferDirection: {
    productDirection: string | null;
    offerDirection: string | null;
  };
  collisionArbitrationHints: Record<string, unknown>;
  klaviyoNativePossible: boolean;
  requiresWorklinProperties: boolean;
  sourceScoringVersion: string;
  sourceFeatureVersion: string;
  sourceScoreSummary: Record<string, unknown>;
  missingCapabilities: string[];
  caveats: string[];
};

type CampaignMemorySummary = {
  campaignsAnalyzed: number;
  topCampaignTypes: Array<{ campaignType: string; count: number }>;
  topSegments: Array<{ segment: string; count: number }>;
  recentWinningInsights: string[];
  caveats: string[];
};

type ProductDirectionSummary = {
  source: string;
  products: Array<{
    name: string;
    category: string | null;
    recommendedUse: string;
    confidence: number;
  }>;
  caveats: string[];
};

type OpportunityBlueprint = {
  opportunityKey: string;
  segmentDefinitionKey: string;
  name: string;
  description: string;
  opportunityType: OpportunityType;
  whyNow: string[];
  recommendedCampaignType: string;
  recommendedChannel: string | null;
  messageAngle: string;
  futureArtifact: {
    artifactType: "campaign_brief_seed" | "flow_branch_plan" | "policy_approval_item" | "suppression_rule_plan" | "review_item";
    title: string;
    readiness: "ready_for_brief" | "needs_policy_before_brief" | "needs_review" | "holdout_only";
  };
  useCaseFocus: {
    campaign: string | null;
    flow: string | null;
    suppression: string | null;
  };
  futureCapabilities: string[];
  blockedCapabilities: string[];
  urgencyBoost: number;
  productSelector: (products: ProductPerformanceIntelligenceResult | null) => ProductDirectionSummary;
};

type OpportunityBundle = {
  opportunityKey: string;
  opportunityVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: CampaignOpportunityStatus;
  opportunityType: OpportunityType;
  name: string;
  description: string;
  priority: number;
  confidence: OpportunityConfidence;
  activationStatus: typeof CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS;
  linkedMicroSegment: Record<string, unknown>;
  audienceEstimate: Record<string, unknown>;
  whyNow: string[];
  whyItMatters: string[];
  recommendedCampaignType: string;
  recommendedUseCase: Record<string, unknown>;
  recommendedProductOfferMessageDirection: Record<string, unknown>;
  recommendedChannel: string | null;
  suppressionCollisionHints: Record<string, unknown>;
  requiredFutureCapabilities: string[];
  futureArtifact: Record<string, unknown>;
  blockedByMissingCapabilities: string[];
  sourceDefinitionVersion: string;
  sourceScoringVersion: string;
  sourceFeatureVersion: string;
  sourceSummary: Record<string, unknown>;
  caveats: string[];
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
};

const DEFAULT_TIMEFRAME_DAYS = 90;
const MAX_TIMEFRAME_DAYS = 730;
const DEFAULT_COMPUTE_LIMIT = 100;
const MAX_COMPUTE_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_MIN_AUDIENCE_SIZE = 1;

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

function parseOpportunityStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return CAMPAIGN_OPPORTUNITY_STATUSES.includes(cleaned as CampaignOpportunityStatus)
    ? (cleaned as CampaignOpportunityStatus)
    : undefined;
}

function parseOpportunityType(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return ["campaign", "flow", "suppression", "policy", "lifecycle", "review"].includes(cleaned)
    ? (cleaned as OpportunityType)
    : undefined;
}

function parseSourceDefinitionStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return ["available", "partial", "unavailable"].includes(cleaned)
    ? (cleaned as SourceDefinitionStatus)
    : undefined;
}

export function parseCampaignOpportunityComputeInput(
  input: CampaignOpportunityComputeInput = {},
): ParsedComputeInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, DEFAULT_TIMEFRAME_DAYS, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_COMPUTE_LIMIT, "limit", MAX_COMPUTE_LIMIT);
  const minAudienceSize = parseInteger(
    input.minAudienceSize,
    DEFAULT_MIN_AUDIENCE_SIZE,
    "minAudienceSize",
    MAX_COMPUTE_LIMIT,
  );
  const persist = parseBoolean(input.persist, true);
  const includeZeroAudience = parseBoolean(input.includeZeroAudience, false);
  const status = parseSourceDefinitionStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!minAudienceSize.ok) issues.push(minAudienceSize.issue);
  if (!persist.ok) issues.push("persist must be true or false.");
  if (!includeZeroAudience.ok) issues.push("includeZeroAudience must be true or false.");
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length || !timeframeDays.ok || !limit.ok || !minAudienceSize.ok || !persist.ok || !includeZeroAudience.ok || status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          timeframeDays: timeframeDays.value ?? DEFAULT_TIMEFRAME_DAYS,
          status,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          minAudienceSize: minAudienceSize.value ?? DEFAULT_MIN_AUDIENCE_SIZE,
          persist: persist.value,
          includeZeroAudience: includeZeroAudience.value,
        },
      };
}

export function parseCampaignOpportunityListInput(input: CampaignOpportunityListInput = {}): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIST_LIMIT);
  const status = parseOpportunityStatus(input.status);
  const opportunityType = parseOpportunityType(input.opportunityType);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");
  if (opportunityType === undefined) issues.push("opportunityType must be campaign, flow, suppression, policy, lifecycle, or review.");

  return issues.length || !timeframeDays.ok || !limit.ok || status === undefined || opportunityType === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          opportunityKey: cleanString(input.opportunityKey, 180),
          microSegmentDefinitionKey: cleanString(input.microSegmentDefinitionKey, 180),
          timeframeDays: timeframeDays.value,
          status,
          opportunityType,
          recommendedCampaignType: cleanString(input.recommendedCampaignType, 120),
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function confidenceValue(value: unknown): OpportunityConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function statusValue(value: unknown): SourceDefinitionStatus {
  return value === "available" || value === "partial" || value === "unavailable" ? value : "partial";
}

function cleanList(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function clampPriority(value: number) {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function audienceCount(definition: SourceMicroSegmentDefinition) {
  const estimate = recordValue(definition.audienceEstimate);
  return numberValue(estimate.count, numberValue(estimate.estimatedAudienceSize));
}

function countBy<T extends string | null | undefined>(items: T[]) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function topCounts(values: Array<string | null | undefined>, max = 5) {
  return Object.entries(countBy(values))
    .filter(([key]) => key !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, count]) => ({ value: key, count }));
}

function productItems(
  products: ProductPerformanceIntelligenceResult | null,
  selector: (result: ProductPerformanceIntelligenceResult) => ProductPerformanceIntelligenceResult["tiers"]["revenueAnchors"],
  source: string,
): ProductDirectionSummary {
  if (!products) {
    return {
      source,
      products: [],
      caveats: ["Product performance intelligence was unavailable; product direction uses the micro-segment recommendation only."],
    };
  }

  return {
    source,
    products: selector(products).slice(0, 3).map((item) => ({
      name: item.name,
      category: item.category,
      recommendedUse: item.recommendedUse,
      confidence: item.confidence,
    })),
    caveats: products.caveats.slice(0, 4),
  };
}

function firstUseCase(values: string[]) {
  return values.find((value) => value.trim()) ?? null;
}

const COMMON_FUTURE_CAPABILITIES = [
  "campaign_opportunity_to_brief_generation",
  "campaign_variant_micro_campaign_factory",
  "approval_queue_campaign_review_canvas",
  "arbitration_frequency_guardrails",
];

const OPPORTUNITY_BLUEPRINTS: OpportunityBlueprint[] = [
  {
    opportunityKey: "second_purchase_high_aov_nurture",
    segmentDefinitionKey: "high_aov_one_time_buyers_ready_for_second_purchase",
    name: "Second-purchase push for high-AOV first buyers",
    description:
      "Turn high-value first buyers into repeat customers with a product-aware second-purchase campaign opportunity.",
    opportunityType: "lifecycle",
    whyNow: [
      "A first-to-second purchase window is open, and the audience is valuable enough to deserve a more specific path than a broad campaign.",
      "The micro-segment already filters out elevated fatigue/suppression, so this can become an early factory candidate once approval and arbitration exist.",
    ],
    recommendedCampaignType: "second_purchase_campaign",
    recommendedChannel: "email",
    messageAngle: "Product education and complementary next step, with margin-safe value before a discount.",
    futureArtifact: {
      artifactType: "campaign_brief_seed",
      title: "High-AOV second-purchase campaign seed",
      readiness: "ready_for_brief",
    },
    useCaseFocus: {
      campaign: "Second-purchase education",
      flow: "Post-purchase second-order nurture",
      suppression: "Hold broad discount promos while a specific second-purchase path is active",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "klaviyo_segment_profile_sync"],
    blockedCapabilities: ["opportunity_to_campaign_brief_writer", "approved_segment_or_property_activation"],
    urgencyBoost: 4,
    productSelector: (products) =>
      productItems(products, (result) => result.lifecyclePlacement.postPurchaseCrossSell, "product_truth.post_purchase_cross_sell"),
  },
  {
    opportunityKey: "vip_churn_save_motion",
    segmentDefinitionKey: "vip_customers_at_churn_risk_still_engaged",
    name: "VIP save motion before high-value customers lapse",
    description:
      "Prioritize engaged VIPs at churn risk for a careful save motion before they become a generic winback audience.",
    opportunityType: "lifecycle",
    whyNow: [
      "The audience is still engaged, which means Worklin can intervene before the save motion degrades into a discount-heavy winback.",
      "VIP value and churn risk together make this more urgent than a general retention campaign.",
    ],
    recommendedCampaignType: "vip_churn_prevention",
    recommendedChannel: "email",
    messageAngle: "Concierge guidance, loyalty recognition, early access, or service recovery before markdowns.",
    futureArtifact: {
      artifactType: "campaign_brief_seed",
      title: "VIP churn save campaign seed",
      readiness: "needs_policy_before_brief",
    },
    useCaseFocus: {
      campaign: "VIP save campaign",
      flow: "VIP reactivation branch",
      suppression: "Suppress from generic winback discounts unless policy allows",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "vip_policy_rules", "klaviyo_segment_profile_sync"],
    blockedCapabilities: ["vip_save_brief_generator", "offer_arbitration_policy"],
    urgencyBoost: 5,
    productSelector: (products) =>
      productItems(products, (result) => result.lifecyclePlacement.vip, "product_truth.vip"),
  },
  {
    opportunityKey: "replenishment_due_now_reminder",
    segmentDefinitionKey: "replenishment_ready_repeat_buyers",
    name: "Due-now replenishment reminder",
    description:
      "Use replenishment-ready repeat-buyer signals to surface a timed reminder opportunity instead of a broad promo.",
    opportunityType: "flow",
    whyNow: [
      "Replenishment timing is the reason to act now; delay makes the reminder less useful and broad promos less precise.",
      "Repeat buyers provide enough behavior to route toward a due-now flow branch or tightly scoped reminder.",
    ],
    recommendedCampaignType: "replenishment_flow",
    recommendedChannel: "email",
    messageAngle: "Convenience, routine, restock timing, subscription, or bundle value.",
    futureArtifact: {
      artifactType: "flow_branch_plan",
      title: "Replenishment branch plan seed",
      readiness: "needs_policy_before_brief",
    },
    useCaseFocus: {
      campaign: "Replenishment reminder",
      flow: "Product/category replenishment branch",
      suppression: "Hold generic sale messaging while replenishment timing is active",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "product_replenishment_timing_rules", "klaviyo_segment_profile_sync"],
    blockedCapabilities: ["product_level_replenishment_windows", "flow_branch_builder"],
    urgencyBoost: 6,
    productSelector: (products) =>
      productItems(products, (result) => result.tiers.replenishmentCandidates, "product_truth.replenishment_candidates"),
  },
  {
    opportunityKey: "full_price_discount_protection_policy",
    segmentDefinitionKey: "full_price_likely_customers_discount_protection",
    name: "Discount protection for full-price likely customers",
    description:
      "Protect likely full-price buyers from unnecessary markdowns and route them toward premium, access, or product-led messaging.",
    opportunityType: "policy",
    whyNow: [
      "This is an arbitration and margin-protection opportunity, not a campaign request: protect customers from unnecessary discounts before the next promo is planned.",
      "The audience is large enough in local data to justify a future offer policy item before campaign generation.",
    ],
    recommendedCampaignType: "not_applicable_policy",
    recommendedChannel: "email",
    messageAngle: "Newness, product quality, early access, loyalty, bundle value, or utility instead of a blanket discount.",
    futureArtifact: {
      artifactType: "policy_approval_item",
      title: "Full-price discount protection policy",
      readiness: "needs_policy_before_brief",
    },
    useCaseFocus: {
      campaign: null,
      flow: "Offer policy branch for discount suppression",
      suppression: "Suppress from heavy sitewide discount campaigns",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "discount_policy_runtime"],
    blockedCapabilities: ["offer_arbitration_policy", "campaign_level_suppression_builder"],
    urgencyBoost: 2,
    productSelector: (products) =>
      productItems(products, (result) => result.tiers.revenueAnchors, "product_truth.revenue_anchors"),
  },
  {
    opportunityKey: "targeted_promo_dormant_winback",
    segmentDefinitionKey: "promo_responsive_dormant_buyers",
    name: "Targeted promo winback for dormant responsive buyers",
    description:
      "Focus incentive spend on dormant buyers with promo-response evidence instead of training the whole list to wait for discounts.",
    opportunityType: "campaign",
    whyNow: [
      "Dormancy creates a defensible reason to test an incentive now, while Worklin guardrails keep likely full-price and fatigued customers out.",
      "This should become a bounded offer test, not a standing promo habit.",
    ],
    recommendedCampaignType: "targeted_winback_offer",
    recommendedChannel: "email",
    messageAngle: "Bounded incentive tied to familiar category affinity or a clear best-next product.",
    futureArtifact: {
      artifactType: "campaign_brief_seed",
      title: "Targeted dormant promo winback seed",
      readiness: "needs_policy_before_brief",
    },
    useCaseFocus: {
      campaign: "Targeted winback offer",
      flow: "Winback branch with offer testing",
      suppression: "Exclude full-price likely and high-fatigue customers",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "promo_offer_test_policy", "klaviyo_segment_profile_sync"],
    blockedCapabilities: ["offer_redemption_history", "discount_guardrail_policy"],
    urgencyBoost: 1,
    productSelector: (products) =>
      productItems(products, (result) => result.lifecyclePlacement.winback, "product_truth.winback"),
  },
  {
    opportunityKey: "product_entry_cross_sell_bridge",
    segmentDefinitionKey: "product_entry_cohort_cross_sell_candidates",
    name: "Product-entry cross-sell bridge",
    description:
      "Translate known product or category entry points into a focused cross-sell opportunity for the future campaign factory.",
    opportunityType: "campaign",
    whyNow: [
      "Known product-entry context creates a better message and offer angle than a generic buyer campaign.",
      "This is a clean bridge from segment definition to future micro-campaign variants once product slotting exists.",
    ],
    recommendedCampaignType: "product_entry_cross_sell",
    recommendedChannel: "email",
    messageAngle: "Next logical complement, product education, routine-building, or bundle value.",
    futureArtifact: {
      artifactType: "campaign_brief_seed",
      title: "Product-entry cross-sell campaign seed",
      readiness: "ready_for_brief",
    },
    useCaseFocus: {
      campaign: "Product-entry cross-sell",
      flow: "Post-purchase education and cross-sell branch",
      suppression: "Hold unrelated broad promos while product-specific messaging is active",
    },
    futureCapabilities: [...COMMON_FUTURE_CAPABILITIES, "product_affinity_depth", "klaviyo_segment_profile_sync"],
    blockedCapabilities: ["next_best_product_mapping", "campaign_factory_product_slotting"],
    urgencyBoost: 2,
    productSelector: (products) =>
      productItems(products, (result) => result.lifecyclePlacement.postPurchaseCrossSell, "product_truth.post_purchase_cross_sell"),
  },
  {
    opportunityKey: "broad_campaign_fatigue_suppression",
    segmentDefinitionKey: "high_email_fatigue_customers_broad_campaign_suppression",
    name: "Broad campaign fatigue suppression opportunity",
    description:
      "Protect fatigued or suppression-risk customers from non-essential campaign pressure while preserving higher-intent moments.",
    opportunityType: "suppression",
    whyNow: [
      "This is a holdout opportunity: it should act before broad campaigns are selected, not after a send is already planned.",
      "A future campaign factory needs suppression decisions alongside campaign ideas to avoid over-contact.",
    ],
    recommendedCampaignType: "not_applicable_suppression",
    recommendedChannel: null,
    messageAngle: "No campaign by default; delay broad messages until intent, replenishment, or service relevance is stronger.",
    futureArtifact: {
      artifactType: "suppression_rule_plan",
      title: "Broad campaign fatigue holdout rule",
      readiness: "holdout_only",
    },
    useCaseFocus: {
      campaign: null,
      flow: "Non-essential marketing holdout branch",
      suppression: "Suppress from broad promos and non-urgent newsletters",
    },
    futureCapabilities: ["suppression_policy_runtime", "arbitration_frequency_guardrails", "approval_queue_campaign_review_canvas"],
    blockedCapabilities: ["frequency_guardrail_runtime", "campaign_level_suppression_builder"],
    urgencyBoost: 7,
    productSelector: () => ({
      source: "suppression_policy",
      products: [],
      caveats: ["Suppression opportunity does not need a product recommendation by default."],
    }),
  },
];

function normalizeUseCases(value: unknown): SourceMicroSegmentDefinition["recommendedUseCases"] {
  const record = recordValue(value);
  return {
    campaigns: asStringArray(record.campaigns),
    flows: asStringArray(record.flows),
    suppressions: asStringArray(record.suppressions),
  };
}

function normalizeProductOrOffer(value: unknown): SourceMicroSegmentDefinition["productOrOfferDirection"] {
  const record = recordValue(value);
  return {
    productDirection: cleanString(record.productDirection, 500),
    offerDirection: cleanString(record.offerDirection, 500),
  };
}

function normalizeSourceDefinition(value: StoredMicroSegmentDefinition | Record<string, unknown>): SourceMicroSegmentDefinition | null {
  const record = value as Record<string, unknown>;
  const definitionKey = cleanString(record.definitionKey, 180);
  const name = cleanString(record.name, 240);
  if (!definitionKey || !name) return null;
  const computedAtValue = record.computedAt instanceof Date
    ? record.computedAt.toISOString()
    : cleanString(record.computedAt, 80) ?? new Date().toISOString();

  return {
    id: cleanString(record.id, 220),
    definitionKey,
    definitionVersion: cleanString(record.definitionVersion, 120) ?? MICRO_SEGMENT_DEFINITION_VERSION,
    timeframeDays: numberValue(record.timeframeDays, DEFAULT_TIMEFRAME_DAYS),
    computedAt: computedAtValue,
    status: statusValue(record.status),
    name,
    description: cleanString(record.description, 1000) ?? "",
    priority: numberValue(record.priority, 50),
    confidence: confidenceValue(record.confidence),
    activationStatus: cleanString(record.activationStatus, 80) ?? "definition_only",
    audienceEstimate: recordValue(record.audienceEstimate),
    whyItMatters: asStringArray(record.whyItMatters),
    recommendedUseCases: normalizeUseCases(record.recommendedUseCases),
    productOrOfferDirection: normalizeProductOrOffer(record.productOrOfferDirection),
    collisionArbitrationHints: recordValue(record.collisionArbitrationHints),
    klaviyoNativePossible: booleanValue(record.klaviyoNativePossible, false),
    requiresWorklinProperties: booleanValue(record.requiresWorklinProperties, true),
    sourceScoringVersion: cleanString(record.sourceScoringVersion, 120) ?? CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: cleanString(record.sourceFeatureVersion, 120) ?? CUSTOMER_FEATURE_STORE_VERSION,
    sourceScoreSummary: recordValue(record.sourceScoreSummary),
    missingCapabilities: asStringArray(record.missingCapabilities),
    caveats: asStringArray(record.caveats),
  };
}

async function loadSourceDefinitions(input: {
  timeframeDays: number;
  status: SourceDefinitionStatus | null;
  limit: number;
}): Promise<{
  definitions: SourceMicroSegmentDefinition[];
  mode: SourceDefinitionMode;
  caveats: string[];
}> {
  const where: Prisma.MicroSegmentDefinitionStoreWhereInput = {
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    timeframeDays: input.timeframeDays,
    ...(input.status ? { status: input.status } : {}),
  };
  const persisted = await prisma.microSegmentDefinitionStore.findMany({
    where,
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
    take: input.limit,
  });
  const normalizedPersisted = persisted
    .map((record) => normalizeSourceDefinition(record))
    .filter((definition): definition is SourceMicroSegmentDefinition => Boolean(definition));

  if (normalizedPersisted.length) {
    return {
      definitions: normalizedPersisted,
      mode: "persisted_micro_segment_definitions",
      caveats: [],
    };
  }

  const computed = await computeMicroSegmentDefinitions({
    timeframeDays: input.timeframeDays,
    status: input.status,
    limit: input.limit,
    persist: false,
    includeZeroCount: true,
  });

  if (!computed.ok) {
    return {
      definitions: [],
      mode: "computed_micro_segment_fallback",
      caveats: ["Micro-segment definitions could not be read or computed for opportunity discovery."],
    };
  }

  const definitions = Array.isArray(computed.definitions)
    ? computed.definitions
        .map((definition) => normalizeSourceDefinition(recordValue(definition)))
        .filter((definition): definition is SourceMicroSegmentDefinition => Boolean(definition))
    : [];

  return {
    definitions,
    mode: "computed_micro_segment_fallback",
    caveats: [
      "No persisted micro-segment definitions were found; opportunities used an in-memory micro-segment definition fallback.",
      "Run POST /api/customers/segment-definitions/compute to persist segment definitions before relying on list/get history.",
    ],
  };
}

async function loadProductDirection() {
  try {
    return await getProductPerformanceIntelligence({ limit: 6, timeframe: "last_90_days" });
  } catch (error) {
    console.warn("Campaign Opportunity Engine product intelligence read failed", error);
    return null;
  }
}

async function loadCampaignMemorySummary(): Promise<CampaignMemorySummary> {
  const memories = await prisma.campaignMemory.findMany({
    orderBy: { sentAt: "desc" },
    take: 100,
    select: {
      campaignType: true,
      segment: true,
      winningInsight: true,
    },
  });

  const topCampaignTypes = topCounts(memories.map((memory) => memory.campaignType)).map(({ value, count }) => ({
    campaignType: value,
    count,
  }));
  const topSegments = topCounts(memories.map((memory) => memory.segment)).map(({ value, count }) => ({
    segment: value,
    count,
  }));

  return {
    campaignsAnalyzed: memories.length,
    topCampaignTypes,
    topSegments,
    recentWinningInsights: memories
      .map((memory) => cleanString(memory.winningInsight, 220))
      .filter((insight): insight is string => Boolean(insight))
      .slice(0, 5),
    caveats: memories.length ? [] : ["No CampaignMemory rows were available; campaign-history fit is directional."],
  };
}

function opportunityStatus(input: {
  count: number;
  segmentStatus: SourceDefinitionStatus;
  confidence: OpportunityConfidence;
  caveats: string[];
}): CampaignOpportunityStatus {
  if (!input.count || input.segmentStatus === "unavailable") return "unavailable";
  if (input.segmentStatus === "partial" || input.confidence === "low" || input.caveats.length) return "partial";
  return "available";
}

function confidenceFromSegment(input: {
  segmentConfidence: OpportunityConfidence;
  audienceCount: number;
  productDirection: ProductDirectionSummary;
  campaignMemory: CampaignMemorySummary;
}) {
  if (!input.audienceCount) return "low";
  if (input.segmentConfidence === "low") return "low";
  if (input.audienceCount < 10) return "low";
  if (input.segmentConfidence === "high" && input.productDirection.products.length && input.campaignMemory.campaignsAnalyzed) {
    return "high";
  }
  return "medium";
}

function buildOpportunityBundle(input: {
  blueprint: OpportunityBlueprint;
  definition: SourceMicroSegmentDefinition;
  productDirection: ProductDirectionSummary;
  campaignMemory: CampaignMemorySummary;
  sourceMode: SourceDefinitionMode;
  sourceModeCaveats: string[];
  computedAt: Date;
}): OpportunityBundle {
  const count = audienceCount(input.definition);
  const confidence = confidenceFromSegment({
    segmentConfidence: input.definition.confidence,
    audienceCount: count,
    productDirection: input.productDirection,
    campaignMemory: input.campaignMemory,
  });
  const caveats = cleanList([
    ...input.sourceModeCaveats,
    ...input.definition.caveats,
    ...input.productDirection.caveats,
    ...input.campaignMemory.caveats,
    count && count < 10 ? "Audience estimate is directional because fewer than 10 customers qualified." : null,
    input.definition.requiresWorklinProperties
      ? "Exact opportunity depends on Worklin scores/properties and is not natively actionable in Klaviyo yet."
      : null,
    "Campaign Opportunity Engine v0 discovers opportunities only; it does not generate campaign briefs.",
    "No Klaviyo drafts, segments, profile syncs, campaign/flow creation, sends, schedules, or live external actions are performed.",
  ]);
  const priority = clampPriority(input.definition.priority + input.blueprint.urgencyBoost + (count >= 25 ? 3 : count >= 10 ? 1 : 0));
  const status = opportunityStatus({
    count,
    segmentStatus: input.definition.status,
    confidence,
    caveats,
  });
  const useCases = input.definition.recommendedUseCases;
  const requiredFutureCapabilities = cleanList([
    ...input.blueprint.futureCapabilities,
    ...input.definition.missingCapabilities,
  ]);
  const blockedByMissingCapabilities = cleanList([
    ...input.blueprint.blockedCapabilities,
    ...input.definition.missingCapabilities,
    "campaign_opportunity_activation_not_built",
  ]);

  return {
    opportunityKey: input.blueprint.opportunityKey,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    timeframeDays: input.definition.timeframeDays,
    computedAt: input.computedAt.toISOString(),
    status,
    opportunityType: input.blueprint.opportunityType,
    name: input.blueprint.name,
    description: input.blueprint.description,
    priority,
    confidence,
    activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
    linkedMicroSegment: {
      id: input.definition.id,
      definitionKey: input.definition.definitionKey,
      name: input.definition.name,
      status: input.definition.status,
      confidence: input.definition.confidence,
      definitionVersion: input.definition.definitionVersion,
      activationStatus: input.definition.activationStatus,
      klaviyoNativePossible: input.definition.klaviyoNativePossible,
      requiresWorklinProperties: input.definition.requiresWorklinProperties,
    },
    audienceEstimate: {
      ...input.definition.audienceEstimate,
      estimatedAudienceSize: count,
      count,
      source: "MicroSegmentDefinitionStore.audienceEstimate",
      countIsDirectional: true,
      memberListReturned: false,
      rawContactFieldsReturned: false,
    },
    whyNow: input.blueprint.whyNow,
    whyItMatters: cleanList([
      ...input.definition.whyItMatters,
      input.blueprint.description,
    ]),
    recommendedCampaignType: input.blueprint.recommendedCampaignType,
    recommendedUseCase: {
      campaign: input.blueprint.useCaseFocus.campaign ?? firstUseCase(useCases.campaigns),
      flow: input.blueprint.useCaseFocus.flow ?? firstUseCase(useCases.flows),
      suppression: input.blueprint.useCaseFocus.suppression ?? firstUseCase(useCases.suppressions),
      sourceSegmentUseCases: useCases,
      opportunityType: input.blueprint.opportunityType,
      shouldBecomeBrief: input.blueprint.futureArtifact.readiness === "ready_for_brief",
      shouldBecomeDraft: false,
      shouldEnterApprovalQueue: true,
      nextFactoryStep: input.blueprint.futureArtifact.artifactType,
    },
    recommendedProductOfferMessageDirection: {
      productDirection: input.definition.productOrOfferDirection.productDirection,
      offerDirection: input.definition.productOrOfferDirection.offerDirection,
      messageAngle: input.blueprint.messageAngle,
      productTruth: input.productDirection,
      campaignMemoryFit: {
        campaignsAnalyzed: input.campaignMemory.campaignsAnalyzed,
        topCampaignTypes: input.campaignMemory.topCampaignTypes,
        topSegments: input.campaignMemory.topSegments,
        recentWinningInsights: input.campaignMemory.recentWinningInsights,
      },
    },
    recommendedChannel: input.blueprint.recommendedChannel,
    suppressionCollisionHints: {
      ...input.definition.collisionArbitrationHints,
      recommendedDelayOrSuppression: input.blueprint.useCaseFocus.suppression,
      suppressOrDelay: cleanList([
        input.blueprint.useCaseFocus.suppression,
        "Delay if frequency guardrails or suppression risk outrank this opportunity.",
        input.blueprint.recommendedCampaignType === "targeted_winback_offer"
          ? "Suppress full-price likely and high-fatigue customers from the promo version."
          : null,
        input.blueprint.opportunityType === "suppression"
          ? "Default to holdout for non-essential broad campaigns."
          : null,
      ]),
      arbitrationNeededBeforeActivation: true,
    },
    requiredFutureCapabilities,
    futureArtifact: {
      ...input.blueprint.futureArtifact,
      shouldBecomeDraft: false,
      shouldCreateExternalArtifactNow: false,
      activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
    },
    blockedByMissingCapabilities,
    sourceDefinitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    sourceScoringVersion: input.definition.sourceScoringVersion,
    sourceFeatureVersion: input.definition.sourceFeatureVersion,
    sourceSummary: {
      sourceDefinitionMode: input.sourceMode,
      sourceMicroSegmentStatus: input.definition.status,
      sourceScoreSummary: input.definition.sourceScoreSummary,
      sourceKlaviyoNativePossible: input.definition.klaviyoNativePossible,
      sourceRequiresWorklinProperties: input.definition.requiresWorklinProperties,
      campaignMemoryRowsAnalyzed: input.campaignMemory.campaignsAnalyzed,
      productDirectionSource: input.productDirection.source,
    },
    caveats,
    metadata: {
      route: "POST /api/campaigns/opportunities/compute",
      listRoute: "GET /api/campaigns/opportunities",
      getRoute: "GET /api/campaigns/opportunities/[id]",
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
      opportunityOnly: true,
      externalActionTaken: false,
      campaignBriefCreated: false,
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

async function persistOpportunityBundle(bundle: OpportunityBundle) {
  return prisma.campaignOpportunityStore.upsert({
    where: {
      opportunityKey_timeframeDays_opportunityVersion: {
        opportunityKey: bundle.opportunityKey,
        timeframeDays: bundle.timeframeDays,
        opportunityVersion: bundle.opportunityVersion,
      },
    },
    create: {
      opportunityKey: bundle.opportunityKey,
      opportunityVersion: bundle.opportunityVersion,
      timeframeDays: bundle.timeframeDays,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      opportunityType: bundle.opportunityType,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      linkedMicroSegment: asJson(bundle.linkedMicroSegment),
      audienceEstimate: asJson(bundle.audienceEstimate),
      whyNow: asJson(bundle.whyNow),
      whyItMatters: asJson(bundle.whyItMatters),
      recommendedCampaignType: bundle.recommendedCampaignType,
      recommendedUseCase: asJson(bundle.recommendedUseCase),
      recommendedProductOfferMessageDirection: asJson(bundle.recommendedProductOfferMessageDirection),
      recommendedChannel: bundle.recommendedChannel,
      suppressionCollisionHints: asJson(bundle.suppressionCollisionHints),
      requiredFutureCapabilities: asJson(bundle.requiredFutureCapabilities),
      futureArtifact: asJson(bundle.futureArtifact),
      blockedByMissingCapabilities: asJson(bundle.blockedByMissingCapabilities),
      sourceDefinitionVersion: bundle.sourceDefinitionVersion,
      sourceScoringVersion: bundle.sourceScoringVersion,
      sourceFeatureVersion: bundle.sourceFeatureVersion,
      sourceSummary: asJson(bundle.sourceSummary),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
    update: {
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      opportunityType: bundle.opportunityType,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      linkedMicroSegment: asJson(bundle.linkedMicroSegment),
      audienceEstimate: asJson(bundle.audienceEstimate),
      whyNow: asJson(bundle.whyNow),
      whyItMatters: asJson(bundle.whyItMatters),
      recommendedCampaignType: bundle.recommendedCampaignType,
      recommendedUseCase: asJson(bundle.recommendedUseCase),
      recommendedProductOfferMessageDirection: asJson(bundle.recommendedProductOfferMessageDirection),
      recommendedChannel: bundle.recommendedChannel,
      suppressionCollisionHints: asJson(bundle.suppressionCollisionHints),
      requiredFutureCapabilities: asJson(bundle.requiredFutureCapabilities),
      futureArtifact: asJson(bundle.futureArtifact),
      blockedByMissingCapabilities: asJson(bundle.blockedByMissingCapabilities),
      sourceDefinitionVersion: bundle.sourceDefinitionVersion,
      sourceScoringVersion: bundle.sourceScoringVersion,
      sourceFeatureVersion: bundle.sourceFeatureVersion,
      sourceSummary: asJson(bundle.sourceSummary),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
  });
}

function compactOpportunityBundle(bundle: OpportunityBundle) {
  return {
    opportunityKey: bundle.opportunityKey,
    opportunityVersion: bundle.opportunityVersion,
    timeframeDays: bundle.timeframeDays,
    computedAt: bundle.computedAt,
    status: bundle.status,
    opportunityType: bundle.opportunityType,
    name: bundle.name,
    description: bundle.description,
    priority: bundle.priority,
    confidence: bundle.confidence,
    activationStatus: bundle.activationStatus,
    linkedMicroSegment: bundle.linkedMicroSegment,
    audienceEstimate: bundle.audienceEstimate,
    whyNow: bundle.whyNow,
    whyItMatters: bundle.whyItMatters,
    recommendedCampaignType: bundle.recommendedCampaignType,
    recommendedUseCase: bundle.recommendedUseCase,
    recommendedProductOfferMessageDirection: bundle.recommendedProductOfferMessageDirection,
    recommendedChannel: bundle.recommendedChannel,
    suppressionCollisionHints: bundle.suppressionCollisionHints,
    requiredFutureCapabilities: bundle.requiredFutureCapabilities,
    futureArtifact: bundle.futureArtifact,
    blockedByMissingCapabilities: bundle.blockedByMissingCapabilities,
    sourceDefinitionVersion: bundle.sourceDefinitionVersion,
    sourceScoringVersion: bundle.sourceScoringVersion,
    sourceFeatureVersion: bundle.sourceFeatureVersion,
    sourceSummary: bundle.sourceSummary,
    caveats: bundle.caveats,
    metadata: bundle.metadata,
    externalActionTaken: false,
    ...(bundle.persistedRecordId ? { persistedRecordId: bundle.persistedRecordId } : {}),
  };
}

function compactStoredOpportunity(record: StoredCampaignOpportunity) {
  return {
    id: record.id,
    opportunityKey: record.opportunityKey,
    opportunityVersion: record.opportunityVersion,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: record.status,
    opportunityType: record.opportunityType,
    name: record.name,
    description: record.description,
    priority: record.priority,
    confidence: record.confidence,
    activationStatus: record.activationStatus,
    linkedMicroSegment: record.linkedMicroSegment,
    audienceEstimate: record.audienceEstimate,
    whyNow: record.whyNow,
    whyItMatters: record.whyItMatters,
    recommendedCampaignType: record.recommendedCampaignType,
    recommendedUseCase: record.recommendedUseCase,
    recommendedProductOfferMessageDirection: record.recommendedProductOfferMessageDirection,
    recommendedChannel: record.recommendedChannel,
    suppressionCollisionHints: record.suppressionCollisionHints,
    requiredFutureCapabilities: record.requiredFutureCapabilities,
    futureArtifact: record.futureArtifact,
    blockedByMissingCapabilities: record.blockedByMissingCapabilities,
    sourceDefinitionVersion: record.sourceDefinitionVersion,
    sourceScoringVersion: record.sourceScoringVersion,
    sourceFeatureVersion: record.sourceFeatureVersion,
    sourceSummary: record.sourceSummary,
    caveats: record.caveats,
    metadata: {
      opportunityVersion: record.opportunityVersion,
      activationStatus: record.activationStatus,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
    externalActionTaken: false,
  };
}

export async function computeCampaignOpportunities(input: CampaignOpportunityComputeInput = {}) {
  const parsed = parseCampaignOpportunityComputeInput(input);
  if (!parsed.ok) return parsed;

  const now = new Date();
  const [sourceDefinitions, productDirection, campaignMemory] = await Promise.all([
    loadSourceDefinitions({
      timeframeDays: parsed.data.timeframeDays,
      status: parsed.data.status,
      limit: parsed.data.limit,
    }),
    loadProductDirection(),
    loadCampaignMemorySummary(),
  ]);

  const definitionByKey = new Map(sourceDefinitions.definitions.map((definition) => [definition.definitionKey, definition]));
  const allOpportunities = OPPORTUNITY_BLUEPRINTS.map((blueprint) => {
    const definition = definitionByKey.get(blueprint.segmentDefinitionKey);
    if (!definition) return null;
    return buildOpportunityBundle({
      blueprint,
      definition,
      productDirection: blueprint.productSelector(productDirection),
      campaignMemory,
      sourceMode: sourceDefinitions.mode,
      sourceModeCaveats: sourceDefinitions.caveats,
      computedAt: now,
    });
  }).filter((opportunity): opportunity is OpportunityBundle => Boolean(opportunity));

  const returnedOpportunities = allOpportunities
    .filter((opportunity) => {
      const count = numberValue(recordValue(opportunity.audienceEstimate).count);
      return parsed.data.includeZeroAudience || count >= parsed.data.minAudienceSize;
    })
    .sort((a, b) => b.priority - a.priority);

  const persisted = parsed.data.persist
    ? await Promise.all(returnedOpportunities.map(persistOpportunityBundle))
    : [];
  const persistedByKey = new Map(persisted.map((record) => [record.opportunityKey, record]));
  const outputOpportunities = returnedOpportunities.map((opportunity) => {
    const persistedRecord = persistedByKey.get(opportunity.opportunityKey);
    return compactOpportunityBundle({
      ...opportunity,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });
  const missingCapabilities = cleanList([
    ...returnedOpportunities.flatMap((opportunity) => opportunity.blockedByMissingCapabilities),
    sourceDefinitions.definitions.length ? null : "micro_segment_definitions.available_records",
  ]);
  const caveats = cleanList([
    ...sourceDefinitions.caveats,
    ...returnedOpportunities.flatMap((opportunity) => opportunity.caveats),
    sourceDefinitions.definitions.length ? null : "No micro-segment definitions were available. Compute customer scores and micro-segment definitions first.",
    "Campaign opportunities are opportunity_only and have not been activated.",
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    sourceDefinitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    sourceScoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    computedAt: now.toISOString(),
    persisted: parsed.data.persist,
    summary: {
      microSegmentDefinitionsAnalyzed: sourceDefinitions.definitions.length,
      sourceDefinitionMode: sourceDefinitions.mode,
      opportunitiesConsidered: allOpportunities.length,
      opportunitiesReturned: outputOpportunities.length,
      opportunitiesPersisted: persisted.length,
      minAudienceSize: parsed.data.minAudienceSize,
      includeZeroAudience: parsed.data.includeZeroAudience,
      statusCounts: countBy(returnedOpportunities.map((opportunity) => opportunity.status)),
      activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
    },
    opportunities: outputOpportunities,
    sourceStatuses: [
      {
        source: "micro_segment_definitions",
        status: sourceDefinitions.definitions.length ? "available" : "unavailable",
        rowsAnalyzed: sourceDefinitions.definitions.length,
        sourceDefinitionMode: sourceDefinitions.mode,
        readOnly: true,
      },
      {
        source: "product_performance_intelligence",
        status: productDirection ? "available" : "partial",
        readOnly: true,
      },
      {
        source: "campaign_memory",
        status: campaignMemory.campaignsAnalyzed ? "available" : "partial",
        rowsAnalyzed: campaignMemory.campaignsAnalyzed,
        readOnly: true,
      },
    ],
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/campaigns/opportunities/compute",
      listRoute: "GET /api/campaigns/opportunities",
      getRoute: "GET /api/campaigns/opportunities/[id]",
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      limit: parsed.data.limit,
      statusFilter: parsed.data.status,
      persist: parsed.data.persist,
      activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
      externalActionTaken: false,
      campaignBriefCreated: false,
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

export async function listCampaignOpportunities(input: CampaignOpportunityListInput = {}) {
  const parsed = parseCampaignOpportunityListInput(input);
  if (!parsed.ok) return parsed;

  const linkedMicroSegmentFilter = parsed.data.microSegmentDefinitionKey
    ? {
        path: ["definitionKey"],
        equals: parsed.data.microSegmentDefinitionKey,
      }
    : undefined;
  const where: Prisma.CampaignOpportunityStoreWhereInput = {
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    ...(parsed.data.opportunityKey ? { opportunityKey: parsed.data.opportunityKey } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.opportunityType ? { opportunityType: parsed.data.opportunityType } : {}),
    ...(parsed.data.recommendedCampaignType ? { recommendedCampaignType: parsed.data.recommendedCampaignType } : {}),
    ...(linkedMicroSegmentFilter ? { linkedMicroSegment: linkedMicroSegmentFilter } : {}),
  };
  const [total, records] = await Promise.all([
    prisma.campaignOpportunityStore.count({ where }),
    prisma.campaignOpportunityStore.findMany({
      where,
      orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
      take: parsed.data.limit,
    }),
  ]);

  return {
    ok: true as const,
    readOnly: true,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    summary: {
      totalMatchingOpportunities: total,
      returnedOpportunities: records.length,
      statusCounts: countBy(records.map((record) => record.status)),
      activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
    },
    opportunities: records.map(compactStoredOpportunity),
    metadata: {
      route: "GET /api/campaigns/opportunities",
      limit: parsed.data.limit,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function getCampaignOpportunity(identifier: string, input: Omit<CampaignOpportunityListInput, "opportunityKey"> = {}) {
  const cleaned = cleanString(identifier, 220);
  if (!cleaned) {
    return {
      ok: false as const,
      reason: "invalid_campaign_opportunity_identifier",
      issues: ["A campaign opportunity id or opportunityKey is required."],
      status: 400,
    };
  }
  const parsed = parseCampaignOpportunityListInput({ ...input, limit: 1 });
  if (!parsed.ok) return parsed;

  const record = await prisma.campaignOpportunityStore.findFirst({
    where: {
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.opportunityType ? { opportunityType: parsed.data.opportunityType } : {}),
      ...(parsed.data.recommendedCampaignType ? { recommendedCampaignType: parsed.data.recommendedCampaignType } : {}),
      OR: [{ id: cleaned }, { opportunityKey: cleaned }],
    },
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
  });

  if (!record) {
    return {
      ok: false as const,
      reason: "campaign_opportunity_not_found",
      issues: ["No persisted campaign opportunity was found for this id or opportunityKey."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    opportunity: compactStoredOpportunity(record),
    metadata: {
      route: "GET /api/campaigns/opportunities/[id]",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function campaignOpportunitiesContextSummary() {
  const [total, latest, byStatus] = await Promise.all([
    prisma.campaignOpportunityStore.count({
      where: { opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION },
    }),
    prisma.campaignOpportunityStore.findFirst({
      where: { opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION },
      orderBy: { computedAt: "desc" },
      select: {
        computedAt: true,
        timeframeDays: true,
        status: true,
        caveats: true,
      },
    }),
    prisma.campaignOpportunityStore.groupBy({
      by: ["status"],
      where: { opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION },
      _count: { status: true },
    }),
  ]);

  return {
    available: total > 0,
    status: !total ? "unavailable" : latest?.status ?? "partial",
    route: "/api/campaigns/opportunities",
    computeRoute: "/api/campaigns/opportunities/compute",
    opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
    sourceDefinitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    sourceScoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    totalOpportunities: total,
    latestComputedAt: latest?.computedAt.toISOString() ?? null,
    latestTimeframeDays: latest?.timeframeDays ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count.status])),
    detailsOmitted: true,
    detailsReason: "Context pack exposes campaign-opportunity status and routes only; use the campaign opportunity API or Tool Runtime read tool for opportunities.",
    activationStatus: CAMPAIGN_OPPORTUNITY_ACTIVATION_STATUS,
    caveats: Array.isArray(latest?.caveats)
      ? latest.caveats.slice(0, 4)
      : total
        ? []
        : ["Campaign opportunities have not been computed yet."],
    externalActionTaken: false,
    rawContactFieldsReturned: false,
  };
}
