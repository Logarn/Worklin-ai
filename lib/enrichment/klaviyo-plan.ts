import { z } from "zod";
import {
  buildShopifySourceSnapshot,
  SHOPIFY_SOURCE_SNAPSHOT_DEPTHS,
  SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES,
  type ShopifySourceSnapshotDepth,
  type ShopifySourceSnapshotTimeframeDays,
} from "@/lib/sources/shopify-snapshot";

const planInputSchema = z
  .object({
    shopifySnapshotDepth: z.enum(SHOPIFY_SOURCE_SNAPSHOT_DEPTHS).optional().default("compact"),
    timeframeDays: z.union([
      z.literal(30),
      z.literal(60),
      z.literal(90),
      z.string(),
    ]).optional().default(60),
    includeSegments: z.boolean().optional().default(true),
    includeFlowUseCases: z.boolean().optional().default(true),
    includeCampaignUseCases: z.boolean().optional().default(true),
  })
  .strict();

type ParsedPlanInput =
  | {
      ok: true;
      data: {
        shopifySnapshotDepth: ShopifySourceSnapshotDepth;
        timeframeDays: ShopifySourceSnapshotTimeframeDays;
        includeSegments: boolean;
        includeFlowUseCases: boolean;
        includeCampaignUseCases: boolean;
      };
    }
  | { ok: false; issues: string[] };

type RecordValue = Record<string, unknown>;

const PLAN_SOURCE = "Shopify Commerce + Cohort Snapshot";
const FUTURE_INTELLIGENCE_LAYER_CAVEAT =
  "This enrichment plan is not the full intelligence layer; Customer Feature Store and Rule-Based Customer Scoring are still needed before reliable ongoing sync/autonomy.";

const PROPERTY_LABELS: Record<string, string> = {
  worklin_ltv_band: "Worklin LTV Band",
  worklin_order_count_band: "Worklin Order Count Band",
  worklin_first_purchase_cohort: "Worklin First Purchase Cohort",
  worklin_first_product_cohort: "Worklin First Product Cohort",
  worklin_repeat_buyer_status: "Worklin Repeat Buyer Status",
  worklin_vip_candidate: "Worklin VIP Candidate",
  worklin_replenishment_candidate: "Worklin Replenishment Candidate",
  worklin_high_aov_customer: "Worklin High AOV Customer",
  worklin_churn_risk: "Worklin Churn Risk",
};

const PROPERTY_SECTION: Record<string, string> = {
  worklin_ltv_band: "lifetimeCustomerValue",
  worklin_order_count_band: "lifetimeCustomerValue",
  worklin_first_purchase_cohort: "firstPurchaseCohorts",
  worklin_first_product_cohort: "productEntryCohorts",
  worklin_repeat_buyer_status: "lifetimeCustomerValue",
  worklin_vip_candidate: "lifetimeCustomerValue",
  worklin_replenishment_candidate: "productPerformance",
  worklin_high_aov_customer: "lifetimeCustomerValue",
  worklin_churn_risk: "lifecycleSignals",
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, max = 160) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function cleanStringArray(value: unknown, maxItems = 12) {
  return Array.isArray(value)
    ? value.map((item) => cleanString(item, 140)).filter((item): item is string => Boolean(item)).slice(0, maxItems)
    : [];
}

function asRecordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseTimeframeDays(value: unknown): ShopifySourceSnapshotTimeframeDays | null {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES.includes(parsed as ShopifySourceSnapshotTimeframeDays)
    ? (parsed as ShopifySourceSnapshotTimeframeDays)
    : null;
}

export function parseKlaviyoEnrichmentPlanInput(body: unknown): ParsedPlanInput {
  const parsed = planInputSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }

  const timeframeDays = parseTimeframeDays(parsed.data.timeframeDays);
  if (!timeframeDays) {
    return { ok: false, issues: ["timeframeDays must be one of 30, 60, or 90."] };
  }

  return {
    ok: true,
    data: {
      shopifySnapshotDepth: parsed.data.shopifySnapshotDepth,
      timeframeDays,
      includeSegments: parsed.data.includeSegments,
      includeFlowUseCases: parsed.data.includeFlowUseCases,
      includeCampaignUseCases: parsed.data.includeCampaignUseCases,
    },
  };
}

