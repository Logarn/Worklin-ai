export const RETENTION_DOMAIN_VERSION = "worklin_retention_v1";
export const BRAND_BRAIN_VERSION = "brand_brain_v1";
export const BRAND_RESEARCH_VERSION = "brand_research_v1";
export const CUSTOMER_FEATURE_STORE_VERSION = "customer_feature_store_v1";
export const CUSTOMER_SCORING_VERSION = "rule_based_customer_scoring_v1";
export const MICRO_SEGMENT_DEFINITION_VERSION =
  "micro_segment_definition_builder_v1";
export const CAMPAIGN_OPPORTUNITY_VERSION = "campaign_opportunity_engine_v1";
export const CAMPAIGN_PACKAGE_VERSION = "campaign_package_generator_v1";
export const RETENTION_QA_VERSION = "retention_qa_v1";
export const DEEP_RETENTION_AUDIT_VERSION = "deep_retention_audit_v1";

export const RETENTION_BLOCKED_CAPABILITIES = [
  "shopify_write",
  "klaviyo_send_campaign",
  "klaviyo_schedule_campaign",
  "klaviyo_activate_flow",
  "klaviyo_mutate_segment",
  "klaviyo_mutate_profile",
] as const;

export type RetentionConnectorId = "shopify" | "klaviyo";
export type RetentionConnectorStatus =
  | "connected"
  | "partial"
  | "not_connected";
export type RetentionFeatureStatus = "available" | "partial" | "unavailable";
export type RetentionOpportunityStatus =
  | "available"
  | "partial"
  | "unavailable";
export type RetentionRiskLevel = "low" | "medium" | "high" | "critical";
export type RetentionApprovalStatus =
  | "not_required"
  | "required"
  | "approved"
  | "blocked";

export interface RetentionSafetyMetadata {
  readOnly: boolean;
  draftCreationAllowed: boolean;
  externalActionTaken: false;
  canGoLiveNow: false;
  approvalStatus: RetentionApprovalStatus;
  blockedCapabilities: string[];
  caveats: string[];
}

export interface RetentionConnectorSnapshot {
  id: RetentionConnectorId;
  label: string;
  status: RetentionConnectorStatus;
  lastSyncedAt: string | null;
  readCapabilities: string[];
  writeCapabilities: string[];
  blockedCapabilities: string[];
  caveats: string[];
}

export interface RetentionSourceStatus {
  generatedAt: string;
  connectors: RetentionConnectorSnapshot[];
  safety: RetentionSafetyMetadata;
  summary: {
    connected: number;
    partial: number;
    notConnected: number;
    readyForReadOnlyAudit: boolean;
  };
}

export interface BrandBrainContext {
  version: typeof BRAND_BRAIN_VERSION;
  generatedAt: string;
  brandName: string;
  websiteUrl?: string;
  industry: string;
  positioning: {
    tagline: string;
    story: string;
    uniqueSellingProposition: string;
  };
  voice: {
    summary: string;
    sliders: {
      formalCasual: number;
      seriousPlayful: number;
      reservedEnthusiastic: number;
    };
    greetingStyle: string;
    signOffStyle: string;
    emojiUsage: "none" | "light" | "moderate";
  };
  audienceNotes: string[];
  offers: Array<{
    id: string;
    label: string;
    constraint: string;
  }>;
  products: Array<{
    id: string;
    name: string;
    category: string;
    replenishmentDays: number | null;
    marginPosture: "low" | "medium" | "high";
  }>;
  rules: Array<{
    type: "do" | "dont" | "compliance" | "suppression";
    rule: string;
  }>;
  ctas: string[];
  phrases: Array<{
    type: "approved" | "avoid";
    phrase: string;
  }>;
  compliance: {
    requiredDisclaimers: string[];
    forbiddenClaims: string[];
    cautionAreas: string[];
  };
  documentSources: Array<{
    id: string;
    title: string;
    sourceType: "storefront" | "pdf" | "docx" | "txt" | "manual";
    status: "pending" | "analyzed" | "applied";
    keyFindings: string[];
  }>;
  sourceProvenance: Array<{
    sourceType:
      | "manual_profile"
      | "store_analysis"
      | "document_upload"
      | "campaign_memory"
      | "source_snapshot"
      | "brand_research"
      | "fixture";
    label: string;
    status: "fixture" | "draft" | "live_readonly" | "approved";
    observedAt: string | null;
  }>;
  readiness: {
    status: "ready" | "partial" | "missing";
    score: number;
    completed: string[];
    missing: string[];
    nextActions: string[];
  };
  campaignMemory: Array<{
    campaignType: string;
    insight: string;
    outcome: "winning" | "mixed" | "avoid";
  }>;
  caveats: string[];
  /** Optional deep public-research report used by downstream agents. */
  research?: BrandResearchReport;
  safety: RetentionSafetyMetadata;
}

export type BrandResearchConfidence = "high" | "medium" | "low";

export interface BrandResearchEvidence {
  id: string;
  url: string;
  title: string;
  sourceType:
    | "official_site"
    | "competitor_site"
    | "search_result"
    | "social_profile"
    | "review"
    | "press"
    | "market_report"
    | "other";
  observedAt: string;
  finding: string;
  confidence: BrandResearchConfidence;
}

export interface BrandResearchReport {
  version: typeof BRAND_RESEARCH_VERSION;
  generatedAt: string;
  query: { brandName: string; websiteUrl?: string };
  executiveSummary: string[];
  identity: {
    category: string;
    positioning: string;
    offers: string[];
    audienceSignals: string[];
  };
  competitorLandscape: Array<{
    name: string;
    websiteUrl?: string;
    positioning: string;
    notableMoves: string[];
    evidenceIds: string[];
    confidence: BrandResearchConfidence;
  }>;
  channelFindings: {
    seoAndContent: string[];
    social: string[];
    emailAndLifecycle: string[];
    sms: string[];
    productAndLaunches: string[];
  };
  marketSignals: string[];
  customerSignals: string[];
  trendSignals: string[];
  evidence: BrandResearchEvidence[];
  gaps: string[];
  recommendations: Array<{
    priority: "now" | "next" | "later";
    action: string;
    rationale: string;
    evidenceIds: string[];
  }>;
  safety: {
    readOnly: true;
    publicSourcesOnly: true;
    unsupportedClaimsExcluded: true;
    caveats: string[];
  };
}

/** Attach public research without turning observations into approved claims. */
export function attachBrandResearch(
  brain: BrandBrainContext,
  research: BrandResearchReport,
): BrandBrainContext {
  if (research.version !== BRAND_RESEARCH_VERSION) {
    throw new Error(`Unsupported Brand Research version: ${research.version}`);
  }
  if (
    research.query.brandName.trim().toLocaleLowerCase() !==
    brain.brandName.trim().toLocaleLowerCase()
  ) {
    throw new Error(
      "Brand Research report does not match the Brand Brain brand name.",
    );
  }
  return {
    ...brain,
    research,
    sourceProvenance: [
      ...brain.sourceProvenance,
      {
        sourceType: "brand_research",
        label: `Public research report for ${research.query.brandName}`,
        status: "live_readonly",
        observedAt: research.generatedAt,
      },
    ],
    caveats: [
      ...new Set([
        ...brain.caveats,
        "Research findings are public observations and inferences, not approved brand claims.",
      ]),
    ],
  };
}

export type BrandBrainCorrectionField =
  | "voice_summary"
  | "tagline"
  | "brand_story"
  | "unique_selling_proposition"
  | "rule_do"
  | "rule_dont"
  | "approved_phrase"
  | "avoid_phrase"
  | "approved_cta"
  | "audience_note"
  | "required_disclaimer"
  | "forbidden_claim"
  | "caution_area";

export interface BrandBrainCorrection {
  field: BrandBrainCorrectionField;
  operation: "add" | "remove" | "replace";
  value: string;
  previousValue?: string;
}

export interface BrandBrainCampaignLearning {
  campaignType: string;
  insight: string;
  outcome: "winning" | "mixed" | "avoid";
}

export interface BrandBrainOnboardingInput {
  brandName: string;
  websiteUrl?: string;
  storefront?: {
    status: "fetched" | "unavailable" | "skipped";
    url?: string;
    title?: string;
    description?: string;
    productHints?: string[];
    caveat?: string;
  };
}

export interface RetentionCustomer {
  id: string;
  email: string;
  shopifyCustomerId: string | null;
  klaviyoProfileId: string | null;
  totalOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  daysSinceLastOrder: number | null;
  daysSinceLastEmailClick: number | null;
  dominantCategory: string | null;
  lastProductName: string | null;
  acceptsMarketing: boolean;
  emailEngagementStatus: "engaged" | "warming" | "cold" | "unknown";
  productAffinity: string[];
}

export interface ShopifySourceSnapshot {
  platform: "shopify";
  generatedAt: string;
  depth: "compact" | "standard" | "full";
  timeframeDays: number;
  connector: RetentionConnectorSnapshot;
  summary: {
    customers: number;
    customersWithOrders: number;
    orders: number;
    revenue: number;
    averageOrderValue: number;
    repeatPurchaseRate: number;
  };
  cohorts: Array<{
    key: string;
    label: string;
    customers: number;
    revenue: number;
    caveats: string[];
  }>;
  products: Array<{
    productId: string;
    name: string;
    category: string;
    revenue: number;
    unitsSold: number;
    avgReplenishmentDays: number | null;
  }>;
  freshness: {
    lastSyncedAt: string | null;
    status: "fixture" | "fresh" | "stale" | "not_connected";
  };
  caveats: string[];
  safety: RetentionSafetyMetadata;
}

export interface KlaviyoSourceSnapshot {
  platform: "klaviyo";
  generatedAt: string;
  depth: "compact" | "standard" | "l365" | "full";
  connector: RetentionConnectorSnapshot;
  analysisWindow?: {
    days: number;
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
    comparisonMode: "last_365_vs_previous_365";
  };
  campaigns: {
    count: number;
    byStatus: Record<string, number>;
    recent: Array<{
      id: string;
      name: string;
      status: string;
      channel: string;
      subject: string | null;
    }>;
  };
  campaignPerformance?: {
    count: number;
    byStatus: Record<string, number>;
    byChannel: Record<string, number>;
    byTheme: Record<string, number>;
    cadenceByWeek: Array<{
      weekStart: string;
      campaignCount: number;
      targetMin: number;
      targetMax: number;
    }>;
    subjectWordBank: Array<{
      word: string;
      count: number;
    }>;
    recent: Array<{
      id: string;
      name: string;
      status: string;
      channel: string;
      subject: string | null;
      sentAt: string | null;
      theme: string;
      salePosture: "sale" | "non_sale" | "unknown";
    }>;
  };
  flows: {
    count: number;
    activeLikeCount: number;
    recent: Array<{
      id: string;
      name: string;
      status: string;
      triggerType: string;
    }>;
  };
  flowPerformance?: {
    count: number;
    activeLikeCount: number;
    byStatus: Record<string, number>;
    byTriggerType: Record<string, number>;
    lifecycleCoverage: KlaviyoSourceSnapshot["lifecycleCoverage"];
  };
  forms?: {
    count: number;
    byStatus: Record<string, number>;
    recent: Array<{
      id: string;
      name: string;
      status: string;
      type: string;
    }>;
  };
  audiences: {
    lists: number;
    segments: number;
    top: Array<{
      id: string;
      name: string;
      type: "list" | "segment";
      profileCount: number | null;
    }>;
  };
  metrics: {
    count: number;
    importantMetrics: {
      found: string[];
      missing: string[];
      readiness: "performance_ready" | "partial" | "not_available";
    };
  };
  lifecycleCoverage: {
    present: Array<{ id: string; label: string }>;
    missing: Array<{ id: string; label: string }>;
    status: "derived_from_snapshot" | "insufficient_source_data";
    caveats: string[];
  };
  freshness: {
    lastSyncedAt: string | null;
    status: "fixture" | "fresh" | "stale" | "not_connected";
  };
  caveats: string[];
  queryErrors?: Array<{
    path: string;
    status: number;
    detail?: string;
  }>;
  safety: RetentionSafetyMetadata;
}

export interface RetentionDataset {
  generatedAt: string;
  brandName: string;
  websiteUrl?: string;
  sourceMode?:
    | "fixture"
    | "live_readonly"
    | "mixed"
    | "klaviyo_inventory"
    | "klaviyo_l365";
  connectors: RetentionConnectorSnapshot[];
  brandBrain: Omit<BrandBrainContext, "generatedAt" | "safety">;
  customers: RetentionCustomer[];
  klaviyoSnapshot?: KlaviyoSourceSnapshot;
}

export interface UnifiedCustomerIdentity {
  identityId: string;
  email: string;
  worklinCustomerId: string;
  shopifyCustomerId: string | null;
  klaviyoProfileId: string | null;
  confidence: "high" | "medium" | "low";
  confidenceReasons: string[];
  sourceCoverage: {
    shopify: boolean;
    klaviyo: boolean;
    commerce: boolean;
    engagement: boolean;
  };
  missingData: string[];
  caveats: string[];
}

export interface UnifiedCustomerViewResult {
  generatedAt: string;
  identities: UnifiedCustomerIdentity[];
  safety: RetentionSafetyMetadata;
  summary: {
    totalIdentities: number;
    highConfidence: number;
    lowConfidence: number;
    shopifyOnly: number;
    klaviyoOnly: number;
    matchedAcrossSources: number;
  };
}

export interface RetentionCustomerFeatureSnapshot {
  identityId: string;
  email: string;
  featureVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: RetentionFeatureStatus;
  identityConfidence: string;
  sourceCoverage: UnifiedCustomerIdentity["sourceCoverage"];
  commerceFeatures: {
    totalOrders: number;
    totalSpent: number;
    avgOrderValue: number;
    daysSinceLastOrder: number | null;
    dominantCategory: string | null;
    lastProductName: string | null;
    productAffinity: string[];
  };
  engagementFeatures: {
    acceptsMarketing: boolean;
    daysSinceLastEmailClick: number | null;
    emailEngagementStatus: string;
  };
  lifecycleFeatures: {
    lifecycleStage: "new" | "active" | "at_risk" | "winback" | "vip";
    retentionPriority: "low" | "medium" | "high";
  };
  derivedLabels: string[];
  missingCapabilities: string[];
  caveats: string[];
}

export interface RetentionFeatureResult {
  generatedAt: string;
  timeframeDays: number;
  features: RetentionCustomerFeatureSnapshot[];
  safety: RetentionSafetyMetadata;
  summary: {
    evaluatedCustomers: number;
    highPriorityCustomers: number;
    averageOrderValue: number;
    caveats: string[];
  };
}

export interface CustomerScoreBundle {
  identityId: string;
  email: string;
  scoringVersion: typeof CUSTOMER_SCORING_VERSION;
  computedAt: string;
  status: RetentionFeatureStatus;
  scores: Record<
    | "ready_to_buy_again"
    | "replenishment_readiness"
    | "churn_risk"
    | "winback_readiness"
    | "vip_likelihood"
    | "second_purchase_opportunity"
    | "email_fatigue_risk"
    | "suppression_risk"
    | "product_affinity",
    {
      score: number;
      tier: "low" | "medium" | "high" | "very_high";
      reasons: string[];
    }
  >;
  priorityHints: string[];
  caveats: string[];
}

export interface RetentionScoreResult {
  generatedAt: string;
  scores: CustomerScoreBundle[];
  safety: RetentionSafetyMetadata;
  summary: {
    evaluatedCustomers: number;
    highChurnRisk: number;
    readyToBuyAgain: number;
    suppressionRisk: number;
  };
}

export interface MicroSegmentDefinition {
  definitionKey: string;
  definitionVersion: typeof MICRO_SEGMENT_DEFINITION_VERSION;
  name: string;
  description: string;
  audienceEstimate: {
    customers: number;
    basis: string;
  };
  priority: number;
  recommendedUseCases: {
    campaigns: string[];
    flows: string[];
    suppressions: string[];
  };
  klaviyoNativePossible: false;
  requiresWorklinProperties: true;
  caveats: string[];
}

export interface MicroSegmentResult {
  generatedAt: string;
  definitions: MicroSegmentDefinition[];
  safety: RetentionSafetyMetadata;
  summary: {
    totalDefinitions: number;
    activationStatus: "definition_only";
  };
}

export interface RetentionMissingPiece {
  id: string;
  area: "brand" | "shopify" | "klaviyo" | "identity" | "campaign" | "safety";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  evidence: string[];
  recommendedNextAction: string;
  blockedCapabilities: string[];
  caveats: string[];
}

export interface RetentionMissingPiecesResult {
  generatedAt: string;
  missingPieces: RetentionMissingPiece[];
  safety: RetentionSafetyMetadata;
  summary: {
    total: number;
    critical: number;
    warnings: number;
    readyForCampaignPackages: boolean;
  };
}

