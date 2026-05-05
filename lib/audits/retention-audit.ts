import {
  collectAuditChartHints,
  createAuditInsight,
  createChartHint,
  rankAuditInsights,
  summarizeAuditInsights,
} from "@/lib/audits/insights";
import type {
  AuditCaveat,
  AuditChartHint,
  AuditConfidence,
  AuditDomain,
  AuditEvidence,
  AuditInsight,
  AuditSeverity,
} from "@/lib/audits/types";
import {
  auditKlaviyoCampaigns,
  type CampaignAuditOutput,
} from "@/lib/campaigns/audit-campaigns";
import {
  auditKlaviyoFlows,
  type FlowAuditOutput,
} from "@/lib/flows/audit-flow";
import {
  getKlaviyoCampaignConfig,
  KlaviyoCampaignApiError,
} from "@/lib/klaviyo-campaigns";
import {
  getKlaviyoFlowConfig,
  KlaviyoFlowApiError,
} from "@/lib/klaviyo-flows";
import {
  discoverKlaviyoConversionMetrics,
  type KlaviyoMetricDiscoveryResult,
} from "@/lib/klaviyo/metric-discovery";
import {
  getKlaviyoMetricConfig,
  KlaviyoMetricApiError,
} from "@/lib/klaviyo-metrics";
import type { KlaviyoPerformanceTimeframe } from "@/lib/klaviyo-performance";
import {
  getProductPerformanceIntelligence,
  type ProductPerformanceIntelligenceResult,
} from "@/lib/products/product-performance-intelligence";
import {
  auditSegments,
  type SegmentAuditInput,
  type SegmentAuditOutput,
  type SegmentAuditTimeframe,
} from "@/lib/segments/audit-segments";

export type RetentionAuditInput = {
  timeframe?: "last_30_days" | "last_90_days" | "last_180_days" | "last_365_days" | "lifetime" | "custom" | null;
  startDate?: string | null;
  endDate?: string | null;
  includeProduct?: boolean;
  includeCampaign?: boolean;
  includeCampaigns?: boolean;
  includeFlow?: boolean;
  includeFlows?: boolean;
  includeAudience?: boolean;
  includeAudiences?: boolean;
  includeMetricDiscovery?: boolean;
  limit?: number | null;
  productLimit?: number | null;
  campaignLimit?: number | null;
  flowLimit?: number | null;
  audienceLimit?: number | null;
  metricLimit?: number | null;
};

export type RetentionDomainKey =
  | "product"
  | "campaign"
  | "flow"
  | "audience"
  | "performance"
  | "lifecycle";

export type RetentionSourceStatus = {
  status: "ok" | "partial" | "skipped" | "unavailable" | "failed";
  readOnly: true;
  summary: Record<string, string | number | boolean | null>;
  caveats: AuditCaveat[];
};

export type RetentionDomainScorecard = {
  domain: RetentionDomainKey;
  label: string;
  score: number;
  status: "strong" | "directional" | "weak" | "unknown";
  confidence: AuditConfidence;
  sourceStatus: RetentionSourceStatus["status"];
  evidence: string[];
  caveats: AuditCaveat[];
};

export type RetentionPriorityItem = {
  id: string;
  title: string;
  domain: AuditDomain;
  insightType: AuditInsight["insightType"];
  severity: AuditSeverity;
  confidence: AuditConfidence;
  priorityScore: number;
};

export type RetentionLifecycleCoverage = {
  productPlacements: {
    welcomeHero: number;
    cartCheckoutAddOns: number;
    postPurchaseCrossSell: number;
    winback: number;
  };
  campaignCoverage: {
    campaignsAnalyzed: number;
    topIssues: number;
    topOpportunities: number;
    protectedPatterns: number;
  };
  flowCoverage: {
    flowsAudited: number;
    topIssues: number;
    topOpportunities: number;
    protectedFlows: number;
  };
  audienceCoverage: {
    covered: number;
    partial: number;
    missing: number;
    unknown: number;
    broadAudienceRisk: string;
  };
  performanceCoverage: {
    metricDiscoveryAvailable: boolean;
    recommendedMetricName: string | null;
    confidence: string;
    needsPerformanceData: boolean;
  };
  gaps: string[];
};

export type RetentionPrioritizedAction = {
  id: string;
  label: string;
  priority: "high" | "medium" | "low";
  domain: AuditDomain;
  whyItMatters: string;
  supportingEvidence: AuditEvidence[];
  suggestedNextWorklinWorkflow: string | null;
  caveats: AuditCaveat[];
  riskLevel: "low" | "medium" | "high";
  approvalRequiredLater: boolean;
};

export type RetentionAuditOutput = {
  ok: true;
  readOnly: true;
  workflowType: "retention_audit";
  summary: {
    executiveSummary: string;
    domainsAnalyzed: number;
    domainsSucceeded: number;
    domainsWithCaveats: number;
    needsPerformanceData: boolean;
    insightSummary: ReturnType<typeof summarizeAuditInsights>;
  };
  overallRetentionHealth: {
    score: number;
    status: "strong" | "directional" | "weak";
    label: string;
    drivers: string[];
  };
  domainScorecards: Record<RetentionDomainKey, RetentionDomainScorecard>;
  topIssues: RetentionPriorityItem[];
  topOpportunities: RetentionPriorityItem[];
  lifecycleCoverage: RetentionLifecycleCoverage;
  prioritizedActions: RetentionPrioritizedAction[];
  insights: AuditInsight[];
  chartHints: AuditChartHint[];
  caveats: AuditCaveat[];
  sourceStatuses: Record<RetentionDomainKey, RetentionSourceStatus>;
  metadata: {
    generatedAt: string;
    readOnly: true;
    input: Required<Pick<
      RetentionAuditInput,
      "includeProduct" | "includeCampaigns" | "includeFlows" | "includeAudiences" | "includeMetricDiscovery"
    >> & {
      timeframe: NonNullable<RetentionAuditInput["timeframe"]>;
      limit: number;
      productLimit: number;
      campaignLimit: number;
      flowLimit: number;
      audienceLimit: number;
      metricLimit: number;
    };
    childWorkflowIds: {
      campaign: string | null;
      flow: string | null;
      audience: string | null;
    };
    sourceFeatures: string[];
  };
  workflowId?: string | null;
};

