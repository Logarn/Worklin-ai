import { describe, expect, test } from "bun:test";

import {
  applyBrandBrainCorrection,
  buildDeepRetentionAudit,
  buildRetentionContextPack,
  buildRetentionMicroSegments,
  buildUnifiedCustomerView,
  buildUnifiedRetentionAudit,
  computeRetentionCustomerFeatures,
  createDraftBrandBrain,
  findRetentionCampaignOpportunities,
  findRetentionMissingPieces,
  generateRetentionAuditArtifact,
  getRetentionAuditStatus,
  generateRetentionCampaignPackage,
  getRetentionBrandBrain,
  getRetentionKlaviyoSnapshot,
  getRetentionShopifySnapshot,
  getRetentionSourceStatus,
  RETENTION_BLOCKED_CAPABILITIES,
  recordBrandBrainCampaignLearning,
  runRetentionQa,
  scheduleRetentionAudit,
  scoreRetentionCustomers,
} from "./index.js";

describe("retention-domain safety posture", () => {
  test("source status never reports live external action", () => {
    const result = getRetentionSourceStatus();

    expect(result.safety.externalActionTaken).toBe(false);
    expect(result.safety.canGoLiveNow).toBe(false);
    expect(result.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
    expect(result.summary.readyForReadOnlyAudit).toBe(true);
  });

  test("blocked capabilities include every live Shopify/Klaviyo mutation", () => {
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("shopify_write");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_send_campaign");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_schedule_campaign");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_activate_flow");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_mutate_segment");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_mutate_profile");
  });
});