export interface RetentionCampaignOpportunity {
  opportunityKey: string;
  opportunityVersion: string;
  computedAt: string;
  status: RetentionOpportunityStatus;
  name: string;
  description: string;
  opportunityType:
    | "campaign"
    | "flow"
    | "suppression"
    | "policy"
    | "lifecycle"
    | "review";
  recommendedCampaignType: string;
  messageAngle: string;
  audienceEstimate: {
    customers: number;
    basis: string;
  };
  priority: number;
  confidence: "low" | "medium" | "high";
  whyNow: string[];
  linkedLabels: string[];
  futureArtifact: {
    artifactType:
      | "retention_audit"
      | "campaign_brief_seed"
      | "flow_branch_plan"
      | "review_item";
    title: string;
    readiness: "ready_for_brief" | "needs_review" | "holdout_only";
  };
  blockedByMissingCapabilities: string[];
  caveats: string[];
}

export interface RetentionOpportunityResult {
  generatedAt: string;
  opportunities: RetentionCampaignOpportunity[];
  safety: RetentionSafetyMetadata;
  summary: {
    totalOpportunities: number;
    draftOnly: boolean;
    highestPriority: string | null;
  };
}

export interface CampaignPackage {
  packageId: string;
  packageVersion: typeof CAMPAIGN_PACKAGE_VERSION;
  generatedAt: string;
  status: "package_only" | "blocked";
  approvalStatus: RetentionApprovalStatus;
  opportunity: RetentionCampaignOpportunity | null;
  brandContext: {
    brandName: string;
    voiceSummary: string;
    rulesApplied: string[];
  };
  audience: {
    description: string;
    estimatedCustomers: number;
    sourceBasis: string;
  };
  brief: {
    title: string;
    goal: string;
    angle: string;
    subjectLines: string[];
    previewTexts: string[];
    sections: Array<{ heading: string; body: string }>;
    cta: string;
    offerGuidance: string;
    suppressionNotes: string[];
  } | null;
  safety: RetentionSafetyMetadata;
  caveats: string[];
}

export interface RetentionQaResult {
  generatedAt: string;
  qaVersion: typeof RETENTION_QA_VERSION;
  status: "passed" | "warning" | "failed";
  approvalStatus: RetentionApprovalStatus;
  checks: Array<{
    id: string;
    status: "passed" | "warning" | "failed";
    message: string;
  }>;
  reviewedPackage: CampaignPackage | null;
  safety: RetentionSafetyMetadata;
}

export interface RetentionActionLog {
  eventType: string;
  actionType: string;
  status: "prepared" | "requested" | "approved" | "blocked" | "failed";
  riskLevel: RetentionRiskLevel;
  requiresApproval: boolean;
  approvalStatus: RetentionApprovalStatus;
  externalActionTaken: false;
  canGoLiveNow: false;
  summary: string;
}

export interface RetentionContextPack {
  generatedAt: string;
  title: string;
  brandSummary: {
    brandName: string;
    voice: string;
    rules: string[];
    readiness: BrandBrainContext["readiness"];
    audienceNotes: string[];
    approvedCtas: string[];
    avoidPhrases: string[];
    compliance: {
      forbiddenClaims: string[];
      cautionAreas: string[];
    };
  };
  sourceSummary: RetentionSourceStatus["summary"];
  customerSummary: RetentionFeatureResult["summary"];
  missingPieces: Array<{
    id: string;
    severity: string;
    title: string;
  }>;
  topOpportunities: Array<{
    key: string;
    name: string;
    audienceCustomers: number;
    readiness: string;
  }>;
  safety: RetentionSafetyMetadata;
}

export type RetentionAuditCadence = "first_run" | "weekly" | "monthly" | "quarterly";

export interface AuditWindowComparison {
  currentWindowDays: number;
  previousWindowDays: number;
  currentLabel: string;
  previousLabel: string;
  comparisonMode: "last_365_vs_previous_365" | "custom";
  caveats: string[];
}

export interface AuditChartSpec {
  chartId: string;
  title: string;
  family:
    | "weekly_campaign_cadence"
    | "product_funnel"
    | "product_quadrant"
    | "sale_non_sale_comparison"
    | "subject_line_word_bank"
    | "segment_theme_heatmap"
    | "flow_stage_waterfall"
    | "period_trend"
    | "opportunity_priority_matrix"
    | "klaviyo_campaign_cadence"
    | "klaviyo_campaign_theme"
    | "klaviyo_inventory"
    | "klaviyo_lifecycle_coverage"
    | "klaviyo_audience_inventory"
    | "klaviyo_metric_readiness"
    | "klaviyo_form_inventory";
  type: "bar" | "funnel" | "scatter" | "comparison" | "word_bank" | "heatmap" | "waterfall" | "line" | "matrix";
  data: Array<Record<string, string | number | boolean | null>>;
  encodings: Record<string, string>;
  diagnosis: string;
  recommendation: string;
  caveats: string[];
}

export interface AuditInsight {
  insightId: string;
  severity: "info" | "opportunity" | "warning" | "critical";
  title: string;
  summary: string;
  evidence: string[];
}

export interface AuditRecommendation {
  recommendationId: string;
  priority: number;
  title: string;
  action: string;
  expectedImpact: string;
  owner: "worklin" | "brand" | "operator";
  blockedCapabilities: string[];
}

export interface OpportunityBacklogItem {
  backlogKey: string;
  sourceModuleId: RetentionAuditModule["moduleId"];
  title: string;
  type:
    | "product"
    | "campaign"
    | "segment"
    | "flow"
    | "acquisition"
    | "quiz"
    | "data_trust";
  impact: number;
  confidence: number;
  effort: "low" | "medium" | "high";
  nextAction: string;
  artifactOnly: true;
  approvalStatus: RetentionApprovalStatus;
  externalActionTaken: false;
  canGoLiveNow: false;
}

export interface RetentionAuditModule {
  moduleId:
    | "data_trust"
    | "brand_context"
    | "product_performance"
    | "campaign_performance"
    | "segment_analysis"
    | "lifecycle_flow"
    | "acquisition_tofu"
    | "quiz_funnel"
    | "opportunity_backlog";
  title: string;
  status: "complete" | "partial" | "blocked";
  summary: string;
  charts: AuditChartSpec[];
  insights: AuditInsight[];
  recommendations: AuditRecommendation[];
  caveats: string[];
}

export interface AuditReasoningCard {
  cardId: string;
  moduleId: RetentionAuditModule["moduleId"];
  title: string;
  status: RetentionAuditModule["status"];
  analysisWindow: string;
  dataRead: string[];
  ruleApplied: string;
  rationale: string;
  evidence: string[];
  caveats: string[];
  recommendation: string;
}

export interface RetentionAuditArtifact {
  title: string;
  contentMarkdown: string;
  charts: AuditChartSpec[];
  generatedAt: string;
  exportReady: boolean;
}

export interface RetentionAuditRun {
  auditId: string;
  auditVersion: typeof DEEP_RETENTION_AUDIT_VERSION;
  generatedAt: string;
  cadence: RetentionAuditCadence;
  title: string;
  brandName: string;
  window: AuditWindowComparison;
  modules: RetentionAuditModule[];
  auditTrace: AuditReasoningCard[];
  opportunityBacklog: OpportunityBacklogItem[];
  artifact: RetentionAuditArtifact;
  actionLog: RetentionActionLog;
  safety: RetentionSafetyMetadata;
  summary: {
    moduleCount: number;
    chartCount: number;
    recommendationCount: number;
    backlogCount: number;
    sourceMode: NonNullable<RetentionDataset["sourceMode"]>;
  };
}

export interface RetentionAuditStatus {
  generatedAt: string;
  status: "ready" | "partial" | "blocked";
  nextRunRecommended: RetentionAuditCadence;
  requiredConnectors: RetentionConnectorId[];
  availableConnectors: RetentionConnectorId[];
  missingConnectors: RetentionConnectorId[];
  safety: RetentionSafetyMetadata;
  caveats: string[];
}

export interface RetentionAuditSchedulePlan {
  generatedAt: string;
  status: "planned";
  schedules: Array<{
    cadence: Exclude<RetentionAuditCadence, "first_run">;
    label: string;
    intervalDays: number;
    purpose: string;
  }>;
  safety: RetentionSafetyMetadata;
  caveats: string[];
}

