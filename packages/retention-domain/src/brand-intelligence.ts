export const BRAND_INTELLIGENCE_CONTRACT_VERSION = "brand_intelligence_v1";

export const BRAND_INTELLIGENCE_MODULES = [
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
] as const;

export type BrandIntelligenceModuleKey =
  (typeof BRAND_INTELLIGENCE_MODULES)[number];
export type BrandIntelligenceModuleStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "not_observable";
export type BrandIntelligenceClaimType =
  | "fact"
  | "estimate"
  | "calculation"
  | "pattern"
  | "inference"
  | "hypothesis"
  | "open_question";
export type BrandIntelligenceHypothesisStatus =
  | "supported"
  | "mixed"
  | "rejected"
  | "untested";
export type BrandIntelligenceConfidenceBand =
  | "high"
  | "medium"
  | "low"
  | "hypothesis";
export type BrandIntelligenceMetricKind =
  | "observed"
  | "calculated"
  | "estimated"
  | "modeled";

export const BRAND_INTELLIGENCE_VISUALIZATION_TYPES = [
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
] as const;

export const BRAND_INTELLIGENCE_ANALYTICAL_VISUALIZATION_TYPES =
  BRAND_INTELLIGENCE_VISUALIZATION_TYPES.filter(
    (type) => type !== "evidence_gallery",
  );

export type BrandIntelligenceVisualizationType =
  (typeof BRAND_INTELLIGENCE_VISUALIZATION_TYPES)[number];

export interface BrandIntelligenceConfidence {
  score: number;
  band: BrandIntelligenceConfidenceBand;
  rationale: string;
}

export interface BrandIntelligenceModule {
  key: BrandIntelligenceModuleKey;
  status: BrandIntelligenceModuleStatus;
  decisionQuestions: string[];
  findingIds: string[];
  hypothesisIds: string[];
  metricIds: string[];
  contradictionIds: string[];
  evidenceIds: string[];
  visualizationIds: string[];
  implications: string[];
  gaps: string[];
  nextValidationSteps: string[];
  confidence: BrandIntelligenceConfidence;
}

export interface BrandIntelligenceClaim {
  id: string;
  module: BrandIntelligenceModuleKey;
  statement: string;
  type: BrandIntelligenceClaimType;
  material: boolean;
  evidenceIds: string[];
  disconfirmingEvidenceIds: string[];
  confidence: BrandIntelligenceConfidence;
}

export interface BrandIntelligenceEvidenceAssessment {
  evidenceId: string;
  independentSourceKey: string;
  primarySource: boolean;
  providerEstimate: boolean;
  sourceQuality: number;
  directness: number;
  freshness: number;
  sampleAdequacy: number;
}

export interface BrandIntelligenceHypothesis {
  id: string;
  module: BrandIntelligenceModuleKey;
  statement: string;
  status: BrandIntelligenceHypothesisStatus;
  supportingEvidenceIds: string[];
  disconfirmingEvidenceIds: string[];
  alternativeExplanations: string[];
  validationStep: string;
}

export interface BrandIntelligenceMetric {
  id: string;
  module: BrandIntelligenceModuleKey;
  label: string;
  kind: BrandIntelligenceMetricKind;
  value?: number | string;
  range?: { min: number; max: number };
  unit: string;
  currency?: string;
  period: string;
  geography: string;
  denominator: string;
  method: string;
  evidenceIds: string[];
  confidence: BrandIntelligenceConfidence;
}

export interface BrandIntelligenceContradiction {
  id: string;
  module: BrandIntelligenceModuleKey;
  description: string;
  evidenceIds: string[];
  status: "open" | "resolved";
  resolution?: string;
  implication: string;
}

export interface BrandIntelligenceVisualization {
  id: string;
  module: BrandIntelligenceModuleKey;
  type: BrandIntelligenceVisualizationType;
  title: string;
  businessQuestion: string;
  evidenceIds: string[];
  assetIds: string[];
  caveats: string[];
  data: Record<string, unknown>;
}

