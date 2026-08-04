import { beforeEach, describe, expect, test } from "bun:test";

import { createDraftBrandBrain } from "@vellumai/retention-domain";

import { run as saveBrandResearch } from "../../config/bundled-skills/worklin-brand-brain/tools/brand-research-save.js";
import { getDocumentById } from "../../documents/document-store.js";
import { listArtifacts } from "../../memory/artifact-store.js";
import { saveBrandBrain } from "../../memory/brand-brain-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { rawRun } from "../../memory/raw-query.js";
import {
  conversations,
  retentionBrandBrainEvents,
  retentionBrandBrains,
  retentionBrands,
  retentionConversationBrandScopes,
  retentionSourceSnapshots,
} from "../../memory/schema.js";
import type { ToolContext } from "../types.js";
import {
  executeBrandBrainApplyCorrection,
  executeBrandBrainRead,
  executeBrandBrainRecordCampaignOutcome,
} from "./brand-brain-tools.js";

initializeDb();

const context = {
  conversationId: "copy-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
} as ToolContext;

function createVisualResearchInput() {
  const observedAt = "2026-07-15";
  const sources = {
    ad: "https://insights.example/ads/ad-1",
    email: "https://insights.example/emails/email-1",
    social: "https://insights.example/social/post-1",
    product: "https://insights.example/products/product-1",
    landingPage: "https://insights.example/pages/landing-1",
    brand: "https://acme.example/about",
    competitor: "https://rival.example",
  };
  return {
    report: {
      version: "brand_research_v1",
      generatedAt: "2026-07-15T12:00:00.000Z",
      query: {
        brandName: "Acme Studio",
        websiteUrl: "https://acme.example",
      },
      executiveSummary: ["The public site emphasizes a focused workflow."],
      identity: {
        category: "Workflow software",
        positioning: "A focused workflow tool.",
        offers: ["Core product"],
        audienceSignals: ["Small teams"],
      },
      competitorLandscape: [],
      channelFindings: {
        seoAndContent: [],
        social: [],
        emailAndLifecycle: [],
        sms: [],
        productAndLaunches: [],
      },
      marketSignals: [],
      customerSignals: [],
      trendSignals: [],
      evidence: [
        {
          id: "visual-ad-1",
          url: sources.ad,
          title: "Public ad detail",
          provider: "trendtrack",
          sourceType: "other",
          observedAt,
          finding: "The ad uses a workflow handoff demonstration.",
          confidence: "medium",
        },
        {
          id: "visual-email-1",
          url: sources.email,
          title: "Public email preview",
          provider: "trendtrack",
          sourceType: "other",
          observedAt,
          finding: "The email promotes a guided workflow.",
          confidence: "medium",
        },
        {
          id: "visual-social-1",
          url: sources.social,
          title: "Public social post",
          provider: "trendtrack",
          sourceType: "social_profile",
          observedAt,
          finding: "The post demonstrates a short team workflow.",
          confidence: "medium",
        },
        {
          id: "visual-product-1",
          url: sources.product,
          title: "Public product page",
          provider: "trendtrack",
          sourceType: "official_site",
          observedAt,
          finding: "The product page presents the core workspace.",
          confidence: "high",
        },
        {
          id: "visual-landing-1",
          url: sources.landingPage,
          title: "Public landing page",
          provider: "trendtrack",
          sourceType: "official_site",
          observedAt,
          finding: "The landing page leads with faster handoffs.",
          confidence: "high",
        },
        {
          id: "visual-brand-1",
          url: sources.brand,
          title: "Public brand page",
          sourceType: "official_site",
          observedAt,
          finding: "The brand page describes a focused operating philosophy.",
          confidence: "high",
        },
        {
          id: "visual-competitor-1",
          url: sources.competitor,
          title: "Public competitor page",
          provider: "trendtrack",
          sourceType: "competitor_site",
          observedAt,
          finding: "The competitor page promotes a broad collaboration suite.",
          confidence: "medium",
        },
      ],
      visualEvidence: [
        {
          id: "preview-ad-1",
          kind: "ad",
          title: "Workflow handoff ad",
          sourceUrl: sources.ad,
          mediaUrl: "https://media.example/ad-1.jpg",
          mediaType: "image",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-ad-1"],
          caption: "A public ad preview focused on faster handoffs.",
          caveats: ["Spend and conversion data were not observable."],
        },
        {
          id: "preview-email-1",
          kind: "email",
          title: "Guided workflow email",
          sourceUrl: sources.email,
          mediaUrl: "https://media.example/email-1.jpg",
          mediaType: "image",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-email-1"],
          caveats: [],
        },
        {
          id: "preview-social-1",
          kind: "social",
          title: "Short workflow demonstration",
          sourceUrl: sources.social,
          mediaUrl: "https://media.example/social-1.mp4",
          thumbnailUrl: "https://media.example/social-1.jpg",
          mediaType: "video",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-social-1"],
          caveats: [],
        },
        {
          id: "preview-product-1",
          kind: "product",
          title: "Core workspace product",
          sourceUrl: sources.product,
          mediaUrl: "https://media.example/product-1.jpg",
          mediaType: "image",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-product-1"],
          caveats: [],
        },
        {
          id: "preview-landing-1",
          kind: "landing_page",
          title: "Faster handoffs landing page",
          sourceUrl: sources.landingPage,
          thumbnailUrl: "https://media.example/landing-1.jpg",
          mediaType: "page",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-landing-1"],
          caveats: [],
        },
        {
          id: "preview-brand-1",
          kind: "brand",
          title: "Acme Studio brand page",
          sourceUrl: sources.brand,
          mediaType: "page",
          observedAt,
          evidenceIds: ["visual-brand-1"],
          caveats: ["No durable public preview image was available."],
        },
        {
          id: "preview-competitor-1",
          kind: "competitor",
          title: "Rival Studio homepage",
          sourceUrl: sources.competitor,
          thumbnailUrl: "https://media.example/competitor-1.jpg",
          mediaType: "page",
          observedAt,
          provider: "trendtrack",
          evidenceIds: ["visual-competitor-1"],
          caveats: [],
        },
      ],
      gaps: ["Private campaign performance was not available."],
      recommendations: [],
      safety: {
        readOnly: true,
        publicSourcesOnly: true,
        unsupportedClaimsExcluded: true,
        caveats: [],
      },
    },
  };
}