export interface ComputeRetentionOptions {
  timeframeDays?: number;
  limit?: number;
  opportunityKey?: string;
  cadence?: RetentionAuditCadence;
  brandName?: string;
  websiteUrl?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function tierFor(score: number): "low" | "medium" | "high" | "very_high" {
  if (score >= 800) return "very_high";
  if (score >= 600) return "high";
  if (score >= 350) return "medium";
  return "low";
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function createRetentionSafetyMetadata(
  caveats: string[] = [],
  approvalStatus: RetentionApprovalStatus = "not_required",
): RetentionSafetyMetadata {
  return {
    readOnly: true,
    draftCreationAllowed: false,
    externalActionTaken: false,
    canGoLiveNow: false,
    approvalStatus,
    blockedCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
    caveats,
  };
}

export function createFixtureRetentionDataset(): RetentionDataset {
  const generatedAt = nowIso();
  const connectors: RetentionConnectorSnapshot[] = [
    {
      id: "shopify",
      label: "Shopify",
      status: "partial",
      lastSyncedAt: generatedAt,
      readCapabilities: ["customers_read", "orders_read", "products_read"],
      writeCapabilities: [],
      blockedCapabilities: ["shopify_write"],
      caveats: [
        "Fixture-backed Shopify snapshot. Replace with Worklin-managed read credentials before production use.",
      ],
    },
    {
      id: "klaviyo",
      label: "Klaviyo",
      status: "partial",
      lastSyncedAt: generatedAt,
      readCapabilities: [
        "profiles_read",
        "campaigns_read",
        "flows_read",
        "lists_read",
        "segments_read",
        "metrics_read",
      ],
      writeCapabilities: ["draft_create_only"],
      blockedCapabilities: [
        "klaviyo_send_campaign",
        "klaviyo_schedule_campaign",
        "klaviyo_activate_flow",
        "klaviyo_mutate_segment",
        "klaviyo_mutate_profile",
      ],
      caveats: [
        "Fixture-backed Klaviyo snapshot. Draft creation remains disabled until an approved credential adapter exists.",
      ],
    },
  ];

  return {
    generatedAt,
    brandName: "Worklin Demo DTC Brand",
    websiteUrl: "https://example.worklin.ai",
    connectors,
    brandBrain: {
      version: BRAND_BRAIN_VERSION,
      brandName: "Worklin Demo DTC Brand",
      websiteUrl: "https://example.worklin.ai",
      industry: "DTC skincare and wellness",
      positioning: {
        tagline: "Calm, useful routines for repeat buyers.",
        story:
          "A retention-led DTC brand focused on practical replenishment, education, and respectful winback offers.",
        uniqueSellingProposition:
          "Product memory plus helpful timing, without spammy urgency.",
      },
      voice: {
        summary:
          "Clear, helpful, premium but not stiff; concise education before offers.",
        sliders: {
          formalCasual: 38,
          seriousPlayful: 42,
          reservedEnthusiastic: 58,
        },
        greetingStyle: "warm_direct",
        signOffStyle: "team_signature",
        emojiUsage: "light",
      },
      audienceNotes: [
        "Repeat buyers respond best to useful timing, product memory, and specific routine guidance.",
        "VIPs should receive early access, education, and replenishment help before discount-led offers.",
        "Cold or long-lapsed audiences need softer winback language and stricter fatigue checks.",
      ],
      offers: [
        {
          id: "replenishment_free_shipping",
          label: "Free shipping on replenishment orders",
          constraint: "Use for recent buyers only; avoid discounting VIPs first.",
        },
        {
          id: "winback_soft_offer",
          label: "Soft winback offer",
          constraint: "Use only after suppression/fatigue checks.",
        },
      ],
      products: [
        {
          id: "prod_serum",
          name: "Barrier Repair Serum",
          category: "skin care",
          replenishmentDays: 60,
          marginPosture: "high",
        },
        {
          id: "prod_greens",
          name: "Daily Greens",
          category: "supplements",
          replenishmentDays: 45,
          marginPosture: "medium",
        },
      ],
      rules: [
        {
          type: "do",
          rule: "Reference the customer's prior product when it is known.",
        },
        {
          type: "dont",
          rule: "Do not imply medical outcomes or guaranteed results.",
        },
        {
          type: "suppression",
          rule: "Suppress non-marketable customers and cold unengaged winback audiences until reviewed.",
        },
      ],
      ctas: ["Restock your routine", "See your recommended refill"],
      phrases: [
        { type: "approved", phrase: "when your routine is ready for a refill" },
        { type: "avoid", phrase: "last chance" },
      ],
      compliance: {
        requiredDisclaimers: [
          "Keep product guidance educational and non-diagnostic.",
          "Use suppression/fatigue review before winback or replenishment pushes.",
        ],
        forbiddenClaims: [
          "Do not claim guaranteed medical, clinical, or body outcomes.",
          "Do not imply a product cures, treats, or prevents a condition.",
        ],
        cautionAreas: [
          "Discount language",
          "Urgency claims",
          "Medical or performance claims",
          "Before-and-after framing",
        ],
      },
      documentSources: [
        {
          id: "fixture_storefront_analysis",
          title: "Storefront positioning analysis",
          sourceType: "storefront",
          status: "applied",
          keyFindings: [
            "Position around calm repeat-purchase support instead of aggressive urgency.",
            "Product education should precede offer-led campaign copy.",
          ],
        },
        {
          id: "fixture_brand_guidelines",
          title: "Brand voice and messaging notes",
          sourceType: "manual",
          status: "applied",
          keyFindings: [
            "Use warm direct copy with concise explanation.",
            "Avoid hard last-chance pressure unless a true sale window exists.",
          ],
        },
      ],
      sourceProvenance: [
        {
          sourceType: "fixture",
          label: "Worklin demo Brand Brain fixture",
          status: "fixture",
          observedAt: generatedAt,
        },
        {
          sourceType: "campaign_memory",
          label: "Fixture replenishment and winback learnings",
          status: "fixture",
          observedAt: generatedAt,
        },
      ],
      readiness: {
        status: "partial",
        score: 72,
        completed: [
          "Brand identity and positioning baseline",
          "Voice summary and tone sliders",
          "Approved CTAs and avoid phrases",
          "Offer constraints",
          "Suppression and compliance guardrails",
          "Campaign memory examples",
        ],
        missing: [
          "Approved product-level claim library",
          "Real brand documents and founder/customer language",
          "Competitor positioning notes",
          "Live campaign outcome memory",
        ],
        nextActions: [
          "Import brand docs, prior audits, and best-performing campaigns.",
          "Approve product claims, forbidden language, CTAs, and offer rules.",
          "Persist campaign outcomes after each audit or draft review.",
        ],
      },
      campaignMemory: [
        {
          campaignType: "replenishment",
          insight:
            "Specific product memory performed better than generic reorder copy.",
          outcome: "winning",
        },
        {
          campaignType: "winback",
          insight:
            "High-pressure urgency underperformed for long-lapsed customers.",
          outcome: "avoid",
        },
      ],
      caveats: [
        "Fixture brand brain. Production should persist brand profile, rules, approved language, and learnings.",
      ],
    },
    customers: [
      {
        id: "cust_vip_001",
        email: "avery@example.com",
        shopifyCustomerId: "shp_avery",
        klaviyoProfileId: "kl_avery",
        totalOrders: 8,
        totalSpent: 1240,
        avgOrderValue: 155,
        daysSinceLastOrder: 112,
        daysSinceLastEmailClick: 14,
        dominantCategory: "skin care",
        lastProductName: "Barrier Repair Serum",
        acceptsMarketing: true,
        emailEngagementStatus: "engaged",
        productAffinity: ["skin care", "serum"],
      },
      {
        id: "cust_replenish_002",
        email: "morgan@example.com",
        shopifyCustomerId: "shp_morgan",
        klaviyoProfileId: "kl_morgan",
        totalOrders: 3,
        totalSpent: 216,
        avgOrderValue: 72,
        daysSinceLastOrder: 47,
        daysSinceLastEmailClick: 9,
        dominantCategory: "supplements",
        lastProductName: "Daily Greens",
        acceptsMarketing: true,
        emailEngagementStatus: "engaged",
        productAffinity: ["supplements"],
      },
      {
        id: "cust_winback_003",
        email: "riley@example.com",
        shopifyCustomerId: "shp_riley",
        klaviyoProfileId: "kl_riley",
        totalOrders: 2,
        totalSpent: 134,
        avgOrderValue: 67,
        daysSinceLastOrder: 214,
        daysSinceLastEmailClick: 128,
        dominantCategory: "apparel",
        lastProductName: "Everyday Hoodie",
        acceptsMarketing: true,
        emailEngagementStatus: "cold",
        productAffinity: ["apparel"],
      },
      {
        id: "cust_suppress_004",
        email: "casey@example.com",
        shopifyCustomerId: "shp_casey",
        klaviyoProfileId: null,
        totalOrders: 1,
        totalSpent: 42,
        avgOrderValue: 42,
        daysSinceLastOrder: 33,
        daysSinceLastEmailClick: null,
        dominantCategory: "accessories",
        lastProductName: "Travel Pouch",
        acceptsMarketing: false,
        emailEngagementStatus: "unknown",
        productAffinity: ["accessories"],
      },
    ],
  };
}

function connectorFor(
  dataset: RetentionDataset,
  id: RetentionConnectorId,
): RetentionConnectorSnapshot {
  const connector = dataset.connectors.find((item) => item.id === id);
  if (!connector) {
    return {
      id,
      label: id === "shopify" ? "Shopify" : "Klaviyo",
      status: "not_connected",
      lastSyncedAt: null,
      readCapabilities: [],
      writeCapabilities: [],
      blockedCapabilities:
        id === "shopify"
          ? ["shopify_write"]
          : [
              "klaviyo_send_campaign",
              "klaviyo_schedule_campaign",
              "klaviyo_activate_flow",
              "klaviyo_mutate_segment",
              "klaviyo_mutate_profile",
            ],
      caveats: ["Connector is not configured."],
    };
  }
  return connector;
}

function applyBrandOptionsToDataset(
  dataset: RetentionDataset,
  options: ComputeRetentionOptions = {},
): RetentionDataset {
  const brandName = options.brandName?.trim() || dataset.brandName;
  const websiteUrl = options.websiteUrl?.trim() || dataset.websiteUrl;
  const brandChanged = brandName !== dataset.brandName;
  const websiteChanged = websiteUrl !== dataset.websiteUrl;
  if (!brandChanged && !websiteChanged) return dataset;

  const observedAt = nowIso();
  const completed = [...dataset.brandBrain.readiness.completed];
  if (brandChanged && !completed.includes("Brand name provided in onboarding conversation")) {
    completed.push("Brand name provided in onboarding conversation");
  }
  if (
    websiteChanged &&
    !completed.includes("Brand website/domain provided in onboarding conversation")
  ) {
    completed.push("Brand website/domain provided in onboarding conversation");
  }

  const missing = dataset.brandBrain.readiness.missing.filter(
    (item) =>
      !(
        brandChanged &&
        /brand identity|positioning/i.test(item)
      ) &&
      !(
        websiteChanged &&
        /founder|customer language|brand documents/i.test(item)
      ),
  );

  const sourceProvenance = [
    ...dataset.brandBrain.sourceProvenance,
    ...(brandChanged
      ? [
          {
            sourceType: "manual_profile" as const,
            label: `Provided brand name: ${brandName}`,
            status: "draft" as const,
            observedAt,
          },
        ]
      : []),
    ...(websiteChanged && websiteUrl
      ? [
          {
            sourceType: "manual_profile" as const,
            label: `Provided website/domain: ${websiteUrl}`,
            status: "draft" as const,
            observedAt,
          },
        ]
      : []),
  ];

  return {
    ...dataset,
    brandName,
    websiteUrl,
    brandBrain: {
      ...dataset.brandBrain,
      brandName,
      websiteUrl,
      sourceProvenance,
      readiness: {
        ...dataset.brandBrain.readiness,
        status: missing.length > 0 ? "partial" : "ready",
        score: Math.min(
          88,
          dataset.brandBrain.readiness.score +
            (brandChanged ? 4 : 0) +
            (websiteChanged ? 6 : 0),
        ),
        completed,
        missing,
        nextActions: [
          "Research the public site, product pages, reviews, socials, press, and competitor positioning.",
          ...dataset.brandBrain.readiness.nextActions,
        ],
      },
      caveats: [
        ...dataset.brandBrain.caveats,
        "Brand name and website/domain may be from the current onboarding conversation; verify researched facts before draft creation.",
      ],
    },
  };
}

export function getRetentionSourceStatus(
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionSourceStatus {
  const connected = dataset.connectors.filter((c) => c.status === "connected");
  const partial = dataset.connectors.filter((c) => c.status === "partial");
  const notConnected = dataset.connectors.filter(
    (c) => c.status === "not_connected",
  );

  return {
    generatedAt: nowIso(),
    connectors: dataset.connectors,
    safety: createRetentionSafetyMetadata([
      dataset.sourceMode === "live_readonly"
        ? "No live external action was taken. Klaviyo was read through a live read-only snapshot."
        : dataset.sourceMode === "klaviyo_l365"
          ? "No live external action was taken. Worklin used a live read-only Klaviyo L365 account snapshot; Shopify commerce data was not required for this Klaviyo-only audit."
          : dataset.sourceMode === "klaviyo_inventory"
            ? "No live external action was taken. Worklin used a live read-only Klaviyo inventory snapshot; Shopify commerce data was not required for this Klaviyo-only posture check."
        : dataset.sourceMode === "mixed"
          ? "No live external action was taken. Worklin used mixed sources: live read-only Klaviyo where available and fixture/sample data where connectors are not yet connected."
        : "No live external action was taken. Current retention milestone uses fixture-backed source reads.",
    ]),
    summary: {
      connected: connected.length,
      partial: partial.length,
      notConnected: notConnected.length,
      readyForReadOnlyAudit: connected.length + partial.length > 0,
    },
  };
}

export function getRetentionBrandBrain(
  dataset: RetentionDataset = createFixtureRetentionDataset(),
  options: ComputeRetentionOptions = {},
): BrandBrainContext {
  const effectiveDataset = applyBrandOptionsToDataset(dataset, options);
  return {
    ...effectiveDataset.brandBrain,
    generatedAt: nowIso(),
    safety: createRetentionSafetyMetadata([
      "Brand Brain is fixture-backed until durable Worklin brand memory is wired.",
    ]),
  };
}

function normalizedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((raw) => {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((value) => value.trim());
}

function updateStringCollection(
  values: string[],
  correction: BrandBrainCorrection,
): string[] {
  const value = correction.value.trim();
  const previousValue = correction.previousValue?.trim();
  if (!value) throw new Error("Brand Brain correction value must not be empty.");
  if (correction.operation === "add") return normalizedUnique([...values, value]);

  const target = correction.operation === "replace" ? previousValue : value;
  if (!target) {
    throw new Error("Brand Brain replacements require the previous value being replaced.");
  }
  const targetKey = target.toLocaleLowerCase();
  const remaining = values.filter(
    (item) => item.trim().toLocaleLowerCase() !== targetKey,
  );
  return correction.operation === "replace"
    ? normalizedUnique([...remaining, value])
    : remaining;
}

/** Build a production-safe draft from onboarding facts without demo fixtures. */
export function createDraftBrandBrain(
  input: BrandBrainOnboardingInput,
): BrandBrainContext {
  const generatedAt = nowIso();
  const brandName = input.brandName.trim() || "Unnamed brand";
  const storefront = input.storefront;
  const websiteUrl = input.websiteUrl?.trim() || storefront?.url?.trim();
  const storefrontFetched = storefront?.status === "fetched";
  const findings = normalizedUnique([
    ...(storefront?.title ? [`Page title: ${storefront.title}`] : []),
    ...(storefront?.description
      ? [`Public description: ${storefront.description}`]
      : []),
    ...(storefront?.productHints ?? []).map(
      (hint) => `Observed storefront signal: ${hint}`,
    ),
  ]).slice(0, 12);

  return {
    version: BRAND_BRAIN_VERSION,
    generatedAt,
    brandName,
    ...(websiteUrl ? { websiteUrl } : {}),
    industry: "Not yet confirmed",
    positioning: {
      tagline: "",
      story:
        storefront?.description?.trim() ||
        `Initial onboarding profile for ${brandName}; positioning still needs approval.`,
      uniqueSellingProposition: "Not yet confirmed",
    },
    voice: {
      summary: "Brand voice has not yet been approved.",
      sliders: {
        formalCasual: 50,
        seriousPlayful: 50,
        reservedEnthusiastic: 50,
      },
      greetingStyle: "not_yet_specified",
      signOffStyle: "not_yet_specified",
      emojiUsage: "none",
    },
    audienceNotes: [],
    offers: [],
    products: [],
    rules: [
      {
        type: "compliance",
        rule: "Do not turn public-site observations into factual product, performance, comparative, or customer claims without evidence.",
      },
    ],
    ctas: [],
    phrases: [],
    compliance: {
      requiredDisclaimers: [],
      forbiddenClaims: [
        "Unsupported product, performance, health, comparative, scarcity, or customer-result claims",
      ],
      cautionAreas: [
        "Product and performance claims",
        "Testimonials and customer outcomes",
        "Comparisons, urgency, and scarcity",
      ],
    },
    documentSources:
      websiteUrl || findings.length > 0
        ? [
            {
              id: "onboarding_storefront_read",
              title:
                storefront?.title?.trim() ||
                `Initial public storefront read for ${brandName}`,
              sourceType: "storefront",
              status: storefrontFetched ? "analyzed" : "pending",
              keyFindings: findings,
            },
          ]
        : [],
    sourceProvenance: [
      {
        sourceType: "manual_profile",
        label: `Provided brand name: ${brandName}`,
        status: "draft",
        observedAt: generatedAt,
      },
      ...(websiteUrl
        ? [
            {
              sourceType: "store_analysis" as const,
              label: `Public storefront: ${websiteUrl}`,
              status: "draft" as const,
              observedAt: storefrontFetched ? generatedAt : null,
            },
          ]
        : []),
    ],
    readiness: {
      status: "partial",
      score: storefrontFetched ? 35 : websiteUrl ? 24 : 15,
      completed: [
        "Brand name provided in onboarding conversation",
        ...(websiteUrl
          ? ["Brand website/domain provided in onboarding conversation"]
          : []),
        ...(storefrontFetched ? ["Initial public storefront read"] : []),
      ],
      missing: [
        "Approved positioning and unique selling proposition",
        "Approved voice examples and forbidden style patterns",
        "Audience research and direct customer language",
        "Offer constraints and product-level claim evidence",
        "Approved CTAs and compliance requirements",
        "Dated campaign outcomes for the same audiences and channels",
      ],
      nextActions: [
        "Confirm positioning, audience, offers, voice boundaries, and approved examples.",
        "Attach evidence and allowed scope to every material product or performance claim.",
        "Record explicit copy corrections and verified campaign outcomes as they are approved.",
      ],
    },
    campaignMemory: [],
    caveats: normalizedUnique([
      "This is a draft onboarding profile. Public website observations are not approved claims.",
      ...(storefront?.caveat ? [storefront.caveat] : []),
    ]),
    safety: createRetentionSafetyMetadata([
      "Brand Brain creation only stored onboarding context; no external action was taken.",
    ]),
  };
}

/** Apply one explicit user-approved correction to a Brand Brain. */
export function applyBrandBrainCorrection(
  brain: BrandBrainContext,
  correction: BrandBrainCorrection,
): BrandBrainContext {
  const value = correction.value.trim();
  if (!value) throw new Error("Brand Brain correction value must not be empty.");
  if (
    [
      "voice_summary",
      "tagline",
      "brand_story",
      "unique_selling_proposition",
    ].includes(correction.field) &&
    correction.operation !== "replace"
  ) {
    throw new Error(`${correction.field} only supports the replace operation.`);
  }

  const next: BrandBrainContext = {
    ...brain,
    generatedAt: nowIso(),
    positioning: { ...brain.positioning },
    voice: { ...brain.voice, sliders: { ...brain.voice.sliders } },
    audienceNotes: [...brain.audienceNotes],
    rules: brain.rules.map((rule) => ({ ...rule })),
    ctas: [...brain.ctas],
    phrases: brain.phrases.map((phrase) => ({ ...phrase })),
    compliance: {
      requiredDisclaimers: [...brain.compliance.requiredDisclaimers],
      forbiddenClaims: [...brain.compliance.forbiddenClaims],
      cautionAreas: [...brain.compliance.cautionAreas],
    },
    sourceProvenance: [
      ...brain.sourceProvenance,
      {
        sourceType: "manual_profile",
        label: `Explicit user correction: ${correction.field}`,
        status: "approved",
        observedAt: nowIso(),
      },
    ],
    readiness: {
      ...brain.readiness,
      completed: normalizedUnique([
        ...brain.readiness.completed,
        "Explicit user-approved Brand Brain corrections",
      ]),
    },
  };

  switch (correction.field) {
    case "voice_summary":
      next.voice.summary = value;
      break;
    case "tagline":
      next.positioning.tagline = value;
      break;
    case "brand_story":
      next.positioning.story = value;
      break;
    case "unique_selling_proposition":
      next.positioning.uniqueSellingProposition = value;
      break;
    case "approved_cta":
      next.ctas = updateStringCollection(next.ctas, correction);
      break;
    case "audience_note":
      next.audienceNotes = updateStringCollection(next.audienceNotes, correction);
      break;
    case "required_disclaimer":
      next.compliance.requiredDisclaimers = updateStringCollection(
        next.compliance.requiredDisclaimers,
        correction,
      );
      break;
    case "forbidden_claim":
      next.compliance.forbiddenClaims = updateStringCollection(
        next.compliance.forbiddenClaims,
        correction,
      );
      break;
    case "caution_area":
      next.compliance.cautionAreas = updateStringCollection(
        next.compliance.cautionAreas,
        correction,
      );
      break;
    case "rule_do":
    case "rule_dont": {
      const type = correction.field === "rule_do" ? "do" : "dont";
      const updated = updateStringCollection(
        next.rules.filter((rule) => rule.type === type).map((rule) => rule.rule),
        correction,
      );
      next.rules = [
        ...next.rules.filter((rule) => rule.type !== type),
        ...updated.map((rule) => ({ type, rule } as const)),
      ];
      break;
    }
    case "approved_phrase":
    case "avoid_phrase": {
      const type = correction.field === "approved_phrase" ? "approved" : "avoid";
      const updated = updateStringCollection(
        next.phrases
          .filter((phrase) => phrase.type === type)
          .map((phrase) => phrase.phrase),
        correction,
      );
      next.phrases = [
        ...next.phrases.filter((phrase) => phrase.type !== type),
        ...updated.map((phrase) => ({ type, phrase } as const)),
      ];
      break;
    }
  }
  return next;
}

/** Add or update a verified campaign learning without treating it as a law. */
export function recordBrandBrainCampaignLearning(
  brain: BrandBrainContext,
  learning: BrandBrainCampaignLearning,
): BrandBrainContext {
  const campaignType = learning.campaignType.trim();
  const insight = learning.insight.trim();
  if (!campaignType || !insight) {
    throw new Error("Campaign type and insight must not be empty.");
  }
  const key = `${campaignType}\u0000${insight}`.toLocaleLowerCase();
  const campaignMemory = brain.campaignMemory.filter(
    (item) =>
      `${item.campaignType}\u0000${item.insight}`.toLocaleLowerCase() !== key,
  );
  campaignMemory.push({ campaignType, insight, outcome: learning.outcome });
  return {
    ...brain,
    generatedAt: nowIso(),
    campaignMemory,
    sourceProvenance: [
      ...brain.sourceProvenance,
      {
        sourceType: "campaign_memory",
        label: `Verified campaign learning: ${campaignType}`,
        status: "approved",
        observedAt: nowIso(),
      },
    ],
    readiness: {
      ...brain.readiness,
      completed: normalizedUnique([
        ...brain.readiness.completed,
        "Verified campaign outcome memory",
      ]),
    },
  };
}

export function getRetentionShopifySnapshot(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): ShopifySourceSnapshot {
  const timeframeDays = normalizePositiveInteger(
    options.timeframeDays,
    90,
    730,
  );
  const customers = dataset.customers.slice(
    0,
    normalizePositiveInteger(options.limit, 200, 500),
  );
  const customersWithOrders = customers.filter(
    (customer) => customer.totalOrders > 0,
  );
  const revenue = customers.reduce((sum, customer) => sum + customer.totalSpent, 0);
  const orders = customers.reduce((sum, customer) => sum + customer.totalOrders, 0);
  const repeatCustomers = customers.filter(
    (customer) => customer.totalOrders >= 2,
  ).length;
  const productRevenue = new Map<
    string,
    {
      productId: string;
      name: string;
      category: string;
      revenue: number;
      unitsSold: number;
      avgReplenishmentDays: number | null;
    }
  >();

  for (const customer of customers) {
    const productName = customer.lastProductName ?? "Unknown product";
    const category = customer.dominantCategory ?? "unknown";
    const existing =
      productRevenue.get(productName) ??
      {
        productId: productName.toLowerCase().replaceAll(/\W+/g, "_"),
        name: productName,
        category,
        revenue: 0,
        unitsSold: 0,
        avgReplenishmentDays:
          category === "supplements" ? 45 : category === "skin care" ? 60 : null,
      };
    existing.revenue += customer.totalSpent;
    existing.unitsSold += customer.totalOrders;
    productRevenue.set(productName, existing);
  }

  return {
    platform: "shopify",
    generatedAt: nowIso(),
    depth: "compact",
    timeframeDays,
    connector: connectorFor(dataset, "shopify"),
    summary: {
      customers: customers.length,
      customersWithOrders: customersWithOrders.length,
      orders,
      revenue: money(revenue),
      averageOrderValue: orders ? money(revenue / orders) : 0,
      repeatPurchaseRate: customers.length
        ? Number((repeatCustomers / customers.length).toFixed(4))
        : 0,
    },
    cohorts: [
      {
        key: "vip_lapsed",
        label: "VIP buyers drifting into winback",
        customers: customers.filter(
          (customer) =>
            customer.totalSpent >= 1000 ||
            customer.totalOrders >= 6 ||
            (customer.daysSinceLastOrder ?? 0) >= 90,
        ).length,
        revenue: money(
          customers
            .filter(
              (customer) =>
                customer.totalSpent >= 1000 ||
                customer.totalOrders >= 6 ||
                (customer.daysSinceLastOrder ?? 0) >= 90,
            )
            .reduce((sum, customer) => sum + customer.totalSpent, 0),
        ),
        caveats: ["Fixture cohort based on simplified recency/value rules."],
      },
      {
        key: "replenishment_window",
        label: "Likely replenishment window",
        customers: customers.filter(
          (customer) =>
            customer.daysSinceLastOrder != null &&
            customer.daysSinceLastOrder >= 35 &&
            customer.daysSinceLastOrder <= 75,
        ).length,
        revenue: money(
          customers
            .filter(
              (customer) =>
                customer.daysSinceLastOrder != null &&
                customer.daysSinceLastOrder >= 35 &&
                customer.daysSinceLastOrder <= 75,
            )
            .reduce((sum, customer) => sum + customer.totalSpent, 0),
        ),
        caveats: ["Production should use product-level replenishment windows."],
      },
    ],
    products: Array.from(productRevenue.values()).sort(
      (a, b) => b.revenue - a.revenue,
    ),
    freshness: {
      lastSyncedAt: connectorFor(dataset, "shopify").lastSyncedAt,
      status: "fixture",
    },
    caveats: [
      "Snapshot is read-only and fixture-backed.",
      "No Shopify write capability is present or registered.",
    ],
    safety: createRetentionSafetyMetadata(),
  };
}

export function getRetentionKlaviyoSnapshot(
  _options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): KlaviyoSourceSnapshot {
  if (dataset.klaviyoSnapshot) return dataset.klaviyoSnapshot;

  const campaigns = [
    {
      id: "camp_replenishment_001",
      name: "Routine Refill Reminder",
      status: "draft",
      channel: "email",
      subject: "Your routine may be ready for a refill",
    },
    {
      id: "camp_vip_001",
      name: "VIP Product Memory Winback",
      status: "sent",
      channel: "email",
      subject: "A quieter way back into your routine",
    },
  ];
  const flows = [
    {
      id: "flow_welcome",
      name: "Welcome Series",
      status: "live",
      triggerType: "new_subscriber",
    },
    {
      id: "flow_post_purchase",
      name: "Post Purchase Education",
      status: "live",
      triggerType: "placed_order",
    },
  ];
  const audiences = [
    {
      id: "list_newsletter",
      name: "Newsletter",
      type: "list" as const,
      profileCount: 1250,
    },
    {
      id: "seg_engaged_60",
      name: "Engaged 60 days",
      type: "segment" as const,
      profileCount: 540,
    },
  ];
  const lifecycleChecks = [
    { id: "welcome", label: "Welcome/new subscriber" },
    { id: "abandoned_checkout", label: "Abandoned checkout" },
    { id: "browse_abandonment", label: "Browse abandonment" },
    { id: "post_purchase", label: "Post-purchase" },
    { id: "winback", label: "Winback/reactivation" },
    { id: "sunset", label: "Sunset/suppression" },
  ];
  const presentIds = new Set(["welcome", "post_purchase"]);

  return {
    platform: "klaviyo",
    generatedAt: nowIso(),
    depth: "compact",
    connector: connectorFor(dataset, "klaviyo"),
    campaigns: {
      count: campaigns.length,
      byStatus: countBy(campaigns.map((campaign) => campaign.status)),
      recent: campaigns,
    },
    flows: {
      count: flows.length,
      activeLikeCount: flows.filter((flow) => flow.status === "live").length,
      recent: flows,
    },
    audiences: {
      lists: audiences.filter((audience) => audience.type === "list").length,
      segments: audiences.filter((audience) => audience.type === "segment")
        .length,
      top: audiences,
    },
    metrics: {
      count: 5,
      importantMetrics: {
        found: [
          "placed_order",
          "received_email",
          "opened_email",
          "clicked_email",
          "unsubscribe",
        ],
        missing: ["spam_complaint"],
        readiness: "performance_ready",
      },
    },
    lifecycleCoverage: {
      present: lifecycleChecks.filter((check) => presentIds.has(check.id)),
      missing: lifecycleChecks.filter((check) => !presentIds.has(check.id)),
      status: "derived_from_snapshot",
      caveats: [
        "Lifecycle coverage is inferred from fixture flow, campaign, and audience names.",
      ],
    },
    freshness: {
      lastSyncedAt: connectorFor(dataset, "klaviyo").lastSyncedAt,
      status: "fixture",
    },
    caveats: [
      "Snapshot is read-only and fixture-backed.",
      "Klaviyo send, schedule, flow activation, segment mutation, and profile mutation are blocked.",
    ],
    safety: createRetentionSafetyMetadata(),
  };
}

export function buildUnifiedCustomerView(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): UnifiedCustomerViewResult {
  const customers = dataset.customers.slice(
    0,
    normalizePositiveInteger(options.limit, 200, 500),
  );
  const identities = customers.map<UnifiedCustomerIdentity>((customer) => {
    const sourceCoverage = {
      shopify: Boolean(customer.shopifyCustomerId),
      klaviyo: Boolean(customer.klaviyoProfileId),
      commerce: customer.totalOrders > 0 || customer.totalSpent > 0,
      engagement:
        customer.daysSinceLastEmailClick != null ||
        customer.emailEngagementStatus !== "unknown",
    };
    const missingData = [
      !sourceCoverage.shopify ? "shopify_customer_id" : null,
      !sourceCoverage.klaviyo ? "klaviyo_profile_id" : null,
      !sourceCoverage.engagement ? "klaviyo_engagement" : null,
      !customer.acceptsMarketing ? "marketing_consent" : null,
    ].filter((item): item is string => Boolean(item));
    const confidence =
      sourceCoverage.shopify && sourceCoverage.klaviyo
        ? "high"
        : sourceCoverage.shopify || sourceCoverage.klaviyo
          ? "medium"
          : "low";

    return {
      identityId: `identity_${customer.id}`,
      email: customer.email,
      worklinCustomerId: customer.id,
      shopifyCustomerId: customer.shopifyCustomerId,
      klaviyoProfileId: customer.klaviyoProfileId,
      confidence,
      confidenceReasons: [
        sourceCoverage.shopify ? "Shopify customer present." : "",
        sourceCoverage.klaviyo ? "Klaviyo profile present." : "",
        "Email is used as the fixture identity join key.",
      ].filter(Boolean),
      sourceCoverage,
      missingData,
      caveats:
        confidence === "high"
          ? []
          : ["Identity needs source confirmation before live drafting."],
    };
  });

  return {
    generatedAt: nowIso(),
    identities,
    safety: createRetentionSafetyMetadata(),
    summary: {
      totalIdentities: identities.length,
      highConfidence: identities.filter((identity) => identity.confidence === "high")
        .length,
      lowConfidence: identities.filter((identity) => identity.confidence === "low")
        .length,
      shopifyOnly: identities.filter(
        (identity) =>
          identity.sourceCoverage.shopify && !identity.sourceCoverage.klaviyo,
      ).length,
      klaviyoOnly: identities.filter(
        (identity) =>
          !identity.sourceCoverage.shopify && identity.sourceCoverage.klaviyo,
      ).length,
      matchedAcrossSources: identities.filter(
        (identity) =>
          identity.sourceCoverage.shopify && identity.sourceCoverage.klaviyo,
      ).length,
    },
  };
}

function lifecycleStageForCustomer(
  customer: RetentionCustomer,
): RetentionCustomerFeatureSnapshot["lifecycleFeatures"]["lifecycleStage"] {
  if (customer.totalSpent >= 1000 || customer.totalOrders >= 6) return "vip";
  if (customer.daysSinceLastOrder == null) return "new";
  if (customer.daysSinceLastOrder >= 180) return "winback";
  if (customer.daysSinceLastOrder >= 90) return "at_risk";
  return "active";
}

function labelsForCustomer(customer: RetentionCustomer): string[] {
  const labels: string[] = [];
  if (customer.totalSpent >= 1000 || customer.totalOrders >= 6)
    labels.push("vip_winback");
  if (
    customer.daysSinceLastOrder != null &&
    customer.daysSinceLastOrder >= 35 &&
    customer.daysSinceLastOrder <= 75
  )
    labels.push("replenishment_ready");
  if (
    customer.daysSinceLastOrder != null &&
    customer.daysSinceLastOrder >= 120
  )
    labels.push("winback_candidate");
  if (customer.totalOrders === 1) labels.push("second_purchase_opportunity");
  if (!customer.acceptsMarketing) labels.push("suppression_required");
  if (
    customer.daysSinceLastEmailClick != null &&
    customer.daysSinceLastEmailClick <= 21
  )
    labels.push("recently_engaged");
  if (customer.emailEngagementStatus === "cold") labels.push("fatigue_risk");
  return labels;
}

export function computeRetentionCustomerFeatures(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionFeatureResult {
  const timeframeDays = normalizePositiveInteger(
    options.timeframeDays,
    90,
    730,
  );
  const limit = normalizePositiveInteger(options.limit, 200, 500);
  const computedAt = nowIso();
  const identities = buildUnifiedCustomerView({ limit }, dataset).identities;
  const identityByCustomerId = new Map(
    identities.map((identity) => [identity.worklinCustomerId, identity]),
  );
  const features = dataset.customers.slice(0, limit).map((customer) => {
    const identity = identityByCustomerId.get(customer.id);
    const lifecycleStage = lifecycleStageForCustomer(customer);
    const derivedLabels = labelsForCustomer(customer);
    const retentionPriority: "low" | "medium" | "high" = derivedLabels.some(
      (label) =>
        ["vip_winback", "replenishment_ready", "winback_candidate"].includes(
          label,
        ),
    )
      ? "high"
      : derivedLabels.includes("suppression_required") ||
          derivedLabels.includes("fatigue_risk")
        ? "medium"
        : "low";

    return {
      identityId: identity?.identityId ?? `identity_${customer.id}`,
      email: customer.email,
      featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
      timeframeDays,
      computedAt,
      status: "partial" as const,
      identityConfidence: identity?.confidence ?? "low",
      sourceCoverage:
        identity?.sourceCoverage ?? {
          shopify: false,
          klaviyo: false,
          commerce: false,
          engagement: false,
        },
      commerceFeatures: {
        totalOrders: customer.totalOrders,
        totalSpent: customer.totalSpent,
        avgOrderValue: customer.avgOrderValue,
        daysSinceLastOrder: customer.daysSinceLastOrder,
        dominantCategory: customer.dominantCategory,
        lastProductName: customer.lastProductName,
        productAffinity: customer.productAffinity,
      },
      engagementFeatures: {
        acceptsMarketing: customer.acceptsMarketing,
        daysSinceLastEmailClick: customer.daysSinceLastEmailClick,
        emailEngagementStatus: customer.emailEngagementStatus,
      },
      lifecycleFeatures: {
        lifecycleStage,
        retentionPriority,
      },
      derivedLabels,
      missingCapabilities: identity?.missingData ?? [],
      caveats: [
        "Computed from milestone fixture data; production adapter must supply persisted Shopify/Klaviyo snapshots.",
      ],
    };
  });

  const averageOrderValue =
    features.length === 0
      ? 0
      : Math.round(
          features.reduce(
            (sum, feature) => sum + feature.commerceFeatures.avgOrderValue,
            0,
          ) / features.length,
        );

  return {
    generatedAt: computedAt,
    timeframeDays,
    features,
    safety: createRetentionSafetyMetadata(),
    summary: {
      evaluatedCustomers: features.length,
      highPriorityCustomers: features.filter(
        (feature) => feature.lifecycleFeatures.retentionPriority === "high",
      ).length,
      averageOrderValue,
      caveats: [
        "This is a deterministic first-milestone feature snapshot, not a live connector sync.",
      ],
    },
  };
}

export function scoreRetentionCustomers(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionScoreResult {
  const featureResult = computeRetentionCustomerFeatures(options, dataset);
  const computedAt = nowIso();
  const scores = featureResult.features.map<CustomerScoreBundle>((feature) => {
    const daysSinceLastOrder = feature.commerceFeatures.daysSinceLastOrder ?? 0;
    const acceptsMarketing = feature.engagementFeatures.acceptsMarketing;
    const recentlyEngaged =
      feature.engagementFeatures.daysSinceLastEmailClick != null &&
      feature.engagementFeatures.daysSinceLastEmailClick <= 21;
    const replenishment = feature.derivedLabels.includes("replenishment_ready")
      ? 860
      : Math.max(100, 700 - Math.abs(daysSinceLastOrder - 55) * 6);
    const churnRisk = feature.derivedLabels.includes("winback_candidate")
      ? 870
      : daysSinceLastOrder >= 90
        ? 720
        : 280;
    const suppressionRisk = !acceptsMarketing
      ? 1000
      : feature.derivedLabels.includes("fatigue_risk")
        ? 720
        : 120;
    const scoreRecord = {
      ready_to_buy_again: clampScore(replenishment + (recentlyEngaged ? 60 : 0)),
      replenishment_readiness: clampScore(replenishment),
      churn_risk: clampScore(churnRisk),
      winback_readiness: clampScore(
        feature.derivedLabels.includes("winback_candidate") ? 840 : 180,
      ),
      vip_likelihood: clampScore(
        feature.derivedLabels.includes("vip_winback") ? 910 : 250,
      ),
      second_purchase_opportunity: clampScore(
        feature.derivedLabels.includes("second_purchase_opportunity")
          ? 780
          : 180,
      ),
      email_fatigue_risk: clampScore(
        feature.derivedLabels.includes("fatigue_risk") ? 760 : 160,
      ),
      suppression_risk: clampScore(suppressionRisk),
      product_affinity: clampScore(
        feature.commerceFeatures.productAffinity.length ? 720 : 180,
      ),
    };

    return {
      identityId: feature.identityId,
      email: feature.email,
      scoringVersion: CUSTOMER_SCORING_VERSION,
      computedAt,
      status: feature.status,
      scores: Object.fromEntries(
        Object.entries(scoreRecord).map(([name, score]) => [
          name,
          {
            score,
            tier: tierFor(score),
            reasons: [
              `Derived from labels: ${feature.derivedLabels.join(", ") || "none"}.`,
              `Source confidence: ${feature.identityConfidence}.`,
            ],
          },
        ]),
      ) as CustomerScoreBundle["scores"],
      priorityHints: feature.derivedLabels,
      caveats: feature.caveats,
    };
  });

  return {
    generatedAt: computedAt,
    scores,
    safety: createRetentionSafetyMetadata(),
    summary: {
      evaluatedCustomers: scores.length,
      highChurnRisk: scores.filter(
        (bundle) => bundle.scores.churn_risk.score >= 700,
      ).length,
      readyToBuyAgain: scores.filter(
        (bundle) => bundle.scores.ready_to_buy_again.score >= 700,
      ).length,
      suppressionRisk: scores.filter(
        (bundle) => bundle.scores.suppression_risk.score >= 700,
      ).length,
    },
  };
}

export function buildRetentionMicroSegments(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): MicroSegmentResult {
  const features = computeRetentionCustomerFeatures(options, dataset);
  const labels = new Map<string, number>();
  for (const feature of features.features) {
    for (const label of feature.derivedLabels) {
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
  }

  return {
    generatedAt: nowIso(),
    definitions: Array.from(labels.entries()).map(([label, customers], index) => ({
      definitionKey: label,
      definitionVersion: MICRO_SEGMENT_DEFINITION_VERSION,
      name: label.replaceAll("_", " "),
      description: `Definition-only Worklin segment for ${label.replaceAll("_", " ")} customers.`,
      audienceEstimate: {
        customers,
        basis: "Fixture customer feature labels.",
      },
      priority: 100 - index * 10,
      recommendedUseCases: {
        campaigns: label.includes("suppression") ? [] : ["campaign_package"],
        flows: label.includes("replenishment") ? ["post_purchase"] : [],
        suppressions: label.includes("suppression") ? ["exclude_from_send"] : [],
      },
      klaviyoNativePossible: false,
      requiresWorklinProperties: true,
      caveats: [
        "Definition is not written to Klaviyo. It is for Worklin analysis and package generation only.",
      ],
    })),
    safety: createRetentionSafetyMetadata(),
    summary: {
      totalDefinitions: labels.size,
      activationStatus: "definition_only",
    },
  };
}

export function findRetentionMissingPieces(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionMissingPiecesResult {
  const klaviyo = getRetentionKlaviyoSnapshot(options, dataset);
  const identities = buildUnifiedCustomerView(options, dataset);
  const missingPieces: RetentionMissingPiece[] = [];

  for (const missing of klaviyo.lifecycleCoverage.missing) {
    missingPieces.push({
      id: `missing_${missing.id}`,
      area: "klaviyo",
      severity:
        missing.id === "abandoned_checkout" || missing.id === "sunset"
          ? "critical"
          : "warning",
      title: `${missing.label} coverage is missing`,
      description:
        "Worklin could not verify lifecycle coverage from the current Klaviyo snapshot.",
      evidence: [`Missing lifecycle check: ${missing.label}`],
      recommendedNextAction:
        "Create an artifact-only recommendation and run retention QA before any draft is created.",
      blockedCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
      caveats: klaviyo.lifecycleCoverage.caveats,
    });
  }

  if (identities.summary.shopifyOnly > 0) {
    missingPieces.push({
      id: "identity_klaviyo_profile_gap",
      area: "identity",
      severity: "warning",
      title: "Some Shopify customers are not matched to Klaviyo profiles",
      description:
        "Worklin can score these customers from commerce data, but engagement and draft targeting need review.",
      evidence: [`${identities.summary.shopifyOnly} Shopify-only identities.`],
      recommendedNextAction:
        "Keep these customers in analysis, but mark campaign packages as needs-review.",
      blockedCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
      caveats: ["Identity matching is fixture-backed in this milestone."],
    });
  }

  return {
    generatedAt: nowIso(),
    missingPieces,
    safety: createRetentionSafetyMetadata(),
    summary: {
      total: missingPieces.length,
      critical: missingPieces.filter((piece) => piece.severity === "critical")
        .length,
      warnings: missingPieces.filter((piece) => piece.severity === "warning")
        .length,
      readyForCampaignPackages: true,
    },
  };
}

export function findRetentionCampaignOpportunities(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionOpportunityResult {
  const featureResult = computeRetentionCustomerFeatures(options, dataset);
  const missingPieces = findRetentionMissingPieces(options, dataset);
  const computedAt = nowIso();
  const replenishment = featureResult.features.filter((feature) =>
    feature.derivedLabels.includes("replenishment_ready"),
  );
  const vipWinback = featureResult.features.filter((feature) =>
    feature.derivedLabels.includes("vip_winback"),
  );
  const winback = featureResult.features.filter((feature) =>
    feature.derivedLabels.includes("winback_candidate"),
  );
  const opportunities: RetentionCampaignOpportunity[] = [];

  if (replenishment.length > 0) {
    opportunities.push({
      opportunityKey: "replenishment_nudge",
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      computedAt,
      status: "partial",
      name: "Replenishment nudge for recently engaged buyers",
      description:
        "Customers are near a likely reorder window and have recent engagement signals.",
      opportunityType: "campaign",
      recommendedCampaignType: "replenishment",
      messageAngle:
        "Helpful reorder reminder anchored to the customer's prior product.",
      audienceEstimate: {
        customers: replenishment.length,
        basis: "Customers with 35-75 days since last order.",
      },
      priority: 92,
      confidence: "high",
      whyNow: [
        "The reorder window is open.",
        "Recent engagement lowers the risk of a cold winback message.",
      ],
      linkedLabels: ["replenishment_ready", "recently_engaged"],
      futureArtifact: {
        artifactType: "campaign_brief_seed",
        title: "Replenishment Nudge Brief",
        readiness: "ready_for_brief",
      },
      blockedByMissingCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
      caveats: [
        "Audience should be rebuilt from live Shopify/Klaviyo snapshots before drafting.",
      ],
    });
  }

  if (vipWinback.length > 0 || winback.length > 0) {
    const audience = new Set(
      [...vipWinback, ...winback].map((feature) => feature.identityId),
    );
    opportunities.push({
      opportunityKey: "vip_winback_review",
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      computedAt,
      status: "partial",
      name: "VIP and lapsed buyer winback review",
      description:
        "High-value or long-lapsed customers should be reviewed before any draft-only winback package.",
      opportunityType: "review",
      recommendedCampaignType: "winback",
      messageAngle:
        "Concierge-style return path with product memory and a conservative offer.",
      audienceEstimate: {
        customers: audience.size,
        basis: "VIP buyers and customers 120+ days since last order.",
      },
      priority: 84,
      confidence: "medium",
      whyNow: [
        "The customers have meaningful prior purchase history.",
        "The lapse is long enough that suppression and offer policy should be checked.",
      ],
      linkedLabels: ["vip_winback", "winback_candidate"],
      futureArtifact: {
        artifactType: "retention_audit",
        title: "VIP Winback QA Review",
        readiness: "needs_review",
      },
      blockedByMissingCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
      caveats: [
        "Run retention QA and suppression checks before creating any Klaviyo draft.",
      ],
    });
  }

  const lifecycleCritical = missingPieces.missingPieces.find(
    (piece) => piece.area === "klaviyo" && piece.severity === "critical",
  );
  if (lifecycleCritical) {
    opportunities.push({
      opportunityKey: "lifecycle_gap_audit",
      opportunityVersion: CAMPAIGN_OPPORTUNITY_VERSION,
      computedAt,
      status: "partial",
      name: "Lifecycle coverage gap audit",
      description:
        "Klaviyo lifecycle coverage is missing critical journeys that should be reviewed before more campaigns are launched.",
      opportunityType: "lifecycle",
      recommendedCampaignType: "audit",
      messageAngle:
        "Audit-first lifecycle plan, not a send-ready marketing campaign.",
      audienceEstimate: {
        customers: featureResult.features.length,
        basis: "Account-level lifecycle gap from Klaviyo snapshot.",
      },
      priority: 78,
      confidence: "medium",
      whyNow: lifecycleCritical.evidence,
      linkedLabels: ["lifecycle_gap"],
      futureArtifact: {
        artifactType: "review_item",
        title: "Lifecycle Gap Audit",
        readiness: "needs_review",
      },
      blockedByMissingCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
      caveats: lifecycleCritical.caveats,
    });
  }

  opportunities.sort((a, b) => b.priority - a.priority);

  return {
    generatedAt: computedAt,
    opportunities,
    safety: createRetentionSafetyMetadata(),
    summary: {
      totalOpportunities: opportunities.length,
      draftOnly: true,
      highestPriority: opportunities[0]?.opportunityKey ?? null,
    },
  };
}

export function generateRetentionCampaignPackage(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): CampaignPackage {
  const brandBrain = getRetentionBrandBrain(dataset);
  const opportunities = findRetentionCampaignOpportunities(options, dataset);
  const selected =
    opportunities.opportunities.find(
      (opportunity) => opportunity.opportunityKey === options.opportunityKey,
    ) ?? opportunities.opportunities[0] ?? null;
  const safety = createRetentionSafetyMetadata(
    ["No draft was created. This package is an artifact-only Worklin result."],
    "required",
  );

  return {
    packageId: `pkg_${selected?.opportunityKey ?? "blocked"}_${Date.now()}`,
    packageVersion: CAMPAIGN_PACKAGE_VERSION,
    generatedAt: nowIso(),
    status: selected ? "package_only" : "blocked",
    approvalStatus: "required",
    opportunity: selected,
    brandContext: {
      brandName: brandBrain.brandName,
      voiceSummary: brandBrain.voice.summary,
      rulesApplied: brandBrain.rules.map((rule) => rule.rule),
    },
    audience: {
      description: selected?.audienceEstimate.basis ?? "No audience selected.",
      estimatedCustomers: selected?.audienceEstimate.customers ?? 0,
      sourceBasis:
        "Derived from Worklin fixture Shopify/Klaviyo snapshots and feature labels.",
    },
    brief: selected
      ? {
          title: selected.futureArtifact.title,
          goal: selected.description,
          angle: selected.messageAngle,
          subjectLines: [
            "Your routine may be ready for a refill",
            "A useful reminder based on your last order",
            "Need a fresh start with your routine?",
          ],
          previewTexts: [
            "A quick, respectful reminder based on what you bought before.",
            "No pressure, just a helpful timing check.",
          ],
          sections: [
            {
              heading: "Why this audience",
              body: selected.audienceEstimate.basis,
            },
            {
              heading: "Message direction",
              body: selected.messageAngle,
            },
            {
              heading: "Safety posture",
              body:
                "Package-only. Requires approval and QA before any Klaviyo draft can be created.",
            },
          ],
          cta: brandBrain.ctas[0] ?? "See your recommended refill",
          offerGuidance:
            brandBrain.offers[0]?.constraint ??
            "Use conservative offer language until brand policy is configured.",
          suppressionNotes: brandBrain.rules
            .filter((rule) => rule.type === "suppression")
            .map((rule) => rule.rule),
        }
      : null,
    safety,
    caveats: [
      "Package is fixture-backed.",
      "No live external action was taken.",
      "Klaviyo draft creation requires explicit approval and a future credential adapter.",
    ],
  };
}

export function runRetentionQa(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionQaResult {
  const campaignPackage = generateRetentionCampaignPackage(options, dataset);
  const checks: RetentionQaResult["checks"] = [
    {
      id: "no_live_action",
      status: "passed",
      message: "No live external action was taken.",
    },
    {
      id: "approval_required",
      status:
        campaignPackage.approvalStatus === "required" ? "warning" : "failed",
      message: "Klaviyo draft creation requires explicit user approval.",
    },
    {
      id: "send_schedule_blocked",
      status: campaignPackage.safety.blockedCapabilities.includes(
        "klaviyo_send_campaign",
      )
        ? "passed"
        : "failed",
      message: "Send, schedule, flow activation, and mutation capabilities are blocked.",
    },
    {
      id: "source_freshness",
      status: "warning",
      message:
        "Current milestone uses fixture snapshots; live source reads must replace them before production drafting.",
    },
    {
      id: "suppression_notes",
      status: campaignPackage.brief?.suppressionNotes.length ? "passed" : "warning",
      message: "Suppression policy is represented in the package.",
    },
  ];
  const failed = checks.some((check) => check.status === "failed");
  const warning = checks.some((check) => check.status === "warning");

  return {
    generatedAt: nowIso(),
    qaVersion: RETENTION_QA_VERSION,
    status: failed ? "failed" : warning ? "warning" : "passed",
    approvalStatus: "required",
    checks,
    reviewedPackage: campaignPackage,
    safety: createRetentionSafetyMetadata(
      ["QA result does not authorize live send or schedule."],
      "required",
    ),
  };
}

export function buildRetentionContextPack(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionContextPack {
  const effectiveDataset = applyBrandOptionsToDataset(dataset, options);
  const brandBrain = getRetentionBrandBrain(effectiveDataset);
  const sourceStatus = getRetentionSourceStatus(effectiveDataset);
  const features = computeRetentionCustomerFeatures(options, effectiveDataset);
  const missingPieces = findRetentionMissingPieces(options, effectiveDataset);
  const opportunities = findRetentionCampaignOpportunities(
    options,
    effectiveDataset,
  );

  return {
    generatedAt: nowIso(),
    title: `${effectiveDataset.brandName} retention context`,
    brandSummary: {
      brandName: brandBrain.brandName,
      voice: brandBrain.voice.summary,
      rules: brandBrain.rules.slice(0, 4).map((rule) => rule.rule),
      readiness: brandBrain.readiness,
      audienceNotes: brandBrain.audienceNotes.slice(0, 4),
      approvedCtas: brandBrain.ctas.slice(0, 4),
      avoidPhrases: brandBrain.phrases
        .filter((phrase) => phrase.type === "avoid")
        .slice(0, 5)
        .map((phrase) => phrase.phrase),
      compliance: {
        forbiddenClaims: brandBrain.compliance.forbiddenClaims.slice(0, 4),
        cautionAreas: brandBrain.compliance.cautionAreas.slice(0, 6),
      },
    },
    sourceSummary: sourceStatus.summary,
    customerSummary: features.summary,
    missingPieces: missingPieces.missingPieces.slice(0, 5).map((piece) => ({
      id: piece.id,
      severity: piece.severity,
      title: piece.title,
    })),
    topOpportunities: opportunities.opportunities.map((opportunity) => ({
      key: opportunity.opportunityKey,
      name: opportunity.name,
      audienceCustomers: opportunity.audienceEstimate.customers,
      readiness: opportunity.futureArtifact.readiness,
    })),
    safety: createRetentionSafetyMetadata([
      "Context pack excludes secrets and excludes live-action capabilities.",
    ]),
  };
}

function auditWindowFor(options: ComputeRetentionOptions): AuditWindowComparison {
  const currentWindowDays = normalizePositiveInteger(
    options.timeframeDays,
    365,
    730,
  );
  return {
    currentWindowDays,
    previousWindowDays: currentWindowDays,
    currentLabel: `Last ${currentWindowDays} days`,
    previousLabel: `Previous ${currentWindowDays} days`,
    comparisonMode:
      currentWindowDays === 365 ? "last_365_vs_previous_365" : "custom",
    caveats: [
      "Fixture-backed comparison uses representative Worklin audit signals until live snapshots are wired.",
    ],
  };
}

function chart(
  chartSpec: Omit<AuditChartSpec, "caveats"> & { caveats?: string[] },
): AuditChartSpec {
  return {
    ...chartSpec,
    caveats: chartSpec.caveats ?? [
      "Chart is generated from fixture-backed Worklin audit signals.",
    ],
  };
}

function recommendation(
  recommendationId: string,
  priority: number,
  title: string,
  action: string,
  expectedImpact: string,
  owner: AuditRecommendation["owner"] = "worklin",
): AuditRecommendation {
  return {
    recommendationId,
    priority,
    title,
    action,
    expectedImpact,
    owner,
    blockedCapabilities: [...RETENTION_BLOCKED_CAPABILITIES],
  };
}

function createDeepAuditCharts(): Record<string, AuditChartSpec> {
  return {
    revenueTrend: chart({
      chartId: "data_trust_revenue_trend",
      title: "Shopify vs Klaviyo Revenue Reconciliation",
      family: "period_trend",
      type: "line",
      data: [
        { period: "previous_365", shopifyRevenue: 31704, klaviyoRevenue: 47880 },
        { period: "current_365", shopifyRevenue: 42190, klaviyoRevenue: 51884 },
      ],
      encodings: {
        x: "period",
        y: "revenue",
        series: "source",
      },
      diagnosis:
        "Klaviyo-attributed retention revenue is materially higher than Shopify-confirmed retained revenue, so attribution and refund treatment need cleanup before forecasts are trusted.",
      recommendation:
        "Keep the audit read-only, add UTM discipline, reconcile refunds, and treat Klaviyo revenue as directional until source trust improves.",
    }),
    productFunnel: chart({
      chartId: "product_conversion_funnel",
      title: "Product Funnel by Views, Checkouts, and Orders",
      family: "product_funnel",
      type: "funnel",
      data: [
        { product: "Barrier Repair Serum", views: 4200, checkouts: 510, orders: 312 },
        { product: "Daily Greens", views: 1800, checkouts: 260, orders: 176 },
        { product: "Everyday Hoodie", views: 3600, checkouts: 140, orders: 68 },
        { product: "Travel Pouch", views: 620, checkouts: 92, orders: 61 },
      ],
      encodings: {
        stage1: "views",
        stage2: "checkouts",
        stage3: "orders",
        group: "product",
      },
      diagnosis:
        "The account has clear top performers, hidden gems, and underperformers. The biggest unlock is not more campaigns; it is routing the right products into the right lifecycle placements.",
      recommendation:
        "Use top performers as revenue anchors, increase exposure for hidden gems, and run PDP/offer tests before promoting underperformers broadly.",
    }),
    productQuadrant: chart({
      chartId: "product_exposure_conversion_quadrant",
      title: "Product Exposure vs Conversion Quadrant",
      family: "product_quadrant",
      type: "scatter",
      data: [
        { product: "Barrier Repair Serum", exposure: 4200, conversionRate: 7.43, tier: "top_performer" },
        { product: "Daily Greens", exposure: 1800, conversionRate: 9.78, tier: "hidden_gem" },
        { product: "Everyday Hoodie", exposure: 3600, conversionRate: 1.89, tier: "underperformer" },
        { product: "Travel Pouch", exposure: 620, conversionRate: 9.84, tier: "hidden_gem" },
      ],
      encodings: {
        x: "exposure",
        y: "conversionRate",
        color: "tier",
      },
      diagnosis:
        "Hidden gems have high conversion but low exposure, while underperformers consume attention without turning demand into orders.",
      recommendation:
        "Give hidden gems more welcome, browse, and post-purchase placement; keep underperformers in test lanes until conversion improves.",
    }),
    campaignCadence: chart({
      chartId: "weekly_campaign_cadence",
      title: "Weekly Campaign Cadence",
      family: "weekly_campaign_cadence",
      type: "bar",
      data: [
        { week: "W1", campaigns: 0, targetLow: 4, targetHigh: 6 },
        { week: "W2", campaigns: 3, targetLow: 4, targetHigh: 6 },
        { week: "W3", campaigns: 4, targetLow: 4, targetHigh: 6 },
        { week: "W4", campaigns: 5, targetLow: 4, targetHigh: 6 },
        { week: "W5", campaigns: 6, targetLow: 4, targetHigh: 6 },
        { week: "W6", campaigns: 2, targetLow: 4, targetHigh: 6 },
        { week: "W7", campaigns: 13, targetLow: 4, targetHigh: 6 },
        { week: "W8", campaigns: 4, targetLow: 4, targetHigh: 6 },
      ],
      encodings: {
        x: "week",
        y: "campaigns",
        bandLow: "targetLow",
        bandHigh: "targetHigh",
      },
      diagnosis:
        "Average cadence is close to the target, but weekly inconsistency creates fatigue spikes and quiet gaps.",
      recommendation:
        "Stabilize at 4-6 campaigns per week and plan one to two months ahead so urgency is intentional instead of reactive.",
    }),
    saleNonSale: chart({
      chartId: "sale_vs_non_sale_campaigns",
      title: "Sale vs Non-Sale Campaign Performance",
      family: "sale_non_sale_comparison",
      type: "comparison",
      data: [
        { type: "sale", openRate: 41.2, clickRate: 2.4, placedOrderRate: 0.18, revenuePerEmail: 0.62 },
        { type: "education", openRate: 38.7, clickRate: 4.8, placedOrderRate: 0.21, revenuePerEmail: 0.58 },
        { type: "new_arrival", openRate: 36.4, clickRate: 3.9, placedOrderRate: 0.17, revenuePerEmail: 0.47 },
        { type: "brand_story", openRate: 33.1, clickRate: 1.2, placedOrderRate: 0.05, revenuePerEmail: 0.14 },
      ],
      encodings: {
        x: "type",
        y: "revenuePerEmail",
        secondary: "clickRate",
      },
      diagnosis:
        "Sale windows drive revenue, but education and product-feature campaigns produce healthier click and purchase intent.",
      recommendation:
        "Use product education as the evergreen backbone, reserving hard urgency for true sale windows and BFCM-style moments.",
    }),
    wordBank: chart({
      chartId: "subject_line_word_bank",
      title: "Subject Line Word Bank",
      family: "subject_line_word_bank",
      type: "word_bank",
      data: [
        { word: "new", openRate: 44.8, uses: 11, orders: 94 },
        { word: "today", openRate: 43.2, uses: 8, orders: 63 },
        { word: "doctor", openRate: 42.1, uses: 5, orders: 48 },
        { word: "guide", openRate: 40.9, uses: 6, orders: 52 },
        { word: "video", openRate: 39.7, uses: 4, orders: 35 },
        { word: "last chance", openRate: 36.8, uses: 7, orders: 28 },
      ],
      encodings: {
        label: "word",
        size: "openRate",
        color: "orders",
      },
      diagnosis:
        "Benefit, novelty, and educational terms outperform heavy urgency outside sale windows.",
      recommendation:
        "Build subject lines around novelty, useful education, numbers, and product-specific outcomes; cap hard urgency outside sale periods.",
    }),
    segmentThemeHeatmap: chart({
      chartId: "segment_theme_heatmap",
      title: "Segment x Campaign Theme Heatmap",
      family: "segment_theme_heatmap",
      type: "heatmap",
      data: [
        { segment: "Engaged 0-30D", theme: "product_feature", revenuePerEmail: 0.74, ordersPerThousand: 7.8 },
        { segment: "Engaged 0-30D", theme: "sale", revenuePerEmail: 0.69, ordersPerThousand: 7.1 },
        { segment: "Engaged 31-150D", theme: "education", revenuePerEmail: 0.58, ordersPerThousand: 6.2 },
        { segment: "Engaged 151-250D", theme: "winback", revenuePerEmail: 0.31, ordersPerThousand: 3.4 },
        { segment: "SMS Engaged", theme: "product_feature", revenuePerEmail: 0.92, ordersPerThousand: 9.6 },
        { segment: "Lapsed 250D+", theme: "brand_story", revenuePerEmail: 0.08, ordersPerThousand: 0.9 },
      ],
      encodings: {
        x: "theme",
        y: "segment",
        color: "revenuePerEmail",
      },
      diagnosis:
        "Different audiences respond to different themes. Product-feature messages are strongest for engaged and SMS-engaged audiences, while lapsed audiences need tighter winback framing.",
      recommendation:
        "Create segment-specific theme rules and stop sending broad brand-story campaigns to lapsed audiences without a clear product or offer path.",
    }),
    flowWaterfall: chart({
      chartId: "flow_stage_dropoff",
      title: "Lifecycle Flow Stage Drop-Off",
      family: "flow_stage_waterfall",
      type: "waterfall",
      data: [
        { stage: "Welcome", recipients: 10000, clicks: 1224, orders: 80 },
        { stage: "Result Delivery", recipients: 9200, clicks: 497, orders: 31 },
        { stage: "Day 2 Education", recipients: 8600, clicks: 172, orders: 8 },
        { stage: "Day 4 Proof", recipients: 8200, clicks: 164, orders: 7 },
        { stage: "Last Chance", recipients: 7800, clicks: 118, orders: 4 },
      ],
      encodings: {
        x: "stage",
        y: "orders",
        secondary: "clicks",
      },
      diagnosis:
        "The flow earns early attention but does not use intent hard enough after the first high-click moments.",
      recommendation:
        "Move product routing earlier, rewrite the dead-zone emails, and trigger click-based follow-up instead of extending weak closers.",
    }),
    opportunityMatrix: chart({
      chartId: "opportunity_priority_matrix",
      title: "Opportunity Priority Matrix",
      family: "opportunity_priority_matrix",
      type: "matrix",
      data: [
        { opportunity: "Stabilize campaign cadence", impact: 86, confidence: 92, effort: "medium" },
        { opportunity: "Promote hidden gems", impact: 81, confidence: 88, effort: "low" },
        { opportunity: "Fix lifecycle gaps", impact: 91, confidence: 82, effort: "high" },
        { opportunity: "Rewrite quiz routing", impact: 74, confidence: 76, effort: "medium" },
        { opportunity: "Clean attribution", impact: 68, confidence: 90, effort: "medium" },
      ],
      encodings: {
        x: "confidence",
        y: "impact",
        label: "opportunity",
      },
      diagnosis:
        "The best first moves are not cosmetic. They are cadence stability, hidden-gem exposure, lifecycle coverage, and data trust.",
      recommendation:
        "Start with the highest-confidence opportunities before creating campaign packages or drafts.",
    }),
  };
}

function buildDeepAuditModules(
  options: ComputeRetentionOptions,
  dataset: RetentionDataset,
): RetentionAuditModule[] {
  const brandBrain = getRetentionBrandBrain(dataset);
  const shopify = getRetentionShopifySnapshot(
    { ...options, timeframeDays: options.timeframeDays ?? 365 },
    dataset,
  );
  const klaviyo = getRetentionKlaviyoSnapshot(options, dataset);
  const missingPieces = findRetentionMissingPieces(options, dataset);
  const charts = createDeepAuditCharts();

  return [
    {
      moduleId: "data_trust",
      title: "Data Trust and Source Reconciliation",
      status: "partial",
      summary:
        "Compares Shopify-confirmed commerce data against Klaviyo attribution, flags discrepancy risk, and sets the caveats for the rest of the audit.",
      charts: [charts.revenueTrend],
      insights: [
        {
          insightId: "klaviyo_shopify_delta",
          severity: "warning",
          title: "Klaviyo attribution is higher than Shopify retained revenue",
          summary:
            "The audit should use Klaviyo revenue directionally until refunds, UTM tagging, and attribution windows are reconciled.",
          evidence: [
            "Klaviyo current-period fixture revenue: $51,884.",
            "Shopify current-period fixture revenue: $42,190.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "reconcile_refunds_and_utms",
          92,
          "Clean revenue trust before forecasting",
          "Resolve refunded orders, enforce UTMs across campaigns and flows, and keep Klaviyo revenue labeled as attributed rather than confirmed.",
          "Cleaner source trust and better confidence in opportunity sizing.",
          "operator",
        ),
      ],
      caveats: [
        "Live production should reconcile actual Shopify orders, refunds, Klaviyo attribution, and campaign UTMs.",
      ],
    },
    {
      moduleId: "brand_context",
      title: "Brand Brain and Competitive Context",
      status: "partial",
      summary:
        "Captures voice, positioning, rules, offers, product memory, source provenance, compliance constraints, and campaign learnings so every downstream recommendation sounds like the brand.",
      charts: [],
      insights: [
        {
          insightId: "brand_voice_rules_available",
          severity: "info",
          title: "Brand voice and suppression rules are available",
          summary: brandBrain.voice.summary,
          evidence: [
            ...brandBrain.rules.slice(0, 3).map((rule) => rule.rule),
            `Brain readiness: ${brandBrain.readiness.status} (${brandBrain.readiness.score}/100).`,
          ],
        },
        {
          insightId: "brand_brain_readiness_gaps",
          severity:
            brandBrain.readiness.status === "ready" ? "info" : "warning",
          title: "Brand Brain readiness controls draft confidence",
          summary:
            "Worklin can audit with partial Brand Brain context, but campaign packages and drafts need approved claims, offers, CTAs, product rules, and campaign memory before they should be trusted.",
          evidence:
            brandBrain.readiness.missing.length > 0
              ? brandBrain.readiness.missing.slice(0, 5)
              : ["No Brand Brain readiness gaps reported."],
        },
      ],
      recommendations: [
        recommendation(
          "persist_brand_brain_before_drafts",
          83,
          "Persist the Brand Brain before any draft workflow",
          "Store approved voice, claims, CTAs, forbidden language, offer rules, and competitor positioning before creating draft campaigns.",
          "Fewer off-brand campaign packages and safer QA.",
        ),
      ],
      caveats: [
        ...brandBrain.caveats,
        ...brandBrain.readiness.missing
          .slice(0, 4)
          .map((item) => `Brand Brain missing: ${item}.`),
      ],
    },
    {
      moduleId: "product_performance",
      title: "Product Performance Report",
      status: "complete",
      summary:
        "Classifies products into top performers, hidden gems, and underperformers using exposure, checkout intent, orders, revenue, and lifecycle placement potential.",
      charts: [charts.productFunnel, charts.productQuadrant],
      insights: [
        {
          insightId: "product_tiers_detected",
          severity: "opportunity",
          title: "Product tiering reveals immediate lifecycle placement moves",
          summary:
            "Top performers should anchor revenue, hidden gems need more exposure, and underperformers need PDP or offer fixes before heavier promotion.",
          evidence: [
            `${shopify.products[0]?.name ?? "Top product"} is the current revenue anchor.`,
            "Daily Greens and Travel Pouch behave like hidden gems in the fixture quadrant.",
            "Everyday Hoodie has high exposure with weak order conversion.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "hidden_gem_lifecycle_placement",
          89,
          "Promote hidden gems in lifecycle surfaces",
          "Add hidden gems to welcome, browse abandon, post-purchase, and product recommendation blocks before discounting them.",
          "More incremental revenue without training customers to wait for discounts.",
        ),
        recommendation(
          "underperformer_fix_or_drop",
          78,
          "Run fix-or-drop tests for underperformers",
          "Audit PDP clarity, offer framing, social proof, format defaults, and product-specific objection handling before broad campaigns.",
          "Protects campaign quality and reduces wasted sends.",
        ),
      ],
      caveats: shopify.caveats,
    },
    {
      moduleId: "campaign_performance",
      title: "Campaign Report",
      status: "complete",
      summary:
        "Audits cadence, sale versus non-sale performance, plain-text versus designed campaign posture, subject-line language, theme mix, and weekly consistency.",
      charts: [
        charts.campaignCadence,
        charts.saleNonSale,
        charts.wordBank,
      ],
      insights: [
        {
          insightId: "cadence_inconsistent",
          severity: "warning",
          title: "Cadence is directionally right but operationally inconsistent",
          summary:
            "Campaign volume swings from quiet weeks to spike weeks, which makes performance harder to read and increases fatigue risk.",
          evidence: [
            "Fixture weekly range: 0 to 13 campaigns.",
            "Target operating band: 4-6 campaigns per week.",
          ],
        },
        {
          insightId: "education_theme_works",
          severity: "opportunity",
          title: "Product education should become the evergreen backbone",
          summary:
            "Educational and product-feature campaigns show healthier click and purchase intent than generic brand stories.",
          evidence: [
            "Product-feature and education themes outperform brand-story fixtures on click and revenue efficiency.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "campaign_cadence_operating_rule",
          94,
          "Set a 4-6 campaign weekly operating rule",
          "Plan one to two months ahead with a steady weekly mix: product education, new arrivals, selective sale windows, and audience-specific follow-ups.",
          "More stable deliverability, cleaner testing, and fewer fatigue spikes.",
        ),
        recommendation(
          "subject_line_word_bank",
          72,
          "Use the winning word bank deliberately",
          "Favor new, today, doctor, guide, video, and specific benefit language; reserve hard urgency for real sale windows.",
          "Higher opens without overusing urgency.",
        ),
      ],
      caveats: klaviyo.caveats,
    },
    {
      moduleId: "segment_analysis",
      title: "Segment Report",
      status: "complete",
      summary:
        "Normalizes performance by audience and campaign theme to identify what each segment should hear, what should be suppressed, and where white space exists.",
      charts: [charts.segmentThemeHeatmap],
      insights: [
        {
          insightId: "segment_theme_mismatch",
          severity: "opportunity",
          title: "Audience-theme fit is uneven",
          summary:
            "Engaged audiences can carry product education, SMS-engaged buyers respond strongly to product features, and lapsed audiences should not receive generic brand stories.",
          evidence: [
            "SMS Engaged + product_feature is the strongest fixture cell.",
            "Lapsed 250D+ + brand_story is the weakest fixture cell.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "segment_theme_rules",
          86,
          "Create segment-specific campaign rules",
          "Define cadence, themes, subject frameworks, and suppression rules for engaged, warming, SMS-engaged, and lapsed audiences.",
          "Sharper personalization without mutating Klaviyo segments in v1.",
        ),
      ],
      caveats: [
        "Segments remain definition-only. Worklin does not create or mutate Klaviyo segments in this version.",
      ],
    },
    {
      moduleId: "lifecycle_flow",
      title: "Flow and Lifecycle Report",
      status: "partial",
      summary:
        "Checks lifecycle coverage, flow inventory, stage drop-off, quiz or diagnostic routing, stale tests, and missing winback or replenishment paths.",
      charts: [charts.flowWaterfall],
      insights: [
        {
          insightId: "critical_lifecycle_gaps",
          severity: missingPieces.summary.critical > 0 ? "critical" : "warning",
          title: "Lifecycle coverage has missing pieces",
          summary:
            "Missing checkout, browse, winback, replenishment, or sunset coverage should be fixed before increasing campaign volume.",
          evidence: missingPieces.missingPieces
            .filter((piece) => piece.area === "klaviyo")
            .slice(0, 4)
            .map((piece) => piece.title),
        },
      ],
      recommendations: [
        recommendation(
          "flow_gap_roadmap",
          91,
          "Build the priority lifecycle roadmap",
          "Prioritize abandoned checkout/cart, browse abandon, post-purchase education, replenishment, winback, review, birthday, and sunset coverage.",
          "More automated revenue and fewer one-off campaign dependencies.",
        ),
      ],
      caveats: missingPieces.missingPieces.flatMap((piece) => piece.caveats).slice(0, 4),
    },
    {
      moduleId: "acquisition_tofu",
      title: "Acquisition and TOFU Pressure Report",
      status: "partial",
      summary:
        "Connects retention performance to new-customer acquisition, source quality, direct/unassigned attribution, and front-door product performance.",
      charts: [charts.revenueTrend],
      insights: [
        {
          insightId: "acquisition_context_partial",
          severity: "warning",
          title: "Acquisition analysis is partial without ad and analytics sources",
          summary:
            "Shopify and Klaviyo can show repeat-buyer pressure, but GA4, Search Console, and ad accounts are needed for full TOFU diagnosis.",
          evidence: [
            "Current implementation uses Shopify/Klaviyo fixture signals only.",
            "Direct and unassigned revenue should be audited when analytics sources are connected.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "tofu_source_expansion",
          64,
          "Add optional analytics and ad-source connectors later",
          "Keep Shopify/Klaviyo as v1 sources, then add GA4, Google Ads, Search Console, Meta, and TikTok for full acquisition context.",
          "Better diagnosis of whether retention issues are really acquisition mix issues.",
          "brand",
        ),
      ],
      caveats: [
        "This module is intentionally partial until analytics and ad platform sources exist.",
      ],
    },
    {
      moduleId: "quiz_funnel",
      title: "Quiz and Lead-Magnet Funnel Report",
      status: "partial",
      summary:
        "Audits diagnostic quizzes and lead magnets for intent capture, product routing, dead-zone emails, click-to-order leakage, and early unsubscribe risk.",
      charts: [charts.flowWaterfall],
      insights: [
        {
          insightId: "quiz_intent_underused",
          severity: "opportunity",
          title: "Quiz intent should route earlier to product paths",
          summary:
            "The Dr. Rachel-style audit pattern shows quiz flows often earn clicks but delay product recommendation and fail to use diagnostic answers hard enough.",
          evidence: [
            "Early flow stages carry the strongest clicks.",
            "Later closers weaken unless the message branches by intent.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "quiz_path_routing",
          74,
          "Move product routing earlier in quiz flows",
          "Create answer-based paths, rewrite dead-zone emails, and trigger click-based follow-up instead of extending weak generic closers.",
          "Higher click-to-order conversion from existing quiz intent.",
        ),
      ],
      caveats: [
        "Quiz analysis is conditional. If a brand has no quiz or lead magnet, Worklin should mark this module not applicable in production.",
      ],
    },
    {
      moduleId: "opportunity_backlog",
      title: "Prioritized Opportunity Backlog",
      status: "complete",
      summary:
        "Ranks the audit findings by impact, confidence, and effort so Worklin can turn the audit into an operating plan without creating drafts or external changes.",
      charts: [charts.opportunityMatrix],
      insights: [
        {
          insightId: "backlog_prioritizes_safe_moves",
          severity: "opportunity",
          title: "The strongest first moves are operational, not live sends",
          summary:
            "Campaign cadence, hidden-gem exposure, lifecycle gaps, attribution trust, and quiz routing are the highest-value areas to fix before generating drafts.",
          evidence: [
            "Every backlog item is artifact-only.",
            "No item is allowed to send, schedule, activate, or mutate external systems.",
          ],
        },
      ],
      recommendations: [
        recommendation(
          "audit_to_backlog_operating_loop",
          95,
          "Turn the audit into a weekly operating loop",
          "Use the weekly scan to update the backlog, the monthly refresh to regenerate charts, and the quarterly review to reset strategy.",
          "Creates autonomous retention momentum without unsafe live actions.",
        ),
      ],
      caveats: [
        "Backlog items are recommendations only. Campaign packages and drafts remain separate approval-gated workflows.",
      ],
    },
  ];
}

function buildOpportunityBacklog(
  modules: RetentionAuditModule[],
): OpportunityBacklogItem[] {
  const items: OpportunityBacklogItem[] = [
    {
      backlogKey: "stabilize_campaign_cadence",
      sourceModuleId: "campaign_performance",
      title: "Stabilize campaign cadence at 4-6 sends per week",
      type: "campaign",
      impact: 86,
      confidence: 92,
      effort: "medium",
      nextAction:
        "Create a 30-day campaign calendar with product education as the evergreen backbone.",
      artifactOnly: true,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "promote_hidden_gems",
      sourceModuleId: "product_performance",
      title: "Give hidden-gem products more lifecycle exposure",
      type: "product",
      impact: 81,
      confidence: 88,
      effort: "low",
      nextAction:
        "Place hidden gems into welcome, browse, post-purchase, and product recommendation blocks.",
      artifactOnly: true,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "repair_lifecycle_gaps",
      sourceModuleId: "lifecycle_flow",
      title: "Repair missing lifecycle coverage",
      type: "flow",
      impact: 91,
      confidence: 82,
      effort: "high",
      nextAction:
        "Prioritize abandoned checkout, browse, replenishment, winback, review, and sunset coverage.",
      artifactOnly: true,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "clean_attribution",
      sourceModuleId: "data_trust",
      title: "Clean attribution and refund reconciliation",
      type: "data_trust",
      impact: 68,
      confidence: 90,
      effort: "medium",
      nextAction:
        "Enforce UTMs, reconcile refunded orders, and label Klaviyo revenue as attributed until reconciled.",
      artifactOnly: true,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "quiz_intent_routing",
      sourceModuleId: "quiz_funnel",
      title: "Rewrite quiz routing around diagnostic intent",
      type: "quiz",
      impact: 74,
      confidence: 76,
      effort: "medium",
      nextAction:
        "Move product recommendation earlier and branch follow-up by quiz answer and click behavior.",
      artifactOnly: true,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
    },
  ];
  const presentModuleIds = new Set(modules.map((module) => module.moduleId));
  return items
    .filter((item) => presentModuleIds.has(item.sourceModuleId))
    .sort((a, b) => b.impact * b.confidence - a.impact * a.confidence);
}

function moduleDataRead(
  moduleId: RetentionAuditModule["moduleId"],
  dataset: RetentionDataset,
): string[] {
  const sourceMode = dataset.sourceMode ?? "fixture";
  const klaviyoSnapshot = dataset.klaviyoSnapshot;
  switch (moduleId) {
    case "data_trust":
      return [
        `Source mode: ${sourceMode}`,
        `Connectors: ${dataset.connectors
          .map((connector) => `${connector.label} ${connector.status}`)
          .join(", ")}`,
        `Brand URL: ${dataset.websiteUrl ?? "not provided"}`,
      ];
    case "brand_context":
      return [
        `Brand Brain: ${dataset.brandBrain.brandName}`,
        `Industry: ${dataset.brandBrain.industry}`,
        `Readiness: ${dataset.brandBrain.readiness.status} (${dataset.brandBrain.readiness.score}/100)`,
        `${dataset.brandBrain.rules.length} brand rules`,
        `${dataset.brandBrain.campaignMemory.length} campaign learnings`,
        `${dataset.brandBrain.documentSources.length} Brain document sources`,
        `${dataset.brandBrain.sourceProvenance.length} provenance records`,
      ];
    case "product_performance":
      return [
        `${dataset.customers.length} customer records`,
        "Shopify product, order, revenue, repeat purchase, AOV, affinity, and replenishment signals",
        "Current 365-day window compared against the previous 365-day window",
      ];
    case "campaign_performance":
      return [
        klaviyoSnapshot
          ? `${klaviyoSnapshot.campaigns.count} Klaviyo campaigns`
          : "Campaign cadence and theme fixture patterns until live Klaviyo campaign metrics are fully normalized",
        "Subject lines, send cadence, sale/non-sale posture, themes, and timing signals",
      ];
    case "segment_analysis":
      return [
        klaviyoSnapshot
          ? `${klaviyoSnapshot.audiences.lists} lists and ${klaviyoSnapshot.audiences.segments} segments`
          : "Segment and list fixture patterns until live Klaviyo audience metrics are fully normalized",
        "Segment x campaign-theme response, revenue concentration, and whitespace signals",
      ];
    case "lifecycle_flow":
      return [
        klaviyoSnapshot
          ? `${klaviyoSnapshot.flows.count} Klaviyo flows`
          : "Lifecycle flow fixture coverage until live Klaviyo flow metrics are fully normalized",
        "Welcome, browse, cart/checkout, post-purchase, replenishment, winback, VIP, review, birthday, and sunset coverage",
      ];
    case "acquisition_tofu":
      return [
        "Top-of-funnel campaign pressure, lead capture, first-purchase conversion, list growth, and acquisition handoff signals where available",
      ];
    case "quiz_funnel":
      return [
        "Quiz, diagnostic, lead magnet, product-routing, click-to-order, and early unsubscribe signals where available",
      ];
    case "opportunity_backlog":
      return [
        "All completed audit module insights, recommendations, chart diagnoses, confidence, impact, and effort estimates",
      ];
  }
}

function moduleRuleApplied(
  moduleId: RetentionAuditModule["moduleId"],
): string {
  switch (moduleId) {
    case "data_trust":
      return "Reconcile source freshness, attribution posture, missing connectors, caveats, and blocked external capabilities before trusting recommendations.";
    case "brand_context":
      return "Map brand voice, offers, approved language, forbidden claims, product posture, CTAs, and prior campaign learnings into the audit context.";
    case "product_performance":
      return "Classify products into top performers, hidden gems, and underperformers using exposure, revenue, conversion intent, affinity, and replenishment usefulness.";
    case "campaign_performance":
      return "Compare weekly send cadence, subject-line language, themes, sale posture, design posture, send timing, and segment response against a healthy retention operating rhythm.";
    case "segment_analysis":
      return "Find segment concentration, revenue-per-campaign differences, theme-response patterns, and audience whitespace without mutating Klaviyo segments.";
    case "lifecycle_flow":
      return "Audit lifecycle coverage and drop-off across welcome, browse, cart/checkout, post-purchase, replenishment, winback, VIP, review, birthday, and sunset stages.";
    case "acquisition_tofu":
      return "Check whether acquisition and first-purchase messaging feed retention loops instead of creating one-off list growth with weak downstream conversion.";
    case "quiz_funnel":
      return "Check whether quiz and lead-magnet intent is captured early, routed into product paths, and followed up without generic dead-zone messaging.";
    case "opportunity_backlog":
      return "Rank the audit findings by impact, confidence, effort, safety posture, and whether Worklin can act through artifact-only next steps.";
  }
}

function evidenceForModule(module: RetentionAuditModule): string[] {
  const evidence = [
    ...module.insights.flatMap((insight) => insight.evidence),
    ...module.charts.map((chart) => chart.diagnosis),
  ].filter((item) => item.trim().length > 0);
  return evidence.length > 0 ? evidence.slice(0, 4) : [module.summary];
}

function recommendationForModule(module: RetentionAuditModule): string {
  const firstRecommendation = module.recommendations[0];
  if (!firstRecommendation) {
    return "No immediate action. Keep monitoring this module in the next audit cycle.";
  }
  return `${firstRecommendation.title}: ${firstRecommendation.action}`;
}

function buildAuditTrace(
  modules: RetentionAuditModule[],
  window: AuditWindowComparison,
  dataset: RetentionDataset,
): AuditReasoningCard[] {
  const analysisWindow = `${window.currentLabel} compared with ${window.previousLabel}`;
  const sourceMode = dataset.sourceMode ?? "fixture";
  return modules.map((module) => {
    const firstInsight = module.insights[0];
    return {
      cardId: `audit_trace_${module.moduleId}`,
      moduleId: module.moduleId,
      title: module.title,
      status: module.status,
      analysisWindow,
      dataRead: moduleDataRead(module.moduleId, dataset),
      ruleApplied: moduleRuleApplied(module.moduleId),
      rationale: firstInsight
        ? `${module.summary} Key signal: ${firstInsight.summary}`
        : module.summary,
      evidence: evidenceForModule(module),
      caveats:
        module.caveats.length > 0
          ? module.caveats
          : [`Source mode: ${sourceMode}. No external writes were attempted.`],
      recommendation: recommendationForModule(module),
    };
  });
}

function chartValueToMarkdown(value: string | number | boolean | null): string {
  if (value == null) return "-";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(value).replaceAll("|", "\\|");
}

function chartColumns(chartSpec: AuditChartSpec): string[] {
  const encodedColumns = Object.values(chartSpec.encodings);
  const dataColumns = chartSpec.data.flatMap((row) => Object.keys(row));
  return Array.from(new Set([...encodedColumns, ...dataColumns])).slice(0, 7);
}

function chartTableMarkdown(chartSpec: AuditChartSpec): string {
  const columns = chartColumns(chartSpec);
  if (columns.length === 0 || chartSpec.data.length === 0) {
    return "_No chart data available._";
  }

  const rows = chartSpec.data
    .slice(0, 12)
    .map((row, index) => {
      const values = columns
        .map((column) => `${column}: ${chartValueToMarkdown(row[column] ?? null)}`)
        .join("; ");
      return `${index + 1}. ${values}`;
    });

  return ["Data points:", ...rows].join("\n");
}

function chartArtifactMarkdown(chartSpec: AuditChartSpec): string {
  return [
    `### ${chartSpec.title}`,
    "",
    `Artifact family: ${chartSpec.family}`,
    `Chart type: ${chartSpec.type}`,
    "",
    chartTableMarkdown(chartSpec),
    "",
    `Diagnosis: ${chartSpec.diagnosis}`,
    "",
    `Recommendation: ${chartSpec.recommendation}`,
    "",
    "Caveats:",
    ...chartSpec.caveats.map((caveat) => `- ${caveat}`),
  ].join("\n");
}

function moduleDepthChecklist(module: RetentionAuditModule): string[] {
  switch (module.moduleId) {
    case "product_performance":
      return [
        "Separate top performers, hidden gems, and underperformers.",
        "Explain whether the issue is exposure, conversion, lifecycle placement, or offer quality.",
        "Turn product findings into concrete welcome, browse, post-purchase, and replenishment placements.",
      ];
    case "campaign_performance":
      return [
        "Show campaign cadence against the 4-6 per week operating band.",
        "Separate sale, non-sale, education, product-feature, new-arrival, and brand-story themes.",
        "Build a subject-line word bank and identify language to reuse or avoid.",
      ];
    case "segment_analysis":
      return [
        "Normalize performance by audience and theme.",
        "Identify whitespace where a segment is receiving the wrong message type or no message at all.",
        "Keep every segment recommendation definition-only until explicitly approved later.",
      ];
    case "lifecycle_flow":
      return [
        "Check welcome, browse, cart, checkout, post-purchase, replenishment, winback, VIP, review, birthday, and sunset coverage.",
        "Call out missing stages before recommending more campaign volume.",
        "Separate inferred flow coverage from message-level analysis when content has not been fetched yet.",
      ];
    case "data_trust":
      return [
        "Reconcile Shopify-confirmed commerce against Klaviyo-attributed revenue.",
        "Flag source freshness, missing connectors, refunds, UTMs, and attribution-window caveats.",
        "Keep forecasts directional until trust gaps are resolved.",
      ];
    case "brand_context":
      return [
        "Persist voice, positioning, claims boundaries, CTAs, offers, and forbidden language.",
        "Carry brand rules into every recommendation and campaign package.",
        "Separate real account data from Brand Brain setup data.",
      ];
    case "acquisition_tofu":
      return [
        "Connect top-of-funnel pressure to first-purchase and retention quality.",
        "Name missing analytics/ad-source connectors instead of pretending the data exists.",
        "Use Shopify and Klaviyo as v1 sources until GA4, ads, and Search Console are connected.",
      ];
    case "quiz_funnel":
      return [
        "Audit diagnostic intent capture, product routing, dead-zone emails, and click-to-order leakage.",
        "Recommend quiz follow-up branches without mutating flows or segments.",
        "Separate known quiz signals from inferred funnel gaps.",
      ];
    case "opportunity_backlog":
      return [
        "Rank by impact, confidence, effort, and safety.",
        "Convert findings into artifact-only next actions.",
        "Keep live sends, schedules, flow activation, and segment mutation blocked.",
      ];
  }
}

function markdownForDeepAudit(input: {
  auditTitle: string;
  brandName: string;
  sourceMode: NonNullable<RetentionDataset["sourceMode"]>;
  window: AuditWindowComparison;
  modules: RetentionAuditModule[];
  auditTrace: AuditReasoningCard[];
  backlog: OpportunityBacklogItem[];
  safety: RetentionSafetyMetadata;
}): string {
  const allCharts = Array.from(
    new Map(
      input.modules
        .flatMap((module) => module.charts)
        .map((chartSpec) => [chartSpec.chartId, chartSpec]),
    ).values(),
  );
  const moduleScorecard = input.modules
    .map(
      (module) =>
        [
          `- ${module.title}`,
          `  - Status: ${module.status}`,
          `  - Artifact charts: ${module.charts.length}`,
          `  - Insights: ${module.insights.length}`,
          `  - Recommendations: ${module.recommendations.length}`,
          `  - Summary: ${module.summary}`,
        ].join("\n"),
    )
    .join("\n\n");
  const moduleSections = input.modules
    .map((module) => {
      const insightLines = module.insights
        .map((insight) => `- ${insight.title}: ${insight.summary}`)
        .join("\n");
      const recommendationLines = module.recommendations
        .map((item) => `- ${item.title}: ${item.action}`)
        .join("\n");
      const chartLines = module.charts
        .map((item) => `- ${item.title}: ${item.diagnosis}`)
        .join("\n");
      const playbookLines = moduleDepthChecklist(module)
        .map((item) => `- ${item}`)
        .join("\n");
      const caveatLines = module.caveats.map((item) => `- ${item}`).join("\n");
      return [
        `## ${module.title}`,
        "",
        `Status: ${module.status}`,
        "",
        module.summary,
        "",
        "Depth checklist:",
        playbookLines,
        "",
        chartLines ? "Charts:\n" + chartLines : "Charts: none for this module.",
        "",
        insightLines ? "Insights:\n" + insightLines : "Insights: none.",
        "",
        recommendationLines
          ? "Recommendations:\n" + recommendationLines
          : "Recommendations: none.",
        "",
        caveatLines ? "Caveats:\n" + caveatLines : "Caveats: none.",
      ].join("\n");
    })
    .join("\n\n");
  const auditTraceSections = input.auditTrace
    .map((card) => {
      const dataRead = card.dataRead.map((item) => `- ${item}`).join("\n");
      const evidence = card.evidence.map((item) => `- ${item}`).join("\n");
      const caveats = card.caveats.map((item) => `- ${item}`).join("\n");
      return [
        `### ${card.title}`,
        "",
        `Status: ${card.status}`,
        `Analysis window: ${card.analysisWindow}`,
        "",
        "Data read:",
        dataRead || "- None",
        "",
        `Rule applied: ${card.ruleApplied}`,
        "",
        `Why it matters: ${card.rationale}`,
        "",
        "Evidence:",
        evidence || "- No evidence available.",
        "",
        `Recommendation: ${card.recommendation}`,
        "",
        "Caveats:",
        caveats || "- None",
      ].join("\n");
    })
    .join("\n\n");
  const backlogLines = input.backlog
    .map(
      (item, index) =>
        `${index + 1}. ${item.title} - impact ${item.impact}, confidence ${item.confidence}. Next: ${item.nextAction}`,
    )
    .join("\n");
  const artifactSections = allCharts.map(chartArtifactMarkdown).join("\n\n");
  const operatingLoop = [
    "- First run: Build the baseline account map. Output: full deep audit, chart artifact, and opportunity backlog. Safety: read-only, no external action.",
    "- Weekly: Detect what changed. Output: short opportunity scan and backlog updates. Safety: no drafts unless explicitly approved later.",
    "- Monthly: Refresh the scorecard. Output: regenerated charts, module status, and priorities. Safety: read-only source refresh.",
    "- Quarterly: Reset strategy. Output: strategic roadmap and lifecycle review. Safety: approval required before any draft workflow.",
  ].join("\n");

  return [
    `# ${input.auditTitle}`,
    "",
    `Brand: ${input.brandName}`,
    `Window: ${input.window.currentLabel} compared with ${input.window.previousLabel}`,
    "",
    "## Executive Summary",
    "",
    "Worklin completed a full-scope Shopify + Klaviyo retention audit modeled on the manual Dr. Rachel-style audit: data trust, Brand Brain, products, campaigns, segments, flows, acquisition pressure, quiz/funnel logic, and opportunity prioritization.",
    "",
    "This audit is designed to be a working artifact, not a short chat answer. It includes the reasoning trace, module scorecard, visual chart artifacts, data tables, diagnoses, recommendations, opportunity backlog, operating cadence, and safety/provenance boundary.",
    "",
    "## Module Scorecard",
    "",
    moduleScorecard,
    "",
    "## Visual Artifact Pack",
    "",
    artifactSections || "No visual artifacts generated.",
    "",
    "## Audit Reasoning Trace",
    "",
    "This is Worklin's user-visible audit trace: what each module inspected, which rule it applied, what evidence it found, and what action it recommends. It is not private model scratchpad.",
    "",
    auditTraceSections || "No audit reasoning trace generated.",
    "",
    moduleSections,
    "",
    "## Opportunity Backlog",
    "",
    backlogLines || "No backlog items generated.",
    "",
    "## Recommended Operating Loop",
    "",
    operatingLoop,
    "",
    "## Safety & Provenance",
    "",
    `- Source mode: ${input.sourceMode === "fixture" ? "fixture/sample data for explicit demos only" : input.sourceMode === "live_readonly" ? "live read-only source data through Worklin-managed credentials" : input.sourceMode === "klaviyo_l365" ? "live read-only Klaviyo L365 account data; Shopify commerce data was optional enrichment and was not used" : input.sourceMode === "klaviyo_inventory" ? "live read-only Klaviyo inventory data only" : "mixed live read-only and fixture/sample data; not valid as a real-client audit unless explicitly run in demo mode"}.`,
    "- Audit output is artifact-only and backlog-only.",
    "- No external action was taken.",
    "- externalActionTaken:false",
    "- canGoLiveNow:false",
    `- Blocked capabilities: ${input.safety.blockedCapabilities.join(", ")}`,
  ].join("\n");
}

export function buildDeepRetentionAudit(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionAuditRun {
  const generatedAt = nowIso();
  const window = auditWindowFor(options);
  const effectiveDataset = applyBrandOptionsToDataset(dataset, options);
  const modules = buildDeepAuditModules(
    { ...options, timeframeDays: window.currentWindowDays },
    effectiveDataset,
  );
  const opportunityBacklog = buildOpportunityBacklog(modules);
  const auditTrace = buildAuditTrace(modules, window, effectiveDataset);
  const charts = Array.from(
    new Map(
      modules
        .flatMap((module) => module.charts)
        .map((chart) => [chart.chartId, chart]),
    ).values(),
  );
  const recommendations = modules.flatMap((module) => module.recommendations);
  const sourceMode = effectiveDataset.sourceMode ?? "fixture";
  const sourceModeCaveat =
    sourceMode === "live_readonly"
      ? "Deep audit used live read-only source data through Worklin-managed credentials."
      : sourceMode === "klaviyo_l365"
        ? "Audit used live read-only Klaviyo L365 account data through Worklin-managed credentials. Shopify commerce data was not required for this Klaviyo-only audit."
        : sourceMode === "klaviyo_inventory"
          ? "Audit used live read-only Klaviyo inventory data through Worklin-managed credentials."
      : sourceMode === "mixed"
        ? "Deep audit used mixed source data: live read-only signals plus fixture/sample sources. This is demo-only and must not be presented as a real client audit."
        : "Deep audit is read-only and fixture-backed in this milestone.";
  const safety = createRetentionSafetyMetadata(
    [
      sourceModeCaveat,
      "Output is artifact-only plus opportunity backlog; no Klaviyo drafts, sends, schedules, or Shopify writes were attempted.",
    ],
    "not_required",
  );
  const title = "Deep Retention Audit";
  const artifact: RetentionAuditArtifact = {
    title,
    contentMarkdown: markdownForDeepAudit({
      auditTitle: title,
      brandName: effectiveDataset.brandName,
      sourceMode,
      window,
      modules,
      auditTrace,
      backlog: opportunityBacklog,
      safety,
    }),
    charts,
    generatedAt,
    exportReady: true,
  };

  return {
    auditId: `audit_${window.currentWindowDays}_${generatedAt.replaceAll(/\W+/g, "_")}`,
    auditVersion: DEEP_RETENTION_AUDIT_VERSION,
    generatedAt,
    cadence: options.cadence ?? "first_run",
    title,
    brandName: effectiveDataset.brandName,
    window,
    modules,
    auditTrace,
    opportunityBacklog,
    artifact,
    actionLog: {
      eventType: "retention_deep_audit",
      actionType: "deep_account_analysis",
      status: "prepared",
      riskLevel: "medium",
      requiresApproval: false,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
      summary:
        "Prepared a full-scope Worklin Shopify + Klaviyo deep retention audit and opportunity backlog.",
    },
    safety,
    summary: {
      moduleCount: modules.length,
      chartCount: charts.length,
      recommendationCount: recommendations.length,
      backlogCount: opportunityBacklog.length,
      sourceMode,
    },
  };
}

export function getRetentionAuditStatus(
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionAuditStatus {
  const availableConnectors = dataset.connectors
    .filter((connector) => connector.status !== "not_connected")
    .map((connector) => connector.id);
  const requiredConnectors: RetentionConnectorId[] = ["shopify", "klaviyo"];
  const missingConnectors = requiredConnectors.filter(
    (connector) => !availableConnectors.includes(connector),
  );

  return {
    generatedAt: nowIso(),
    status:
      missingConnectors.length === 0
        ? "ready"
        : availableConnectors.length > 0
          ? "partial"
          : "blocked",
    nextRunRecommended: "first_run",
    requiredConnectors,
    availableConnectors,
    missingConnectors,
    safety: createRetentionSafetyMetadata([
      "Status check is read-only and does not contact external systems.",
    ]),
    caveats:
      missingConnectors.length === 0
        ? [
            "Fixture connectors are available. Production readiness requires Worklin-managed live source snapshots.",
          ]
        : [
            "Connect Shopify and Klaviyo before a production deep audit run.",
          ],
  };
}

export function scheduleRetentionAudit(): RetentionAuditSchedulePlan {
  return {
    generatedAt: nowIso(),
    status: "planned",
    schedules: [
      {
        cadence: "weekly",
        label: "Weekly opportunity scan",
        intervalDays: 7,
        purpose:
          "Detect changed performance, missing opportunities, and urgent lifecycle gaps without regenerating the full strategy audit.",
      },
      {
        cadence: "monthly",
        label: "Monthly deep refresh",
        intervalDays: 30,
        purpose:
          "Refresh the main visual audit scorecard, charts, and opportunity backlog.",
      },
      {
        cadence: "quarterly",
        label: "Quarterly strategy review",
        intervalDays: 90,
        purpose:
          "Regenerate the full strategic audit and roadmap for the next operating cycle.",
      },
    ],
    safety: createRetentionSafetyMetadata([
      "This returns a Worklin schedule plan only. It does not create an external cron job in the fixture milestone.",
    ]),
    caveats: [
      "Production should bind this plan to Worklin's native scheduler after live connector readiness checks.",
    ],
  };
}

export function generateRetentionAuditArtifact(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
): RetentionAuditArtifact {
  return buildDeepRetentionAudit(options, dataset).artifact;
}

function buildAuditMarkdown(input: {
  brandBrain: BrandBrainContext;
  shopify: ShopifySourceSnapshot;
  klaviyo: KlaviyoSourceSnapshot;
  identities: UnifiedCustomerViewResult;
  missingPieces: RetentionMissingPiecesResult;
  opportunities: RetentionOpportunityResult;
  qa: RetentionQaResult;
}): string {
  const topOpportunity = input.opportunities.opportunities[0];
  const missingLines = input.missingPieces.missingPieces
    .slice(0, 5)
    .map((piece) => `- ${piece.severity.toUpperCase()}: ${piece.title}`)
    .join("\n");
  const lifecycleMissing = input.klaviyo.lifecycleCoverage.missing
    .map((piece) => piece.label)
    .join(", ");
  const brainCompleted = input.brandBrain.readiness.completed
    .slice(0, 6)
    .map((item) => `- ${item}`)
    .join("\n");
  const brainMissing = input.brandBrain.readiness.missing
    .slice(0, 6)
    .map((item) => `- ${item}`)
    .join("\n");
  const avoidPhrases = input.brandBrain.phrases
    .filter((phrase) => phrase.type === "avoid")
    .slice(0, 6)
    .map((phrase) => `- ${phrase.phrase}`)
    .join("\n");
  const complianceCautions = input.brandBrain.compliance.cautionAreas
    .slice(0, 6)
    .map((area) => `- ${area}`)
    .join("\n");

  return [
    "# Retention Audit",
    "",
    `Brand: ${input.brandBrain.brandName}`,
    `Voice: ${input.brandBrain.voice.summary}`,
    "",
    "## Brand Brain Readiness",
    "",
    `- Status: ${input.brandBrain.readiness.status}`,
    `- Score: ${input.brandBrain.readiness.score}/100`,
    `- Audience notes: ${input.brandBrain.audienceNotes.slice(0, 3).join(" ")}`,
    "",
    "What Worklin already knows:",
    brainCompleted || "- No completed Brain fields yet.",
    "",
    "What Worklin still needs:",
    brainMissing || "- No missing Brain fields reported.",
    "",
    "Avoid phrases:",
    avoidPhrases || "- No avoid phrases configured.",
    "",
    "Compliance caution areas:",
    complianceCautions || "- No compliance caution areas configured.",
    "",
    "## Source Summary",
    "",
    `- Shopify customers: ${input.shopify.summary.customers}`,
    `- Shopify revenue: $${input.shopify.summary.revenue}`,
    `- Klaviyo campaigns: ${input.klaviyo.campaigns.count}`,
    `- Klaviyo flows: ${input.klaviyo.flows.count}`,
    `- Matched Shopify + Klaviyo identities: ${input.identities.summary.matchedAcrossSources}`,
    "",
    "## Missing Pieces",
    "",
    missingLines || "- No missing pieces detected.",
    "",
    "## Top Opportunity",
    "",
    topOpportunity
      ? `- ${topOpportunity.name}: ${topOpportunity.messageAngle}`
      : "- No opportunity available.",
    "",
    "## Klaviyo Lifecycle Gaps",
    "",
    lifecycleMissing || "No lifecycle gaps detected.",
    "",
    "## Safety",
    "",
    `- QA status: ${input.qa.status}`,
    "- Source mode: fixture/sample data.",
    "- Freshness/caveats: simulated 90-day window; not live data.",
    "- No external action was taken.",
    "- externalActionTaken:false",
    "- This audit cannot go live as-is.",
    "- canGoLiveNow:false",
    "- Shopify writes, Klaviyo sends, schedules, flow activation, segment mutation, and profile mutation are blocked.",
  ].join("\n");
}

export function buildUnifiedRetentionAudit(
  options: ComputeRetentionOptions = {},
  dataset: RetentionDataset = createFixtureRetentionDataset(),
) {
  const effectiveDataset = applyBrandOptionsToDataset(dataset, options);
  const brandBrain = getRetentionBrandBrain(effectiveDataset);
  const shopify = getRetentionShopifySnapshot(options, effectiveDataset);
  const klaviyo = getRetentionKlaviyoSnapshot(options, effectiveDataset);
  const identities = buildUnifiedCustomerView(options, effectiveDataset);
  const features = computeRetentionCustomerFeatures(options, effectiveDataset);
  const scores = scoreRetentionCustomers(options, effectiveDataset);
  const segments = buildRetentionMicroSegments(options, effectiveDataset);
  const missingPieces = findRetentionMissingPieces(options, effectiveDataset);
  const opportunities = findRetentionCampaignOpportunities(
    options,
    effectiveDataset,
  );
  const campaignPackage = generateRetentionCampaignPackage(
    options,
    effectiveDataset,
  );
  const qa = runRetentionQa(options, effectiveDataset);

  return {
    generatedAt: nowIso(),
    title: "Retention Audit",
    brandBrain,
    sources: { shopify, klaviyo },
    identities,
    features,
    scores,
    segments,
    missingPieces,
    opportunities,
    recommendedPackage: campaignPackage,
    qa,
    document: {
      title: "Retention Audit",
      contentMarkdown: buildAuditMarkdown({
        brandBrain,
        shopify,
        klaviyo,
        identities,
        missingPieces,
        opportunities,
        qa,
      }),
    },
    actionLog: {
      eventType: "retention_audit",
      actionType: "unified_analysis",
      status: "prepared",
      riskLevel: "medium",
      requiresApproval: false,
      approvalStatus: "not_required",
      externalActionTaken: false,
      canGoLiveNow: false,
      summary:
        "Prepared a unified Shopify + Klaviyo + Brand Brain retention audit.",
    } satisfies RetentionActionLog,
    safety: createRetentionSafetyMetadata([
      "Unified audit is read-only and fixture-backed in this milestone.",
    ]),
  };
}
