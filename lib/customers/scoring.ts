import { Prisma } from "@prisma/client";
import { CUSTOMER_FEATURE_STORE_VERSION } from "@/lib/customers/feature-store";
import { prisma } from "@/lib/prisma";

export const CUSTOMER_SCORING_VERSION = "rule_based_customer_scoring_v0";
export const CUSTOMER_SCORE_STATUSES = ["available", "partial", "unavailable"] as const;
export const CUSTOMER_SCORE_NAMES = [
  "ready_to_buy_again",
  "replenishment_readiness",
  "churn_risk",
  "winback_readiness",
  "vip_likelihood",
  "promo_responsiveness",
  "full_price_likelihood",
  "cross_sell_opportunity",
  "upsell_opportunity",
  "second_purchase_opportunity",
  "email_fatigue_risk",
  "channel_preference",
  "suppression_risk",
  "product_affinity",
  "category_affinity",
  "deliverability_engagement_health",
] as const;

type CustomerScoreStatus = (typeof CUSTOMER_SCORE_STATUSES)[number];
type CustomerScoreName = (typeof CUSTOMER_SCORE_NAMES)[number];
type ScoreConfidence = "high" | "medium" | "low";

export type CustomerScoreComputeInput = {
  timeframeDays?: number | string | null;
  limit?: number | string | null;
  identityId?: string | null;
  persist?: boolean | string | null;
};

export type CustomerScoreListInput = {
  identityId?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        timeframeDays: number;
        limit: number;
        identityId: string | null;
        persist: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        identityId: string | null;
        timeframeDays: number | null;
        status: CustomerScoreStatus | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type FeatureRecord = Awaited<ReturnType<typeof prisma.customerFeatureStore.findMany>>[number];

type ScoreDirection =
  | "higher_is_more_ready"
  | "higher_is_more_likely"
  | "higher_is_more_risk"
  | "higher_is_stronger_preference"
  | "higher_is_healthier";

type CustomerScore = {
  scoreName: CustomerScoreName;
  score: number;
  tier: string;
  confidence: ScoreConfidence;
  direction: ScoreDirection;
  value?: unknown;
  reasons: string[];
  sourceFeatures: string[];
  caveats: string[];
};

type FeatureFacts = {
  record: FeatureRecord;
  commerce: Record<string, unknown>;
  engagement: Record<string, unknown>;
  intent: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
  cohort: Record<string, unknown>;
  sourceCoverage: Record<string, unknown>;
  derivedLabels: Record<string, unknown>;
  missingCapabilities: string[];
  caveats: string[];
};

type ScoreBundle = {
  identityId: string;
  worklinCustomerId: string | null;
  shopifyCustomerId: string | null;
  klaviyoProfileId: string | null;
  sourceFeatureStoreId: string;
  featureVersion: string;
  scoringVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: CustomerScoreStatus;
  identityConfidence: string;
  featureStatus: string;
  scores: Record<CustomerScoreName, CustomerScore>;
  scoreSummary: Record<string, unknown>;
  actionPriorityHints: Record<string, unknown>;
  arbitrationMetadata: Record<string, unknown>;
  sourceFeatureSummary: Record<string, unknown>;
  sourceCoverage: Record<string, unknown>;
  missingCapabilities: string[];
  caveats: string[];
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
};

const DEFAULT_TIMEFRAME_DAYS = 90;
const MAX_TIMEFRAME_DAYS = 730;
const DEFAULT_COMPUTE_LIMIT = 200;
const MAX_COMPUTE_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

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
  return { ok: false as const, issue: "persist must be true or false." };
}

function parseStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return CUSTOMER_SCORE_STATUSES.includes(cleaned as CustomerScoreStatus)
    ? (cleaned as CustomerScoreStatus)
    : undefined;
}

export function parseCustomerScoreComputeInput(input: CustomerScoreComputeInput = {}): ParsedComputeInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, DEFAULT_TIMEFRAME_DAYS, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_COMPUTE_LIMIT, "limit", MAX_COMPUTE_LIMIT);
  const persist = parseBoolean(input.persist, true);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!persist.ok) issues.push(persist.issue);

  return issues.length || !timeframeDays.ok || !limit.ok || !persist.ok
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          timeframeDays: timeframeDays.value ?? DEFAULT_TIMEFRAME_DAYS,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          identityId: cleanString(input.identityId, 220),
          persist: persist.value,
        },
      };
}

export function parseCustomerScoreListInput(input: CustomerScoreListInput = {}): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIST_LIMIT);
  const status = parseStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length || !timeframeDays.ok || !limit.ok || status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          identityId: cleanString(input.identityId, 220),
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

function recordsValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

