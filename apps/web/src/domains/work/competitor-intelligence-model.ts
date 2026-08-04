export type Confidence = "high" | "medium" | "low" | "hypothesis";

export type IntelligenceModuleKey =
  | "company_operating_model"
  | "market_category"
  | "customers_demand"
  | "offers_pricing_portfolio"
  | "brand_positioning_creative"
  | "customer_journey"
  | "growth_channels_lifecycle"
  | "economics_financial"
  | "culture_trends"
  | "reputation_risk"
  | "competitors"
  | "strategic_synthesis";

export interface IntelligenceEvidence {
  id: string;
  url: string;
  title: string;
  sourceType: string;
  observedAt: string;
  finding: string;
  confidence: Exclude<Confidence, "hypothesis">;
  provider?: string;
}

export interface IntelligenceVisual {
  id: string;
  module?: IntelligenceModuleKey;
  kind:
    | "ad"
    | "email"
    | "social"
    | "product"
    | "landing_page"
    | "brand"
    | "competitor";
  title: string;
  sourceUrl: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaType?: "image" | "video" | "page";
  observedAt: string;
  provider?: string;
  platform?: string;
  evidenceIds: string[];
  caption?: string;
  caveats: string[];
  data: Record<string, unknown>;
}

export type CompetitorDatasetKey =
  | "overview"
  | "products"
  | "meta"
  | "tiktok"
  | "google"
  | "emails"
  | "social"
  | "tools";

export interface CompetitorDatasetCoverage {
  status: "found" | "not_found" | "not_measured";
  note: string;
}

export interface CompetitorSocialAccount {
  platform: string;
  handle?: string;
  followers?: number;
  posts?: number;
  views?: number;
  likes?: number;
}

export interface IntelligenceCompetitorDetails {
  countryCode?: string;
  currency?: string;
  category?: string;
  storeCreatedAt?: string;
  isShopifyPlus?: boolean;
  productCount?: number | null;
  monthlyVisits?: number | null;
  activeAds?: number | null;
  averageActiveAds30d?: number | null;
  trafficHistory: Array<{ period: string; value: number }>;
  adHistory: Array<{ period: string; value: number }>;
  products: IntelligenceVisual[];
  metaAds: IntelligenceVisual[];
  tiktok: IntelligenceVisual[];
  googleAds: IntelligenceVisual[];
  emails: IntelligenceVisual[];
  socialAccounts: CompetitorSocialAccount[];
  tools: string[];
  tracking: string[];
  coverage: Partial<
    Record<CompetitorDatasetKey, CompetitorDatasetCoverage>
  >;
}

export interface IntelligenceCompetitor {
  name: string;
  websiteUrl?: string;
  classification?: "direct" | "adjacent" | "substitute" | "aspirational";
  rationale?: string;
  positioning: string;
  offers: string[];
  pricingPosture?: string;
  channelSignals: {
    paidMedia: string[];
    social: string[];
    seoAndContent: string[];
    emailAndLifecycle: string[];
  };
  differentiators: string[];
  notableMoves: string[];
  gaps: string[];
  evidenceIds: string[];
  confidence: Exclude<Confidence, "hypothesis">;
  details?: IntelligenceCompetitorDetails;
}

export interface IntelligenceConfidence {
  score: number;
  band: Confidence;
  rationale: string;
}

export interface IntelligenceModule {
  key: IntelligenceModuleKey;
  status: "complete" | "partial" | "unavailable" | "not_observable";
  decisionQuestions: string[];
  implications: string[];
  gaps: string[];
  nextValidationSteps: string[];
  findingIds: string[];
  evidenceIds: string[];
  visualizationIds: string[];
  confidence: IntelligenceConfidence;
}

export interface IntelligenceClaim {
  id: string;
  module: IntelligenceModuleKey;
  statement: string;
  type:
    | "fact"
    | "estimate"
    | "calculation"
    | "pattern"
    | "inference"
    | "hypothesis"
    | "open_question";
  material: boolean;
  evidenceIds: string[];
  confidence: IntelligenceConfidence;
}