export interface BrandIntelligenceVisualEvidence {
  id: string;
  module?: BrandIntelligenceModuleKey;
  sourceUrl: string;
  evidenceIds: string[];
}

export interface BrandIntelligenceQualityContext {
  visualEvidence?: BrandIntelligenceVisualEvidence[];
}

export interface BrandIntelligenceRecommendation {
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
  confidence: BrandIntelligenceConfidence;
}

export interface BrandIntelligence {
  contractVersion: typeof BRAND_INTELLIGENCE_CONTRACT_VERSION;
  brandId: string;
  researchMode: "deep";
  scope: {
    businessQuestions: string[];
    geographies: string[];
    languages: string[];
    periodStart?: string;
    periodEnd: string;
  };
  modules: BrandIntelligenceModule[];
  claims: BrandIntelligenceClaim[];
  evidenceAssessments: BrandIntelligenceEvidenceAssessment[];
  hypotheses: BrandIntelligenceHypothesis[];
  metrics: BrandIntelligenceMetric[];
  contradictions: BrandIntelligenceContradiction[];
  visualizations: BrandIntelligenceVisualization[];
  recommendations: BrandIntelligenceRecommendation[];
  limitations: string[];
}

export const BRAND_INTELLIGENCE_QUALITY_WEIGHTS = {
  coverage: 15,
  evidence: 20,
  hypotheses: 15,
  quantification: 15,
  synthesis: 15,
  visualReasoning: 10,
  transparency: 10,
} as const;

export type BrandIntelligenceQualityCategory =
  keyof typeof BRAND_INTELLIGENCE_QUALITY_WEIGHTS;

export interface BrandIntelligenceQualityResult {
  accepted: boolean;
  score: number;
  categoryScores: Record<BrandIntelligenceQualityCategory, number>;
  blockingFailures: string[];
  warnings: string[];
  triangulatedMaterialClaimRatio: number;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max);
}

function weightedScore(ratio: number, weight: number): number {
  return Math.round(clamp(ratio) * weight * 100) / 100;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function completeConfidence(value: BrandIntelligenceConfidence): boolean {
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    return false;
  }
  if (!nonEmpty(value.rationale)) return false;
  if (value.score >= 80) return value.band === "high";
  if (value.score >= 60) return value.band === "medium";
  if (value.score >= 40) return value.band === "low";
  return value.band === "hypothesis";
}

function recommendationComplete(
  value: BrandIntelligenceRecommendation,
): boolean {
  return (
    nonEmpty(value.decision) &&
    nonEmpty(value.action) &&
    nonEmpty(value.rationale) &&
    nonEmpty(value.mechanism) &&
    nonEmpty(value.expectedImpact.unit) &&
    nonEmpty(value.expectedImpact.timeframe) &&
    value.risks.length > 0 &&
    value.dependencies.length > 0 &&
    value.alternatives.length > 0 &&
    nonEmpty(value.suggestedOwner) &&
    nonEmpty(value.timing) &&
    nonEmpty(value.kpi) &&
    nonEmpty(value.firstTest) &&
    nonEmpty(value.scaleCriterion) &&
    nonEmpty(value.stopCriterion) &&
    value.evidenceIds.length > 0 &&
    completeConfidence(value.confidence)
  );
}

function metricComplete(value: BrandIntelligenceMetric): boolean {
  const hasValue =
    value.value !== undefined ||
    (value.range !== undefined &&
      Number.isFinite(value.range.min) &&
      Number.isFinite(value.range.max) &&
      value.range.min <= value.range.max);
  return (
    hasValue &&
    nonEmpty(value.label) &&
    nonEmpty(value.unit) &&
    nonEmpty(value.period) &&
    nonEmpty(value.geography) &&
    nonEmpty(value.denominator) &&
    nonEmpty(value.method) &&
    value.evidenceIds.length > 0 &&
    completeConfidence(value.confidence)
  );
}