function cleanList(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function tierFor(score: number) {
  if (score >= 800) return "very_high";
  if (score >= 600) return "high";
  if (score >= 400) return "medium";
  if (score >= 200) return "low";
  return "very_low";
}

function confidenceFromStatuses(statuses: unknown[], fallback: ScoreConfidence = "medium"): ScoreConfidence {
  if (statuses.some((status) => status === "unavailable")) return "low";
  if (statuses.length && statuses.every((status) => status === "available")) return "high";
  if (statuses.some((status) => status === "partial")) return "medium";
  return fallback;
}

function score(input: {
  scoreName: CustomerScoreName;
  score: number;
  direction: ScoreDirection;
  confidence: ScoreConfidence;
  reasons: string[];
  sourceFeatures: string[];
  caveats?: string[];
  value?: unknown;
}): CustomerScore {
  const bounded = clampScore(input.score);
  return {
    scoreName: input.scoreName,
    score: bounded,
    tier: tierFor(bounded),
    confidence: input.confidence,
    direction: input.direction,
    ...(input.value === undefined ? {} : { value: input.value }),
    reasons: cleanList(input.reasons),
    sourceFeatures: cleanList(input.sourceFeatures),
    caveats: cleanList(input.caveats ?? []),
  };
}

function scoreMap(scores: CustomerScore[]) {
  return Object.fromEntries(scores.map((entry) => [entry.scoreName, entry])) as Record<CustomerScoreName, CustomerScore>;
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function firstTopProduct(cohort: Record<string, unknown>) {
  return recordsValue(cohort.topProductsByRevenue)[0] ?? null;
}

function topCategory(cohort: Record<string, unknown>) {
  return recordsValue(cohort.categoryAffinity)[0] ?? null;
}

function hasRecentIntent(intent: Record<string, unknown>) {
  return [
    "activeOnSite7d",
    "activeOnSite30d",
    "viewedProduct7d",
    "viewedProduct30d",
    "addedToCart7d",
    "addedToCart30d",
    "startedCheckout7d",
    "startedCheckout30d",
  ].some((field) => booleanValue(intent[field]));
}

function engagementStrength(engagement: Record<string, unknown>) {
  const opens = numberValue(engagement.emailOpens30d) + numberValue(engagement.emailOpens60d) * 0.4;
  const clicks = numberValue(engagement.emailClicks30d) + numberValue(engagement.emailClicks60d) * 0.6;
  const campaign = numberValue(engagement.campaignEngaged30d);
  return Math.min(300, opens * 20 + clicks * 70 + campaign * 25);
}

function factsFromRecord(record: FeatureRecord): FeatureFacts {
  const missingCapabilities = asStringArray(record.missingCapabilities);
  const caveats = asStringArray(record.caveats);
  return {
    record,
    commerce: recordValue(record.commerceFeatures),
    engagement: recordValue(record.engagementFeatures),
    intent: recordValue(record.intentFeatures),
    lifecycle: recordValue(record.lifecycleFeatures),
    cohort: recordValue(record.cohortFeatures),
    sourceCoverage: recordValue(record.sourceCoverage),
    derivedLabels: recordValue(record.derivedLabels),
    missingCapabilities,
    caveats,
  };
}

function commerceConfidence(facts: FeatureFacts) {
  return confidenceFromStatuses([facts.commerce.status]);
}

function engagementConfidence(facts: FeatureFacts) {
  return confidenceFromStatuses([facts.engagement.status]);
}

function lifecycleConfidence(facts: FeatureFacts) {
  return confidenceFromStatuses([facts.lifecycle.status, facts.commerce.status]);
}

function lifecycleConfidenceWithEngagementCaveat(facts: FeatureFacts) {
  const base = lifecycleConfidence(facts);
  if (facts.engagement.status === "unavailable" && base === "high") return "medium";
  return base;
}

function readyToBuyAgain(facts: FeatureFacts): CustomerScore {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  const repeatBuyer = booleanValue(facts.commerce.repeatBuyer);
  const oneTimeBuyer = booleanValue(facts.commerce.oneTimeBuyer);
  const replenishment = booleanValue(facts.lifecycle.replenishmentCandidateSignal);
  let value = booleanValue(facts.commerce.hasPurchased) ? 220 : 60;
  const reasons: string[] = [];

  if (repeatBuyer) {
    value += 180;
    reasons.push("Repeat buyers get a readiness lift because prior purchase behavior is established.");
  }
  if (oneTimeBuyer) {
    value += 120;
    reasons.push("One-time buyers are eligible for second-purchase readiness.");
  }
  if (daysSinceLastOrder <= 7) {
    value -= 140;
    reasons.push("Very recent buyers are cooled down for broad buy-again pushes.");
  } else if (daysSinceLastOrder <= 45) {
    value += 220;
    reasons.push("Last purchase is inside the normal buy-again window.");
  } else if (daysSinceLastOrder <= 90) {
    value += 170;
    reasons.push("Customer is outside the immediate post-purchase period but still recently active enough for lifecycle nudges.");
  } else if (daysSinceLastOrder <= 180) {
    value += 80;
    reasons.push("Longer purchase gap adds some readiness only when other signals support it.");
  }
  if (replenishment) {
    value += 150;
    reasons.push("Feature Store marks replenishment as due or near due.");
  }
  if (hasRecentIntent(facts.intent)) {
    value += 160;
    reasons.push("Recent local intent activity increases buy-again readiness.");
  }
  const engagementLift = engagementStrength(facts.engagement);
  if (engagementLift > 0) {
    value += engagementLift * 0.5;
    reasons.push("Recent local email/campaign engagement supports readiness.");
  }

  return score({
    scoreName: "ready_to_buy_again",
    score: value,
    direction: "higher_is_more_ready",
    confidence: confidenceFromStatuses([facts.commerce.status, facts.lifecycle.status, facts.intent.status], "medium"),
    reasons,
    sourceFeatures: [
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `commerce.repeatBuyer=${repeatBuyer}`,
      `lifecycle.replenishmentCandidateSignal=${replenishment}`,
      `intent.recentIntent=${hasRecentIntent(facts.intent)}`,
    ],
    caveats: facts.intent.status === "unavailable" ? ["Intent signals are unavailable, so readiness is mostly commerce-based."] : [],
  });
}

function replenishmentReadiness(facts: FeatureFacts): CustomerScore {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 0);
  const topProduct = firstTopProduct(facts.cohort);
  const avgReplenishmentDays = numberValue(topProduct?.avgReplenishmentDays, 0);
  const replenishmentSignal = booleanValue(facts.lifecycle.replenishmentCandidateSignal);
  let value = booleanValue(facts.commerce.hasPurchased) ? 120 : 20;
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (avgReplenishmentDays > 0) {
    const ratio = daysSinceLastOrder / avgReplenishmentDays;
    if (ratio >= 1) {
      value += 520;
      reasons.push("Customer is at or beyond the local product replenishment interval.");
    } else if (ratio >= 0.8) {
      value += 420;
      reasons.push("Customer is close to the local product replenishment interval.");
    } else if (ratio >= 0.5) {
      value += 180;
      reasons.push("Customer is approaching the local product replenishment window.");
    }
  } else {
    caveats.push("No local product avgReplenishmentDays value is available for the primary product.");
  }
  if (replenishmentSignal) {
    value += 220;
    reasons.push("Customer Feature Store lifecycle signal marks replenishment as a candidate.");
  }
  if (hasRecentIntent(facts.intent)) {
    value += 110;
    reasons.push("Recent intent activity supports replenishment timing.");
  }

  return score({
    scoreName: "replenishment_readiness",
    score: value,
    direction: "higher_is_more_ready",
    confidence: avgReplenishmentDays > 0 ? lifecycleConfidence(facts) : "low",
    value: {
      primaryProductName: stringValue(topProduct?.name),
      avgReplenishmentDays: avgReplenishmentDays || null,
    },
    reasons,
    sourceFeatures: [
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `cohort.topProductsByRevenue[0].avgReplenishmentDays=${avgReplenishmentDays || "missing"}`,
      `lifecycle.replenishmentCandidateSignal=${replenishmentSignal}`,
    ],
    caveats,
  });
}

function churnRisk(facts: FeatureFacts): CustomerScore {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  const totalOrders = numberValue(facts.commerce.totalOrdersLifetime);
  let value = totalOrders ? 120 : 80;
  const reasons: string[] = [];

  if (!totalOrders) {
    reasons.push("No purchase history exists, so churn is not strongly defined for this customer.");
  } else if (daysSinceLastOrder >= 180) {
    value += 680;
    reasons.push("Last purchase is 180+ days ago.");
  } else if (daysSinceLastOrder >= 90) {
    value += 470;
    reasons.push("Last purchase is 90+ days ago.");
  } else if (daysSinceLastOrder >= 45) {
    value += 230;
    reasons.push("Purchase gap is expanding beyond the recent-buyer window.");
  } else {
    value -= 70;
    reasons.push("Recent purchase activity lowers churn risk.");
  }
  if (hasRecentIntent(facts.intent)) {
    value -= 130;
    reasons.push("Recent local intent activity lowers churn concern.");
  }
  if (engagementStrength(facts.engagement) > 0) {
    value -= 90;
    reasons.push("Recent engagement lowers churn concern.");
  }

  return score({
    scoreName: "churn_risk",
    score: value,
    direction: "higher_is_more_risk",
    confidence: lifecycleConfidenceWithEngagementCaveat(facts),
    reasons,
    sourceFeatures: [
      `commerce.totalOrdersLifetime=${totalOrders}`,
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `lifecycle.churnSignalReason=${stringValue(facts.lifecycle.churnSignalReason) ?? "unknown"}`,
    ],
    caveats: [
      "Rule-Based Scoring v0 is deterministic and not a predictive churn model.",
      facts.engagement.status === "unavailable"
        ? "Engagement is unavailable, so churn confidence is reduced instead of treating missing engagement as negative behavior."
        : null,
    ].filter((item): item is string => Boolean(item)),
  });
}

function winbackReadiness(facts: FeatureFacts, churn: CustomerScore): CustomerScore {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  let value = daysSinceLastOrder >= 90 ? 300 : 80;
  const reasons: string[] = [];
  if (daysSinceLastOrder >= 90) {
    value += 230;
    reasons.push("Customer is in a winback-eligible purchase gap.");
  }
  if (booleanValue(facts.lifecycle.winbackCandidateSignal)) {
    value += 170;
    reasons.push("Feature Store lifecycle signal marks winback candidate.");
  }
  if (engagementStrength(facts.engagement) > 0) {
    value += 140;
    reasons.push("Recent engagement suggests the customer may still be reachable.");
  }
  if (hasRecentIntent(facts.intent)) {
    value += 170;
    reasons.push("Recent intent suggests winback action may be timely.");
  }
  if (churn.score < 400) {
    value -= 120;
    reasons.push("Churn risk is not elevated enough to prioritize winback.");
  }

  return score({
    scoreName: "winback_readiness",
    score: value,
    direction: "higher_is_more_ready",
    confidence: facts.engagement.status === "unavailable"
      ? lifecycleConfidenceWithEngagementCaveat(facts)
      : confidenceFromStatuses([facts.commerce.status, facts.lifecycle.status, facts.engagement.status], "medium"),
    reasons,
    sourceFeatures: [
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `lifecycle.winbackCandidateSignal=${booleanValue(facts.lifecycle.winbackCandidateSignal)}`,
      `score.churn_risk=${churn.score}`,
    ],
    caveats: facts.engagement.status === "unavailable"
      ? ["Reachability is caveated because engagement data is unavailable; missing engagement does not lower winback readiness by itself."]
      : [],
  });
}

function vipLikelihood(facts: FeatureFacts): CustomerScore {
  const ltvBand = stringValue(facts.commerce.ltvBand) ?? "unknown";
  const totalRevenue = numberValue(facts.commerce.totalRevenueLifetime);
  const totalOrders = numberValue(facts.commerce.totalOrdersLifetime);
  let value = 80;
  const reasons: string[] = [];
  if (ltvBand === "vip") {
    value += 610;
    reasons.push("Customer is in the account-relative VIP LTV band.");
  } else if (ltvBand === "high") {
    value += 430;
    reasons.push("Customer is in the account-relative high LTV band.");
  } else if (ltvBand === "mid") {
    value += 220;
    reasons.push("Customer is in the account-relative mid LTV band.");
  }
  if (totalOrders >= 5) {
    value += 160;
    reasons.push("Five or more lifetime orders increases VIP likelihood.");
  } else if (totalOrders >= 2) {
    value += 90;
    reasons.push("Repeat purchase history supports VIP likelihood.");
  }
  if (booleanValue(facts.commerce.highAovCustomer)) {
    value += 140;
    reasons.push("Customer is marked high AOV relative to the local account.");
  }

  return score({
    scoreName: "vip_likelihood",
    score: value,
    direction: "higher_is_more_likely",
    confidence: commerceConfidence(facts),
    value: { ltvBand, totalRevenue },
    reasons,
    sourceFeatures: [
      `commerce.ltvBand=${ltvBand}`,
      `commerce.totalOrdersLifetime=${totalOrders}`,
      `commerce.highAovCustomer=${booleanValue(facts.commerce.highAovCustomer)}`,
    ],
    caveats: asStringArray(facts.commerce.caveats).filter((entry) => entry.includes("directional")),
  });
}

function promoResponsiveness(facts: FeatureFacts): CustomerScore {
  const clicks90d = numberValue(facts.engagement.emailClicks90d);
  const opens90d = numberValue(facts.engagement.emailOpens90d);
  const campaignEngaged30d = numberValue(facts.engagement.campaignEngaged30d);
  const value = 120 + clicks90d * 120 + opens90d * 25 + campaignEngaged30d * 60;
  const reasons: string[] = [];
  if (clicks90d > 0) reasons.push("Recent email clicks indicate campaign responsiveness.");
  if (opens90d > 0) reasons.push("Recent opens add a weaker responsiveness signal.");
  if (campaignEngaged30d > 0) reasons.push("Local campaign engagement in the last 30 days supports responsiveness.");
  if (!clicks90d && !opens90d && !campaignEngaged30d) reasons.push("No local promo-specific response signal was found.");

  return score({
    scoreName: "promo_responsiveness",
    score: value,
    direction: "higher_is_more_likely",
    confidence: facts.engagement.status === "unavailable" ? "low" : "medium",
    reasons,
    sourceFeatures: [
      `engagement.emailClicks90d=${clicks90d}`,
      `engagement.emailOpens90d=${opens90d}`,
      `engagement.campaignEngaged30d=${campaignEngaged30d}`,
    ],
    caveats: [
      "Discount sensitivity and promotion redemption are not separately normalized in local v0 data.",
      facts.engagement.status === "unavailable" ? "Engagement signals are unavailable." : null,
    ].filter((item): item is string => Boolean(item)),
  });
}

function fullPriceLikelihood(facts: FeatureFacts, promo: CustomerScore, vip: CustomerScore): CustomerScore {
  let value = 240;
  const reasons: string[] = [];
  if (booleanValue(facts.commerce.highAovCustomer)) {
    value += 220;
    reasons.push("High AOV customers are protected from heavy discounting.");
  }
  if (vip.score >= 600) {
    value += 220;
    reasons.push("VIP/high-LTV signal supports full-price protection.");
  }
  if (promo.score < 400) {
    value += 120;
    reasons.push("No strong local promo responsiveness signal was found.");
  } else if (promo.score >= 700) {
    value -= 120;
    reasons.push("Strong campaign responsiveness may indicate promo sensitivity.");
  }
  if (numberValue(facts.commerce.averageOrderValueLifetime) > 0) {
    value += 60;
    reasons.push("Average order value is locally available for discount arbitration.");
  }

  return score({
    scoreName: "full_price_likelihood",
    score: value,
    direction: "higher_is_more_likely",
    confidence: commerceConfidence(facts),
    reasons,
    sourceFeatures: [
      `commerce.highAovCustomer=${booleanValue(facts.commerce.highAovCustomer)}`,
      `score.vip_likelihood=${vip.score}`,
      `score.promo_responsiveness=${promo.score}`,
    ],
    caveats: ["No final discount decision is made by this score."],
  });
}

function crossSellOpportunity(facts: FeatureFacts): CustomerScore {
  const categoryCount = recordsValue(facts.cohort.categoryAffinity).length;
  const productCount = recordsValue(facts.cohort.topProductsByRevenue).length;
  let value = booleanValue(facts.lifecycle.crossSellCandidateSignal) ? 310 : 120;
  const reasons: string[] = [];
  if (booleanValue(facts.lifecycle.crossSellCandidateSignal)) {
    reasons.push("Feature Store lifecycle signal marks cross-sell candidate.");
  }
  if (productCount > 0) {
    value += 130;
    reasons.push("Product affinity is available for adjacent-product selection.");
  }
  if (categoryCount > 0) {
    value += 130;
    reasons.push("Category affinity is available for adjacent-category selection.");
  }
  if (booleanValue(facts.lifecycle.replenishmentCandidateSignal)) {
    value -= 90;
    reasons.push("Replenishment can outrank cross-sell when it is due now.");
  }

  return score({
    scoreName: "cross_sell_opportunity",
    score: value,
    direction: "higher_is_more_ready",
    confidence: confidenceFromStatuses([facts.lifecycle.status, facts.cohort.status], "medium"),
    reasons,
    sourceFeatures: [
      `lifecycle.crossSellCandidateSignal=${booleanValue(facts.lifecycle.crossSellCandidateSignal)}`,
      `cohort.topProductsByRevenue.count=${productCount}`,
      `cohort.categoryAffinity.count=${categoryCount}`,
    ],
    caveats: facts.cohort.status === "unavailable" ? ["Product/category affinity is unavailable."] : [],
  });
}

function upsellOpportunity(facts: FeatureFacts, vip: CustomerScore): CustomerScore {
  const repeatBuyer = booleanValue(facts.commerce.repeatBuyer);
  let value = 120;
  const reasons: string[] = [];
  if (repeatBuyer) {
    value += 180;
    reasons.push("Repeat purchase behavior supports upsell testing.");
  }
  if (booleanValue(facts.commerce.highAovCustomer)) {
    value += 260;
    reasons.push("High AOV customers can be candidates for premium-product upsell.");
  }
  if (vip.score >= 600) {
    value += 160;
    reasons.push("VIP likelihood supports premium treatment.");
  }
  if (hasRecentIntent(facts.intent)) {
    value += 120;
    reasons.push("Recent intent activity supports upsell timing.");
  }

  return score({
    scoreName: "upsell_opportunity",
    score: value,
    direction: "higher_is_more_ready",
    confidence: confidenceFromStatuses([facts.commerce.status, facts.intent.status], "medium"),
    reasons,
    sourceFeatures: [
      `commerce.repeatBuyer=${repeatBuyer}`,
      `commerce.highAovCustomer=${booleanValue(facts.commerce.highAovCustomer)}`,
      `score.vip_likelihood=${vip.score}`,
    ],
    caveats: ["No product recommendation engine is created in this v0."],
  });
}

function secondPurchaseOpportunity(facts: FeatureFacts): CustomerScore {
  const oneTimeBuyer = booleanValue(facts.commerce.oneTimeBuyer);
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  let value = oneTimeBuyer ? 260 : 40;
  const reasons: string[] = [];
  if (oneTimeBuyer) {
    reasons.push("Customer has exactly one local lifetime order.");
    if (daysSinceLastOrder >= 7 && daysSinceLastOrder <= 60) {
      value += 350;
      reasons.push("Timing is inside the early second-purchase conversion window.");
    } else if (daysSinceLastOrder > 60 && daysSinceLastOrder <= 120) {
      value += 180;
      reasons.push("Timing is later than ideal but still relevant for second-purchase nudges.");
    } else if (daysSinceLastOrder < 7) {
      value -= 100;
      reasons.push("Purchase is too recent for broad second-purchase pressure.");
    }
  } else {
    reasons.push("Customer is not a one-time buyer, so second-purchase opportunity is low.");
  }
  if (hasRecentIntent(facts.intent)) value += 120;
  if (engagementStrength(facts.engagement) > 0) value += 90;

  return score({
    scoreName: "second_purchase_opportunity",
    score: value,
    direction: "higher_is_more_ready",
    confidence: confidenceFromStatuses([facts.commerce.status, facts.intent.status, facts.engagement.status], "medium"),
    reasons,
    sourceFeatures: [
      `commerce.oneTimeBuyer=${oneTimeBuyer}`,
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `intent.recentIntent=${hasRecentIntent(facts.intent)}`,
    ],
  });
}

function emailFatigueRisk(facts: FeatureFacts): CustomerScore {
  const receiptCount = numberValue(recordValue(facts.sourceCoverage.counts).localCampaignReceipts);
  const opens90d = numberValue(facts.engagement.emailOpens90d);
  const clicks90d = numberValue(facts.engagement.emailClicks90d);
  const campaignEngaged30d = numberValue(facts.engagement.campaignEngaged30d);
  let value = 120;
  const reasons: string[] = [];
  if (receiptCount >= 20 && clicks90d === 0) {
    value += 420;
    reasons.push("Many local campaign receipts exist without recent clicks.");
  } else if (receiptCount >= 10 && clicks90d === 0) {
    value += 260;
    reasons.push("Multiple local campaign receipts exist without recent clicks.");
  }
  if (opens90d === 0 && clicks90d === 0 && receiptCount > 0) {
    value += 190;
    reasons.push("No recent opens or clicks were found despite local receipt history.");
  }
  if (campaignEngaged30d > 0) {
    value -= 100;
    reasons.push("Recent campaign engagement lowers fatigue concern.");
  }

  return score({
    scoreName: "email_fatigue_risk",
    score: value,
    direction: "higher_is_more_risk",
    confidence: facts.engagement.status === "unavailable" ? "low" : "medium",
    reasons,
    sourceFeatures: [
      `sourceCoverage.counts.localCampaignReceipts=${receiptCount}`,
      `engagement.emailOpens90d=${opens90d}`,
      `engagement.emailClicks90d=${clicks90d}`,
    ],
    caveats: [
      "Send frequency by window is not separately normalized, so fatigue uses compact local receipt and engagement signals.",
      facts.engagement.status === "unavailable" ? "Engagement data is unavailable." : null,
    ].filter((item): item is string => Boolean(item)),
  });
}

function channelPreference(facts: FeatureFacts): CustomerScore {
  const emailClicks = numberValue(facts.engagement.emailClicks90d);
  const emailOpens = numberValue(facts.engagement.emailOpens90d);
  const smsEngaged30d = numberValue(facts.engagement.smsEngaged30d);
  const emailStrength = emailClicks * 140 + emailOpens * 30;
  const smsStrength = smsEngaged30d * 170;
  const preferredChannel = smsStrength > emailStrength && smsStrength > 0
    ? "sms"
    : emailStrength > 0
      ? "email"
      : "unknown";
  const value = preferredChannel === "unknown" ? 80 : Math.max(emailStrength, smsStrength) + 260;
  const reasons = preferredChannel === "unknown"
    ? ["No local channel preference signal was found."]
    : [`${preferredChannel.toUpperCase()} has the strongest local engagement signal.`];

  return score({
    scoreName: "channel_preference",
    score: value,
    direction: "higher_is_stronger_preference",
    confidence: preferredChannel === "unknown" ? "low" : engagementConfidence(facts),
    value: {
      preferredChannel,
      emailStrength: clampScore(emailStrength),
      smsStrength: clampScore(smsStrength),
    },
    reasons,
    sourceFeatures: [
      `engagement.emailClicks90d=${emailClicks}`,
      `engagement.emailOpens90d=${emailOpens}`,
      `engagement.smsEngaged30d=${smsEngaged30d}`,
    ],
    caveats: smsEngaged30d ? [] : ["SMS engagement is only available if local receipts include SMS channel data."],
  });
}

function suppressionRisk(facts: FeatureFacts, fatigue: CustomerScore, churn: CustomerScore): CustomerScore {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  let value = 90;
  const reasons: string[] = [];
  const caveats = ["This is a suppression risk signal, not a final send/no-send decision."];
  if (daysSinceLastOrder <= 7 && booleanValue(facts.commerce.hasPurchased)) {
    value += 260;
    reasons.push("Recent buyer should be suppressed from broad promotional sends.");
  }
  if (fatigue.score >= 600) {
    value += 300;
    reasons.push("High email fatigue risk can veto marketing sends.");
  }
  if (churn.score >= 800 && facts.engagement.status !== "unavailable" && engagementStrength(facts.engagement) === 0) {
    value += 160;
    reasons.push("Very high churn risk with no engagement increases suppression caution.");
  }
  if (facts.engagement.status === "unavailable") {
    caveats.push("Engagement is unavailable, so suppression confidence is reduced instead of increasing risk from missing data alone.");
  }

  return score({
    scoreName: "suppression_risk",
    score: value,
    direction: "higher_is_more_risk",
    confidence: confidenceFromStatuses([facts.commerce.status, facts.engagement.status], "medium"),
    reasons,
    sourceFeatures: [
      `commerce.daysSinceLastOrder=${daysSinceLastOrder}`,
      `score.email_fatigue_risk=${fatigue.score}`,
      `score.churn_risk=${churn.score}`,
    ],
    caveats,
  });
}

function productAffinityScore(facts: FeatureFacts): CustomerScore {
  const productAffinity = recordValue(facts.cohort.productAffinity);
  const topProducts = recordsValue(facts.cohort.topProductsByRevenue);
  const primaryProductName = stringValue(productAffinity.primaryProductName) ?? stringValue(topProducts[0]?.name);
  const confidence = stringValue(productAffinity.confidence) as ScoreConfidence | null;
  let value = primaryProductName ? 360 : 60;
  if (topProducts.length >= 3) value += 170;
  else if (topProducts.length >= 1) value += 90;
  if (numberValue(facts.commerce.totalOrdersLifetime) >= 2) value += 120;

  return score({
    scoreName: "product_affinity",
    score: value,
    direction: "higher_is_stronger_preference",
    confidence: confidence ?? confidenceFromStatuses([facts.cohort.status], "medium"),
    value: {
      primaryProductName,
      topProductCount: topProducts.length,
      topProducts: topProducts.slice(0, 3).map((item) => ({
        productId: stringValue(item.productId),
        shopifyProductId: stringValue(item.shopifyProductId),
        name: stringValue(item.name),
        revenue: numberValue(item.revenue),
        quantity: numberValue(item.quantity),
      })),
    },
    reasons: primaryProductName
      ? ["Local order items identify a primary product affinity."]
      : ["No local product affinity could be identified."],
    sourceFeatures: [
      `cohort.productAffinity.primaryProductName=${primaryProductName ?? "unknown"}`,
      `cohort.topProductsByRevenue.count=${topProducts.length}`,
    ],
    caveats: asStringArray(facts.cohort.productEntryCohortCaveats),
  });
}

function categoryAffinityScore(facts: FeatureFacts): CustomerScore {
  const categories = recordsValue(facts.cohort.categoryAffinity);
  const primaryCategory = stringValue(topCategory(facts.cohort)?.category);
  let value = primaryCategory ? 320 : 50;
  if (categories.length >= 2) value += 120;
  if (numberValue(facts.commerce.totalOrdersLifetime) >= 2) value += 120;

  return score({
    scoreName: "category_affinity",
    score: value,
    direction: "higher_is_stronger_preference",
    confidence: primaryCategory ? confidenceFromStatuses([facts.cohort.status], "medium") : "low",
    value: {
      primaryCategory,
      categories: categories.slice(0, 3).map((item) => ({
        category: stringValue(item.category) ?? "unknown",
        revenue: numberValue(item.revenue),
        quantity: numberValue(item.quantity),
      })),
    },
    reasons: primaryCategory
      ? ["Local order items identify a primary category affinity."]
      : ["No local category affinity could be identified."],
    sourceFeatures: [`cohort.categoryAffinity.count=${categories.length}`],
    caveats: categories.length ? [] : ["Local product category data is missing or no order items exist."],
  });
}

function deliverabilityEngagementHealth(facts: FeatureFacts, fatigue: CustomerScore): CustomerScore {
  const opens90d = numberValue(facts.engagement.emailOpens90d);
  const clicks90d = numberValue(facts.engagement.emailClicks90d);
  const receiptCount = numberValue(recordValue(facts.sourceCoverage.counts).localCampaignReceipts);
  let value = facts.engagement.status === "unavailable" ? 500 : 360;
  const reasons: string[] = facts.engagement.status === "unavailable"
    ? ["Engagement health is treated as unknown/neutral because local engagement data is unavailable."]
    : [];
  if (opens90d > 0) {
    value += Math.min(220, opens90d * 35);
    reasons.push("Recent opens support engagement health.");
  }
  if (clicks90d > 0) {
    value += Math.min(260, clicks90d * 110);
    reasons.push("Recent clicks strongly support engagement health.");
  }
  if (receiptCount > 0 && opens90d === 0 && clicks90d === 0) {
    value -= 180;
    reasons.push("Local receipt history exists without recent email engagement.");
  }
  if (fatigue.score >= 600) {
    value -= 160;
    reasons.push("Email fatigue risk lowers engagement health.");
  }

  return score({
    scoreName: "deliverability_engagement_health",
    score: value,
    direction: "higher_is_healthier",
    confidence: facts.engagement.status === "unavailable" ? "low" : engagementConfidence(facts),
    reasons,
    sourceFeatures: [
      `engagement.emailOpens90d=${opens90d}`,
      `engagement.emailClicks90d=${clicks90d}`,
      `score.email_fatigue_risk=${fatigue.score}`,
    ],
    caveats: [
      "This score uses local engagement health, not mailbox provider deliverability telemetry.",
      facts.engagement.status === "unavailable" ? "Engagement data is unavailable." : null,
    ].filter((item): item is string => Boolean(item)),
  });
}

function buildScores(facts: FeatureFacts) {
  const ready = readyToBuyAgain(facts);
  const replenishment = replenishmentReadiness(facts);
  const churn = churnRisk(facts);
  const winback = winbackReadiness(facts, churn);
  const vip = vipLikelihood(facts);
  const promo = promoResponsiveness(facts);
  const fullPrice = fullPriceLikelihood(facts, promo, vip);
  const crossSell = crossSellOpportunity(facts);
  const upsell = upsellOpportunity(facts, vip);
  const secondPurchase = secondPurchaseOpportunity(facts);
  const fatigue = emailFatigueRisk(facts);
  const channel = channelPreference(facts);
  const suppression = suppressionRisk(facts, fatigue, churn);
  const product = productAffinityScore(facts);
  const category = categoryAffinityScore(facts);
  const health = deliverabilityEngagementHealth(facts, fatigue);

  return scoreMap([
    ready,
    replenishment,
    churn,
    winback,
    vip,
    promo,
    fullPrice,
    crossSell,
    upsell,
    secondPurchase,
    fatigue,
    channel,
    suppression,
    product,
    category,
    health,
  ]);
}

function scoreSummary(scores: Record<CustomerScoreName, CustomerScore>) {
  const entries = Object.values(scores);
  const opportunityNames = [
    "ready_to_buy_again",
    "replenishment_readiness",
    "winback_readiness",
    "vip_likelihood",
    "cross_sell_opportunity",
    "upsell_opportunity",
    "second_purchase_opportunity",
  ] as CustomerScoreName[];
  const riskNames = ["churn_risk", "email_fatigue_risk", "suppression_risk"] as CustomerScoreName[];
  const topOpportunities = opportunityNames
    .map((name) => scores[name])
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => ({ scoreName: entry.scoreName, score: entry.score, tier: entry.tier }));
  const elevatedRisks = riskNames
    .map((name) => scores[name])
    .filter((entry) => entry.score >= 600)
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ scoreName: entry.scoreName, score: entry.score, tier: entry.tier }));

  return {
    scoreCount: entries.length,
    scoreScale: "0_to_1000",
    tiers: countBy(entries.map((entry) => entry.tier)),
    confidenceCounts: countBy(entries.map((entry) => entry.confidence)),
    topOpportunities,
    elevatedRisks,
    multiScoreEligible: true,
    finalSegmentAssigned: false,
    campaignDecisionMade: false,
  };
}