export interface IntelligenceMetric {
  id: string;
  module: IntelligenceModuleKey;
  label: string;
  kind: "observed" | "calculated" | "estimated" | "modeled";
  value?: number | string;
  range?: { min: number; max: number };
  unit: string;
  currency?: string;
  period: string;
  geography: string;
  denominator: string;
  method: string;
  evidenceIds: string[];
  confidence: IntelligenceConfidence;
}

export interface IntelligenceVisualization {
  id: string;
  module: IntelligenceModuleKey;
  type:
    | "metric_tiles"
    | "timeline"
    | "comparison_matrix"
    | "journey_map"
    | "positioning_map"
    | "theme_clusters"
    | "offer_ladder"
    | "claim_proof_matrix"
    | "channel_map"
    | "risk_matrix"
    | "opportunity_matrix"
    | "recommendation_sequence"
    | "evidence_gallery";
  title: string;
  businessQuestion: string;
  evidenceIds: string[];
  assetIds: string[];
  caveats: string[];
  data: Record<string, unknown>;
}

export interface IntelligenceRecommendation {
  id: string;
  priority: "now" | "next" | "later";
  decision: string;
  action: string;
  rationale: string;
  mechanism: string;
  expectedImpact: {
    low: number | null;
    high: number | null;
    unit: string;
    timeframe: string;
  };
  effort: "low" | "medium" | "high";
  risks: string[];
  dependencies: string[];
  alternatives: string[];
  suggestedOwner: string;
  timing: string;
  kpi: string;
  firstTest: string;
  scaleCriterion: string;
  stopCriterion: string;
  evidenceIds: string[];
  confidence: IntelligenceConfidence;
}

export interface BrandIntelligenceLayer {
  contractVersion: "brand_intelligence_v1";
  brandId: string;
  researchMode: "deep";
  scope: {
    businessQuestions: string[];
    geographies: string[];
    languages: string[];
    periodStart?: string;
    periodEnd: string;
  };
  modules: IntelligenceModule[];
  claims: IntelligenceClaim[];
  metrics: IntelligenceMetric[];
  visualizations: IntelligenceVisualization[];
  recommendations: IntelligenceRecommendation[];
  limitations: string[];
}

export interface IntelligenceQuality {
  accepted: boolean;
  score: number;
  categoryScores: Record<string, number>;
  blockingFailures: string[];
  warnings: string[];
  triangulatedMaterialClaimRatio: number;
}

export interface CompetitorIntelligenceReport {
  generatedAt: string;
  query: { brandName: string; websiteUrl?: string };
  executiveSummary: string[];
  identity: {
    category: string;
    positioning: string;
    offers: string[];
    audienceSignals: string[];
  };
  competitorLandscape: IntelligenceCompetitor[];
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
  evidence: IntelligenceEvidence[];
  visualEvidence: IntelligenceVisual[];
  gaps: string[];
  recommendations: Array<{
    priority: "now" | "next" | "later";
    action: string;
    rationale: string;
    evidenceIds: string[];
  }>;
  safety: { caveats: string[] };
  intelligence?: BrandIntelligenceLayer;
  quality?: IntelligenceQuality;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function confidence(value: unknown): Exclude<Confidence, "hypothesis"> {
  return value === "high" || value === "low" ? value : "medium";
}

function confidenceRecord(value: unknown): IntelligenceConfidence {
  const record = isRecord(value) ? value : {};
  const score = Math.min(100, Math.max(0, numberValue(record.score, 50)));
  const band: Confidence =
    record.band === "high" ||
    record.band === "low" ||
    record.band === "hypothesis"
      ? record.band
      : "medium";
  return {
    score,
    band,
    rationale: stringValue(record.rationale),
  };
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseEvidence(value: unknown): IntelligenceEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const url = publicUrl(item.url);
    if (!id || !url) return [];
    return [
      {
        id,
        url,
        title: stringValue(item.title) || "Untitled source",
        sourceType: stringValue(item.sourceType) || "other",
        observedAt: stringValue(item.observedAt),
        finding: stringValue(item.finding),
        confidence: confidence(item.confidence),
        ...(typeof item.provider === "string"
          ? { provider: item.provider }
          : {}),
      },
    ];
  });
}