type ChildResult<T> = {
  key: RetentionDomainKey;
  output: T | null;
  status: RetentionSourceStatus;
};

type NormalizedInput = {
  timeframe: NonNullable<RetentionAuditInput["timeframe"]>;
  startDate?: string | null;
  endDate?: string | null;
  includeProduct: boolean;
  includeCampaign: boolean;
  includeFlow: boolean;
  includeAudience: boolean;
  includeMetricDiscovery: boolean;
  limit: number;
  productLimit: number;
  campaignLimit: number;
  flowLimit: number;
  audienceLimit: number;
  metricLimit: number;
};

const DEFAULT_LIMIT = 20;

function caveat(message: string, severity: AuditSeverity = "unknown"): AuditCaveat {
  return {
    message,
    evidenceType: "caveat",
    severity,
  };
}

function cleanLimit(value: number | null | undefined, fallback: number, max: number) {
  if (!value || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

function normalizeInput(input: RetentionAuditInput = {}): NormalizedInput {
  const limit = cleanLimit(input.limit, DEFAULT_LIMIT, 100);

  return {
    timeframe: input.timeframe ?? "last_365_days",
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    includeProduct: input.includeProduct !== false,
    includeCampaign: input.includeCampaigns ?? input.includeCampaign ?? true,
    includeFlow: input.includeFlows ?? input.includeFlow ?? true,
    includeAudience: input.includeAudiences ?? input.includeAudience ?? true,
    includeMetricDiscovery: input.includeMetricDiscovery !== false,
    limit,
    productLimit: cleanLimit(input.productLimit, Math.min(8, limit), 12),
    campaignLimit: cleanLimit(input.campaignLimit, Math.min(20, limit), 50),
    flowLimit: cleanLimit(input.flowLimit, Math.min(5, limit), 10),
    audienceLimit: cleanLimit(input.audienceLimit, Math.min(100, Math.max(limit, 50)), 250),
    metricLimit: cleanLimit(input.metricLimit, Math.min(100, Math.max(limit, 50)), 250),
  };
}

function campaignTimeframe(input: NormalizedInput): KlaviyoPerformanceTimeframe {
  if (input.timeframe === "last_180_days") return "last_90_days";
  return input.timeframe;
}

function segmentTimeframe(input: NormalizedInput): SegmentAuditTimeframe {
  if (input.timeframe === "last_90_days" || input.timeframe === "last_180_days" || input.timeframe === "last_365_days") {
    return input.timeframe;
  }
  return input.timeframe === "last_30_days" ? "last_90_days" : "last_365_days";
}

function timeframeCaveats(input: NormalizedInput) {
  const caveats: AuditCaveat[] = [];
  if (input.timeframe === "last_180_days") {
    caveats.push(caveat("Campaign performance reads do not support last_180_days directly; campaign audit used last_90_days."));
  }
  if (input.timeframe === "last_30_days") {
    caveats.push(caveat("Segment audit supports last_90_days or longer; audience audit used last_90_days."));
  }
  if (input.timeframe === "lifetime" || input.timeframe === "custom") {
    caveats.push(caveat("Segment audit used last_365_days because audience v0 supports fixed recent windows only."));
  }
  return caveats;
}

function skippedStatus(label: string): RetentionSourceStatus {
  return {
    status: "skipped",
    readOnly: true,
    summary: { skipped: true },
    caveats: [caveat(`${label} was skipped by request.`)],
  };
}

function unavailableStatus(label: string, missingConfig: string[]): RetentionSourceStatus {
  return {
    status: "unavailable",
    readOnly: true,
    summary: { available: false, missingConfigCount: missingConfig.length },
    caveats: [caveat(`${label} is not configured: ${missingConfig.join(", ")}.`)],
  };
}

function failedStatus(label: string, error: unknown): RetentionSourceStatus {
  const known = error instanceof KlaviyoCampaignApiError ||
    error instanceof KlaviyoFlowApiError ||
    error instanceof KlaviyoMetricApiError;

  return {
    status: "failed",
    readOnly: true,
    summary: {
      failed: true,
      providerStatus: known ? error.status : null,
    },
    caveats: [
      caveat(
        known
          ? `${label} failed with a safe provider read error; no Klaviyo writes were attempted.`
          : `${label} failed unexpectedly; retention audit continued with remaining sources.`,
        "warning",
      ),
    ],
  };
}

function sourceStatus(
  status: RetentionSourceStatus["status"],
  summary: RetentionSourceStatus["summary"],
  caveats: AuditCaveat[] = [],
): RetentionSourceStatus {
  return {
    status,
    readOnly: true,
    summary,
    caveats,
  };
}

async function readProduct(input: NormalizedInput): Promise<ChildResult<ProductPerformanceIntelligenceResult>> {
  if (!input.includeProduct) {
    return { key: "product", output: null, status: skippedStatus("Product intelligence") };
  }

  try {
    const output = await getProductPerformanceIntelligence({
      limit: input.productLimit,
      timeframe: input.timeframe,
    });
    const status = output.caveats.length ? "partial" : "ok";

    return {
      key: "product",
      output,
      status: sourceStatus(status, {
        productsAnalyzed: output.summary.productsAnalyzed,
        productsWithOrders: output.summary.productsWithOrders,
        revenueAnchors: output.tiers.revenueAnchors.length,
        replenishmentCandidates: output.tiers.replenishmentCandidates.length,
        viewDataReliable: output.summary.viewData.reliable,
      }, output.caveats.map((message) => caveat(message))),
    };
  } catch (error) {
    return { key: "product", output: null, status: failedStatus("Product intelligence", error) };
  }
}

async function readCampaign(input: NormalizedInput): Promise<ChildResult<Omit<CampaignAuditOutput, "workflowId">>> {
  if (!input.includeCampaign) {
    return { key: "campaign", output: null, status: skippedStatus("Campaign audit") };
  }

  const configResult = getKlaviyoCampaignConfig();
  if (!configResult.ok) {
    return { key: "campaign", output: null, status: unavailableStatus("Klaviyo campaign read", configResult.missingConfig) };
  }

  try {
    const output = await auditKlaviyoCampaigns(configResult.config, {
      timeframe: campaignTimeframe(input),
      startDate: input.startDate,
      endDate: input.endDate,
      limit: input.campaignLimit,
      includeDrafts: true,
    });
    const status = output.caveats.length || output.summary.needsPerformanceData ? "partial" : "ok";

    return {
      key: "campaign",
      output,
      status: sourceStatus(status, {
        campaignsAnalyzed: output.summary.campaignsAnalyzed,
        needsPerformanceData: output.summary.needsPerformanceData,
        insights: output.insights.length,
      }, output.caveats),
    };
  } catch (error) {
    return { key: "campaign", output: null, status: failedStatus("Campaign audit", error) };
  }
}

async function readFlow(input: NormalizedInput): Promise<ChildResult<Omit<FlowAuditOutput, "workflowId">>> {
  if (!input.includeFlow) {
    return { key: "flow", output: null, status: skippedStatus("Flow audit") };
  }

  const configResult = getKlaviyoFlowConfig();
  if (!configResult.ok) {
    return { key: "flow", output: null, status: unavailableStatus("Klaviyo flow read", configResult.missingConfig) };
  }

  try {
    const output = await auditKlaviyoFlows(configResult.config, {
      auditAll: true,
      limit: input.flowLimit,
    });
    const flowCaveats = output.audits.flatMap((audit) => [
      ...audit.caveats,
      ...audit.performance.caveats,
    ]);
    const performanceCaveats = output.summary.needsPerformanceData
      ? [caveat("Flow audit continued with structural/playbook evidence because performance data is unavailable or incomplete.")]
      : [];
    const status = flowCaveats.length || performanceCaveats.length ? "partial" : "ok";

    return {
      key: "flow",
      output,
      status: sourceStatus(status, {
        totalAudited: output.summary.totalAudited,
        needsPerformanceData: output.summary.needsPerformanceData,
        topIssues: output.summary.topIssues.length,
      }, [...flowCaveats, ...performanceCaveats]),
    };
  } catch (error) {
    return { key: "flow", output: null, status: failedStatus("Flow audit", error) };
  }
}

async function readAudience(input: NormalizedInput): Promise<ChildResult<SegmentAuditOutput>> {
  if (!input.includeAudience) {
    return { key: "audience", output: null, status: skippedStatus("Segment / audience audit") };
  }

  const segmentInput: SegmentAuditInput = {
    timeframe: segmentTimeframe(input),
    includeKlaviyo: true,
    includeLocal: true,
    limit: input.audienceLimit,
  };

  try {
    const output = await auditSegments(segmentInput);
    const status = output.caveats.length || output.summary.needsKlaviyoAudienceData || output.summary.needsLocalAudienceData
      ? "partial"
      : "ok";

    return {
      key: "audience",
      output,
      status: sourceStatus(status, {
        audiencesAnalyzed: output.summary.audiencesAnalyzed,
        audienceHealthScore: output.overallAudienceHealth.score,
        coveredAudiences: output.lifecycleAudienceCoverage.filter((item) => item.status === "covered").length,
        missingAudiences: output.lifecycleAudienceCoverage.filter((item) => item.status === "missing").length,
      }, output.caveats),
    };
  } catch (error) {
    return { key: "audience", output: null, status: failedStatus("Segment / audience audit", error) };
  }
}

async function readMetrics(input: NormalizedInput): Promise<ChildResult<KlaviyoMetricDiscoveryResult>> {
  if (!input.includeMetricDiscovery) {
    return { key: "performance", output: null, status: skippedStatus("Klaviyo metric discovery") };
  }

  const configResult = getKlaviyoMetricConfig();
  if (!configResult.ok) {
    return { key: "performance", output: null, status: unavailableStatus("Klaviyo metric discovery", configResult.missingConfig) };
  }

  try {
    const output = await discoverKlaviyoConversionMetrics(configResult.config, {
      limit: input.metricLimit,
    });
    const status = output.recommendedMetric && output.confidence === "strong" ? "ok" : "partial";

    return {
      key: "performance",
      output,
      status: sourceStatus(status, {
        metricsRead: output.metrics.length,
        candidates: output.candidates.length,
        recommendedMetric: output.recommendedMetric?.name ?? null,
        confidence: output.confidence,
      }, output.caveats.map((message) => caveat(message))),
    };
  } catch (error) {
    return { key: "performance", output: null, status: failedStatus("Klaviyo metric discovery", error) };
  }
}

function scoreStatus(score: number): RetentionDomainScorecard["status"] {
  if (score >= 75) return "strong";
  if (score >= 50) return "directional";
  return "weak";
}

function confidenceForStatus(status: RetentionSourceStatus["status"]): AuditConfidence {
  if (status === "ok") return "strong";
  if (status === "partial") return "directional";
  return "weak";
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function productScorecard(result: ChildResult<ProductPerformanceIntelligenceResult>): RetentionDomainScorecard {
  const output = result.output;
  if (!output) return basicScorecard("product", "Product truth", result.status, 25, ["Product source was not available."]);

  const score = clampScore(
    45 +
      Math.min(18, output.tiers.revenueAnchors.length * 5) +
      Math.min(12, output.tiers.replenishmentCandidates.length * 4) +
      (output.summary.productsWithOrders > 0 ? 12 : -15) +
      (output.summary.viewData.reliable ? 8 : -5) -
      Math.min(12, output.caveats.length * 2),
  );

  return basicScorecard("product", "Product truth", result.status, score, [
    `${output.summary.productsAnalyzed} products analyzed.`,
    `${output.tiers.revenueAnchors.length} revenue anchors found.`,
    `${output.tiers.replenishmentCandidates.length} replenishment candidates found.`,
    output.summary.viewData.reliable ? "Product view data is reliable." : "Product view data is limited or unreliable.",
  ], result.status.caveats);
}

function campaignScorecard(result: ChildResult<Omit<CampaignAuditOutput, "workflowId">>): RetentionDomainScorecard {
  const output = result.output;
  if (!output) return basicScorecard("campaign", "Campaign truth", result.status, 25, ["Campaign source was not available."]);

  const issueCount = output.summary.topIssues.length;
  const score = clampScore(
    58 +
      Math.min(12, output.summary.campaignsAnalyzed) +
      Math.min(8, output.summary.protectedPatterns.length * 3) -
      (output.summary.needsPerformanceData ? 14 : 0) -
      Math.min(18, issueCount * 5) -
      Math.min(8, output.caveats.length),
  );

  return basicScorecard("campaign", "Campaign truth", result.status, score, [
    `${output.summary.campaignsAnalyzed} campaigns analyzed.`,
    `${issueCount} campaign issue patterns surfaced.`,
    output.summary.needsPerformanceData ? "Campaign performance needs conversion metric setup." : "Campaign performance data was available.",
  ], output.caveats);
}

function flowScorecard(result: ChildResult<Omit<FlowAuditOutput, "workflowId">>): RetentionDomainScorecard {
  const output = result.output;
  if (!output) return basicScorecard("flow", "Flow truth", result.status, 25, ["Flow source was not available."]);

  const averageFlowScore = output.audits.length
    ? output.audits.reduce((sum, audit) => sum + audit.score, 0) / output.audits.length
    : 45;
  const score = clampScore(
    averageFlowScore +
      Math.min(10, output.summary.protectedFlows.length * 3) -
      Math.min(15, output.summary.topIssues.length * 4) -
      (output.summary.needsPerformanceData ? 8 : 0),
  );

  return basicScorecard("flow", "Flow truth", result.status, score, [
    `${output.summary.totalAudited} flows audited.`,
    `${output.summary.topIssues.length} flow issue patterns surfaced.`,
    output.summary.needsPerformanceData ? "Flow performance needs conversion metric setup." : "Flow performance data was available.",
  ]);
}

function audienceScorecard(result: ChildResult<SegmentAuditOutput>): RetentionDomainScorecard {
  const output = result.output;
  if (!output) return basicScorecard("audience", "Audience truth", result.status, 25, ["Audience source was not available."]);

  return basicScorecard("audience", "Audience truth", result.status, output.overallAudienceHealth.score, [
    `${output.lifecycleAudienceCoverage.filter((item) => item.status === "covered").length} lifecycle audience buckets covered.`,
    `${output.lifecycleAudienceCoverage.filter((item) => item.status === "missing").length} lifecycle audience buckets missing.`,
    `Broad audience risk is ${output.broadAudienceRisk.level}.`,
  ], output.caveats);
}

function performanceScorecard(
  result: ChildResult<KlaviyoMetricDiscoveryResult>,
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>,
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>,
): RetentionDomainScorecard {
  const output = result.output;
  if (!output) return basicScorecard("performance", "Performance setup", result.status, 25, ["Metric discovery source was not available."]);

  const needsPerformanceData = Boolean(campaign.output?.summary.needsPerformanceData || flow.output?.summary.needsPerformanceData);
  const score = clampScore(
    (output.recommendedMetric ? 82 : output.candidates.length ? 56 : 34) -
      (needsPerformanceData ? 12 : 0) -
      Math.min(8, output.caveats.length),
  );

  return basicScorecard("performance", "Performance setup", result.status, score, [
    output.recommendedMetric
      ? `Recommended metric: ${output.recommendedMetric.name}.`
      : "No strong recommended conversion metric yet.",
    `${output.candidates.length} metric candidates detected.`,
    needsPerformanceData ? "Campaign or flow audit still needs performance data." : "Child audits did not report missing performance data.",
  ], output.caveats.map((message) => caveat(message)));
}

function basicScorecard(
  domain: RetentionDomainKey,
  label: string,
  source: RetentionSourceStatus,
  score: number,
  evidence: string[],
  caveats: AuditCaveat[] = source.caveats,
): RetentionDomainScorecard {
  const normalizedScore = source.status === "skipped" ? 0 : clampScore(score);

  return {
    domain,
    label,
    score: normalizedScore,
    status: source.status === "skipped" ? "unknown" : scoreStatus(normalizedScore),
    confidence: confidenceForStatus(source.status),
    sourceStatus: source.status,
    evidence,
    caveats,
  };
}

function lifecycleScorecard(scorecards: Omit<Record<RetentionDomainKey, RetentionDomainScorecard>, "lifecycle">): RetentionDomainScorecard {
  const active = Object.values(scorecards).filter((scorecard) => scorecard.sourceStatus !== "skipped");
  const average = active.length
    ? active.reduce((sum, scorecard) => sum + scorecard.score, 0) / active.length
    : 0;
  const score = clampScore(average);
  const lowDomains = active.filter((scorecard) => scorecard.score < 50).map((scorecard) => scorecard.label);

  return {
    domain: "lifecycle",
    label: "Lifecycle operating system",
    score,
    status: scoreStatus(score),
    confidence: active.every((scorecard) => scorecard.confidence === "strong") ? "strong" : "directional",
    sourceStatus: active.length ? "partial" : "skipped",
    evidence: [
      `${active.length} audit domains contributed to lifecycle health.`,
      lowDomains.length ? `Lowest scoring domains: ${lowDomains.join(", ")}.` : "No domain scored below 50.",
    ],
    caveats: active.flatMap((scorecard) => scorecard.caveats).slice(0, 6),
  };
}

function domainScorecards(input: {
  product: ChildResult<ProductPerformanceIntelligenceResult>;
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
  performance: ChildResult<KlaviyoMetricDiscoveryResult>;
}) {
  const base = {
    product: productScorecard(input.product),
    campaign: campaignScorecard(input.campaign),
    flow: flowScorecard(input.flow),
    audience: audienceScorecard(input.audience),
    performance: performanceScorecard(input.performance, input.campaign, input.flow),
  };

  return {
    ...base,
    lifecycle: lifecycleScorecard(base),
  };
}

function sourceStatuses(input: {
  product: ChildResult<ProductPerformanceIntelligenceResult>;
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
  performance: ChildResult<KlaviyoMetricDiscoveryResult>;
  lifecycle: RetentionSourceStatus;
}): Record<RetentionDomainKey, RetentionSourceStatus> {
  return {
    product: input.product.status,
    campaign: input.campaign.status,
    flow: input.flow.status,
    audience: input.audience.status,
    performance: input.performance.status,
    lifecycle: input.lifecycle,
  };
}

function normalizeInsightKey(insight: AuditInsight) {
  return `${insight.domain}:${insight.insightType}:${insight.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

function dedupeInsights(insights: AuditInsight[]) {
  const seen = new Map<string, AuditInsight>();

  for (const insight of rankAuditInsights(insights)) {
    const key = normalizeInsightKey(insight);
    if (!seen.has(key)) {
      seen.set(key, insight);
    }
  }

  return rankAuditInsights(Array.from(seen.values()));
}

function retentionInsights(input: {
  scorecards: Record<RetentionDomainKey, RetentionDomainScorecard>;
  performance: ChildResult<KlaviyoMetricDiscoveryResult>;
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
}) {
  const insights: AuditInsight[] = [];
  const needsPerformanceData = Boolean(
    input.campaign.output?.summary.needsPerformanceData ||
    input.flow.output?.summary.needsPerformanceData ||
    !input.performance.output?.recommendedMetric,
  );

  if (needsPerformanceData) {
    insights.push(createAuditInsight({
      id: "retention_audit_performance_metric_setup",
      title: "Revenue performance setup needs a verified conversion metric",
      summary: "Campaign and flow revenue reads should stay caveated until Worklin has a verified Klaviyo conversion metric.",
      domain: "revenue",
      insightType: "audit",
      severity: "warning",
      confidence: "strong",
      priorityScore: 82,
      evidence: [
        { type: "metric", label: "Metric candidates", value: input.performance.output?.candidates.length ?? 0, metricKey: "metric_candidates" },
        { type: "performance", label: "Recommended metric", value: input.performance.output?.recommendedMetric?.name ?? null, metricKey: "recommended_metric" },
      ],
      caveats: [
        { message: "This workflow does not write KLAVIYO_CONVERSION_METRIC_ID or persist metric selection.", evidenceType: "caveat", severity: "unknown" },
      ],
      recommendedActions: [
        {
          label: "Verify the Klaviyo Placed Order metric before revenue-based audit scoring.",
          actionType: "audit",
          priority: "high",
          requiresApproval: false,
        },
      ],
      chartHints: [
        createChartHint({
          type: "scorecard",
          title: "Performance setup status",
          metricKeys: ["metric_candidates", "recommended_metric", "needs_performance_data"],
          entityIds: [],
        }),
      ],
    }));
  }

  const weakDomains = Object.values(input.scorecards).filter((scorecard) =>
    scorecard.domain !== "lifecycle" && scorecard.sourceStatus !== "skipped" && scorecard.score < 50,
  );
  if (weakDomains.length >= 2) {
    insights.push(createAuditInsight({
      id: "retention_audit_cross_domain_foundation",
      title: "Retention foundation needs sequencing before action plans",
      summary: "Multiple audit domains are weak or partial, so Worklin should resolve source truth and lifecycle gaps before recommending execution.",
      domain: "lifecycle",
      insightType: "audit",
      severity: "issue",
      confidence: "directional",
      priorityScore: 78,
      evidence: weakDomains.map((scorecard) => ({
        type: "metric" as const,
        label: scorecard.label,
        value: scorecard.score,
        metricKey: `${scorecard.domain}_score`,
      })),
      recommendedActions: [
        {
          label: "Prioritize the lowest-scoring retention domains before creating new campaigns or flows.",
          actionType: "audit",
          priority: "high",
          requiresApproval: false,
        },
      ],
      chartHints: [
        createChartHint({
          type: "bar",
          title: "Retention domain scores",
          metricKeys: weakDomains.map((scorecard) => `${scorecard.domain}_score`),
          entityIds: weakDomains.map((scorecard) => scorecard.domain),
        }),
      ],
    }));
  }

  if (input.audience.output?.suppressionRisks.some((risk) => risk.severity === "high")) {
    insights.push(createAuditInsight({
      id: "retention_audit_suppression_guardrails",
      title: "Audience suppression guardrails should protect lifecycle execution",
      summary: "Segment audit found high suppression risk that can weaken campaign and flow recommendations if ignored.",
      domain: "segment",
      insightType: "protect",
      severity: "warning",
      confidence: "directional",
      priorityScore: 74,
      evidence: [
        {
          type: "segment",
          label: "High suppression risks",
          value: input.audience.output.suppressionRisks.filter((risk) => risk.severity === "high").length,
          metricKey: "high_suppression_risks",
        },
      ],
      recommendedActions: [
        {
          label: "Define suppression rules for recent purchasers, repeat buyers, VIPs, and active abandonment windows.",
          actionType: "protect",
          priority: "high",
          requiresApproval: false,
        },
      ],
    }));
  }

  return insights;
}

function collectInsights(input: {
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
  scorecards: Record<RetentionDomainKey, RetentionDomainScorecard>;
  performance: ChildResult<KlaviyoMetricDiscoveryResult>;
}) {
  return dedupeInsights([
    ...(input.campaign.output?.insights ?? []),
    ...(input.flow.output?.audits.flatMap((audit) => audit.insights) ?? []),
    ...(input.audience.output?.insights ?? []),
    ...retentionInsights(input),
  ]);
}

function itemFromInsight(insight: AuditInsight): RetentionPriorityItem {
  return {
    id: insight.id,
    title: insight.title,
    domain: insight.domain,
    insightType: insight.insightType,
    severity: insight.severity,
    confidence: insight.confidence,
    priorityScore: insight.priorityScore,
  };
}

function riskLevel(severity: AuditSeverity): RetentionPrioritizedAction["riskLevel"] {
  if (severity === "critical" || severity === "issue") return "high";
  if (severity === "warning" || severity === "unknown") return "medium";
  return "low";
}

function suggestedWorkflow(insight: AuditInsight) {
  if (insight.domain === "product") return "Product Performance Intelligence";
  if (insight.domain === "campaign") return "Campaign Audit -> Action Plan";
  if (insight.domain === "flow") return "Flow Audit -> Flow Planner";
  if (insight.domain === "segment") return "Segment / Audience Audit";
  if (insight.domain === "revenue") return "Klaviyo Metric Discovery / Performance Setup";
  if (insight.domain === "lifecycle") return "Retention Audit Workflow";
  return null;
}

function normalizeActionText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function actionIntentKey(insight: AuditInsight, action: AuditInsight["recommendedActions"][number]) {
  const text = normalizeActionText([
    insight.id,
    insight.title,
    insight.summary,
    action.label,
    action.description ?? "",
  ].join(" "));

  if (
    text.includes("conversion metric") ||
    text.includes("metric discovery") ||
    text.includes("performance reporting") ||
    text.includes("performance setup") ||
    text.includes("performance data") ||
    text.includes("revenue based") ||
    text.includes("revenue backed") ||
    text.includes("klaviyo conversion metric id")
  ) {
    return "performance_metric_setup";
  }

  if (text.includes("suppression") || text.includes("suppress") || text.includes("guardrail")) {
    return "suppression_guardrails";
  }

  return [
    insight.domain,
    action.actionType ?? insight.insightType,
    normalizeActionText(action.label),
  ].join(":");
}

function actionLabelForIntent(intentKey: string, fallback: string) {
  if (intentKey === "performance_metric_setup") {
    return "Confirm Klaviyo conversion metric and performance reporting before trusting revenue-backed prioritization.";
  }

  if (intentKey === "suppression_guardrails") {
    return "Define suppression guardrails for recent purchasers, VIPs, active buyers, and winback audiences before turning audit findings into campaigns.";
  }

  return fallback;
}

function actionWhyForIntent(intentKey: string, fallback: string) {
  if (intentKey === "performance_metric_setup") {
    return "Campaign, flow, and retention priorities should stay caveated until Worklin has a verified conversion metric and performance reporting path.";
  }

  if (intentKey === "suppression_guardrails") {
    return "Campaign and flow recommendations can over-target lifecycle audiences without clear suppression rules for buyers, VIPs, abandonment windows, and winback cohorts.";
  }

  return fallback;
}

function actionDomainForIntent(intentKey: string, fallback: AuditDomain): AuditDomain {
  if (intentKey === "performance_metric_setup") return "revenue";
  if (intentKey === "suppression_guardrails") return "segment";
  return fallback;
}

function workflowForIntent(intentKey: string, fallback: string | null) {
  if (intentKey === "performance_metric_setup") return "Klaviyo Metric Discovery / Performance Setup";
  if (intentKey === "suppression_guardrails") return "Segment / Audience Audit";
  return fallback;
}

function priorityRank(priority: RetentionPrioritizedAction["priority"]) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function riskRank(risk: RetentionPrioritizedAction["riskLevel"]) {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function mergeActionEvidence(existing: AuditEvidence[], incoming: AuditEvidence[]) {
  const seen = new Set(existing.map((item) => `${item.type}:${item.label}:${item.metricKey ?? ""}:${item.entityId ?? ""}`));
  const merged = [...existing];

  for (const item of incoming) {
    const key = `${item.type}:${item.label}:${item.metricKey ?? ""}:${item.entityId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 6);
}

function mergeActionCaveats(existing: AuditCaveat[], incoming: AuditCaveat[]) {
  const seen = new Set(existing.map((item) => item.message.toLowerCase()));
  const merged = [...existing];

  for (const item of incoming) {
    const key = item.message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 6);
}

function prioritizedActions(insights: AuditInsight[]): RetentionPrioritizedAction[] {
  const actionsByIntent = new Map<string, RetentionPrioritizedAction>();

  for (const insight of rankAuditInsights(insights)) {
    for (const action of insight.recommendedActions) {
      const intentKey = actionIntentKey(insight, action);
      if (!intentKey) continue;

      const priority = action.priority ?? (insight.priorityScore >= 75 ? "high" : "medium");
      const candidate: RetentionPrioritizedAction = {
        id: action.id ?? `${insight.id}_action`,
        label: actionLabelForIntent(intentKey, action.label),
        priority,
        domain: actionDomainForIntent(intentKey, insight.domain),
        whyItMatters: actionWhyForIntent(intentKey, action.description ?? insight.summary),
        supportingEvidence: insight.evidence.slice(0, 4),
        suggestedNextWorklinWorkflow: workflowForIntent(intentKey, suggestedWorkflow(insight)),
        caveats: insight.caveats,
        riskLevel: riskLevel(insight.severity),
        approvalRequiredLater: action.requiresApproval ?? ["build", "fix", "scale", "pause"].includes(insight.insightType),
      };

      const existing = actionsByIntent.get(intentKey);
      if (!existing) {
        actionsByIntent.set(intentKey, candidate);
        continue;
      }

      existing.priority = priorityRank(candidate.priority) > priorityRank(existing.priority)
        ? candidate.priority
        : existing.priority;
      existing.riskLevel = riskRank(candidate.riskLevel) > riskRank(existing.riskLevel)
        ? candidate.riskLevel
        : existing.riskLevel;
      existing.supportingEvidence = mergeActionEvidence(existing.supportingEvidence, candidate.supportingEvidence);
      existing.caveats = mergeActionCaveats(existing.caveats, candidate.caveats);
      existing.approvalRequiredLater = existing.approvalRequiredLater || candidate.approvalRequiredLater;
    }
  }

  return Array.from(actionsByIntent.values()).slice(0, 10);
}

function lifecycleCoverage(input: {
  product: ChildResult<ProductPerformanceIntelligenceResult>;
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  flow: ChildResult<Omit<FlowAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
  performance: ChildResult<KlaviyoMetricDiscoveryResult>;
}): RetentionLifecycleCoverage {
  const audienceCounts = input.audience.output
    ? {
        covered: input.audience.output.lifecycleAudienceCoverage.filter((item) => item.status === "covered").length,
        partial: input.audience.output.lifecycleAudienceCoverage.filter((item) => item.status === "partial").length,
        missing: input.audience.output.lifecycleAudienceCoverage.filter((item) => item.status === "missing").length,
        unknown: input.audience.output.lifecycleAudienceCoverage.filter((item) => item.status === "unknown").length,
        broadAudienceRisk: input.audience.output.broadAudienceRisk.level,
      }
    : { covered: 0, partial: 0, missing: 0, unknown: 0, broadAudienceRisk: "unknown" };
  const needsPerformanceData = Boolean(input.campaign.output?.summary.needsPerformanceData || input.flow.output?.summary.needsPerformanceData || !input.performance.output?.recommendedMetric);
  const gaps = [
    input.product.output?.summary.viewData.reliable === false ? "Product view data is limited, so hidden-gem and fix-candidate calls stay caveated." : null,
    input.campaign.output?.summary.needsPerformanceData ? "Campaign audit needs performance metric setup." : null,
    input.flow.output?.summary.needsPerformanceData ? "Flow audit needs performance metric setup." : null,
    audienceCounts.missing > 0 ? `${audienceCounts.missing} lifecycle audience buckets are missing.` : null,
    !input.performance.output?.recommendedMetric ? "No verified Klaviyo conversion metric has been recommended yet." : null,
  ].filter((item): item is string => Boolean(item));

  return {
    productPlacements: {
      welcomeHero: input.product.output?.lifecyclePlacement.welcomeHero.length ?? 0,
      cartCheckoutAddOns: input.product.output?.lifecyclePlacement.cartCheckoutAddOns.length ?? 0,
      postPurchaseCrossSell: input.product.output?.lifecyclePlacement.postPurchaseCrossSell.length ?? 0,
      winback: input.product.output?.lifecyclePlacement.winback.length ?? 0,
    },
    campaignCoverage: {
      campaignsAnalyzed: input.campaign.output?.summary.campaignsAnalyzed ?? 0,
      topIssues: input.campaign.output?.summary.topIssues.length ?? 0,
      topOpportunities: input.campaign.output?.summary.topOpportunities.length ?? 0,
      protectedPatterns: input.campaign.output?.summary.protectedPatterns.length ?? 0,
    },
    flowCoverage: {
      flowsAudited: input.flow.output?.summary.totalAudited ?? 0,
      topIssues: input.flow.output?.summary.topIssues.length ?? 0,
      topOpportunities: input.flow.output?.summary.topOpportunities.length ?? 0,
      protectedFlows: input.flow.output?.summary.protectedFlows.length ?? 0,
    },
    audienceCoverage: audienceCounts,
    performanceCoverage: {
      metricDiscoveryAvailable: input.performance.status.status === "ok" || input.performance.status.status === "partial",
      recommendedMetricName: input.performance.output?.recommendedMetric?.name ?? null,
      confidence: input.performance.output?.confidence ?? "none",
      needsPerformanceData,
    },
    gaps,
  };
}

function chartHints(input: {
  insights: AuditInsight[];
  scorecards: Record<RetentionDomainKey, RetentionDomainScorecard>;
  lifecycleCoverage: RetentionLifecycleCoverage;
  campaign: ChildResult<Omit<CampaignAuditOutput, "workflowId">>;
  audience: ChildResult<SegmentAuditOutput>;
}) {
  const base = [
    createChartHint({
      type: "scorecard",
      title: "Overall retention health",
      metricKeys: ["overall_retention_score", "domains_analyzed", "needs_performance_data"],
      entityIds: [],
    }),
    createChartHint({
      type: "bar",
      title: "Retention domain scorecards",
      metricKeys: Object.values(input.scorecards).map((scorecard) => `${scorecard.domain}_score`),
      entityIds: Object.values(input.scorecards).map((scorecard) => scorecard.domain),
    }),
    createChartHint({
      type: "table",
      title: "Lifecycle coverage map",
      metricKeys: [
        "product_placements",
        "campaign_patterns",
        "flow_coverage",
        "audience_coverage",
        "performance_setup",
      ],
      entityIds: [],
      description: input.lifecycleCoverage.gaps.slice(0, 2).join(" "),
    }),
    createChartHint({
      type: "table",
      title: "Prioritized retention actions",
      metricKeys: ["priority_score", "severity", "confidence", "domain"],
      entityIds: input.insights.slice(0, 8).map((insight) => insight.id),
    }),
  ];

  return dedupeChartHints([
    ...base,
    ...collectAuditChartHints(input.insights),
    ...(input.campaign.output?.chartHints ?? []),
    ...(input.audience.output?.chartHints ?? []),
  ]).slice(0, 16);
}

function dedupeChartHints(hints: AuditChartHint[]) {
  const seen = new Set<string>();
  const deduped: AuditChartHint[] = [];

  for (const hint of hints) {
    const key = `${hint.type}:${hint.title}:${hint.metricKeys.join(",")}:${hint.entityIds.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hint);
  }

  return deduped;
}

function caveats(input: {
  timeframe: AuditCaveat[];
  sourceStatuses: Record<RetentionDomainKey, RetentionSourceStatus>;
  insights: AuditInsight[];
}) {
  const seen = new Set<string>();
  const caveats = [
    ...input.timeframe,
    ...Object.values(input.sourceStatuses).flatMap((status) => status.caveats),
    ...input.insights.flatMap((insight) => insight.caveats),
  ];

  return caveats.filter((item) => {
    const key = item.message.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

function overallHealth(scorecards: Record<RetentionDomainKey, RetentionDomainScorecard>) {
  const lifecycle = scorecards.lifecycle;
  const weakDomains = Object.values(scorecards).filter((scorecard) =>
    scorecard.domain !== "lifecycle" && scorecard.sourceStatus !== "skipped" && scorecard.score < 50,
  );
  const score = lifecycle.score;

  return {
    score,
    status: scoreStatus(score) === "strong" ? "strong" as const : scoreStatus(score) === "directional" ? "directional" as const : "weak" as const,
    label: score >= 75
      ? "Retention setup has a usable operating foundation."
      : score >= 50
        ? "Retention setup is usable but needs cleanup before heavy scaling."
        : "Retention setup needs source truth and lifecycle fixes before action plans.",
    drivers: [
      `${Object.values(scorecards).filter((scorecard) => scorecard.domain !== "lifecycle" && scorecard.sourceStatus !== "skipped").length} domains contributed to the score.`,
      weakDomains.length ? `${weakDomains.length} domains scored below 50.` : "No active domain scored below 50.",
      scorecards.performance.score < 60 ? "Performance certainty is limited until a conversion metric is verified." : "Performance setup is usable.",
    ],
  };
}

function executiveSummary(input: {
  scorecards: Record<RetentionDomainKey, RetentionDomainScorecard>;
  insights: AuditInsight[];
  lifecycleCoverage: RetentionLifecycleCoverage;
}) {
  const health = overallHealth(input.scorecards);
  const top = input.insights[0];
  const gaps = input.lifecycleCoverage.gaps.length;

  return [
    `Retention health is ${health.status} at ${health.score}/100.`,
    `${Object.values(input.scorecards).filter((scorecard) => scorecard.sourceStatus !== "skipped").length} domains were analyzed.`,
    gaps ? `${gaps} lifecycle gaps remain caveated.` : "No major lifecycle coverage gaps were detected from available data.",
    top ? `Top priority: ${top.title}.` : "No audit insights were generated.",
  ].join(" ");
}

export async function auditRetentionSetup(input: RetentionAuditInput = {}): Promise<RetentionAuditOutput> {
  const normalized = normalizeInput(input);
  const timeframeNotes = timeframeCaveats(normalized);
  const [product, campaign, flow, audience, performance] = await Promise.all([
    readProduct(normalized),
    readCampaign(normalized),
    readFlow(normalized),
    readAudience(normalized),
    readMetrics(normalized),
  ]);
  const scorecards = domainScorecards({ product, campaign, flow, audience, performance });
  const activeChildScorecards = Object.values(scorecards).filter((scorecard) =>
    scorecard.domain !== "lifecycle" && scorecard.sourceStatus !== "skipped",
  );
  const lifecycleStatus = sourceStatus(
    activeChildScorecards.some((scorecard) => scorecard.sourceStatus !== "ok") ? "partial" : "ok",
    {
      score: scorecards.lifecycle.score,
      activeDomains: Object.values(scorecards).filter((scorecard) => scorecard.sourceStatus !== "skipped").length,
    },
    scorecards.lifecycle.caveats,
  );
  const statuses = sourceStatuses({ product, campaign, flow, audience, performance, lifecycle: lifecycleStatus });
  const insights = collectInsights({ campaign, flow, audience, scorecards, performance });
  const lifecycle = lifecycleCoverage({ product, campaign, flow, audience, performance });
  const insightSummary = summarizeAuditInsights(insights, { topLimit: 8 });
  const overallRetentionHealth = overallHealth(scorecards);
  const allCaveats = caveats({ timeframe: timeframeNotes, sourceStatuses: statuses, insights });
  const domains = Object.values(scorecards);
  const domainsAnalyzed = domains.filter((scorecard) => scorecard.sourceStatus !== "skipped").length;
  const domainsSucceeded = domains.filter((scorecard) => scorecard.sourceStatus === "ok" || scorecard.sourceStatus === "partial").length;

  return {
    ok: true,
    readOnly: true,
    workflowType: "retention_audit",
    summary: {
      executiveSummary: executiveSummary({ scorecards, insights, lifecycleCoverage: lifecycle }),
      domainsAnalyzed,
      domainsSucceeded,
      domainsWithCaveats: domains.filter((scorecard) => scorecard.caveats.length > 0).length,
      needsPerformanceData: lifecycle.performanceCoverage.needsPerformanceData,
      insightSummary,
    },
    overallRetentionHealth,
    domainScorecards: scorecards,
    topIssues: insights
      .filter((insight) => ["critical", "issue", "warning"].includes(insight.severity))
      .slice(0, 8)
      .map(itemFromInsight),
    topOpportunities: insights
      .filter((insight) => insight.severity === "opportunity" || insight.insightType === "build" || insight.insightType === "scale")
      .slice(0, 8)
      .map(itemFromInsight),
    lifecycleCoverage: lifecycle,
    prioritizedActions: prioritizedActions(insights),
    insights,
    chartHints: chartHints({ insights, scorecards, lifecycleCoverage: lifecycle, campaign, audience }),
    caveats: allCaveats,
    sourceStatuses: statuses,
    metadata: {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      input: {
        timeframe: normalized.timeframe,
        includeProduct: normalized.includeProduct,
        includeCampaigns: normalized.includeCampaign,
        includeFlows: normalized.includeFlow,
        includeAudiences: normalized.includeAudience,
        includeMetricDiscovery: normalized.includeMetricDiscovery,
        limit: normalized.limit,
        productLimit: normalized.productLimit,
        campaignLimit: normalized.campaignLimit,
        flowLimit: normalized.flowLimit,
        audienceLimit: normalized.audienceLimit,
        metricLimit: normalized.metricLimit,
      },
      childWorkflowIds: {
        campaign: null,
        flow: null,
        audience: null,
      },
      sourceFeatures: [
        "Product Performance Intelligence",
        "Campaign Audit",
        "Flow Audit",
        "Segment / Audience Audit",
        "Klaviyo Metric Discovery",
        "Audit Insight Framework",
      ],
    },
  };
}