function actionPriorityHints(facts: FeatureFacts, scores: Record<CustomerScoreName, CustomerScore>) {
  const daysSinceLastOrder = numberValue(facts.commerce.daysSinceLastOrder, 999);
  const hints = [
    {
      key: "specific_lifecycle_beats_generic_promo",
      applies: true,
      reason: "Lifecycle-specific actions should outrank generic promos when a high-confidence lifecycle score is present.",
    },
    {
      key: "replenishment_can_beat_churn_if_due_now",
      applies: scores.replenishment_readiness.score >= 700,
      reason: "A due-now replenishment action can outrank broad churn/winback messaging.",
    },
    {
      key: "recent_buyer_suppresses_broad_promos",
      applies: daysSinceLastOrder <= 7 && booleanValue(facts.commerce.hasPurchased),
      reason: "Recent buyers should avoid immediate broad promo pressure.",
    },
    {
      key: "high_fatigue_can_veto_marketing_sends",
      applies: scores.email_fatigue_risk.score >= 700 || scores.suppression_risk.score >= 700,
      reason: "High fatigue or suppression risk should veto non-essential marketing sends.",
    },
    {
      key: "protect_vip_full_price_buyers_from_heavy_discounts",
      applies: scores.vip_likelihood.score >= 600 || scores.full_price_likelihood.score >= 600,
      reason: "VIP/full-price buyers should be protected from unnecessary heavy discounts.",
    },
  ];

  return {
    hints,
    vetoes: hints.filter((hint) => hint.applies && hint.key.includes("veto")).map((hint) => hint.key),
    priorityOrder: [
      "suppression_or_fatigue_veto",
      "due_replenishment",
      "second_purchase_or_winback_lifecycle",
      "vip_full_price_protection",
      "cross_sell_or_upsell",
      "generic_promo",
    ],
    noCampaignCreated: true,
    noSegmentAssigned: true,
  };
}

