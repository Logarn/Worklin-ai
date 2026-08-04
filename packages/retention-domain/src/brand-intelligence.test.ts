import { describe, expect, test } from "bun:test";

import {
  BRAND_INTELLIGENCE_CONTRACT_VERSION,
  BRAND_INTELLIGENCE_MODULES,
  evaluateBrandIntelligenceQuality,
  type BrandIntelligence,
} from "./brand-intelligence.js";

function confidence(score = 84) {
  return {
    score,
    band: score >= 80 ? ("high" as const) : ("medium" as const),
    rationale: "Supported by current, independent public evidence.",
  };
}

function acceptedFixture(): {
  intelligence: BrandIntelligence;
  evidenceIds: string[];
} {
  const evidenceIds = Array.from({ length: 30 }, (_, index) => `ev-${index + 1}`);
  const claims = BRAND_INTELLIGENCE_MODULES.map((module, index) => ({
    id: `claim-${index + 1}`,
    module,
    statement: `Material finding for ${module}.`,
    type: "fact" as const,
    material: true,
    evidenceIds: [evidenceIds[index * 2]!, evidenceIds[index * 2 + 1]!],
    disconfirmingEvidenceIds: [],
    confidence: confidence(),
  }));
  const visualizations = BRAND_INTELLIGENCE_MODULES.map((module, index) => ({
    id: `visual-${index + 1}`,
    module,
    type: index === 5 ? ("journey_map" as const) : ("comparison_matrix" as const),
    title: `Decision view for ${module}`,
    businessQuestion: `What matters in ${module}?`,
    evidenceIds: claims[index]!.evidenceIds,
    assetIds: [],
    caveats: [],
    data: { rows: [] },
  }));
  const modules = BRAND_INTELLIGENCE_MODULES.map((key, index) => ({
    key,
    status: "complete" as const,
    decisionQuestions: [`What matters in ${key}?`],
    findingIds: [claims[index]!.id],
    hypothesisIds: index === 0 ? ["hypothesis-1"] : [],
    metricIds: index < 5 ? [`metric-${index + 1}`] : [],
    contradictionIds: [],
    evidenceIds: claims[index]!.evidenceIds,
    visualizationIds: [visualizations[index]!.id],
    implications: [`Implication for ${key}.`],
    gaps: [],
    nextValidationSteps: [],
    confidence: confidence(),
  }));
  const metrics = Array.from({ length: 5 }, (_, index) => ({
    id: `metric-${index + 1}`,
    module: BRAND_INTELLIGENCE_MODULES[index]!,
    label: `Metric ${index + 1}`,
    kind: "observed" as const,
    value: index + 1,
    unit: "count",
    period: "2026",
    geography: "Global",
    denominator: "Observed public records",
    method: "Counted from the linked public sources.",
    evidenceIds: [evidenceIds[index * 2]!],
    confidence: confidence(),
  }));
  const recommendations = Array.from({ length: 3 }, (_, index) => ({
    id: `recommendation-${index + 1}`,
    priority: index === 0 ? ("now" as const) : index === 1 ? ("next" as const) : ("later" as const),
    decision: `Decision ${index + 1}`,
    action: `Action ${index + 1}`,
    rationale: "The linked evidence supports this choice.",
    mechanism: "The action addresses the diagnosed demand barrier.",
    expectedImpact: {
      low: 2,
      high: 5,
      unit: "percent",
      timeframe: "90 days",
    },
    effort: "medium" as const,
    risks: ["Demand response may vary."],
    dependencies: ["Confirm measurement baseline."],
    alternatives: ["Maintain the current approach."],
    suggestedOwner: "Marketing lead",
    timing: "Start within 30 days",
    kpi: "Qualified conversion rate",
    firstTest: "Run a bounded audience test.",
    scaleCriterion: "Scale after the KPI improves by at least 2%.",
    stopCriterion: "Stop if the KPI declines for two test cycles.",
    evidenceIds: claims[index]!.evidenceIds,
    confidence: confidence(),
  }));
  return {
    evidenceIds,
    intelligence: {
      contractVersion: BRAND_INTELLIGENCE_CONTRACT_VERSION,
      brandId: "brand-123",
      researchMode: "deep",
      scope: {
        businessQuestions: ["Where can the brand grow with defensible advantage?"],
        geographies: ["Global"],
        languages: ["English"],
        periodEnd: "2026-07-30",
      },
      modules,
      claims,
      evidenceAssessments: evidenceIds.map((evidenceId, index) => ({
        evidenceId,
        independentSourceKey: `source-${index + 1}`,
        primarySource: index % 2 === 0,
        providerEstimate: false,
        sourceQuality: 85,
        directness: 85,
        freshness: 85,
        sampleAdequacy: 80,
      })),
      hypotheses: [
        {
          id: "hypothesis-1",
          module: "company_operating_model",
          statement: "A clearer offer hierarchy may reduce evaluation friction.",
          status: "mixed",
          supportingEvidenceIds: ["ev-1"],
          disconfirmingEvidenceIds: ["ev-2"],
          alternativeExplanations: ["The audience may lack category awareness."],
          validationStep: "Test the hierarchy against the current presentation.",
        },
      ],
      metrics,
      contradictions: [],
    visualizations,
      recommendations,
      limitations: ["Private financial and conversion data were not available."],
    },
  };
}