function possibleValuesFor(property: string, snapshot: RecordValue) {
  const lifecycle = isRecord(snapshot.lifecycleSignals) ? snapshot.lifecycleSignals : {};
  const lifetime = isRecord(snapshot.lifetimeCustomerValue) ? snapshot.lifetimeCustomerValue : {};
  const firstPurchase = isRecord(snapshot.firstPurchaseCohorts) ? snapshot.firstPurchaseCohorts : {};
  const productEntry = isRecord(snapshot.productEntryCohorts) ? snapshot.productEntryCohorts : {};
  const firstPurchaseCohorts = asRecordArray(firstPurchase.cohorts)
    .map((cohort) => cleanString(cohort.cohort, 80))
    .filter((cohort): cohort is string => Boolean(cohort));
  const firstProducts = asRecordArray(productEntry.cohorts)
    .map((cohort) => cleanString(cohort.firstProduct, 120))
    .filter((product): product is string => Boolean(product));

  switch (property) {
    case "worklin_ltv_band":
      return Object.keys(isRecord(lifetime.valueBands) && isRecord(lifetime.valueBands.counts)
        ? lifetime.valueBands.counts
        : { low: true, mid: true, high: true, vip: true });
    case "worklin_order_count_band":
      return Object.keys(isRecord(lifetime.orderCountBands)
        ? lifetime.orderCountBands
        : { one: true, two: true, threeToFour: true, fivePlus: true });
    case "worklin_first_purchase_cohort":
      return firstPurchaseCohorts.length ? firstPurchaseCohorts : ["YYYY-MM"];
    case "worklin_first_product_cohort":
      return firstProducts.length ? firstProducts : ["Product name"];
    case "worklin_repeat_buyer_status":
      return ["one_time_buyer", "repeat_buyer"];
    case "worklin_vip_candidate":
      return [true, false];
    case "worklin_replenishment_candidate":
      return [true, false];
    case "worklin_high_aov_customer":
      return [true, false];
    case "worklin_churn_risk":
      return [
        (Number(lifecycle.winbackCandidates) || 0) > 0 ? "at_risk" : "not_enough_signal",
        "not_at_risk",
      ];
    default:
      return [];
  }
}

function confidenceFor(property: string, snapshot: RecordValue, caveatedSections: string[]) {
  const section = PROPERTY_SECTION[property];
  const sectionRecord = isRecord(snapshot[section]) ? snapshot[section] : {};
  const sectionStatus = cleanString(sectionRecord.status, 80);
  if (!sectionStatus || sectionStatus === "unavailable" || sectionStatus === "insufficient_data") return "low";
  if (sectionStatus === "directional" || caveatedSections.includes(section)) return "directional";
  return "medium_local_data";
}

function unlockedUseCasesFor(property: string) {
  const map: Record<string, string[]> = {
    worklin_ltv_band: ["VIP campaigns", "value-tier nurture", "winback priority"],
    worklin_order_count_band: ["first-to-second purchase campaigns", "repeat buyer targeting"],
    worklin_first_purchase_cohort: ["cohort reporting", "acquisition-month retention readouts"],
    worklin_first_product_cohort: ["entry-product cross-sell", "product education branches"],
    worklin_repeat_buyer_status: ["repeat buyer campaigns", "one-time buyer conversion flows"],
    worklin_vip_candidate: ["VIP treatment", "premium early-access campaigns"],
    worklin_replenishment_candidate: ["replenishment reminders", "post-purchase timing tests"],
    worklin_high_aov_customer: ["bundle/premium product targeting", "high-value lookalike strategy"],
    worklin_churn_risk: ["winback planning", "suppression from broad promos when risky"],
  };
  return map[property] ?? [];
}