function arbitrationMetadata(facts: FeatureFacts, scores: Record<CustomerScoreName, CustomerScore>) {
  return {
    purpose: "Early action arbitration hints only; full campaign arbitration is not implemented in v0.",
    customersMayQualifyForMultipleScores: true,
    suggestedPriorityScores: Object.values(scores)
      .filter((entry) => entry.score >= 600)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => ({
        scoreName: entry.scoreName,
        score: entry.score,
        tier: entry.tier,
        confidence: entry.confidence,
      })),
    guardrails: {
      noSegmentBuilder: true,
      noSegmentProfileSync: true,
      noCampaignCreation: true,
      noFlowCreation: true,
      noSendOrSchedule: true,
      externalActionTaken: false,
    },
    sourceLifecycleStage: stringValue(facts.lifecycle.lifecycleStage) ?? "unknown",
  };
}

function sourceFeatureSummary(facts: FeatureFacts) {
  const topProduct = firstTopProduct(facts.cohort);
  const primaryCategory = topCategory(facts.cohort);
  return {
    sourceFeatureStoreId: facts.record.id,
    featureVersion: facts.record.featureVersion,
    featureComputedAt: facts.record.computedAt.toISOString(),
    featureStatus: facts.record.status,
    timeframeDays: facts.record.timeframeDays,
    identityConfidence: facts.record.identityConfidence,
    commerce: {
      totalOrdersLifetime: numberValue(facts.commerce.totalOrdersLifetime),
      totalRevenueLifetime: numberValue(facts.commerce.totalRevenueLifetime),
      averageOrderValueLifetime: numberValue(facts.commerce.averageOrderValueLifetime),
      daysSinceLastOrder: facts.commerce.daysSinceLastOrder ?? null,
      orderCountBand: stringValue(facts.commerce.orderCountBand) ?? "unknown",
      ltvBand: stringValue(facts.commerce.ltvBand) ?? "unknown",
      highAovCustomer: booleanValue(facts.commerce.highAovCustomer),
    },
    lifecycle: {
      lifecycleStage: stringValue(facts.lifecycle.lifecycleStage) ?? "unknown",
      repeatBuyerStatus: stringValue(facts.lifecycle.repeatBuyerStatus) ?? "unknown",
      vipCandidateSignal: booleanValue(facts.lifecycle.vipCandidateSignal),
      replenishmentCandidateSignal: booleanValue(facts.lifecycle.replenishmentCandidateSignal),
      winbackCandidateSignal: booleanValue(facts.lifecycle.winbackCandidateSignal),
    },
    engagement: {
      status: stringValue(facts.engagement.status) ?? "unknown",
      emailOpens90d: numberValue(facts.engagement.emailOpens90d),
      emailClicks90d: numberValue(facts.engagement.emailClicks90d),
      campaignEngaged30d: numberValue(facts.engagement.campaignEngaged30d),
    },
    intent: {
      status: stringValue(facts.intent.status) ?? "unknown",
      activeOnSite30d: booleanValue(facts.intent.activeOnSite30d),
      viewedProduct30d: booleanValue(facts.intent.viewedProduct30d),
      addedToCart30d: booleanValue(facts.intent.addedToCart30d),
      startedCheckout30d: booleanValue(facts.intent.startedCheckout30d),
    },
    affinity: {
      primaryProductName: stringValue(topProduct?.name),
      primaryCategory: stringValue(primaryCategory?.category),
    },
    rawContactFieldsReturned: false,
    rawPayloadsReturned: false,
  };
}

