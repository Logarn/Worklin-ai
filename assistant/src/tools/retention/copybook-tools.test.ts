import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { rawRun } from "../../memory/raw-query.js";
import {
  conversations,
  retentionBrands,
  retentionCopybookSnapshots,
} from "../../memory/schema.js";
import type { ToolContext } from "../types.js";
import {
  executeCopybookCampaignCreate,
  executeCopybookCampaignUpdate,
  executeCopybookCreate,
  executeCopybookList,
  executeCopybookMonthCreate,
  executeCopybookMonthUpdate,
} from "./copybook-tools.js";

initializeDb();

const context = {
  conversationId: "copybook-tool-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
  sourceActorPrincipalId: "principal-1",
} as ToolContext;

function parsed(result: { content: string }) {
  return JSON.parse(result.content) as Record<string, any>;
}

beforeEach(() => {
  const db = getDb();
  db.delete(retentionCopybookSnapshots).run();
  rawRun("DELETE FROM retention_copybook_campaigns");
  rawRun("DELETE FROM retention_copybook_months");
  rawRun("DELETE FROM retention_copybooks");
  rawRun("DELETE FROM document_conversations");
  rawRun("DELETE FROM documents");
  db.delete(retentionBrands).run();
  db.delete(conversations).run();
  const now = Date.now();
  db.insert(retentionBrands)
    .values({
      id: "brand-1",
      name: "Example Brand",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(conversations)
    .values({
      id: context.conversationId,
      title: "Copybook tools",
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

async function buildCampaignInCopyReview() {
  const copybookResult = await executeCopybookCreate(
    { brand_id: "brand-1", year: 2026 },
    context,
  );
  const copybook = parsed(copybookResult).copybook;
  const monthResult = await executeCopybookMonthCreate(
    { copybook_id: copybook.id, month: 1 },
    context,
  );
  const month = parsed(monthResult).month;
  const campaignResult = await executeCopybookCampaignCreate(
    {
      month_id: month.id,
      channel: "email",
      ordinal: 1,
      title: "New Year Email",
    },
    context,
  );
  const campaign = parsed(campaignResult).campaign;
  for (const status of [
    "brief_review",
    "brief_approved",
    "copy_draft",
    "copy_review",
  ]) {
    const result = await executeCopybookCampaignUpdate(
      {
        campaign_id: campaign.id,
        status,
        ...(status === "brief_approved" ? { explicitly_approved: true } : {}),
      },
      context,
    );
    expect(result.isError).toBe(false);
  }
  return { copybook, month, campaign };
}

describe("copybook skill tools", () => {
  test("creates and reads a structured annual copybook", async () => {
    const { copybook, month, campaign } = await buildCampaignInCopyReview();
    const result = await executeCopybookList(
      { copybook_id: copybook.id },
      context,
    );
    const detail = parsed(result);

    expect(result.isError).toBe(false);
    expect(detail.copybook.year).toBe(2026);
    expect(detail.months[0].id).toBe(month.id);
    expect(detail.months[0].campaigns[0].id).toBe(campaign.id);
  });

  test("requires direct approval for strategy and campaign gates", async () => {
    const copybookResult = await executeCopybookCreate(
      { brand_id: "brand-1", year: 2026 },
      context,
    );
    const copybook = parsed(copybookResult).copybook;
    const monthResult = await executeCopybookMonthCreate(
      { copybook_id: copybook.id, month: 1 },
      context,
    );
    const month = parsed(monthResult).month;
    const campaignResult = await executeCopybookCampaignCreate(
      {
        month_id: month.id,
        channel: "email",
        ordinal: 1,
        title: "New Year Email",
      },
      context,
    );
    const campaign = parsed(campaignResult).campaign;
    await executeCopybookMonthUpdate(
      { month_id: month.id, strategy_status: "in_review" },
      context,
    );
    await executeCopybookCampaignUpdate(
      { campaign_id: campaign.id, status: "brief_review" },
      context,
    );

    const strategy = await executeCopybookMonthUpdate(
      { month_id: month.id, strategy_status: "approved" },
      context,
    );
    const brief = await executeCopybookCampaignUpdate(
      { campaign_id: campaign.id, status: "brief_approved" },
      context,
    );
    const copy = await executeCopybookCampaignUpdate(
      { campaign_id: campaign.id, action: "approve" },
      context,
    );

    expect(strategy.isError).toBe(true);
    expect(parsed(strategy).error).toContain("explicitly_approved");
    expect(brief.isError).toBe(true);
    expect(parsed(brief).error).toContain("explicitly_approved");
    expect(copy.isError).toBe(true);
    expect(parsed(copy).error).toContain("explicitly_approved");
  });

  test("snapshots explicitly approved strategy, copy, and design handoff", async () => {
    const { month, campaign } = await buildCampaignInCopyReview();
    await executeCopybookMonthUpdate(
      { month_id: month.id, strategy_status: "in_review" },
      context,
    );
    const strategy = await executeCopybookMonthUpdate(
      {
        month_id: month.id,
        strategy_status: "approved",
        explicitly_approved: true,
      },
      context,
    );
    const copy = await executeCopybookCampaignUpdate(
      {
        campaign_id: campaign.id,
        action: "approve",
        explicitly_approved: true,
      },
      context,
    );
    const handoff = await executeCopybookCampaignUpdate(
      {
        campaign_id: campaign.id,
        action: "ready_for_design",
        explicitly_approved: true,
      },
      context,
    );

    expect(strategy.isError).toBe(false);
    expect(parsed(copy).campaign.status).toBe("approved");
    expect(parsed(handoff).campaign.status).toBe("ready_for_design");
    const snapshots = getDb()
      .select()
      .from(retentionCopybookSnapshots)
      .where(eq(retentionCopybookSnapshots.monthId, month.id))
      .all();
    expect(snapshots.map((snapshot) => snapshot.kind).sort()).toEqual([
      "brief_approved",
      "copy_approved",
      "ready_for_design",
      "strategy_approved",
    ]);
    expect(
      snapshots.every(
        (snapshot) => snapshot.actorPrincipalId === "principal-1",
      ),
    ).toBe(true);
  });
});