function parseVisualEvidence(value: unknown): IntelligenceVisual[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set([
    "ad",
    "email",
    "social",
    "product",
    "landing_page",
    "brand",
    "competitor",
  ]);
  return value.slice(0, 240).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const sourceUrl = publicUrl(item.sourceUrl);
    const kind = stringValue(item.kind);
    if (!id || !sourceUrl || !kinds.has(kind)) return [];
    const mediaType =
      item.mediaType === "video" || item.mediaType === "page"
        ? item.mediaType
        : "image";
    const mediaUrl = publicUrl(item.mediaUrl);
    const thumbnailUrl = publicUrl(item.thumbnailUrl);
    const module = moduleKey(item.module);
    return [
      {
        id,
        ...(module ? { module } : {}),
        kind: kind as IntelligenceVisual["kind"],
        title: stringValue(item.title) || "Untitled evidence",
        sourceUrl,
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        mediaType,
        observedAt: stringValue(item.observedAt),
        ...(typeof item.provider === "string"
          ? { provider: item.provider }
          : {}),
        ...(typeof item.platform === "string"
          ? { platform: item.platform }
          : {}),
        evidenceIds: stringList(item.evidenceIds),
        ...(typeof item.caption === "string" && item.caption.trim()
          ? { caption: item.caption }
          : {}),
        caveats: stringList(item.caveats),
        data: isRecord(item.data) ? item.data : {},
      },
    ];
  });
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseHistory(
  value: unknown,
): Array<{ period: string; value: number }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 400).flatMap((item) => {
    if (!isRecord(item)) return [];
    const period = stringValue(item.period);
    const amount = optionalNumber(item.value);
    return period && amount !== undefined ? [{ period, value: amount }] : [];
  });
}

function parseCompetitorDetails(
  value: unknown,
): IntelligenceCompetitorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const coverageRecord = isRecord(value.coverage) ? value.coverage : {};
  const coverage: IntelligenceCompetitorDetails["coverage"] = {};
  const datasetKeys: CompetitorDatasetKey[] = [
    "overview",
    "products",
    "meta",
    "tiktok",
    "google",
    "emails",
    "social",
    "tools",
  ];
  for (const key of datasetKeys) {
    const item = coverageRecord[key];
    if (!isRecord(item)) continue;
    const status =
      item.status === "found" ||
      item.status === "not_found" ||
      item.status === "not_measured"
        ? item.status
        : undefined;
    if (status) {
      coverage[key] = {
        status,
        note: stringValue(item.note),
      };
    }
  }

  const socialAccounts = Array.isArray(value.socialAccounts)
    ? value.socialAccounts.slice(0, 50).flatMap((item) => {
        if (!isRecord(item) || !stringValue(item.platform)) return [];
        const handle = stringValue(item.handle);
        const followers = optionalNumber(item.followers);
        const posts = optionalNumber(item.posts);
        const views = optionalNumber(item.views);
        const likes = optionalNumber(item.likes);
        return [
          {
            platform: stringValue(item.platform),
            ...(handle ? { handle } : {}),
            ...(followers !== undefined ? { followers } : {}),
            ...(posts !== undefined ? { posts } : {}),
            ...(views !== undefined ? { views } : {}),
            ...(likes !== undefined ? { likes } : {}),
          },
        ];
      })
    : [];
  const monthlyVisits =
    value.monthlyVisits === null
      ? null
      : optionalNumber(value.monthlyVisits);
  const productCount =
    value.productCount === null ? null : optionalNumber(value.productCount);
  const activeAds =
    value.activeAds === null ? null : optionalNumber(value.activeAds);
  const averageActiveAds30d =
    value.averageActiveAds30d === null
      ? null
      : optionalNumber(value.averageActiveAds30d);

  return {
    ...(stringValue(value.countryCode)
      ? { countryCode: stringValue(value.countryCode) }
      : {}),
    ...(stringValue(value.currency)
      ? { currency: stringValue(value.currency) }
      : {}),
    ...(stringValue(value.category)
      ? { category: stringValue(value.category) }
      : {}),
    ...(stringValue(value.storeCreatedAt)
      ? { storeCreatedAt: stringValue(value.storeCreatedAt) }
      : {}),
    ...(typeof value.isShopifyPlus === "boolean"
      ? { isShopifyPlus: value.isShopifyPlus }
      : {}),
    ...(monthlyVisits !== undefined ? { monthlyVisits } : {}),
    ...(productCount !== undefined ? { productCount } : {}),
    ...(activeAds !== undefined ? { activeAds } : {}),
    ...(averageActiveAds30d !== undefined
      ? { averageActiveAds30d }
      : {}),
    trafficHistory: parseHistory(value.trafficHistory),
    adHistory: parseHistory(value.adHistory),
    products: parseVisualEvidence(value.products),
    metaAds: parseVisualEvidence(value.metaAds),
    tiktok: parseVisualEvidence(value.tiktok),
    googleAds: parseVisualEvidence(value.googleAds),
    emails: parseVisualEvidence(value.emails),
    socialAccounts,
    tools: stringList(value.tools).slice(0, 100),
    tracking: stringList(value.tracking).slice(0, 100),
    coverage,
  };
}