function scoringMissingCapabilities(facts: FeatureFacts, scores: Record<CustomerScoreName, CustomerScore>) {
  return cleanList([
    ...facts.missingCapabilities,
    facts.engagement.status === "unavailable" ? "customer_scoring.engagement_signals.local_read" : null,
    facts.intent.status === "unavailable" ? "customer_scoring.intent_signals.local_read" : null,
    scores.replenishment_readiness.confidence === "low" ? "customer_scoring.replenishment.product_replenishment_days" : null,
    scores.promo_responsiveness.confidence !== "high" ? "customer_scoring.discount_sensitivity.local_redemption_signal" : null,
    scores.channel_preference.confidence === "low" ? "customer_scoring.channel_preference.local_signal" : null,
  ]);
}

function buildScoreBundle(record: FeatureRecord, now: Date): ScoreBundle {
  const facts = factsFromRecord(record);
  const scores = buildScores(facts);
  const missingCapabilities = scoringMissingCapabilities(facts, scores);
  const caveats = cleanList([
    ...facts.caveats,
    ...Object.values(scores).flatMap((entry) => entry.caveats),
    "Rule-Based Customer Scoring v0 creates deterministic local scores, not predictive ML scores.",
    "Scores are not final segments, campaigns, sends, schedules, or external profile updates.",
  ]);
  const status: CustomerScoreStatus =
    record.status === "unavailable"
      ? "unavailable"
      : missingCapabilities.length || caveats.length
        ? "partial"
        : "available";

  return {
    identityId: record.identityId,
    worklinCustomerId: record.worklinCustomerId,
    shopifyCustomerId: record.shopifyCustomerId,
    klaviyoProfileId: record.klaviyoProfileId,
    sourceFeatureStoreId: record.id,
    featureVersion: record.featureVersion,
    scoringVersion: CUSTOMER_SCORING_VERSION,
    timeframeDays: record.timeframeDays,
    computedAt: now.toISOString(),
    status,
    identityConfidence: record.identityConfidence,
    featureStatus: record.status,
    scores,
    scoreSummary: scoreSummary(scores),
    actionPriorityHints: actionPriorityHints(facts, scores),
    arbitrationMetadata: arbitrationMetadata(facts, scores),
    sourceFeatureSummary: sourceFeatureSummary(facts),
    sourceCoverage: {
      ...facts.sourceCoverage,
      scoringSource: "customer_feature_store_v0",
      scoringReadOnly: true,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/scores/compute",
      scoringVersion: CUSTOMER_SCORING_VERSION,
      featureVersion: record.featureVersion,
      scoreScale: "0_to_1000",
      scoreNames: CUSTOMER_SCORE_NAMES,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      shopifyWritesAllowed: false,
      klaviyoWritesAllowed: false,
      segmentDefinitionCreated: false,
      segmentProfileSyncPerformed: false,
      campaignCreated: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
    },
  };
}