function hypothesisComplete(value: BrandIntelligenceHypothesis): boolean {
  return (
    nonEmpty(value.statement) &&
    value.supportingEvidenceIds.length > 0 &&
    value.disconfirmingEvidenceIds.length > 0 &&
    value.alternativeExplanations.length > 0 &&
    nonEmpty(value.validationStep)
  );
}

function publicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function moduleComplete(value: BrandIntelligenceModule): boolean {
  if (!completeConfidence(value.confidence)) return false;
  if (
    value.status === "unavailable" ||
    value.status === "not_observable"
  ) {
    return value.gaps.length > 0 && value.nextValidationSteps.length > 0;
  }
  return (
    value.decisionQuestions.length > 0 &&
    value.implications.length > 0 &&
    value.findingIds.length > 0 &&
    value.evidenceIds.length > 0 &&
    (value.status === "complete" ||
      value.gaps.length > 0 ||
      value.nextValidationSteps.length > 0)
  );
}

export function evaluateBrandIntelligenceQuality(
  intelligence: BrandIntelligence,
  knownEvidenceIds: Iterable<string>,
  context: BrandIntelligenceQualityContext = {},
): BrandIntelligenceQualityResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const evidenceIds = new Set(knownEvidenceIds);
  const moduleByKey = new Map(
    intelligence.modules.map((module) => [module.key, module]),
  );
  const claimById = new Map(
    intelligence.claims.map((claim) => [claim.id, claim]),
  );
  const assessmentByEvidence = new Map(
    intelligence.evidenceAssessments.map((assessment) => [
      assessment.evidenceId,
      assessment,
    ]),
  );
  const visualizationById = new Map(
    intelligence.visualizations.map((visualization) => [
      visualization.id,
      visualization,
    ]),
  );
  const visualEvidence = context.visualEvidence ?? [];
  const visualEvidenceById = new Map(
    visualEvidence.map((asset) => [asset.id, asset]),
  );

  const duplicateIds = [
    ...intelligence.modules.map((item) => item.key),
    ...intelligence.claims.map((item) => item.id),
    ...intelligence.hypotheses.map((item) => item.id),
    ...intelligence.metrics.map((item) => item.id),
    ...intelligence.contradictions.map((item) => item.id),
    ...intelligence.visualizations.map((item) => item.id),
    ...intelligence.recommendations.map((item) => item.id),
  ].filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    blockers.push(`Duplicate intelligence IDs: ${unique(duplicateIds).join(", ")}.`);
  }

  const missingModules = BRAND_INTELLIGENCE_MODULES.filter(
    (key) => !moduleByKey.has(key),
  );
  if (missingModules.length > 0) {
    blockers.push(`Missing required modules: ${missingModules.join(", ")}.`);
  }

  const validModules = BRAND_INTELLIGENCE_MODULES.flatMap((key) => {
    const module = moduleByKey.get(key);
    return module ? [module] : [];
  });
  const structurallyCompleteModules = validModules.filter(moduleComplete);
  const coverageRatio =
    structurallyCompleteModules.length / BRAND_INTELLIGENCE_MODULES.length;

  const allReferencedEvidenceIds = [
    ...intelligence.modules.flatMap((item) => item.evidenceIds),
    ...intelligence.claims.flatMap((item) => [
      ...item.evidenceIds,
      ...item.disconfirmingEvidenceIds,
    ]),
    ...intelligence.hypotheses.flatMap((item) => [
      ...item.supportingEvidenceIds,
      ...item.disconfirmingEvidenceIds,
    ]),
    ...intelligence.metrics.flatMap((item) => item.evidenceIds),
    ...intelligence.contradictions.flatMap((item) => item.evidenceIds),
    ...intelligence.visualizations.flatMap((item) => item.evidenceIds),
    ...intelligence.recommendations.flatMap((item) => item.evidenceIds),
    ...visualEvidence.flatMap((item) => item.evidenceIds),
  ];
  const unknownEvidenceIds = unique(allReferencedEvidenceIds).filter(
    (id) => !evidenceIds.has(id),
  );
  if (unknownEvidenceIds.length > 0) {
    blockers.push(
      `Intelligence records reference unknown evidence: ${unknownEvidenceIds.join(", ")}.`,
    );
  }

  const materialClaims = intelligence.claims.filter((claim) => claim.material);
  const traceableMaterialClaims = materialClaims.filter(
    (claim) =>
      claim.type === "hypothesis" ||
      claim.type === "open_question" ||
      claim.evidenceIds.length > 0,
  );
  const untraceableMaterialClaims = materialClaims.filter(
    (claim) =>
      claim.type !== "hypothesis" &&
      claim.type !== "open_question" &&
      claim.evidenceIds.length === 0,
  );
  if (untraceableMaterialClaims.length > 0) {
    blockers.push(
      `Material findings lack evidence: ${untraceableMaterialClaims.map((item) => item.id).join(", ")}.`,
    );
  }

  const triangulatedMaterialClaims = materialClaims.filter((claim) => {
    if (claim.type === "hypothesis" || claim.type === "open_question") {
      return true;
    }
    const sources = new Set(
      claim.evidenceIds.flatMap((id) => {
        const assessment = assessmentByEvidence.get(id);
        return assessment?.independentSourceKey
          ? [assessment.independentSourceKey]
          : [];
      }),
    );
    return sources.size >= 2;
  });
  const triangulatedRatio =
    materialClaims.length === 0
      ? 0
      : triangulatedMaterialClaims.length / materialClaims.length;
  if (materialClaims.length === 0) {
    blockers.push("The report contains no material claims.");
  } else if (triangulatedRatio < 0.8) {
    blockers.push(
      `Only ${Math.round(triangulatedRatio * 100)}% of material claims are independently triangulated.`,
    );
  }

  const completeAssessments = intelligence.evidenceAssessments.filter(
    (assessment) =>
      evidenceIds.has(assessment.evidenceId) &&
      nonEmpty(assessment.independentSourceKey) &&
      [assessment.sourceQuality, assessment.directness, assessment.freshness, assessment.sampleAdequacy].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      ),
  );
  const assessmentRatio =
    evidenceIds.size === 0
      ? 0
      : Math.min(completeAssessments.length / evidenceIds.size, 1);
  const traceabilityRatio =
    materialClaims.length === 0
      ? 0
      : traceableMaterialClaims.length / materialClaims.length;
  const evidenceScore = weightedScore(
    traceabilityRatio * 0.4 +
      triangulatedRatio * 0.4 +
      assessmentRatio * 0.2,
    BRAND_INTELLIGENCE_QUALITY_WEIGHTS.evidence,
  );

  const completeHypotheses =
    intelligence.hypotheses.filter(hypothesisComplete);
  const hypothesisRatio =
    intelligence.hypotheses.length === 0
      ? 0
      : completeHypotheses.length / intelligence.hypotheses.length;
  if (intelligence.hypotheses.length === 0) {
    blockers.push("A deep report must test at least one strategic hypothesis.");
  }

  const completeMetrics = intelligence.metrics.filter(metricComplete);
  const metricCompleteness =
    intelligence.metrics.length === 0
      ? 0
      : completeMetrics.length / intelligence.metrics.length;
  const metricBreadth = Math.min(intelligence.metrics.length / 5, 1);
  if (intelligence.metrics.length === 0) {
    warnings.push("No quantified metric was recorded.");
  }

  const completeRecommendations =
    intelligence.recommendations.filter(recommendationComplete);
  const recommendationCompleteness =
    intelligence.recommendations.length === 0
      ? 0
      : completeRecommendations.length / intelligence.recommendations.length;
  const recommendationBreadth = Math.min(
    intelligence.recommendations.length / 3,
    1,
  );
  if (intelligence.recommendations.length === 0) {
    blockers.push("The report contains no decision-ready recommendation.");
  }

  const analyticalVisualizations = intelligence.visualizations.filter(
    (visualization) =>
      (
        BRAND_INTELLIGENCE_ANALYTICAL_VISUALIZATION_TYPES as readonly string[]
      ).includes(visualization.type) &&
      nonEmpty(visualization.title) &&
      nonEmpty(visualization.businessQuestion) &&
      visualization.evidenceIds.length > 0 &&
      Object.keys(visualization.data).length > 0,
  );
  const completeModuleKeys = validModules
    .filter((module) => module.status === "complete")
    .map((module) => module.key);
  const modulesWithAnalyticalVisual = new Set(
    analyticalVisualizations.map((visualization) => visualization.module),
  );
  const completeModulesWithoutAnalyticalVisual = completeModuleKeys.filter(
    (key) => !modulesWithAnalyticalVisual.has(key),
  );
  if (completeModulesWithoutAnalyticalVisual.length > 0) {
    blockers.push(
      `Complete modules lack a source-linked analytical visual: ${completeModulesWithoutAnalyticalVisual.join(", ")}.`,
    );
  }
  const visualCoverage =
    completeModuleKeys.length === 0
      ? 0
      : completeModuleKeys.filter((key) => modulesWithAnalyticalVisual.has(key))
          .length / completeModuleKeys.length;
  const visualBreadth = Math.min(analyticalVisualizations.length / 6, 1);
  if (analyticalVisualizations.length === 0) {
    blockers.push("The report contains no source-linked analytical visual.");
  }
  const validVisualEvidence = visualEvidence.filter(
    (asset) =>
      nonEmpty(asset.id) &&
      publicHttpUrl(asset.sourceUrl) &&
      asset.evidenceIds.length > 0 &&
      asset.evidenceIds.every((id) => evidenceIds.has(id)),
  );
  if (validVisualEvidence.length === 0) {
    blockers.push(
      "The deep report contains no source-linked visual evidence preview.",
    );
  }
  const invalidAssetReferences = unique(
    intelligence.visualizations.flatMap((visualization) =>
      visualization.assetIds.filter(
        (assetId) => !visualEvidenceById.has(assetId),
      ),
    ),
  );
  if (invalidAssetReferences.length > 0) {
    blockers.push(
      `Analytical visuals reference unknown visual assets: ${invalidAssetReferences.join(", ")}.`,
    );
  }
  const incompleteEvidenceGalleries = intelligence.visualizations.filter(
    (visualization) =>
      visualization.type === "evidence_gallery" &&
      visualization.assetIds.length === 0,
  );
  if (incompleteEvidenceGalleries.length > 0) {
    blockers.push(
      `Evidence galleries contain no source assets: ${incompleteEvidenceGalleries.map((item) => item.id).join(", ")}.`,
    );
  }
  const visuallyProvableModules: BrandIntelligenceModuleKey[] = [
    "brand_positioning_creative",
    "competitors",
  ];
  const modulesWithVisualEvidence = new Set(
    validVisualEvidence.flatMap((asset) => (asset.module ? [asset.module] : [])),
  );
  const completeVisualModulesWithoutEvidence = visuallyProvableModules.filter(
    (moduleKey) =>
      moduleByKey.get(moduleKey)?.status === "complete" &&
      !modulesWithVisualEvidence.has(moduleKey),
  );
  if (completeVisualModulesWithoutEvidence.length > 0) {
    blockers.push(
      `Complete visual modules lack source previews: ${completeVisualModulesWithoutEvidence.join(", ")}.`,
    );
  }
  const visualEvidenceBreadth = Math.min(validVisualEvidence.length / 6, 1);

  const invalidConfidenceRecords = [
    ...intelligence.modules.filter(
      (item) => !completeConfidence(item.confidence),
    ),
    ...intelligence.claims.filter(
      (item) => !completeConfidence(item.confidence),
    ),
    ...intelligence.metrics.filter(
      (item) => !completeConfidence(item.confidence),
    ),
    ...intelligence.recommendations.filter(
      (item) => !completeConfidence(item.confidence),
    ),
  ];
  if (invalidConfidenceRecords.length > 0) {
    blockers.push("One or more confidence scores do not match their bands.");
  }

  const unresolvedContradictions = intelligence.contradictions.filter(
    (item) => item.status === "open",
  );
  for (const contradiction of unresolvedContradictions) {
    const affectedClaims = contradiction.evidenceIds.flatMap((evidenceId) =>
      intelligence.claims.filter((claim) =>
        claim.evidenceIds.includes(evidenceId),
      ),
    );
    if (affectedClaims.some((claim) => claim.confidence.score >= 60)) {
      blockers.push(
        `Open contradiction ${contradiction.id} affects a medium- or high-confidence claim.`,
      );
    }
  }

  const partialWithoutGaps = intelligence.modules.filter(
    (module) =>
      module.status === "partial" &&
      module.gaps.length === 0 &&
      module.nextValidationSteps.length === 0,
  );
  if (partialWithoutGaps.length > 0) {
    blockers.push(
      `Partial modules lack explicit gaps: ${partialWithoutGaps.map((item) => item.key).join(", ")}.`,
    );
  }

  const transparencySignals = [
    intelligence.limitations.length > 0,
    intelligence.modules.every(
      (module) =>
        module.status === "complete" ||
        module.gaps.length > 0 ||
        module.nextValidationSteps.length > 0,
    ),
    intelligence.contradictions.every(
      (item) =>
        nonEmpty(item.description) &&
        item.evidenceIds.length > 0 &&
        nonEmpty(item.implication),
    ),
    intelligence.scope.businessQuestions.length > 0,
    nonEmpty(intelligence.scope.periodEnd),
  ].filter(Boolean).length;

  const categoryScores: Record<BrandIntelligenceQualityCategory, number> = {
    coverage: weightedScore(
      coverageRatio,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.coverage,
    ),
    evidence: evidenceScore,
    hypotheses: weightedScore(
      hypothesisRatio,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.hypotheses,
    ),
    quantification: weightedScore(
      metricCompleteness * 0.7 + metricBreadth * 0.3,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.quantification,
    ),
    synthesis: weightedScore(
      recommendationCompleteness * 0.7 + recommendationBreadth * 0.3,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.synthesis,
    ),
    visualReasoning: weightedScore(
      visualCoverage * 0.6 +
        visualBreadth * 0.2 +
        visualEvidenceBreadth * 0.2,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.visualReasoning,
    ),
    transparency: weightedScore(
      transparencySignals / 5,
      BRAND_INTELLIGENCE_QUALITY_WEIGHTS.transparency,
    ),
  };
  const score =
    Math.round(
      Object.values(categoryScores).reduce((sum, value) => sum + value, 0) *
        100,
    ) / 100;

  for (const [category, weight] of Object.entries(
    BRAND_INTELLIGENCE_QUALITY_WEIGHTS,
  ) as Array<[BrandIntelligenceQualityCategory, number]>) {
    if (categoryScores[category] < weight * 0.6) {
      blockers.push(
        `${category} scored below 60% of its available quality points.`,
      );
    }
  }
  if (score < 80) {
    blockers.push(`The deep-research quality score is ${score}; 80 is required.`);
  }

  return {
    accepted: blockers.length === 0,
    score,
    categoryScores,
    blockingFailures: unique(blockers),
    warnings: unique(warnings),
    triangulatedMaterialClaimRatio:
      Math.round(triangulatedRatio * 1000) / 1000,
  };
}