describe("Worklin Retention Brain", () => {
  test("onboarding drafts never persist demo fixture facts", () => {
    const result = createDraftBrandBrain({
      brandName: "Acme Studio",
      websiteUrl: "https://acme.example",
      storefront: {
        status: "fetched",
        title: "Acme Studio",
        description: "Practical tools for independent design teams.",
        productHints: ["Design operations toolkit"],
      },
    });

    expect(result.brandName).toBe("Acme Studio");
    expect(result.positioning.story).toContain("Practical tools");
    expect(result.products).toEqual([]);
    expect(result.offers).toEqual([]);
    expect(result.sourceProvenance.some((source) => source.status === "fixture"))
      .toBe(false);
    expect(result.caveats.join(" ")).not.toContain("Fixture brand brain");
  });

  test("approved corrections and verified outcomes update structured context", () => {
    const draft = createDraftBrandBrain({ brandName: "Acme Studio" });
    const corrected = applyBrandBrainCorrection(draft, {
      field: "rule_dont",
      operation: "add",
      value: "Do not use manufactured urgency.",
    });
    const learned = recordBrandBrainCampaignLearning(corrected, {
      campaignType: "welcome_email",
      insight: "A product demonstration drove more qualified replies.",
      outcome: "winning",
    });

    expect(corrected.rules).toContainEqual({
      type: "dont",
      rule: "Do not use manufactured urgency.",
    });
    expect(
      corrected.sourceProvenance.some(
        (source) => source.status === "approved",
      ),
    ).toBe(true);
    expect(learned.campaignMemory).toContainEqual({
      campaignType: "welcome_email",
      insight: "A product demonstration drove more qualified replies.",
      outcome: "winning",
    });
  });

  test("Brand Brain exposes voice, rules, and safety metadata", () => {
    const result = getRetentionBrandBrain();

    expect(result.brandName).toContain("Worklin");
    expect(result.websiteUrl).toContain("example.worklin.ai");
    expect(result.voice.summary).toBeTruthy();
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.audienceNotes.length).toBeGreaterThan(0);
    expect(result.compliance.forbiddenClaims.length).toBeGreaterThan(0);
    expect(result.documentSources.length).toBeGreaterThan(0);
    expect(result.sourceProvenance.length).toBeGreaterThan(0);
    expect(result.readiness.status).toBe("partial");
    expect(result.readiness.score).toBeGreaterThan(0);
    expect(result.safety.externalActionTaken).toBe(false);
  });

  test("Brand Brain and context pack honor conversational onboarding brand inputs", () => {
    const context = buildRetentionContextPack({
      brandName: "Dr. Rachael Institute",
      websiteUrl: "https://drrachaelinstitute.com",
    });

    expect(context.brandSummary.brandName).toBe("Dr. Rachael Institute");
    expect(context.title).toContain("Dr. Rachael Institute");
    expect(context.brandSummary.readiness.completed).toContain(
      "Brand website/domain provided in onboarding conversation",
    );
    expect(context.brandSummary.readiness.nextActions[0]).toContain(
      "Research the public site",
    );
  });

  test("Shopify and Klaviyo snapshots are read-only fixture-backed sources", () => {
    const shopify = getRetentionShopifySnapshot();
    const klaviyo = getRetentionKlaviyoSnapshot();

    expect(shopify.platform).toBe("shopify");
    expect(shopify.summary.customers).toBeGreaterThan(0);
    expect(shopify.safety.blockedCapabilities).toContain("shopify_write");
    expect(klaviyo.platform).toBe("klaviyo");
    expect(klaviyo.lifecycleCoverage.missing.length).toBeGreaterThan(0);
    expect(klaviyo.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
  });

  test("unified identity joins Shopify and Klaviyo coverage with caveats", () => {
    const result = buildUnifiedCustomerView();

    expect(result.summary.totalIdentities).toBeGreaterThan(0);
    expect(result.summary.matchedAcrossSources).toBeGreaterThan(0);
    expect(result.summary.shopifyOnly).toBeGreaterThan(0);
  });

  test("feature snapshots preserve Worklin-style retention labels", () => {
    const result = computeRetentionCustomerFeatures();

    expect(result.summary.evaluatedCustomers).toBeGreaterThan(0);
    expect(result.summary.highPriorityCustomers).toBeGreaterThan(0);
    expect(
      result.features.some((feature) =>
        feature.derivedLabels.includes("replenishment_ready"),
      ),
    ).toBe(true);
  });

  test("scoring and micro-segments expose action-ready but definition-only output", () => {
    const scores = scoreRetentionCustomers();
    const segments = buildRetentionMicroSegments();

    expect(scores.summary.readyToBuyAgain).toBeGreaterThan(0);
    expect(scores.summary.suppressionRisk).toBeGreaterThan(0);
    expect(segments.summary.activationStatus).toBe("definition_only");
    expect(
      segments.definitions.every((definition) => !definition.klaviyoNativePossible),
    ).toBe(true);
  });

  test("missing pieces detect Klaviyo lifecycle gaps", () => {
    const result = findRetentionMissingPieces();

    expect(result.summary.total).toBeGreaterThan(0);
    expect(
      result.missingPieces.some((piece) => piece.id === "missing_winback"),
    ).toBe(true);
    expect(result.safety.externalActionTaken).toBe(false);
  });

  test("campaign opportunities are draft-only and blocked from live action", () => {
    const result = findRetentionCampaignOpportunities();

    expect(result.summary.draftOnly).toBe(true);
    expect(result.safety.canGoLiveNow).toBe(false);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opportunity of result.opportunities) {
      expect(opportunity.blockedByMissingCapabilities).toContain(
        "shopify_write",
      );
    }
  });

  test("campaign package requires approval and QA blocks live readiness", () => {
    const campaignPackage = generateRetentionCampaignPackage();
    const qa = runRetentionQa();

    expect(campaignPackage.status).toBe("package_only");
    expect(campaignPackage.approvalStatus).toBe("required");
    expect(campaignPackage.safety.externalActionTaken).toBe(false);
    expect(qa.approvalStatus).toBe("required");
    expect(qa.safety.canGoLiveNow).toBe(false);
    expect(qa.checks.some((check) => check.id === "send_schedule_blocked")).toBe(
      true,
    );
  });

  test("context pack and unified audit are compact safe assistant inputs", () => {
    const context = buildRetentionContextPack();
    const audit = buildUnifiedRetentionAudit();

    expect(context.title).toContain("retention context");
    expect(context.topOpportunities.length).toBeGreaterThan(0);
    expect(context.brandSummary.readiness.status).toBe("partial");
    expect(context.brandSummary.avoidPhrases.length).toBeGreaterThan(0);
    expect(context.brandSummary.compliance.forbiddenClaims.length).toBeGreaterThan(0);
    expect(context.safety.externalActionTaken).toBe(false);
    expect(audit.title).toBe("Retention Audit");
    expect(audit.document.title).toBe("Retention Audit");
    expect(audit.document.contentMarkdown).toContain("Brand Brain Readiness");
    expect(audit.document.contentMarkdown).toContain("## Source Summary");
    expect(audit.safety.canGoLiveNow).toBe(false);
    expect(audit.actionLog.externalActionTaken).toBe(false);
  });

  test("deep audit produces the full Dr Rachel-style module and chart shape", () => {
    const audit = buildDeepRetentionAudit();
    const moduleIds = audit.modules.map((module) => module.moduleId);
    const chartFamilies = new Set(
      audit.artifact.charts.map((chart) => chart.family),
    );

    expect(audit.title).toBe("Deep Retention Audit");
    expect(audit.window.currentWindowDays).toBe(365);
    expect(audit.window.previousWindowDays).toBe(365);
    expect(moduleIds).toEqual([
      "data_trust",
      "brand_context",
      "product_performance",
      "campaign_performance",
      "segment_analysis",
      "lifecycle_flow",
      "acquisition_tofu",
      "quiz_funnel",
      "opportunity_backlog",
    ]);
    expect(chartFamilies).toEqual(
      new Set([
        "period_trend",
        "product_funnel",
        "product_quadrant",
        "weekly_campaign_cadence",
        "sale_non_sale_comparison",
        "subject_line_word_bank",
        "segment_theme_heatmap",
        "flow_stage_waterfall",
        "opportunity_priority_matrix",
      ]),
    );
    expect(audit.artifact.contentMarkdown).toContain(
      "Product Performance Report",
    );
    expect(audit.artifact.contentMarkdown).toContain("Campaign Report");
    expect(audit.artifact.contentMarkdown).toContain("Segment Report");
    expect(audit.artifact.contentMarkdown).toContain(
      "Flow and Lifecycle Report",
    );
    expect(audit.artifact.contentMarkdown).toContain(
      "Prioritized Opportunity Backlog",
    );
    expect(audit.auditTrace).toHaveLength(audit.modules.length);
    expect(audit.auditTrace[0]?.dataRead.length).toBeGreaterThan(0);
    expect(audit.auditTrace[0]?.ruleApplied.length).toBeGreaterThan(0);
    expect(audit.artifact.contentMarkdown).toContain(
      "Audit Reasoning Trace",
    );
    expect(audit.artifact.contentMarkdown).toContain(
      "not private model scratchpad",
    );
  });

  test("deep audit applies requested brand metadata and emits unique chart specs", () => {
    const audit = buildDeepRetentionAudit({
      brandName: "Dr. Rachael Institute",
      websiteUrl: "https://drrachaelinstitute.com",
    });
    const chartIds = audit.artifact.charts.map((chart) => chart.chartId);

    expect(audit.brandName).toBe("Dr. Rachael Institute");
    expect(audit.artifact.contentMarkdown).toContain(
      "Brand: Dr. Rachael Institute",
    );
    expect(new Set(chartIds).size).toBe(chartIds.length);
  });

  test("deep audit is artifact-only and never authorizes live action", () => {
    const audit = buildDeepRetentionAudit({ cadence: "monthly" });

    expect(audit.cadence).toBe("monthly");
    expect(audit.summary.backlogCount).toBeGreaterThan(0);
    expect(audit.safety.externalActionTaken).toBe(false);
    expect(audit.safety.canGoLiveNow).toBe(false);
    expect(audit.actionLog.externalActionTaken).toBe(false);
    expect(
      audit.opportunityBacklog.every(
        (item) =>
          item.artifactOnly &&
          !item.externalActionTaken &&
          !item.canGoLiveNow,
      ),
    ).toBe(true);
    expect(audit.safety.blockedCapabilities).toContain("shopify_write");
    expect(audit.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
  });

  test("audit status, schedule, and artifact helpers expose production interfaces", () => {
    const status = getRetentionAuditStatus();
    const schedule = scheduleRetentionAudit();
    const artifact = generateRetentionAuditArtifact();

    expect(status.status).toBe("ready");
    expect(schedule.schedules.map((item) => item.cadence)).toEqual([
      "weekly",
      "monthly",
      "quarterly",
    ]);
    expect(schedule.safety.externalActionTaken).toBe(false);
    expect(artifact.title).toBe("Deep Retention Audit");
    expect(artifact.charts.length).toBeGreaterThanOrEqual(9);
    expect(
      artifact.charts.every(
        (chart) => chart.diagnosis.length > 0 && chart.recommendation.length > 0,
      ),
    ).toBe(true);
  });
});
