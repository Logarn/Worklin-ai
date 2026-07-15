import { beforeEach, describe, expect, test } from "bun:test";

import { createDraftBrandBrain } from "@vellumai/retention-domain";

import { run as saveBrandResearch } from "../../config/bundled-skills/worklin-brand-brain/tools/brand-research-save.js";
import { saveBrandBrain } from "../../memory/brand-brain-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  retentionBrandBrainEvents,
  retentionBrandBrains,
  retentionBrands,
  retentionConversationBrandScopes,
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

describe("Brand Brain skill tools", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(retentionBrandBrainEvents).run();
    db.delete(retentionConversationBrandScopes).run();
    db.delete(retentionBrandBrains).run();
    db.delete(retentionBrands).run();
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
    const result = await saveBrandResearch(
      {
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
              id: "official-home",
              url: "https://acme.example",
              title: "Acme Studio homepage",
              sourceType: "official_site",
              observedAt: "2026-07-15",
              finding: "The homepage describes a focused workflow tool.",
              confidence: "high",
            },
          ],
          gaps: ["Public customer sentiment was not available."],
          recommendations: [],
          safety: {
            readOnly: true,
            publicSourcesOnly: true,
            unsupportedClaimsExcluded: true,
            caveats: [],
          },
        },
      },
      context,
    );
    const parsed = JSON.parse(result.content);
    expect(result.isError).toBe(false);
    expect(parsed.saved).toBe(true);
    const stored = JSON.parse(
      (await executeBrandBrainRead({}, context)).content,
    );
    expect(stored.profile.research.version).toBe("brand_research_v1");
    expect(stored.profile.caveats).toContain(
      "Research findings are public observations and inferences, not approved brand claims.",
    );
  });
});