function parseCompetitors(value: unknown): IntelligenceCompetitor[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    if (!isRecord(item) || !stringValue(item.name)) return [];
    const channels = isRecord(item.channelSignals)
      ? item.channelSignals
      : {};
    const classification =
      item.classification === "direct" ||
      item.classification === "adjacent" ||
      item.classification === "substitute" ||
      item.classification === "aspirational"
        ? item.classification
        : undefined;
    const websiteUrl = publicUrl(item.websiteUrl);
    const details = parseCompetitorDetails(item.details);
    return [
      {
        name: stringValue(item.name),
        ...(websiteUrl ? { websiteUrl } : {}),
        ...(classification ? { classification } : {}),
        ...(typeof item.rationale === "string"
          ? { rationale: item.rationale }
          : {}),
        positioning: stringValue(item.positioning),
        offers: stringList(item.offers),
        ...(typeof item.pricingPosture === "string"
          ? { pricingPosture: item.pricingPosture }
          : {}),
        channelSignals: {
          paidMedia: stringList(channels.paidMedia),
          social: stringList(channels.social),
          seoAndContent: stringList(channels.seoAndContent),
          emailAndLifecycle: stringList(channels.emailAndLifecycle),
        },
        differentiators: stringList(item.differentiators),
        notableMoves: stringList(item.notableMoves),
        gaps: stringList(item.gaps),
        evidenceIds: stringList(item.evidenceIds),
        confidence: confidence(item.confidence),
        ...(details ? { details } : {}),
      },
    ];
  });
}

const MODULE_KEYS = new Set<IntelligenceModuleKey>([
  "company_operating_model",
  "market_category",
  "customers_demand",
  "offers_pricing_portfolio",
  "brand_positioning_creative",
  "customer_journey",
  "growth_channels_lifecycle",
  "economics_financial",
  "culture_trends",
  "reputation_risk",
  "competitors",
  "strategic_synthesis",
]);

function moduleKey(value: unknown): IntelligenceModuleKey | undefined {
  return typeof value === "string" &&
    MODULE_KEYS.has(value as IntelligenceModuleKey)
    ? (value as IntelligenceModuleKey)
    : undefined;
}

function parseModules(value: unknown): IntelligenceModule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const key = moduleKey(item.key);
    if (!key) return [];
    const status =
      item.status === "complete" ||
      item.status === "unavailable" ||
      item.status === "not_observable"
        ? item.status
        : "partial";
    return [
      {
        key,
        status,
        decisionQuestions: stringList(item.decisionQuestions),
        implications: stringList(item.implications),
        gaps: stringList(item.gaps),
        nextValidationSteps: stringList(item.nextValidationSteps),
        findingIds: stringList(item.findingIds),
        evidenceIds: stringList(item.evidenceIds),
        visualizationIds: stringList(item.visualizationIds),
        confidence: confidenceRecord(item.confidence),
      },
    ];
  });
}

