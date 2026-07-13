import { beforeEach, describe, expect, test } from "bun:test";

import { createDraftBrandBrain } from "@vellumai/retention-domain";

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
});
