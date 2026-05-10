import { Prisma } from "@prisma/client";
import { CUSTOMER_FEATURE_STORE_VERSION } from "@/lib/customers/feature-store";
import { CUSTOMER_SCORING_VERSION } from "@/lib/customers/scoring";
import { prisma } from "@/lib/prisma";

export const MICRO_SEGMENT_DEFINITION_VERSION = "micro_segment_definition_builder_v0";
export const MICRO_SEGMENT_DEFINITION_STATUSES = ["available", "partial", "unavailable"] as const;
export const MICRO_SEGMENT_ACTIVATION_STATUS = "definition_only";

type MicroSegmentDefinitionStatus = (typeof MICRO_SEGMENT_DEFINITION_STATUSES)[number];
type SegmentConfidence = "high" | "medium" | "low";
type SourceScoreStatus = "available" | "partial" | "unavailable";

export type MicroSegmentDefinitionComputeInput = {
  timeframeDays?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
  minAudienceSize?: number | string | null;
  persist?: boolean | string | null;
  includeZeroCount?: boolean | string | null;
};

export type MicroSegmentDefinitionListInput = {
  definitionKey?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        timeframeDays: number;
        status: SourceScoreStatus | null;
        limit: number;
        minAudienceSize: number;
        persist: boolean;
        includeZeroCount: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        definitionKey: string | null;
        timeframeDays: number | null;
        status: MicroSegmentDefinitionStatus | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type ScoreRecord = Awaited<ReturnType<typeof prisma.customerScoreStore.findMany>>[number];

type ScoreRule = {
  scoreName: string;
  operator: ">=" | "<=" | ">" | "<";
  threshold: number;
  rationale: string;
};

type FeatureRule = {
  source: string;
  condition: string;
  rationale: string;
};

type SegmentMatch = {
  qualifies: boolean;
  reasons: string[];
  caveats: string[];
  confidenceSignals: SegmentConfidence[];
};

type SegmentBlueprint = {
  definitionKey: string;
  name: string;
  description: string;
  definitionType: "campaign" | "flow" | "suppression" | "cross_sell" | "offer_policy";
  priority: number;
  qualifyingLogic: {
    humanReadable: string;
    scoreRules: ScoreRule[];
    featureRules: FeatureRule[];
    exclusions: FeatureRule[];
  };
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
  collisionArbitrationHints: {
    primaryCollisionRisks: string[];
    suggestedPriorityRules: string[];
    suppressionHints: string[];
  };
  klaviyoNativePossible: boolean;
  requiresWorklinProperties: boolean;
  missingCapabilities: string[];
  caveats: string[];
  match: (record: ScoreRecord) => SegmentMatch;
};

type DefinitionBundle = {
  definitionKey: string;
  definitionVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: MicroSegmentDefinitionStatus;
  name: string;
  description: string;
  definitionType: string;
  priority: number;
  confidence: SegmentConfidence;
  activationStatus: typeof MICRO_SEGMENT_ACTIVATION_STATUS;
  qualifyingLogic: SegmentBlueprint["qualifyingLogic"];
  audienceEstimate: Record<string, unknown>;
  whyItMatters: string[];
  recommendedUseCases: SegmentBlueprint["recommendedUseCases"];
  productOrOfferDirection: SegmentBlueprint["productOrOfferDirection"];
  collisionArbitrationHints: Record<string, unknown>;
  klaviyoNativePossible: boolean;
  requiresWorklinProperties: boolean;
  sourceScoringVersion: string;
  sourceFeatureVersion: string;
  sourceScoreSummary: Record<string, unknown>;
  missingCapabilities: string[];
  caveats: string[];
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
};

const DEFAULT_TIMEFRAME_DAYS = 90;
const MAX_TIMEFRAME_DAYS = 730;
const DEFAULT_COMPUTE_LIMIT = 500;
const MAX_COMPUTE_LIMIT = 2000;
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

function parseDefinitionStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return MICRO_SEGMENT_DEFINITION_STATUSES.includes(cleaned as MicroSegmentDefinitionStatus)
    ? (cleaned as MicroSegmentDefinitionStatus)
    : undefined;
}

function parseSourceScoreStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return ["available", "partial", "unavailable"].includes(cleaned)
    ? (cleaned as SourceScoreStatus)
    : undefined;
}

export function parseMicroSegmentDefinitionComputeInput(
  input: MicroSegmentDefinitionComputeInput = {},
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
  const includeZeroCount = parseBoolean(input.includeZeroCount, false);
  const status = parseSourceScoreStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!minAudienceSize.ok) issues.push(minAudienceSize.issue);
  if (!persist.ok) issues.push("persist must be true or false.");
  if (!includeZeroCount.ok) issues.push("includeZeroCount must be true or false.");
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length || !timeframeDays.ok || !limit.ok || !minAudienceSize.ok || !persist.ok || !includeZeroCount.ok || status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          timeframeDays: timeframeDays.value ?? DEFAULT_TIMEFRAME_DAYS,
          status,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          minAudienceSize: minAudienceSize.value ?? DEFAULT_MIN_AUDIENCE_SIZE,
          persist: persist.value,
          includeZeroCount: includeZeroCount.value,
        },
      };
}