function parseClaims(value: unknown): IntelligenceClaim[] {
  if (!Array.isArray(value)) return [];
  const types = new Set([
    "fact",
    "estimate",
    "calculation",
    "pattern",
    "inference",
    "hypothesis",
    "open_question",
  ]);
  return value.slice(0, 400).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const module = moduleKey(item.module);
    const statement = stringValue(item.statement);
    if (!id || !module || !statement) return [];
    const type = types.has(String(item.type))
      ? (item.type as IntelligenceClaim["type"])
      : "inference";
    return [
      {
        id,
        module,
        statement,
        type,
        material: item.material === true,
        evidenceIds: stringList(item.evidenceIds),
        confidence: confidenceRecord(item.confidence),
      },
    ];
  });
}

function parseMetrics(value: unknown): IntelligenceMetric[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const module = moduleKey(item.module);
    const label = stringValue(item.label);
    if (!id || !module || !label) return [];
    const range = isRecord(item.range)
      ? {
          min: numberValue(item.range.min),
          max: numberValue(item.range.max),
        }
      : undefined;
    const kind =
      item.kind === "calculated" ||
      item.kind === "estimated" ||
      item.kind === "modeled"
        ? item.kind
        : "observed";
    return [
      {
        id,
        module,
        label,
        kind,
        ...(typeof item.value === "number" || typeof item.value === "string"
          ? { value: item.value }
          : {}),
        ...(range ? { range } : {}),
        unit: stringValue(item.unit),
        ...(typeof item.currency === "string"
          ? { currency: item.currency }
          : {}),
        period: stringValue(item.period),
        geography: stringValue(item.geography),
        denominator: stringValue(item.denominator),
        method: stringValue(item.method),
        evidenceIds: stringList(item.evidenceIds),
        confidence: confidenceRecord(item.confidence),
      },
    ];
  });
}

function parseVisualizations(value: unknown): IntelligenceVisualization[] {
  if (!Array.isArray(value)) return [];
  const types = new Set([
    "metric_tiles",
    "timeline",
    "comparison_matrix",
    "journey_map",
    "positioning_map",
    "theme_clusters",
    "offer_ladder",
    "claim_proof_matrix",
    "channel_map",
    "risk_matrix",
    "opportunity_matrix",
    "recommendation_sequence",
    "evidence_gallery",
  ]);
  return value.slice(0, 120).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const module = moduleKey(item.module);
    const type = stringValue(item.type);
    if (!id || !module || !types.has(type)) return [];
    return [
      {
        id,
        module,
        type: type as IntelligenceVisualization["type"],
        title: stringValue(item.title),
        businessQuestion: stringValue(item.businessQuestion),
        evidenceIds: stringList(item.evidenceIds),
        assetIds: stringList(item.assetIds),
        caveats: stringList(item.caveats),
        data: isRecord(item.data) ? item.data : {},
      },
    ];
  });
}

function parseRecommendations(value: unknown): IntelligenceRecommendation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const action = stringValue(item.action);
    if (!id || !action) return [];
    const impact = isRecord(item.expectedImpact) ? item.expectedImpact : {};
    const priority =
      item.priority === "next" || item.priority === "later"
        ? item.priority
        : "now";
    const effort =
      item.effort === "low" || item.effort === "high"
        ? item.effort
        : "medium";
    return [
      {
        id,
        priority,
        decision: stringValue(item.decision),
        action,
        rationale: stringValue(item.rationale),
        mechanism: stringValue(item.mechanism),
        expectedImpact: {
          low:
            typeof impact.low === "number" && Number.isFinite(impact.low)
              ? impact.low
              : null,
          high:
            typeof impact.high === "number" && Number.isFinite(impact.high)
              ? impact.high
              : null,
          unit: stringValue(impact.unit),
          timeframe: stringValue(impact.timeframe),
        },
        effort,
        risks: stringList(item.risks),
        dependencies: stringList(item.dependencies),
        alternatives: stringList(item.alternatives),
        suggestedOwner: stringValue(item.suggestedOwner),
        timing: stringValue(item.timing),
        kpi: stringValue(item.kpi),
        firstTest: stringValue(item.firstTest),
        scaleCriterion: stringValue(item.scaleCriterion),
        stopCriterion: stringValue(item.stopCriterion),
        evidenceIds: stringList(item.evidenceIds),
        confidence: confidenceRecord(item.confidence),
      },
    ];
  });
}