function recommendedProperties(input: {
  snapshot: RecordValue;
  candidates: RecordValue[];
  caveatedSections: string[];
}) {
  return input.candidates.map((candidate) => {
    const property = cleanString(candidate.property, 120) ?? "worklin_unknown_property";
    const sourceFields = cleanStringArray(candidate.sourceFields, 12);
    return {
      property,
      label: PROPERTY_LABELS[property] ?? property,
      definition: cleanString(candidate.definition, 260) ?? cleanString(candidate.use, 260) ?? "Worklin profile enrichment definition.",
      source: PLAN_SOURCE,
      sourceData: {
        source: cleanString(candidate.source, 120) ?? "shopify_local_snapshot_data",
        sourceFields,
        snapshotSection: PROPERTY_SECTION[property] ?? "klaviyoEnrichmentCandidates",
        snapshotReadMethod: "local_data",
      },
      possibleValues: possibleValuesFor(property, input.snapshot),
      confidence: confidenceFor(property, input.snapshot, input.caveatedSections),
      whyItMatters: cleanString(candidate.use, 260) ?? "Creates reusable targeting and reporting context after future approved sync.",
      unlockedUseCases: unlockedUseCasesFor(property),
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
      syncStatus: "not_synced",
      externalActionTaken: false,
      status: "definition_only",
      caveats: [
        "Property is proposed only; no Klaviyo profile property was written or synced.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    };
  });
}

function segmentDefinition(input: {
  name: string;
  description: string;
  rules: Array<Record<string, unknown>>;
  sourceProperties: string[];
  campaignUseCases: string[];
  flowUseCases: string[];
  suppressionUseCases: string[];
}) {
  return {
    ...input,
    source: PLAN_SOURCE,
    confidence: "definition_only_local_data",
    syncStatus: "not_synced",
    status: "definition_only",
    requiresCapability: "klaviyo.segment.create",
    prerequisiteCapability: "klaviyo.profile.write",
    approvalRequired: true,
    externalActionTaken: false,
    canGoLiveNow: false,
    caveats: [
      "Segment is a definition only; no Klaviyo segment was created.",
      "Segment membership should be estimated by Customer Feature Store / Segment Builder before any future sync.",
      FUTURE_INTELLIGENCE_LAYER_CAVEAT,
    ],
  };
}

function recommendedSegments(input: {
  snapshot: RecordValue;
  includeSegments: boolean;
  includeCampaignUseCases: boolean;
  includeFlowUseCases: boolean;
}) {
  if (!input.includeSegments) return [];
  const productEntry = isRecord(input.snapshot.productEntryCohorts) ? input.snapshot.productEntryCohorts : {};
  const firstProducts = asRecordArray(productEntry.cohorts)
    .map((cohort) => cleanString(cohort.firstProduct, 80))
    .filter((product): product is string => Boolean(product))
    .slice(0, 3);

  const campaign = input.includeCampaignUseCases;
  const flow = input.includeFlowUseCases;
  const base = [
    segmentDefinition({
      name: "Worklin - VIP Candidates",
      description: "Customers with high value or VIP candidate signals from local Shopify commerce data.",
      rules: [
        { property: "worklin_vip_candidate", operator: "equals", value: true },
        { property: "worklin_ltv_band", operator: "equals_any", value: ["high", "vip"] },
      ],
      sourceProperties: ["worklin_vip_candidate", "worklin_ltv_band"],
      campaignUseCases: campaign ? ["premium launches", "early access", "VIP retention offers"] : [],
      flowUseCases: flow ? ["VIP thank-you branch", "high-value replenishment branch"] : [],
      suppressionUseCases: ["Exclude from generic discount-heavy winback unless strategy approves."],
    }),
    segmentDefinition({
      name: "Worklin - High AOV One-Time Buyers",
      description: "One-time buyers with high average order value who may deserve a careful second-purchase path.",
      rules: [
        { property: "worklin_high_aov_customer", operator: "equals", value: true },
        { property: "worklin_order_count_band", operator: "equals", value: "one" },
      ],
      sourceProperties: ["worklin_high_aov_customer", "worklin_order_count_band"],
      campaignUseCases: campaign ? ["second-purchase education", "bundle cross-sell"] : [],
      flowUseCases: flow ? ["premium post-purchase follow-up", "second order nurture"] : [],
      suppressionUseCases: ["Avoid broad first-time-buyer discount logic until offer strategy is set."],
    }),
    segmentDefinition({
      name: "Worklin - Repeat Buyers",
      description: "Customers who have purchased more than once.",
      rules: [{ property: "worklin_repeat_buyer_status", operator: "equals", value: "repeat_buyer" }],
      sourceProperties: ["worklin_repeat_buyer_status", "worklin_order_count_band"],
      campaignUseCases: campaign ? ["loyal customer campaigns", "product expansion campaigns"] : [],
      flowUseCases: flow ? ["repeat buyer lifecycle branch"] : [],
      suppressionUseCases: ["Suppress from first-purchase conversion messaging."],
    }),
    segmentDefinition({
      name: "Worklin - Replenishment Candidates",
      description: "Customers likely to benefit from replenishment timing once profile enrichment is approved.",
      rules: [{ property: "worklin_replenishment_candidate", operator: "equals", value: true }],
      sourceProperties: ["worklin_replenishment_candidate", "worklin_first_product_cohort"],
      campaignUseCases: campaign ? ["replenishment reminders", "consumable product replenishment campaigns"] : [],
      flowUseCases: flow ? ["replenishment flow branch", "post-purchase product timing branch"] : [],
      suppressionUseCases: ["Suppress from unrelated one-off promos during replenishment window tests."],
    }),
    segmentDefinition({
      name: "Worklin - Churn Risk / Winback Candidates",
      description: "Customers with churn-risk or recency signals that can support winback planning.",
      rules: [{ property: "worklin_churn_risk", operator: "equals_any", value: ["at_risk", true] }],
      sourceProperties: ["worklin_churn_risk", "worklin_repeat_buyer_status"],
      campaignUseCases: campaign ? ["winback campaigns", "reactivation campaigns"] : [],
      flowUseCases: flow ? ["winback flow branch"] : [],
      suppressionUseCases: ["Suppress from aggressive sends if deliverability or fatigue risk is high."],
    }),
  ];

  const productSegments = firstProducts.map((product) =>
    segmentDefinition({
      name: `Worklin - First Product Cohort: ${product}`,
      description: `Customers whose first local Shopify order appears to enter through ${product}.`,
      rules: [{ property: "worklin_first_product_cohort", operator: "equals", value: product }],
      sourceProperties: ["worklin_first_product_cohort"],
      campaignUseCases: campaign ? ["entry-product education", "cross-sell campaigns"] : [],
      flowUseCases: flow ? ["entry-product post-purchase branch"] : [],
      suppressionUseCases: ["Treat as directional when cohort size is below threshold."],
    }),
  );

  return [...base, ...productSegments];
}

function campaignUseCases(enabled: boolean) {
  if (!enabled) return [];
  return [
    {
      name: "VIP / high-value retention campaign",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_vip_candidate", "worklin_ltv_band"],
      segmentExamples: ["Worklin - VIP Candidates"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      additionalRequiredCapabilities: ["klaviyo.segment.create"],
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [FUTURE_INTELLIGENCE_LAYER_CAVEAT],
    },
    {
      name: "Second-purchase conversion campaign",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_order_count_band", "worklin_high_aov_customer", "worklin_first_product_cohort"],
      segmentExamples: ["Worklin - High AOV One-Time Buyers"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      additionalRequiredCapabilities: ["klaviyo.segment.create"],
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [FUTURE_INTELLIGENCE_LAYER_CAVEAT],
    },
    {
      name: "Entry-product cross-sell campaign",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_first_product_cohort", "worklin_repeat_buyer_status"],
      segmentExamples: ["Worklin - First Product Cohort: [Product]"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      additionalRequiredCapabilities: ["klaviyo.segment.create"],
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [FUTURE_INTELLIGENCE_LAYER_CAVEAT],
    },
  ];
}

function flowUseCases(enabled: boolean) {
  if (!enabled) return [];
  return [
    {
      name: "Post-purchase path by first product",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_first_product_cohort", "worklin_order_count_band"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Flow use case is a planning hint only; no Klaviyo flow was created or changed.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
    {
      name: "Replenishment branch",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_replenishment_candidate"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Flow use case is a planning hint only; no Klaviyo flow was created or changed.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
    {
      name: "Winback branch",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_churn_risk", "worklin_repeat_buyer_status"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Flow use case is a planning hint only; no Klaviyo flow was created or changed.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
  ];
}

function suppressionUseCases() {
  return [
    {
      name: "Suppress VIPs from generic discount sends",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_vip_candidate", "worklin_ltv_band"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Suppression use case is a planning hint only; no Klaviyo suppression segment was created.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
    {
      name: "Suppress repeat buyers from first-purchase education",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_repeat_buyer_status"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Suppression use case is a planning hint only; no Klaviyo suppression segment was created.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
    {
      name: "Throttle churn-risk cohorts until winback strategy is approved",
      source: PLAN_SOURCE,
      sourceProperties: ["worklin_churn_risk"],
      syncStatus: "not_synced",
      externalActionTaken: false,
      approvalRequired: true,
      requiresCapability: "klaviyo.profile.write",
      confidence: "definition_only_local_data",
      status: "definition_only",
      caveats: [
        "Suppression use case is a planning hint only; no Klaviyo suppression segment was created.",
        FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      ],
    },
  ];
}

function planRisks(input: { snapshotData: RecordValue; recommendedSegmentsCount: number }) {
  const caveats = cleanStringArray(input.snapshotData.caveats, 12);
  return [
    {
      risk: "local_data_only",
      severity: "medium",
      mitigation: "Treat the plan as prepare-only until live source health checks and future sync gates are approved.",
    },
    {
      risk: "small_or_directional_cohorts",
      severity: caveats.some((item) => item.includes("directional")) ? "medium" : "low",
      mitigation: "Do not over-personalize tiny cohorts; keep minimum useful cohort size visible.",
    },
    {
      risk: "segment_volume_unknown",
      severity: input.recommendedSegmentsCount ? "medium" : "low",
      mitigation: "Estimate segment volumes before any future Klaviyo segment creation.",
    },
  ];
}

export async function buildKlaviyoEnrichmentPlan(body: unknown) {
  const parsed = parseKlaviyoEnrichmentPlanInput(body);
  if (!parsed.ok) return parsed;

  const snapshotResult = await buildShopifySourceSnapshot({
    depth: parsed.data.shopifySnapshotDepth,
    timeframeDays: parsed.data.timeframeDays,
    includeCohorts: true,
  });
  if (!snapshotResult.ok) return { ok: false as const, issues: snapshotResult.issues };

  const snapshotData = snapshotResult.data as RecordValue;
  const snapshot = isRecord(snapshotData.snapshot) ? snapshotData.snapshot : {};
  const enrichment = isRecord(snapshot.klaviyoEnrichmentCandidates) ? snapshot.klaviyoEnrichmentCandidates : {};
  const candidates = asRecordArray(enrichment.labels);
  const caveatedSections = cleanStringArray(snapshotData.caveatedSections, 20);
  const properties = recommendedProperties({ snapshot, candidates, caveatedSections });
  const segments = recommendedSegments({
    snapshot,
    includeSegments: parsed.data.includeSegments,
    includeCampaignUseCases: parsed.data.includeCampaignUseCases,
    includeFlowUseCases: parsed.data.includeFlowUseCases,
  });
  const generatedAt = new Date().toISOString();
  const caveats = [
    "Definition/planning only; no Klaviyo profile properties, segments, flows, or campaigns were created.",
    "Plan is based on local Shopify snapshot data, not live Shopify API reads.",
    "Future sync requires durable approval and Tool Runtime capabilities.",
    FUTURE_INTELLIGENCE_LAYER_CAVEAT,
    ...cleanStringArray(snapshotData.caveats, 10),
  ];

  const response = {
    ok: true as const,
    readOnly: true,
    syncPerformed: false,
    externalActionTaken: false,
    canGoLiveNow: false,
    plan: {
      architectureBoundary: {
        layer: "definition_planning_layer",
        isFullIntelligenceLayer: false,
        stillNeededBeforeAutonomy: [
          "Customer Feature Store v0",
          "Rule-Based Customer Scoring v0",
          "Segment Definition Builder v0",
          "Segment/Profile Sync v0",
        ],
        caveat: FUTURE_INTELLIGENCE_LAYER_CAVEAT,
      },
      recommendedProperties: properties,
      recommendedSegments: segments,
      campaignUseCases: campaignUseCases(parsed.data.includeCampaignUseCases),
      flowUseCases: flowUseCases(parsed.data.includeFlowUseCases),
      suppressionUseCases: suppressionUseCases(),
      refreshPolicy: {
        status: "definition_only",
        recommendedCadence: "after_shopify_sync_or_weekly",
        source: "shopify_snapshot",
        refreshBeforeSync: true,
        reason: "Cohort and value bands can drift as new orders arrive.",
      },
      approvalPackage: {
        title: "Commerce cohort to Klaviyo enrichment plan",
        status: "approval_ready_definition_only",
        requestedDecision:
          "Approve these Klaviyo property and segment definitions for future implementation planning only; do not approve profile sync, segment creation, sends, schedules, or go-live execution in this plan.",
        approvalRequired: true,
        requestedFutureCapabilities: ["klaviyo.profile.write", "klaviyo.segment.create"],
        missingCapabilities: [
          "Customer Feature Store v0",
          "Rule-Based Customer Scoring v0",
          "Segment Definition Builder v0",
          "Segment/Profile Sync v0",
          "Tool Runtime approval-gated Klaviyo profile writes",
          "Tool Runtime approval-gated Klaviyo segment creation",
        ],
        externalActionTaken: false,
        canGoLiveNow: false,
        syncPerformed: false,
        approvalScope: [
          "approve profile property definitions",
          "approve segment definitions",
          "approve future sync behavior only after Segment/Profile Sync is implemented",
        ],
      },
      risks: planRisks({ snapshotData, recommendedSegmentsCount: segments.length }),
      caveats,
    },
    metadata: {
      route: "POST /api/enrichment/klaviyo/plan",
      generatedAt,
      input: parsed.data,
      shopifySnapshot: {
        depth: snapshotData.depth,
        timeframeDays: snapshotData.timeframeDays,
        snapshotReadStatus: snapshotData.snapshotReadStatus,
        snapshotReadMethod: snapshotData.snapshotReadMethod,
        snapshotAvailability: snapshotData.snapshotAvailability,
        connectorVerificationStatus: isRecord(snapshot.connector) ? snapshot.connector.verificationStatus : null,
        connectorVerificationMethod: isRecord(snapshot.connector) ? snapshot.connector.verificationMethod : null,
        computedSections: cleanStringArray(snapshotData.computedSections, 20),
        caveatedSections,
        dataCoverage: isRecord(snapshotData.metadata) ? snapshotData.metadata.dataCoverage ?? null : null,
      },
      sourceHelpersUsed: ["buildShopifySourceSnapshot"],
      writeRoutesCalled: [],
      syncRoutesCalled: [],
      liveExternalActionsAttempted: false,
      omittedDataClasses: [
        "customer contact fields",
        "raw customer rows",
        "raw order rows",
        "full workflow request bodies",
        "full workflow result bodies",
      ],
      sizeBytes: 0,
    },
  };

  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  return { ok: true as const, data: response };
}