describe("Brand Brain skill tools", () => {
  beforeEach(() => {
    const db = getDb();
    rawRun("DELETE FROM artifacts");
    rawRun("DELETE FROM document_conversations");
    rawRun("DELETE FROM documents");
    db.delete(retentionBrandBrainEvents).run();
    db.delete(retentionConversationBrandScopes).run();
    db.delete(retentionBrandBrains).run();
    db.delete(retentionBrands).run();
    rawRun("DELETE FROM conversations WHERE id = ?", context.conversationId);
    const timestamp = Date.now();
    db.insert(conversations)
      .values({
        id: context.conversationId,
        title: "Brand research test",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    saveBrandBrain({
      brain: createDraftBrandBrain({ brandName: "Acme Studio" }),
      source: "onboarding",
      conversationId: context.conversationId,
    });
  });

  test("reads the profile bound to the conversation", async () => {
    const result = await executeBrandBrainRead({}, context);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.profile.brandName).toBe("Acme Studio");
  });

  test("refuses to persist an unapproved correction", async () => {
    const result = await executeBrandBrainApplyCorrection(
      {
        field: "rule_dont",
        operation: "add",
        value: "Do not use hype.",
        explicitly_approved: false,
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("explicitly_approved");
  });

  test("persists approved corrections and confirmed campaign outcomes", async () => {
    const correction = await executeBrandBrainApplyCorrection(
      {
        field: "rule_dont",
        operation: "add",
        value: "Do not use hype.",
        explicitly_approved: true,
      },
      context,
    );
    const outcome = await executeBrandBrainRecordCampaignOutcome(
      {
        campaign_type: "product_video",
        insight: "Workflow demonstrations improved completion.",
        outcome: "winning",
        evidence: "User-confirmed analytics review.",
        result_confirmed: true,
      },
      context,
    );

    expect(correction.isError).toBe(false);
    expect(JSON.parse(correction.content).profile.rules).toContainEqual({
      type: "dont",
      rule: "Do not use hype.",
    });
    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.content).profile.campaignMemory).toHaveLength(1);
  });

  test("persists a public research report as unapproved Brand Brain context", async () => {
    const input = {
      report: {
        version: "brand_research_v1",
        generatedAt: "2026-07-15T00:00:00.000Z",
        query: {
          brandName: "Acme Studio",
          websiteUrl: "https://acme.example",
        },
        executiveSummary: ["The public site emphasizes a focused workflow."],
        identity: {
          category: "Workflow software",
          positioning: "A focused workflow tool.",
          offers: ["Core product"],
          audienceSignals: ["Small teams"],
        },
        competitorLandscape: [
          {
            name: "Rival Studio",
            websiteUrl: "https://rival.example",
            classification: "direct",
            rationale: "It targets the same small-team workflow buyer.",
            positioning: "A broad collaborative workflow suite.",
            offers: ["Team workspace"],
            pricingPosture: "Public per-seat subscription.",
            channelSignals: {
              paidMedia: ["Promotes faster project handoffs."],
              social: ["Uses short workflow demonstrations."],
              seoAndContent: ["Publishes workflow comparison guides."],
              emailAndLifecycle: ["Public signup promises weekly tips."],
            },
            differentiators: ["Broader collaboration surface."],
            notableMoves: ["Introduced a team workspace."],
            gaps: ["Private campaign performance is not observable."],
            evidenceIds: ["competitor-home"],
            confidence: "medium",
          },
        ],
        channelFindings: {
          seoAndContent: [],
          social: [],
          emailAndLifecycle: [],
          sms: [],
          productAndLaunches: [],
        },
        marketSignals: [],
        customerSignals: [],
        trendSignals: [],
        evidence: [
          {
            id: "official-home",
            url: "https://acme.example",
            title: "Acme Studio homepage",
            sourceType: "official_site",
            observedAt: "2026-07-15",
            finding: "The homepage describes a focused workflow tool.",
            confidence: "high",
          },
          {
            id: "competitor-home",
            url: "https://rival.example",
            title: "Rival Studio homepage",
            sourceType: "competitor_site",
            observedAt: "2026-07-15",
            finding: "The homepage promotes a team workspace.",
            confidence: "medium",
          },
        ],
        gaps: ["Public customer sentiment was not available."],
        recommendations: [
          {
            priority: "now",
            action: "Test a focused workflow comparison page.",
            rationale:
              "The observed competitor promotes a broader collaborative workspace.",
            evidenceIds: ["competitor-home"],
          },
        ],
        safety: {
          readOnly: true,
          publicSourcesOnly: true,
          unsupportedClaimsExcluded: true,
          caveats: [],
        },
      },
    };
    const result = await saveBrandResearch(input, context);
    const parsed = JSON.parse(result.content);
    expect(result.isError).toBe(false);
    expect(parsed.saved).toBe(true);
    expect(parsed.artifactSaved).toBe(true);
    expect(parsed.snapshotId).toStartWith("brand_research_");
    const stored = JSON.parse(
      (await executeBrandBrainRead({}, context)).content,
    );
    expect(stored.profile.research.version).toBe("brand_research_v1");
    expect(stored.profile.caveats).toContain(
      "Research findings are public observations and inferences, not approved brand claims.",
    );
    expect(stored.researchHistory.preserved).toBe(true);
    expect(stored.researchHistory.snapshots).toHaveLength(1);
    expect(stored.researchHistory.snapshots[0].snapshotId).toBe(
      parsed.snapshotId,
    );
    const savedSnapshot = getDb().select().from(retentionSourceSnapshots).get();
    expect(savedSnapshot?.status).toBe("accepted");
    expect(
      JSON.parse(savedSnapshot?.snapshotJson ?? "{}").report.query.brandName,
    ).toBe("Acme Studio");
    const artifacts = listArtifacts({
      brandId: parsed.brandId,
      artifactType: "competitor_intelligence",
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.title).toBe("Competitor Intelligence");
    expect(artifacts[0]?.metadata?.snapshotId).toBe(parsed.snapshotId);
    expect(artifacts[0]?.metadata?.researchHistoryPreserved).toBe(true);
    const document = getDocumentById(parsed.artifactSurfaceId);
    expect(document?.content).toContain("# Acme Studio Brand Research");
    expect(document?.content).toContain("### [Rival Studio]");
    expect(document?.content).toContain("**Class:** direct");
    expect(document?.content).toContain("#### Paid media");
    expect(document?.content).toContain(
      "No visual previews were saved for this report.",
    );
    expect(document?.content).toContain(
      "Test a focused workflow comparison page.",
    );
    expect(document?.content).toContain("## Evidence Ledger");

    const retry = await saveBrandResearch(input, context);
    expect(retry.isError).toBe(false);
    expect(
      listArtifacts({
        brandId: parsed.brandId,
        artifactType: "competitor_intelligence",
      }),
    ).toHaveLength(1);
    const refreshed = JSON.parse(
      (await executeBrandBrainRead({}, context)).content,
    );
    expect(
      refreshed.profile.sourceProvenance.filter(
        (source: { sourceType?: string }) =>
          source.sourceType === "brand_research",
      ),
    ).toHaveLength(1);
    expect(refreshed.researchHistory.snapshots).toHaveLength(1);

    const changedInput = structuredClone(input);
    changedInput.report.generatedAt = "2026-07-16T00:00:00.000Z";
    changedInput.report.executiveSummary = [
      "The refreshed public evidence shows a more focused workflow message.",
    ];
    const changed = await saveBrandResearch(changedInput, context);
    const changedParsed = JSON.parse(changed.content);
    expect(changed.isError).toBe(false);
    expect(changedParsed.snapshotId).not.toBe(parsed.snapshotId);
    const afterChange = JSON.parse(
      (await executeBrandBrainRead({}, context)).content,
    );
    expect(afterChange.profile.research.generatedAt).toBe(
      "2026-07-16T00:00:00.000Z",
    );
    expect(afterChange.researchHistory.snapshots).toHaveLength(2);
  });

  test("persists and renders the stable visual evidence contract for every supported kind", async () => {
    const result = await saveBrandResearch(
      createVisualResearchInput(),
      context,
    );
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.visualEvidenceCount).toBe(7);
    expect(parsed.artifactType).toBe("competitor_intelligence");
    const stored = JSON.parse(
      (await executeBrandBrainRead({}, context)).content,
    );
    expect(stored.profile.research.visualEvidence).toHaveLength(7);
    const artifact = listArtifacts({
      brandId: parsed.brandId,
      artifactType: "competitor_intelligence",
    })[0];
    expect(artifact?.title).toBe("Competitor Intelligence");
    expect(artifact?.metadata?.title).toBe("Competitor Intelligence");
    const artifactPayload = artifact?.metadata?.competitorIntelligence as
      | {
          visualEvidence?: unknown[];
        }
      | undefined;
    expect(artifactPayload?.visualEvidence).toHaveLength(7);
    const document = getDocumentById(parsed.artifactSurfaceId);
    expect(document?.content).toContain("## Visual Evidence Gallery");
    expect(document?.content).toContain("### Ads");
    expect(document?.content).toContain("### Emails");
    expect(document?.content).toContain("### Social Posts");
    expect(document?.content).toContain("### Products");
    expect(document?.content).toContain("### Landing Pages");
    expect(document?.content).toContain("### Brand");
    expect(document?.content).toContain("### Competitors");
    expect(document?.content).toContain(
      "[![Workflow handoff ad](https://media.example/ad-1.jpg)](https://insights.example/ads/ad-1)",
    );
    expect(document?.content).toContain(
      "[![Short workflow demonstration](https://media.example/social-1.jpg)](https://insights.example/social/post-1)",
    );
    expect(document?.content).toContain(
      "[Open video media](https://media.example/social-1.mp4)",
    );
    expect(document?.content).toContain(
      "#### [Acme Studio brand page](https://acme.example/about)",
    );
    expect(document?.content).toContain("**Provider:** `trendtrack`");
    expect(document?.content).toContain("**Evidence:** `visual-ad-1`");
    expect(document?.content).toContain(
      "**Caveat:** Spend and conversion data were not observable.",
    );
  });

  test.each([
    ["data media URL", "mediaUrl", "data:image/png;base64,abc"],
    ["javascript source URL", "sourceUrl", "javascript:alert(1)"],
    [
      "embedded URL credentials",
      "mediaUrl",
      "https://user:password@media.example/ad.jpg",
    ],
    [
      "credential query parameter",
      "mediaUrl",
      "https://media.example/ad.jpg?access_token=secret",
    ],
    [
      "credential thumbnail URL",
      "thumbnailUrl",
      "https://media.example/ad.jpg?token=secret",
    ],
    ["private source URL", "sourceUrl", "http://127.0.0.1/ad"],
  ])("rejects visual evidence with %s", async (_label, field, value) => {
    const input = createVisualResearchInput();
    const item = input.report.visualEvidence[0] as Record<string, unknown>;
    item[field] = value;

    const result = await saveBrandResearch(input, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      `visualEvidence[0].${field}`,
    );
  });

  test("rejects credential fields that are not part of the visual evidence contract", async () => {
    const input = createVisualResearchInput();
    const item = input.report.visualEvidence[0] as Record<string, unknown>;
    item.apiKey = "not-allowed";

    const result = await saveBrandResearch(input, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "contains unsupported field apiKey",
    );
  });

  test("rejects visual evidence without matching evidence-ledger provenance", async () => {
    const unknownEvidenceInput = createVisualResearchInput();
    unknownEvidenceInput.report.visualEvidence[0]!.evidenceIds = ["unknown"];
    const unknownEvidence = await saveBrandResearch(
      unknownEvidenceInput,
      context,
    );
    expect(unknownEvidence.isError).toBe(true);
    expect(JSON.parse(unknownEvidence.content).error).toContain(
      "references unknown evidence ID unknown",
    );

    const providerMismatchInput = createVisualResearchInput();
    providerMismatchInput.report.visualEvidence[0]!.provider = "public-web";
    const providerMismatch = await saveBrandResearch(
      providerMismatchInput,
      context,
    );
    expect(providerMismatch.isError).toBe(true);
    expect(JSON.parse(providerMismatch.content).error).toContain(
      "must match linked evidence provider trendtrack",
    );
  });

  test("caps each visual evidence kind at six items", async () => {
    const input = createVisualResearchInput();
    const first = input.report.visualEvidence[0]!;
    (input.report as Record<string, unknown>).visualEvidence = Array.from(
      { length: 7 },
      (_, index) => ({
        ...first,
        id: `preview-ad-${index + 1}`,
        mediaUrl: `https://media.example/ad-${index + 1}.jpg`,
        title: `Workflow handoff ad ${index + 1}`,
      }),
    );

    const result = await saveBrandResearch(input, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "visualEvidence may include at most 6 ad items",
    );
  });

  test("caps the full visual evidence payload at twenty-four items", async () => {
    const input = createVisualResearchInput();
    const originals = input.report.visualEvidence;
    (input.report as Record<string, unknown>).visualEvidence = Array.from(
      { length: 25 },
      (_, index) => {
        const original = originals[index % originals.length]!;
        return {
          ...original,
          id: `preview-${original.kind}-${index + 1}`,
        };
      },
    );

    const result = await saveBrandResearch(input, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "visualEvidence may include at most 24 items in total",
    );
  });
});