function parseIntelligence(value: unknown): BrandIntelligenceLayer | undefined {
  if (
    !isRecord(value) ||
    value.contractVersion !== "brand_intelligence_v1" ||
    typeof value.brandId !== "string"
  ) {
    return undefined;
  }
  const scope = isRecord(value.scope) ? value.scope : {};
  return {
    contractVersion: "brand_intelligence_v1",
    brandId: value.brandId,
    researchMode: "deep",
    scope: {
      businessQuestions: stringList(scope.businessQuestions),
      geographies: stringList(scope.geographies),
      languages: stringList(scope.languages),
      ...(typeof scope.periodStart === "string"
        ? { periodStart: scope.periodStart }
        : {}),
      periodEnd: stringValue(scope.periodEnd),
    },
    modules: parseModules(value.modules),
    claims: parseClaims(value.claims),
    metrics: parseMetrics(value.metrics),
    visualizations: parseVisualizations(value.visualizations),
    recommendations: parseRecommendations(value.recommendations),
    limitations: stringList(value.limitations),
  };
}

function parseQuality(value: unknown): IntelligenceQuality | undefined {
  if (!isRecord(value) || typeof value.accepted !== "boolean") return undefined;
  return {
    accepted: value.accepted,
    score: numberValue(value.score),
    categoryScores: isRecord(value.categoryScores)
      ? Object.fromEntries(
          Object.entries(value.categoryScores).flatMap(([key, score]) =>
            typeof score === "number" && Number.isFinite(score)
              ? [[key, score]]
              : [],
          ),
        )
      : {},
    blockingFailures: stringList(value.blockingFailures),
    warnings: stringList(value.warnings),
    triangulatedMaterialClaimRatio: numberValue(
      value.triangulatedMaterialClaimRatio,
    ),
  };
}

export function parseCompetitorIntelligence(
  value: unknown,
  qualityValue?: unknown,
): CompetitorIntelligenceReport | null {
  if (!isRecord(value) || !isRecord(value.query)) return null;
  const brandName = stringValue(value.query.brandName);
  if (!brandName) return null;
  const identity = isRecord(value.identity) ? value.identity : {};
  const channels = isRecord(value.channelFindings)
    ? value.channelFindings
    : {};
  const safety = isRecord(value.safety) ? value.safety : {};
  const websiteUrl = publicUrl(value.query.websiteUrl);
  const intelligence = parseIntelligence(value.intelligence);
  const quality = parseQuality(qualityValue);
  return {
    generatedAt: stringValue(value.generatedAt),
    query: {
      brandName,
      ...(websiteUrl ? { websiteUrl } : {}),
    },
    executiveSummary: stringList(value.executiveSummary),
    identity: {
      category: stringValue(identity.category),
      positioning: stringValue(identity.positioning),
      offers: stringList(identity.offers),
      audienceSignals: stringList(identity.audienceSignals),
    },
    competitorLandscape: parseCompetitors(value.competitorLandscape),
    channelFindings: {
      seoAndContent: stringList(channels.seoAndContent),
      social: stringList(channels.social),
      emailAndLifecycle: stringList(channels.emailAndLifecycle),
      sms: stringList(channels.sms),
      productAndLaunches: stringList(channels.productAndLaunches),
    },
    marketSignals: stringList(value.marketSignals),
    customerSignals: stringList(value.customerSignals),
    trendSignals: stringList(value.trendSignals),
    evidence: parseEvidence(value.evidence),
    visualEvidence: parseVisualEvidence(value.visualEvidence),
    gaps: stringList(value.gaps),
    recommendations: Array.isArray(value.recommendations)
      ? value.recommendations.flatMap((item) => {
          if (!isRecord(item) || !stringValue(item.action)) return [];
          const priority =
            item.priority === "next" || item.priority === "later"
              ? item.priority
              : "now";
          return [
            {
              priority,
              action: stringValue(item.action),
              rationale: stringValue(item.rationale),
              evidenceIds: stringList(item.evidenceIds),
            },
          ];
        })
      : [],
    safety: { caveats: stringList(safety.caveats) },
    ...(intelligence ? { intelligence } : {}),
    ...(quality ? { quality } : {}),
  };
}