describe("Brand Intelligence quality gate", () => {
  test("accepts a complete, triangulated and decision-ready deep report", () => {
    const fixture = acceptedFixture();
    const result = evaluateBrandIntelligenceQuality(
      fixture.intelligence,
      fixture.evidenceIds,
      {
        visualEvidence: [
          {
            id: "asset-brand",
            module: "brand_positioning_creative",
            sourceUrl: "https://brand.example/creative",
            evidenceIds: ["ev-9"],
          },
          {
            id: "asset-competitor",
            module: "competitors",
            sourceUrl: "https://competitor.example/ad",
            evidenceIds: ["ev-21"],
          },
          {
            id: "asset-offer",
            module: "offers_pricing_portfolio",
            sourceUrl: "https://brand.example/offers",
            evidenceIds: ["ev-7"],
          },
          {
            id: "asset-social",
            module: "growth_channels_lifecycle",
            sourceUrl: "https://brand.example/social",
            evidenceIds: ["ev-13"],
          },
          {
            id: "asset-email",
            module: "growth_channels_lifecycle",
            sourceUrl: "https://brand.example/email",
            evidenceIds: ["ev-14"],
          },
          {
            id: "asset-product",
            module: "offers_pricing_portfolio",
            sourceUrl: "https://brand.example/product",
            evidenceIds: ["ev-8"],
          },
        ],
      },
    );

    expect(result.accepted).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.triangulatedMaterialClaimRatio).toBe(1);
    expect(result.blockingFailures).toEqual([]);
  });

  test("rejects polished-looking work without triangulation or analytical visuals", () => {
    const fixture = acceptedFixture();
    fixture.intelligence.claims = fixture.intelligence.claims.map((claim) => ({
      ...claim,
      evidenceIds: claim.evidenceIds.slice(0, 1),
    }));
    fixture.intelligence.visualizations = fixture.intelligence.visualizations.map(
      (visualization) => ({
        ...visualization,
        type: "evidence_gallery",
      }),
    );

    const result = evaluateBrandIntelligenceQuality(
      fixture.intelligence,
      fixture.evidenceIds,
      {
        visualEvidence: [
          {
            id: "asset-brand",
            module: "brand_positioning_creative",
            sourceUrl: "https://brand.example/creative",
            evidenceIds: ["ev-9"],
          },
          {
            id: "asset-competitor",
            module: "competitors",
            sourceUrl: "https://competitor.example/ad",
            evidenceIds: ["ev-21"],
          },
        ],
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.blockingFailures.join(" ")).toContain(
      "independently triangulated",
    );
    expect(result.blockingFailures.join(" ")).toContain(
      "analytical visual",
    );
  });

  test("rejects an unresolved contradiction behind a confident claim", () => {
    const fixture = acceptedFixture();
    fixture.intelligence.contradictions = [
      {
        id: "contradiction-1",
        module: "market_category",
        description: "Two current sources disagree about category growth.",
        evidenceIds: ["ev-3", "ev-4"],
        status: "open",
        implication: "The market-growth recommendation remains conditional.",
      },
    ];

    const result = evaluateBrandIntelligenceQuality(
      fixture.intelligence,
      fixture.evidenceIds,
      {
        visualEvidence: [
          {
            id: "asset-brand",
            module: "brand_positioning_creative",
            sourceUrl: "https://brand.example/creative",
            evidenceIds: ["ev-9"],
          },
          {
            id: "asset-competitor",
            module: "competitors",
            sourceUrl: "https://competitor.example/ad",
            evidenceIds: ["ev-21"],
          },
        ],
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.blockingFailures.join(" ")).toContain(
      "medium- or high-confidence claim",
    );
  });

  test("rejects a complete visual module that only has prose", () => {
    const fixture = acceptedFixture();

    const result = evaluateBrandIntelligenceQuality(
      fixture.intelligence,
      fixture.evidenceIds,
      {
        visualEvidence: [
          {
            id: "asset-brand",
            module: "brand_positioning_creative",
            sourceUrl: "https://brand.example/creative",
            evidenceIds: ["ev-9"],
          },
        ],
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.blockingFailures.join(" ")).toContain(
      "Complete visual modules lack source previews: competitors",
    );
  });

  test("rejects empty chart shells even when they have polished titles", () => {
    const fixture = acceptedFixture();
    fixture.intelligence.visualizations = fixture.intelligence.visualizations.map(
      (visualization) => ({
        ...visualization,
        data: {},
      }),
    );

    const result = evaluateBrandIntelligenceQuality(
      fixture.intelligence,
      fixture.evidenceIds,
      {
        visualEvidence: [
          {
            id: "asset-brand",
            module: "brand_positioning_creative",
            sourceUrl: "https://brand.example/creative",
            evidenceIds: ["ev-9"],
          },
          {
            id: "asset-competitor",
            module: "competitors",
            sourceUrl: "https://competitor.example/ad",
            evidenceIds: ["ev-21"],
          },
        ],
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.blockingFailures.join(" ")).toContain(
      "Complete modules lack a source-linked analytical visual",
    );
  });
});