async function persistScoreBundle(bundle: ScoreBundle) {
  return prisma.customerScoreStore.upsert({
    where: {
      identityId_timeframeDays_scoringVersion: {
        identityId: bundle.identityId,
        timeframeDays: bundle.timeframeDays,
        scoringVersion: bundle.scoringVersion,
      },
    },
    create: {
      identityId: bundle.identityId,
      worklinCustomerId: bundle.worklinCustomerId,
      shopifyCustomerId: bundle.shopifyCustomerId,
      klaviyoProfileId: bundle.klaviyoProfileId,
      sourceFeatureStoreId: bundle.sourceFeatureStoreId,
      featureVersion: bundle.featureVersion,
      scoringVersion: bundle.scoringVersion,
      timeframeDays: bundle.timeframeDays,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      identityConfidence: bundle.identityConfidence,
      featureStatus: bundle.featureStatus,
      scores: asJson(bundle.scores),
      scoreSummary: asJson(bundle.scoreSummary),
      actionPriorityHints: asJson(bundle.actionPriorityHints),
      arbitrationMetadata: asJson(bundle.arbitrationMetadata),
      sourceFeatureSummary: asJson(bundle.sourceFeatureSummary),
      sourceCoverage: asJson(bundle.sourceCoverage),
      missingCapabilities: asJson(bundle.missingCapabilities),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
    update: {
      worklinCustomerId: bundle.worklinCustomerId,
      shopifyCustomerId: bundle.shopifyCustomerId,
      klaviyoProfileId: bundle.klaviyoProfileId,
      sourceFeatureStoreId: bundle.sourceFeatureStoreId,
      featureVersion: bundle.featureVersion,
      computedAt: new Date(bundle.computedAt),
      status: bundle.status,
      identityConfidence: bundle.identityConfidence,
      featureStatus: bundle.featureStatus,
      scores: asJson(bundle.scores),
      scoreSummary: asJson(bundle.scoreSummary),
      actionPriorityHints: asJson(bundle.actionPriorityHints),
      arbitrationMetadata: asJson(bundle.arbitrationMetadata),
      sourceFeatureSummary: asJson(bundle.sourceFeatureSummary),
      sourceCoverage: asJson(bundle.sourceCoverage),
      missingCapabilities: asJson(bundle.missingCapabilities),
      caveats: asJson(bundle.caveats),
      metadata: asJson(bundle.metadata),
    },
  });
}

function compactScoreBundle(bundle: ScoreBundle) {
  return {
    identityId: bundle.identityId,
    worklinCustomerId: bundle.worklinCustomerId,
    shopifyCustomerId: bundle.shopifyCustomerId,
    klaviyoProfileId: bundle.klaviyoProfileId,
    sourceFeatureStoreId: bundle.sourceFeatureStoreId,
    featureVersion: bundle.featureVersion,
    scoringVersion: bundle.scoringVersion,
    timeframeDays: bundle.timeframeDays,
    computedAt: bundle.computedAt,
    status: bundle.status,
    identityConfidence: bundle.identityConfidence,
    featureStatus: bundle.featureStatus,
    scores: bundle.scores,
    scoreSummary: bundle.scoreSummary,
    actionPriorityHints: bundle.actionPriorityHints,
    arbitrationMetadata: bundle.arbitrationMetadata,
    sourceFeatureSummary: bundle.sourceFeatureSummary,
    sourceCoverage: bundle.sourceCoverage,
    missingCapabilities: bundle.missingCapabilities,
    caveats: bundle.caveats,
    metadata: bundle.metadata,
    ...(bundle.persistedRecordId ? { persistedRecordId: bundle.persistedRecordId } : {}),
  };
}

function compactStoredScore(record: Awaited<ReturnType<typeof prisma.customerScoreStore.findMany>>[number]) {
  return {
    id: record.id,
    identityId: record.identityId,
    worklinCustomerId: record.worklinCustomerId,
    shopifyCustomerId: record.shopifyCustomerId,
    klaviyoProfileId: record.klaviyoProfileId,
    sourceFeatureStoreId: record.sourceFeatureStoreId,
    featureVersion: record.featureVersion,
    scoringVersion: record.scoringVersion,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: record.status,
    identityConfidence: record.identityConfidence,
    featureStatus: record.featureStatus,
    scores: record.scores,
    scoreSummary: record.scoreSummary,
    actionPriorityHints: record.actionPriorityHints,
    arbitrationMetadata: record.arbitrationMetadata,
    sourceFeatureSummary: record.sourceFeatureSummary,
    sourceCoverage: record.sourceCoverage,
    missingCapabilities: record.missingCapabilities,
    caveats: record.caveats,
    metadata: {
      scoringVersion: record.scoringVersion,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function computeCustomerScores(input: CustomerScoreComputeInput = {}) {
  const parsed = parseCustomerScoreComputeInput(input);
  if (!parsed.ok) return parsed;

  const now = new Date();
  const where: Prisma.CustomerFeatureStoreWhereInput = {
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    ...(parsed.data.identityId ? { identityId: parsed.data.identityId } : {}),
  };
  const featureRecords = await prisma.customerFeatureStore.findMany({
    where,
    orderBy: { computedAt: "desc" },
    take: parsed.data.limit,
  });

  if (parsed.data.identityId && !featureRecords.length) {
    return {
      ok: false as const,
      reason: "customer_score_identity_feature_not_found",
      issues: ["identityId has no persisted Customer Feature Store record for this timeframe. Compute feature store records first."],
      status: 404,
    };
  }

  const bundles = featureRecords.map((record) => buildScoreBundle(record, now));
  const persisted = parsed.data.persist
    ? await Promise.all(bundles.map(persistScoreBundle))
    : [];
  const persistedByIdentity = new Map(persisted.map((record) => [record.identityId, record]));
  const outputScores = bundles.map((bundle) => {
    const persistedRecord = persistedByIdentity.get(bundle.identityId);
    return compactScoreBundle({
      ...bundle,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });
  const missingCapabilities = cleanList([
    ...bundles.flatMap((bundle) => bundle.missingCapabilities),
    bundles.length ? null : "customer_feature_store.persisted_records",
  ]);
  const caveats = cleanList([
    ...bundles.flatMap((bundle) => bundle.caveats),
    bundles.length ? null : "No persisted Customer Feature Store records were available to score.",
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    scoringVersion: CUSTOMER_SCORING_VERSION,
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    computedAt: now.toISOString(),
    persisted: parsed.data.persist,
    summary: {
      featureRecordsRequested: parsed.data.identityId ? 1 : parsed.data.limit,
      featureRecordsMatched: featureRecords.length,
      scoreRecordsComputed: bundles.length,
      scoreRecordsPersisted: persisted.length,
      scoreNames: CUSTOMER_SCORE_NAMES,
      statusCounts: countBy(bundles.map((bundle) => bundle.status)),
    },
    scores: outputScores,
    sourceStatuses: [
      {
        source: "customer_feature_store",
        status: featureRecords.length ? "available" : "unavailable",
        rowsAnalyzed: featureRecords.length,
        readOnly: true,
      },
      {
        source: "rule_based_customer_scoring",
        status: bundles.length ? "available" : "unavailable",
        persistedCount: persisted.length,
        readOnlyExternally: true,
      },
    ],
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/scores/compute",
      scoringVersion: CUSTOMER_SCORING_VERSION,
      limit: parsed.data.limit,
      identityIdProvided: Boolean(parsed.data.identityId),
      persist: parsed.data.persist,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      shopifyWritesAllowed: false,
      klaviyoWritesAllowed: false,
      segmentDefinitionCreated: false,
      segmentProfileSyncPerformed: false,
      campaignCreated: false,
      flowCreated: false,
      sendOrScheduleCreated: false,
    },
  };
}

export async function listCustomerScores(input: CustomerScoreListInput = {}) {
  const parsed = parseCustomerScoreListInput(input);
  if (!parsed.ok) return parsed;

  const where: Prisma.CustomerScoreStoreWhereInput = {
    ...(parsed.data.identityId ? { identityId: parsed.data.identityId } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    scoringVersion: CUSTOMER_SCORING_VERSION,
  };
  const [total, records] = await Promise.all([
    prisma.customerScoreStore.count({ where }),
    prisma.customerScoreStore.findMany({
      where,
      orderBy: { computedAt: "desc" },
      take: parsed.data.limit,
    }),
  ]);

  return {
    ok: true as const,
    readOnly: true,
    scoringVersion: CUSTOMER_SCORING_VERSION,
    summary: {
      totalMatchingRecords: total,
      returnedRecords: records.length,
      statusCounts: countBy(records.map((record) => record.status)),
    },
    scores: records.map(compactStoredScore),
    metadata: {
      route: "GET /api/customers/scores",
      limit: parsed.data.limit,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function getCustomerScoreRecord(identityId: string, input: Omit<CustomerScoreListInput, "identityId"> = {}) {
  const parsed = parseCustomerScoreListInput({ ...input, identityId, limit: 1 });
  if (!parsed.ok) return parsed;

  const record = await prisma.customerScoreStore.findFirst({
    where: {
      identityId,
      ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
      scoringVersion: CUSTOMER_SCORING_VERSION,
    },
    orderBy: { computedAt: "desc" },
  });

  if (!record) {
    return {
      ok: false as const,
      reason: "customer_score_record_not_found",
      issues: ["No persisted customer score record was found for this identityId."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    scoringVersion: CUSTOMER_SCORING_VERSION,
    score: compactStoredScore(record),
    metadata: {
      route: "GET /api/customers/scores/[identityId]",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function customerScoringContextSummary() {
  const [total, latest, byStatus] = await Promise.all([
    prisma.customerScoreStore.count({
      where: { scoringVersion: CUSTOMER_SCORING_VERSION },
    }),
    prisma.customerScoreStore.findFirst({
      where: { scoringVersion: CUSTOMER_SCORING_VERSION },
      orderBy: { computedAt: "desc" },
      select: {
        computedAt: true,
        timeframeDays: true,
        status: true,
        scoreSummary: true,
        missingCapabilities: true,
        caveats: true,
      },
    }),
    prisma.customerScoreStore.groupBy({
      by: ["status"],
      where: { scoringVersion: CUSTOMER_SCORING_VERSION },
      _count: { status: true },
    }),
  ]);

  const summary = recordValue(latest?.scoreSummary);
  return {
    available: total > 0,
    status: !total ? "unavailable" : latest?.status ?? "partial",
    route: "/api/customers/scores",
    computeRoute: "/api/customers/scores/compute",
    scoringVersion: CUSTOMER_SCORING_VERSION,
    sourceFeatureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    totalRecords: total,
    latestComputedAt: latest?.computedAt.toISOString() ?? null,
    latestTimeframeDays: latest?.timeframeDays ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count.status])),
    scoreNames: CUSTOMER_SCORE_NAMES,
    latestTopOpportunities: Array.isArray(summary.topOpportunities)
      ? summary.topOpportunities.slice(0, 5)
      : [],
    latestElevatedRisks: Array.isArray(summary.elevatedRisks)
      ? summary.elevatedRisks.slice(0, 5)
      : [],
    missingCapabilities: Array.isArray(latest?.missingCapabilities)
      ? latest.missingCapabilities.slice(0, 8)
      : [],
    caveats: Array.isArray(latest?.caveats)
      ? latest.caveats.slice(0, 4)
      : total
        ? []
        : ["Rule-Based Customer Scoring has not been computed yet."],
    externalActionTaken: false,
    rawContactFieldsReturned: false,
  };
}