export function parseMicroSegmentDefinitionListInput(
  input: MicroSegmentDefinitionListInput = {},
): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIST_LIMIT);
  const status = parseDefinitionStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length || !timeframeDays.ok || !limit.ok || status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          definitionKey: cleanString(input.definitionKey, 180),
          timeframeDays: timeframeDays.value,
          status,
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown) {
  return value === true;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function scoreConfidence(value: unknown): SegmentConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function cleanList(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function scoreEntry(record: ScoreRecord, scoreName: string) {
  const scores = recordValue(record.scores);
  const entry = recordValue(scores[scoreName]);
  return {
    scoreName,
    score: numberValue(entry.score),
    tier: stringValue(entry.tier) ?? "unknown",
    confidence: scoreConfidence(entry.confidence),
    reasons: asStringArray(entry.reasons),
    caveats: asStringArray(entry.caveats),
  };
}

function sourceSummary(record: ScoreRecord) {
  return recordValue(record.sourceFeatureSummary);
}

function commerceSummary(record: ScoreRecord) {
  return recordValue(sourceSummary(record).commerce);
}

function engagementSummary(record: ScoreRecord) {
  return recordValue(sourceSummary(record).engagement);
}

function affinitySummary(record: ScoreRecord) {
  return recordValue(sourceSummary(record).affinity);
}

function scoreAtLeast(record: ScoreRecord, scoreName: string, threshold: number) {
  return scoreEntry(record, scoreName).score >= threshold;
}

function scoreBelow(record: ScoreRecord, scoreName: string, threshold: number) {
  return scoreEntry(record, scoreName).score < threshold;
}

function daysSinceLastOrder(record: ScoreRecord) {
  const value = commerceSummary(record).daysSinceLastOrder;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function totalOrders(record: ScoreRecord) {
  return numberValue(commerceSummary(record).totalOrdersLifetime);
}

function hasEngagement(record: ScoreRecord) {
  const engagement = engagementSummary(record);
  return (
    numberValue(engagement.emailOpens90d) > 0 ||
    numberValue(engagement.emailClicks90d) > 0 ||
    numberValue(engagement.campaignEngaged30d) > 0
  );
}

function highAov(record: ScoreRecord) {
  return booleanValue(commerceSummary(record).highAovCustomer);
}

function primaryProduct(record: ScoreRecord) {
  return stringValue(affinitySummary(record).primaryProductName);
}

function primaryCategory(record: ScoreRecord) {
  return stringValue(affinitySummary(record).primaryCategory);
}

function matchFrom(record: ScoreRecord, input: {
  qualifies: boolean;
  scoreNames: string[];
  reasons: string[];
  caveats?: string[];
}) {
  const entries = input.scoreNames.map((scoreName) => scoreEntry(record, scoreName));
  return {
    qualifies: input.qualifies,
    reasons: cleanList(input.reasons),
    caveats: cleanList([
      ...entries.flatMap((entry) => entry.caveats),
      ...(input.caveats ?? []),
    ]),
    confidenceSignals: entries.map((entry) => entry.confidence),
  };
}

const SEGMENT_BLUEPRINTS: SegmentBlueprint[] = [
  {
    definitionKey: "high_aov_one_time_buyers_ready_for_second_purchase",
    name: "High-AOV one-time buyers ready for second purchase",
    description:
      "Customers with one known order, high AOV context, and strong second-purchase readiness signals.",
    definitionType: "campaign",
    priority: 92,
    qualifyingLogic: {
      humanReadable:
        "One-time buyers with high-AOV context and second-purchase readiness at or above 650, excluding high fatigue/suppression risk.",
      scoreRules: [
        {
          scoreName: "second_purchase_opportunity",
          operator: ">=",
          threshold: 650,
          rationale: "Signals readiness for the first repeat purchase.",
        },
        {
          scoreName: "email_fatigue_risk",
          operator: "<",
          threshold: 700,
          rationale: "Avoid broad pressure when fatigue is elevated.",
        },
      ],
      featureRules: [
        {
          source: "CustomerScoreStore.sourceFeatureSummary.commerce",
          condition: "totalOrdersLifetime equals 1 and highAovCustomer is true when available",
          rationale: "Keeps the segment specific to high-value first buyers.",
        },
      ],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.suppression_risk",
          condition: "suppression_risk below 700",
          rationale: "Suppress customers likely to be harmed by marketing pressure.",
        },
      ],
    },
    whyItMatters: [
      "Second purchase is a decisive retention step, especially after an expensive first order.",
      "AOV-aware follow-up can protect margin while nudging a higher-value customer into repeat behavior.",
    ],
    recommendedUseCases: {
      campaigns: ["Second-purchase education", "Cross-sell from first purchase context"],
      flows: ["Post-purchase second-order nurture"],
      suppressions: ["Exclude from generic discount blasts while a more specific second-purchase play is active"],
    },
    productOrOfferDirection: {
      productDirection: "Recommend complements or replenishable products tied to the first order/category.",
      offerDirection: "Start with value-add, bundle, or service angle before discounting.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: [
        "product_entry_cohort_cross_sell_candidates",
        "full_price_likely_customers_discount_protection",
      ],
      suggestedPriorityRules: [
        "If replenishment_readiness is higher than second_purchase_opportunity, prefer replenishment messaging.",
        "If full_price_likelihood is high, avoid aggressive promo framing.",
      ],
      suppressionHints: ["Hold if email_fatigue_risk or suppression_risk crosses 700."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: [],
    caveats: [
      "A native Klaviyo approximation can use order-count and order-value conditions, but the exact definition depends on Worklin second-purchase, fatigue, and suppression scores.",
    ],
    match: (record) => matchFrom(record, {
      qualifies:
        totalOrders(record) === 1 &&
        highAov(record) &&
        scoreAtLeast(record, "second_purchase_opportunity", 650) &&
        scoreBelow(record, "email_fatigue_risk", 700) &&
        scoreBelow(record, "suppression_risk", 700),
      scoreNames: ["second_purchase_opportunity", "email_fatigue_risk", "suppression_risk"],
      reasons: [
        "one_time_buyer",
        "high_aov_context",
        "second_purchase_score_ready",
        "fatigue_and_suppression_below_holdout_threshold",
      ],
      caveats: highAov(record) ? [] : ["High-AOV signal was not available or false for this record."],
    }),
  },
  {
    definitionKey: "vip_customers_at_churn_risk_still_engaged",
    name: "VIP customers at churn risk but still engaged",
    description:
      "High-value customers with elevated churn risk and recent engagement signals, useful for careful save motions.",
    definitionType: "campaign",
    priority: 90,
    qualifyingLogic: {
      humanReadable:
        "VIP likelihood at or above 650, churn risk at or above 600, at least some engagement signal, and suppression risk below 700.",
      scoreRules: [
        {
          scoreName: "vip_likelihood",
          operator: ">=",
          threshold: 650,
          rationale: "Protects high-value customers.",
        },
        {
          scoreName: "churn_risk",
          operator: ">=",
          threshold: 600,
          rationale: "Flags retention risk before the customer is fully dormant.",
        },
      ],
      featureRules: [
        {
          source: "CustomerScoreStore.sourceFeatureSummary.engagement",
          condition: "email opens, clicks, or campaign engagement are present when available",
          rationale: "Still-engaged VIPs deserve different treatment than unreachable lapsed buyers.",
        },
      ],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.suppression_risk",
          condition: "suppression_risk below 700",
          rationale: "Do not pressure customers with strong suppression signals.",
        },
      ],
    },
    whyItMatters: [
      "VIP churn prevention can preserve more value than broad acquisition-style campaigns.",
      "Still-engaged risk is an actionable window before full winback mechanics are needed.",
    ],
    recommendedUseCases: {
      campaigns: ["VIP save campaign", "Early churn intervention"],
      flows: ["VIP reactivation branch", "Customer care check-in"],
      suppressions: ["Suppress from generic winback discounts if full-price likelihood is strong"],
    },
    productOrOfferDirection: {
      productDirection: "Lead with personalized recommendations, replenishment, or concierge guidance.",
      offerDirection: "Prefer loyalty, access, or service recovery before markdowns.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: ["full_price_likely_customers_discount_protection", "promo_responsive_dormant_buyers"],
      suggestedPriorityRules: [
        "VIP save beats generic promo when vip_likelihood is high.",
        "If promo_responsiveness is high but full_price_likelihood is also high, use a non-discount VIP benefit first.",
      ],
      suppressionHints: ["Hold broad sends if suppression_risk crosses 700."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: ["micro_segments.vip_churn.engagement_linkage_quality"],
    caveats: [
      "Engagement linkage may be local-only or partial depending on available Klaviyo/event data.",
      "The exact VIP churn definition depends on Worklin score properties, not native Klaviyo segment conditions alone.",
    ],
    match: (record) => matchFrom(record, {
      qualifies:
        scoreAtLeast(record, "vip_likelihood", 650) &&
        scoreAtLeast(record, "churn_risk", 600) &&
        hasEngagement(record) &&
        scoreBelow(record, "suppression_risk", 700),
      scoreNames: ["vip_likelihood", "churn_risk", "suppression_risk"],
      reasons: ["vip_score_ready", "churn_risk_elevated", "engagement_present", "suppression_below_holdout_threshold"],
      caveats: hasEngagement(record) ? [] : ["Recent engagement signal was not available in the score summary."],
    }),
  },
  {
    definitionKey: "replenishment_ready_repeat_buyers",
    name: "Replenishment-ready repeat buyers",
    description:
      "Repeat buyers whose replenishment readiness suggests a due-now product or category prompt.",
    definitionType: "flow",
    priority: 88,
    qualifyingLogic: {
      humanReadable:
        "Repeat buyers with replenishment_readiness at or above 700 and no elevated fatigue/suppression veto.",
      scoreRules: [
        {
          scoreName: "replenishment_readiness",
          operator: ">=",
          threshold: 700,
          rationale: "Identifies buyers likely due for a replenish or restock reminder.",
        },
      ],
      featureRules: [
        {
          source: "CustomerScoreStore.sourceFeatureSummary.commerce",
          condition: "totalOrdersLifetime is 2 or more",
          rationale: "Repeat buyers have stronger replenishment evidence than one-time buyers.",
        },
      ],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.email_fatigue_risk",
          condition: "email_fatigue_risk below 700",
          rationale: "Replenishment should not override a strong fatigue veto.",
        },
      ],
    },
    whyItMatters: [
      "Due-now replenishment can beat broad lifecycle promos because timing is clearer.",
      "Repeat-buyer replenishment is one of the cleanest inputs for future micro-campaign automation.",
    ],
    recommendedUseCases: {
      campaigns: ["Replenishment reminder", "Routine restock campaign"],
      flows: ["Product/category replenishment branch"],
      suppressions: ["Avoid generic sale campaign while a due-now replenishment message is active"],
    },
    productOrOfferDirection: {
      productDirection: "Use the primary product or category where available; otherwise use the strongest replenishable category.",
      offerDirection: "Use convenience, timing, subscription, or bundle angle before discounts.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: ["product_entry_cohort_cross_sell_candidates"],
      suggestedPriorityRules: [
        "Due-now replenishment should outrank generic cross-sell.",
        "If suppression risk rises, hold rather than switching to broad promo.",
      ],
      suppressionHints: ["Hold if fatigue or suppression risk crosses 700."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: ["micro_segments.replenishment.product_replenishment_days"],
    caveats: [
      "Replenishment timing is stronger when products have avgReplenishmentDays or equivalent signals.",
      "A native Klaviyo approximation can use product/order timing, but exact due-now readiness depends on Worklin replenishment and suppression scores.",
    ],
    match: (record) => matchFrom(record, {
      qualifies:
        totalOrders(record) >= 2 &&
        scoreAtLeast(record, "replenishment_readiness", 700) &&
        scoreBelow(record, "email_fatigue_risk", 700) &&
        scoreBelow(record, "suppression_risk", 700),
      scoreNames: ["replenishment_readiness", "email_fatigue_risk", "suppression_risk"],
      reasons: ["repeat_buyer", "replenishment_due_signal", "fatigue_and_suppression_below_holdout_threshold"],
    }),
  },
  {
    definitionKey: "full_price_likely_customers_discount_protection",
    name: "Full-price likely customers to protect from discounts",
    description:
      "Customers with strong full-price or VIP signals who should be insulated from unnecessary markdown pressure.",
    definitionType: "offer_policy",
    priority: 84,
    qualifyingLogic: {
      humanReadable:
        "Full-price likelihood at or above 650, or VIP likelihood at or above 700, with promo responsiveness below 650 when available.",
      scoreRules: [
        {
          scoreName: "full_price_likelihood",
          operator: ">=",
          threshold: 650,
          rationale: "Suggests the customer may buy without a heavy discount.",
        },
        {
          scoreName: "promo_responsiveness",
          operator: "<",
          threshold: 650,
          rationale: "Avoids treating discount-sensitive customers as full-price protect candidates.",
        },
      ],
      featureRules: [],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.email_fatigue_risk",
          condition: "email_fatigue_risk below 750",
          rationale: "Do not simply redirect fatigued customers to premium messaging.",
        },
        {
          source: "CustomerScoreStore.scores.suppression_risk",
          condition: "suppression_risk below 700",
          rationale: "Suppression risk should still win over discount-protection messaging.",
        },
      ],
    },
    whyItMatters: [
      "Margin protection is a segment decision, not just a campaign copy decision.",
      "This group helps future arbitration choose value, access, or product education over markdowns.",
    ],
    recommendedUseCases: {
      campaigns: ["New arrivals", "VIP early access", "Product education"],
      flows: ["Offer policy branch for discount suppression"],
      suppressions: ["Suppress from heavy sitewide discount campaigns unless policy explicitly overrides"],
    },
    productOrOfferDirection: {
      productDirection: "Feature hero products, premium bundles, or newness.",
      offerDirection: "Use access, loyalty, replenishment convenience, or bundle value before percentage discounts.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: ["promo_responsive_dormant_buyers", "vip_customers_at_churn_risk_still_engaged"],
      suggestedPriorityRules: [
        "Full-price protection should veto heavy discounts unless churn risk is severe and promo responsiveness is higher.",
        "If VIP churn risk is high, try non-discount save mechanics first.",
      ],
      suppressionHints: ["Suppress from broad discount sends when a non-discount campaign is available."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: [],
    caveats: ["Exact discount-protection requires Worklin full-price, VIP, promo, fatigue, and suppression score properties."],
    match: (record) => matchFrom(record, {
      qualifies:
        (scoreAtLeast(record, "full_price_likelihood", 650) || scoreAtLeast(record, "vip_likelihood", 700)) &&
        scoreBelow(record, "promo_responsiveness", 650) &&
        scoreBelow(record, "email_fatigue_risk", 750) &&
        scoreBelow(record, "suppression_risk", 700),
      scoreNames: ["full_price_likelihood", "vip_likelihood", "promo_responsiveness", "email_fatigue_risk", "suppression_risk"],
      reasons: ["full_price_or_vip_signal", "promo_responsiveness_below_discount_first_threshold", "suppression_below_holdout_threshold"],
    }),
  },
  {
    definitionKey: "promo_responsive_dormant_buyers",
    name: "Promo-responsive dormant buyers",
    description:
      "Dormant or winback-ready buyers whose score profile suggests a promotion may be useful and safe enough to test.",
    definitionType: "campaign",
    priority: 78,
    qualifyingLogic: {
      humanReadable:
        "Promo responsiveness at or above 650, winback readiness at or above 550 or last order at least 90 days ago, and suppression risk below 700.",
      scoreRules: [
        {
          scoreName: "promo_responsiveness",
          operator: ">=",
          threshold: 650,
          rationale: "Identifies customers more likely to respond to an offer.",
        },
        {
          scoreName: "winback_readiness",
          operator: ">=",
          threshold: 550,
          rationale: "Keeps the segment anchored in lifecycle need, not discount appetite alone.",
        },
      ],
      featureRules: [
        {
          source: "CustomerScoreStore.sourceFeatureSummary.commerce",
          condition: "daysSinceLastOrder is at least 90 when available",
          rationale: "Dormancy makes a promotion more defensible.",
        },
      ],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.full_price_likelihood",
          condition: "full_price_likelihood below 700",
          rationale: "Protect likely full-price buyers from unnecessary discounts.",
        },
        {
          source: "CustomerScoreStore.scores.email_fatigue_risk",
          condition: "email_fatigue_risk below 700",
          rationale: "Fatigue veto beats promo readiness.",
        },
      ],
    },
    whyItMatters: [
      "Discounting is most useful when it is targeted to dormant customers with actual promo response evidence.",
      "This segment prevents a future campaign factory from using broad discounts as the default retention lever.",
    ],
    recommendedUseCases: {
      campaigns: ["Targeted winback offer", "Dormant buyer reactivation"],
      flows: ["Winback branch with offer testing"],
      suppressions: ["Suppress full-price likely customers and fatigue-risk customers from the same promo"],
    },
    productOrOfferDirection: {
      productDirection: "Pair the offer with familiar category affinity or a best next product.",
      offerDirection: "Use a bounded, targeted incentive rather than a sitewide habit-forming discount.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: ["full_price_likely_customers_discount_protection", "high_email_fatigue_customers_broad_campaign_suppression"],
      suggestedPriorityRules: [
        "Full-price protection beats promo responsiveness when full_price_likelihood is 700 or higher.",
        "Suppression/fatigue veto beats promo readiness.",
      ],
      suppressionHints: ["Exclude high fatigue and suppression risk from broad winback promotions."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: ["micro_segments.promo_response.local_redemption_signal"],
    caveats: [
      "Promo responsiveness is stronger when local redemption or offer history is available.",
      "A native Klaviyo dormant-buyer approximation is possible, but the exact definition depends on Worklin promo, winback, full-price, fatigue, and suppression scores.",
    ],
    match: (record) => {
      const days = daysSinceLastOrder(record);
      return matchFrom(record, {
        qualifies:
          scoreAtLeast(record, "promo_responsiveness", 650) &&
          (scoreAtLeast(record, "winback_readiness", 550) || (days !== null && days >= 90)) &&
          scoreBelow(record, "full_price_likelihood", 700) &&
          scoreBelow(record, "email_fatigue_risk", 700) &&
          scoreBelow(record, "suppression_risk", 700),
        scoreNames: ["promo_responsiveness", "winback_readiness", "full_price_likelihood", "email_fatigue_risk", "suppression_risk"],
        reasons: ["promo_response_signal", "dormant_or_winback_ready", "not_full_price_protect_candidate", "fatigue_and_suppression_below_holdout_threshold"],
        caveats: days === null ? ["daysSinceLastOrder unavailable; winback score carried dormancy qualification."] : [],
      });
    },
  },
  {
    definitionKey: "product_entry_cohort_cross_sell_candidates",
    name: "Product-entry cohort cross-sell candidates",
    description:
      "Customers whose first or primary product/category context creates a credible cross-sell opportunity.",
    definitionType: "cross_sell",
    priority: 76,
    qualifyingLogic: {
      humanReadable:
        "Cross-sell opportunity at or above 650 with known product or category affinity and no elevated suppression risk.",
      scoreRules: [
        {
          scoreName: "cross_sell_opportunity",
          operator: ">=",
          threshold: 650,
          rationale: "Signals readiness for adjacent product/category messaging.",
        },
        {
          scoreName: "product_affinity",
          operator: ">=",
          threshold: 500,
          rationale: "Product context helps avoid generic cross-sell recommendations.",
        },
        {
          scoreName: "category_affinity",
          operator: ">=",
          threshold: 500,
          rationale: "Category context can anchor the cross-sell when product affinity is sparse.",
        },
      ],
      featureRules: [
        {
          source: "CustomerScoreStore.sourceFeatureSummary.affinity",
          condition: "primaryProductName or primaryCategory is available",
          rationale: "Cross-sell needs a product-entry anchor.",
        },
      ],
      exclusions: [
        {
          source: "CustomerScoreStore.scores.suppression_risk",
          condition: "suppression_risk below 700",
          rationale: "Cross-sell should not override suppression risk.",
        },
      ],
    },
    whyItMatters: [
      "Product-entry cohorts are a natural bridge from customer scoring to personalized campaign opportunities.",
      "This definition gives future campaign generation a product-aware audience rather than a broad buyer pool.",
    ],
    recommendedUseCases: {
      campaigns: ["Product-entry cross-sell", "Category bridge campaign"],
      flows: ["Post-purchase education and cross-sell branch"],
      suppressions: ["Suppress from unrelated broad promos while product-specific messaging is active"],
    },
    productOrOfferDirection: {
      productDirection: "Use primary product/category to choose the next logical complement.",
      offerDirection: "Favor education, bundle value, or routine-building before discounting.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: ["replenishment_ready_repeat_buyers", "high_aov_one_time_buyers_ready_for_second_purchase"],
      suggestedPriorityRules: [
        "Replenishment beats cross-sell when replenishment_readiness is 700 or higher.",
        "Second-purchase education beats generic cross-sell for one-time buyers unless product affinity is clearly stronger.",
      ],
      suppressionHints: ["Hold if suppression risk crosses 700."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: ["micro_segments.cross_sell.product_affinity_depth"],
    caveats: [
      "Cross-sell direction is better when product-entry cohort and product affinity data are complete.",
      "A native Klaviyo approximation can use purchase/product conditions, but the exact definition depends on Worklin cross-sell, affinity, and suppression scores.",
    ],
    match: (record) => matchFrom(record, {
      qualifies:
        scoreAtLeast(record, "cross_sell_opportunity", 650) &&
        (scoreAtLeast(record, "product_affinity", 500) || scoreAtLeast(record, "category_affinity", 500)) &&
        totalOrders(record) >= 1 &&
        (Boolean(primaryProduct(record)) || Boolean(primaryCategory(record))) &&
        scoreBelow(record, "suppression_risk", 700),
      scoreNames: ["cross_sell_opportunity", "product_affinity", "category_affinity", "suppression_risk"],
      reasons: cleanList([
        "cross_sell_score_ready",
        primaryProduct(record) ? `primary_product:${primaryProduct(record)}` : null,
        primaryCategory(record) ? `primary_category:${primaryCategory(record)}` : null,
      ]),
      caveats: [],
    }),
  },
  {
    definitionKey: "high_email_fatigue_customers_broad_campaign_suppression",
    name: "High email-fatigue customers to suppress from broad campaigns",
    description:
      "Customers with elevated fatigue or suppression risk who should be protected from non-essential broad marketing.",
    definitionType: "suppression",
    priority: 95,
    qualifyingLogic: {
      humanReadable:
        "Email fatigue risk at or above 700, or suppression risk at or above 650.",
      scoreRules: [
        {
          scoreName: "email_fatigue_risk",
          operator: ">=",
          threshold: 700,
          rationale: "Flags potential over-contact or weak engagement health.",
        },
        {
          scoreName: "suppression_risk",
          operator: ">=",
          threshold: 650,
          rationale: "Flags customers who should be held out of broad campaigns.",
        },
      ],
      featureRules: [],
      exclusions: [],
    },
    whyItMatters: [
      "A campaign factory needs holdouts as much as it needs audiences.",
      "Fatigue-aware suppression protects deliverability, customer trust, and future high-intent moments.",
    ],
    recommendedUseCases: {
      campaigns: [],
      flows: ["Non-essential marketing holdout branch"],
      suppressions: ["Suppress from broad promos", "Suppress from non-urgent newsletters", "Allow transactional/service messages only"],
    },
    productOrOfferDirection: {
      productDirection: null,
      offerDirection: "No offer by default; wait for higher-intent or service-relevant context.",
    },
    collisionArbitrationHints: {
      primaryCollisionRisks: [
        "promo_responsive_dormant_buyers",
        "replenishment_ready_repeat_buyers",
        "vip_customers_at_churn_risk_still_engaged",
      ],
      suggestedPriorityRules: [
        "Suppression/fatigue veto should beat broad campaign eligibility.",
        "Allow only highly specific replenishment/service messages when business policy permits.",
      ],
      suppressionHints: ["Default activation is holdout/suppression, not campaign creation."],
    },
    klaviyoNativePossible: false,
    requiresWorklinProperties: true,
    missingCapabilities: [],
    caveats: [
      "Native Klaviyo engagement/suppression approximations may be possible, but this exact holdout definition depends on Worklin fatigue and suppression scores.",
    ],
    match: (record) => matchFrom(record, {
      qualifies:
        scoreAtLeast(record, "email_fatigue_risk", 700) ||
        scoreAtLeast(record, "suppression_risk", 650),
      scoreNames: ["email_fatigue_risk", "suppression_risk"],
      reasons: ["fatigue_or_suppression_veto"],
    }),
  },
];

function countBy<T extends string | null | undefined>(items: T[]) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function confidenceFromMatches(matches: SegmentMatch[], matchedCount: number): SegmentConfidence {
  if (!matchedCount) return "low";
  const signals = matches.flatMap((match) => match.confidenceSignals);
  const highCount = signals.filter((signal) => signal === "high").length;
  const lowCount = signals.filter((signal) => signal === "low").length;
  if (matchedCount >= 20 && highCount >= signals.length * 0.55 && lowCount <= signals.length * 0.2) {
    return "high";
  }
  if (matchedCount >= 5 && lowCount <= signals.length * 0.5) {
    return "medium";
  }
  return "low";
}

function averageScore(records: ScoreRecord[], scoreName: string) {
  if (!records.length) return null;
  const total = records.reduce((sum, record) => sum + scoreEntry(record, scoreName).score, 0);
  return Math.round(total / records.length);
}

function commonVetoes(records: ScoreRecord[]) {
  return cleanList(records.flatMap((record) => asStringArray(recordValue(record.actionPriorityHints).vetoes)));
}

function buildDefinitionBundle(input: {
  blueprint: SegmentBlueprint;
  scoreRecords: ScoreRecord[];
  timeframeDays: number;
  computedAt: Date;
  limit: number;
}) {
  const matches = input.scoreRecords.map((record) => ({
    record,
    match: input.blueprint.match(record),
  }));
  const matched = matches.filter((entry) => entry.match.qualifies);
  const matchedRecords = matched.map((entry) => entry.record);
  const matchedCount = matched.length;
  const confidence = confidenceFromMatches(matched.map((entry) => entry.match), matchedCount);
  const matchedCaveats = cleanList(matched.flatMap((entry) => entry.match.caveats));
  const scoreRuleNames = input.blueprint.qualifyingLogic.scoreRules.map((rule) => rule.scoreName);
  const missingCapabilities = cleanList([
    ...input.blueprint.missingCapabilities,
    input.scoreRecords.length ? null : "customer_scores.persisted_records",
    input.scoreRecords.length >= input.limit ? "micro_segments.estimate_limited_by_query_limit" : null,
  ]);
  const caveats = cleanList([
    ...input.blueprint.caveats,
    ...matchedCaveats,
    matchedCount && matchedCount < 10
      ? "Audience estimate is directional because fewer than 10 score records qualified."
      : null,
    input.scoreRecords.length >= input.limit
      ? "Audience estimate may be undercounted because the source score query hit the requested limit."
      : null,
    "Micro-Segment Definition Builder v0 creates audience definitions only, not Klaviyo segments.",
    "No raw contact fields, member lists, profile syncs, sends, schedules, or live external actions are returned or performed.",
  ]);
  const status: MicroSegmentDefinitionStatus = !matchedCount
    ? "unavailable"
    : missingCapabilities.length || caveats.length
      ? "partial"
      : "available";

  return {
    definitionKey: input.blueprint.definitionKey,
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    timeframeDays: input.timeframeDays,
    computedAt: input.computedAt.toISOString(),
    status,
    name: input.blueprint.name,
    description: input.blueprint.description,
    definitionType: input.blueprint.definitionType,
    priority: input.blueprint.priority,
    confidence,
    activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
    qualifyingLogic: input.blueprint.qualifyingLogic,
    audienceEstimate: {
      estimatedAudienceSize: matchedCount,
      count: matchedCount,
      recordsAnalyzed: input.scoreRecords.length,
      calculationMethod: "count_of_persisted_customer_score_records_matching_definition_rules",
      countIsDirectional: true,
      minimumUsefulAudienceSize: 10,
      memberListReturned: false,
      rawContactFieldsReturned: false,
    },
    whyItMatters: input.blueprint.whyItMatters,
    recommendedUseCases: input.blueprint.recommendedUseCases,
    productOrOfferDirection: input.blueprint.productOrOfferDirection,
    collisionArbitrationHints: {
      ...input.blueprint.collisionArbitrationHints,
      commonVetoes: commonVetoes(matchedRecords),
      overlapScoreNames: scoreRuleNames,
      activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
    },
    klaviyoNativePossible: input.blueprint.klaviyoNativePossible,
    requiresWorklinProperties: input.blueprint.requiresWorklinProperties,
    sourceScoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    sourceScoreSummary: {
      sourceRecordsAnalyzed: input.scoreRecords.length,
      matchedRecords: matchedCount,
      matchRate: input.scoreRecords.length ? Number((matchedCount / input.scoreRecords.length).toFixed(4)) : 0,
      sourceStatusCounts: countBy(input.scoreRecords.map((record) => record.status)),
      matchedIdentityConfidenceCounts: countBy(matchedRecords.map((record) => record.identityConfidence)),
      averageScoresForRules: Object.fromEntries(
        scoreRuleNames.map((scoreName) => [scoreName, averageScore(matchedRecords, scoreName)]),
      ),
      scoreRecordIdsReturned: false,
      memberIdentityIdsReturned: false,
    },
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/segment-definitions/compute",
      listRoute: "GET /api/customers/segment-definitions",
      definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      sourceScoringVersion: CUSTOMER_SCORING_VERSION,
      sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
      source: "CustomerScoreStore",
      definitionOnly: true,
      activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
      externalActionTaken: false,
      klaviyoSegmentCreated: false,
      profileSyncPerformed: false,
      campaignCreated: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  } satisfies DefinitionBundle;
}

async function persistDefinitionBundle(bundle: DefinitionBundle) {
  return prisma.microSegmentDefinitionStore.upsert({
    where: {
      definitionKey_timeframeDays_definitionVersion: {
        definitionKey: bundle.definitionKey,
        timeframeDays: bundle.timeframeDays,
        definitionVersion: bundle.definitionVersion,
      },
    },
    create: {
      definitionKey: bundle.definitionKey,
      definitionVersion: bundle.definitionVersion,
      timeframeDays: bundle.timeframeDays,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      qualifyingLogic: asJson(bundle.qualifyingLogic),
      audienceEstimate: asJson(bundle.audienceEstimate),
      whyItMatters: asJson(bundle.whyItMatters),
      recommendedUseCases: asJson(bundle.recommendedUseCases),
      productOrOfferDirection: asJson(bundle.productOrOfferDirection),
      collisionArbitrationHints: asJson(bundle.collisionArbitrationHints),
      klaviyoNativePossible: bundle.klaviyoNativePossible,
      requiresWorklinProperties: bundle.requiresWorklinProperties,
      sourceScoringVersion: bundle.sourceScoringVersion,
      sourceFeatureVersion: bundle.sourceFeatureVersion,
      sourceScoreSummary: asJson(bundle.sourceScoreSummary),
      missingCapabilities: asJson(bundle.missingCapabilities),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
    update: {
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      name: bundle.name,
      description: bundle.description,
      priority: bundle.priority,
      confidence: bundle.confidence,
      activationStatus: bundle.activationStatus,
      qualifyingLogic: asJson(bundle.qualifyingLogic),
      audienceEstimate: asJson(bundle.audienceEstimate),
      whyItMatters: asJson(bundle.whyItMatters),
      recommendedUseCases: asJson(bundle.recommendedUseCases),
      productOrOfferDirection: asJson(bundle.productOrOfferDirection),
      collisionArbitrationHints: asJson(bundle.collisionArbitrationHints),
      klaviyoNativePossible: bundle.klaviyoNativePossible,
      requiresWorklinProperties: bundle.requiresWorklinProperties,
      sourceScoringVersion: bundle.sourceScoringVersion,
      sourceFeatureVersion: bundle.sourceFeatureVersion,
      sourceScoreSummary: asJson(bundle.sourceScoreSummary),
      missingCapabilities: asJson(bundle.missingCapabilities),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
  });
}

function compactDefinitionBundle(bundle: DefinitionBundle) {
  return {
    definitionKey: bundle.definitionKey,
    definitionVersion: bundle.definitionVersion,
    timeframeDays: bundle.timeframeDays,
    computedAt: bundle.computedAt,
    status: bundle.status,
    name: bundle.name,
    description: bundle.description,
    definitionType: bundle.definitionType,
    priority: bundle.priority,
    confidence: bundle.confidence,
    activationStatus: bundle.activationStatus,
    qualifyingLogic: bundle.qualifyingLogic,
    audienceEstimate: bundle.audienceEstimate,
    whyItMatters: bundle.whyItMatters,
    recommendedUseCases: bundle.recommendedUseCases,
    productOrOfferDirection: bundle.productOrOfferDirection,
    collisionArbitrationHints: bundle.collisionArbitrationHints,
    klaviyoNativePossible: bundle.klaviyoNativePossible,
    requiresWorklinProperties: bundle.requiresWorklinProperties,
    sourceScoringVersion: bundle.sourceScoringVersion,
    sourceFeatureVersion: bundle.sourceFeatureVersion,
    sourceScoreSummary: bundle.sourceScoreSummary,
    missingCapabilities: bundle.missingCapabilities,
    caveats: bundle.caveats,
    metadata: bundle.metadata,
    externalActionTaken: false,
    ...(bundle.persistedRecordId ? { persistedRecordId: bundle.persistedRecordId } : {}),
  };
}

function compactStoredDefinition(
  record: Awaited<ReturnType<typeof prisma.microSegmentDefinitionStore.findMany>>[number],
) {
  return {
    id: record.id,
    definitionKey: record.definitionKey,
    definitionVersion: record.definitionVersion,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: record.status,
    name: record.name,
    description: record.description,
    priority: record.priority,
    confidence: record.confidence,
    activationStatus: record.activationStatus,
    qualifyingLogic: record.qualifyingLogic,
    audienceEstimate: record.audienceEstimate,
    whyItMatters: record.whyItMatters,
    recommendedUseCases: record.recommendedUseCases,
    productOrOfferDirection: record.productOrOfferDirection,
    collisionArbitrationHints: record.collisionArbitrationHints,
    klaviyoNativePossible: record.klaviyoNativePossible,
    requiresWorklinProperties: record.requiresWorklinProperties,
    sourceScoringVersion: record.sourceScoringVersion,
    sourceFeatureVersion: record.sourceFeatureVersion,
    sourceScoreSummary: record.sourceScoreSummary,
    missingCapabilities: record.missingCapabilities,
    caveats: record.caveats,
    metadata: {
      definitionVersion: record.definitionVersion,
      activationStatus: record.activationStatus,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
    externalActionTaken: false,
  };
}

export async function computeMicroSegmentDefinitions(input: MicroSegmentDefinitionComputeInput = {}) {
  const parsed = parseMicroSegmentDefinitionComputeInput(input);
  if (!parsed.ok) return parsed;

  const now = new Date();
  const where: Prisma.CustomerScoreStoreWhereInput = {
    scoringVersion: CUSTOMER_SCORING_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  };
  const scoreRecords = await prisma.customerScoreStore.findMany({
    where,
    orderBy: { computedAt: "desc" },
    take: parsed.data.limit,
  });

  const allDefinitions = SEGMENT_BLUEPRINTS.map((blueprint) =>
    buildDefinitionBundle({
      blueprint,
      scoreRecords,
      timeframeDays: parsed.data.timeframeDays,
      computedAt: now,
      limit: parsed.data.limit,
    }),
  );
  const returnedDefinitions = allDefinitions.filter((definition) => {
    const estimate = recordValue(definition.audienceEstimate);
    const count = numberValue(estimate.count);
    return parsed.data.includeZeroCount || count >= parsed.data.minAudienceSize;
  });
  const persisted = parsed.data.persist
    ? await Promise.all(returnedDefinitions.map(persistDefinitionBundle))
    : [];
  const persistedByKey = new Map(persisted.map((record) => [record.definitionKey, record]));
  const outputDefinitions = returnedDefinitions.map((definition) => {
    const persistedRecord = persistedByKey.get(definition.definitionKey);
    return compactDefinitionBundle({
      ...definition,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });
  const missingCapabilities = cleanList([
    ...returnedDefinitions.flatMap((definition) => definition.missingCapabilities),
    scoreRecords.length ? null : "customer_scores.persisted_records",
  ]);
  const caveats = cleanList([
    ...returnedDefinitions.flatMap((definition) => definition.caveats),
    scoreRecords.length ? null : "No persisted CustomerScoreStore records were available. Compute customer scores first.",
    "Definitions are not Klaviyo segments and have not been activated.",
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    sourceScoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    computedAt: now.toISOString(),
    persisted: parsed.data.persist,
    summary: {
      scoreRecordsAnalyzed: scoreRecords.length,
      blueprintDefinitionsConsidered: allDefinitions.length,
      definitionsReturned: outputDefinitions.length,
      definitionsPersisted: persisted.length,
      minAudienceSize: parsed.data.minAudienceSize,
      includeZeroCount: parsed.data.includeZeroCount,
      statusCounts: countBy(returnedDefinitions.map((definition) => definition.status)),
      activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
    },
    definitions: outputDefinitions,
    sourceStatuses: [
      {
        source: "customer_score_store",
        status: scoreRecords.length ? "available" : "unavailable",
        rowsAnalyzed: scoreRecords.length,
        readOnly: true,
      },
      {
        source: "micro_segment_definition_builder",
        status: outputDefinitions.length ? "available" : "unavailable",
        persistedCount: persisted.length,
        readOnlyExternally: true,
      },
    ],
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/segment-definitions/compute",
      listRoute: "GET /api/customers/segment-definitions",
      definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      limit: parsed.data.limit,
      statusFilter: parsed.data.status,
      persist: parsed.data.persist,
      externalActionTaken: false,
      activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
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

export async function listMicroSegmentDefinitions(input: MicroSegmentDefinitionListInput = {}) {
  const parsed = parseMicroSegmentDefinitionListInput(input);
  if (!parsed.ok) return parsed;

  const where: Prisma.MicroSegmentDefinitionStoreWhereInput = {
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    ...(parsed.data.definitionKey ? { definitionKey: parsed.data.definitionKey } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
  };
  const [total, records] = await Promise.all([
    prisma.microSegmentDefinitionStore.count({ where }),
    prisma.microSegmentDefinitionStore.findMany({
      where,
      orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
      take: parsed.data.limit,
    }),
  ]);

  return {
    ok: true as const,
    readOnly: true,
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    summary: {
      totalMatchingDefinitions: total,
      returnedDefinitions: records.length,
      statusCounts: countBy(records.map((record) => record.status)),
      activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
    },
    definitions: records.map(compactStoredDefinition),
    metadata: {
      route: "GET /api/customers/segment-definitions",
      limit: parsed.data.limit,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function getMicroSegmentDefinition(identifier: string, input: Omit<MicroSegmentDefinitionListInput, "definitionKey"> = {}) {
  const cleaned = cleanString(identifier, 220);
  if (!cleaned) {
    return {
      ok: false as const,
      reason: "invalid_micro_segment_definition_identifier",
      issues: ["A micro-segment definition id or definitionKey is required."],
      status: 400,
    };
  }
  const parsed = parseMicroSegmentDefinitionListInput({ ...input, limit: 1 });
  if (!parsed.ok) return parsed;

  const record = await prisma.microSegmentDefinitionStore.findFirst({
    where: {
      definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      OR: [{ id: cleaned }, { definitionKey: cleaned }],
    },
    orderBy: [{ priority: "desc" }, { computedAt: "desc" }],
  });

  if (!record) {
    return {
      ok: false as const,
      reason: "micro_segment_definition_not_found",
      issues: ["No persisted micro-segment definition was found for this id or definitionKey."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    definition: compactStoredDefinition(record),
    metadata: {
      route: "GET /api/customers/segment-definitions/[id]",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function microSegmentDefinitionsContextSummary() {
  const [total, latest, byStatus] = await Promise.all([
    prisma.microSegmentDefinitionStore.count({
      where: { definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION },
    }),
    prisma.microSegmentDefinitionStore.findFirst({
      where: { definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION },
      orderBy: { computedAt: "desc" },
      select: {
        computedAt: true,
        timeframeDays: true,
        status: true,
        caveats: true,
      },
    }),
    prisma.microSegmentDefinitionStore.groupBy({
      by: ["status"],
      where: { definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION },
      _count: { status: true },
    }),
  ]);

  return {
    available: total > 0,
    status: !total ? "unavailable" : latest?.status ?? "partial",
    route: "/api/customers/segment-definitions",
    computeRoute: "/api/customers/segment-definitions/compute",
    definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
    sourceScoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    totalDefinitions: total,
    latestComputedAt: latest?.computedAt.toISOString() ?? null,
    latestTimeframeDays: latest?.timeframeDays ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count.status])),
    detailsOmitted: true,
    detailsReason: "Context pack exposes segment-definition status and routes only; use the segment-definition API or Tool Runtime read tool for definitions.",
    activationStatus: MICRO_SEGMENT_ACTIVATION_STATUS,
    caveats: Array.isArray(latest?.caveats)
      ? latest.caveats.slice(0, 4)
      : total
        ? []
        : ["Micro-segment definitions have not been computed yet."],
    externalActionTaken: false,
    rawContactFieldsReturned: false,
  };
}
