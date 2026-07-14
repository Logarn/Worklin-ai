import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  approveCopybookCampaign,
  createCopybook,
  createCopybookCampaign,
  createCopybookMonth,
  getCopybookDetail,
  markCopybookCampaignReadyForDesign,
  updateCopybookCampaign,
  updateCopybookMonth,
} from "./copybook-store.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { rawRun } from "./raw-query.js";
import {
  conversations,
  retentionBrands,
  retentionCopybookSnapshots,
} from "./schema.js";

initializeDb();

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
      id: "conversation-1",
      title: "Copybook",
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

describe("copybook store", () => {
  test("creates a brand/year copybook and an atomic month document", () => {
    const copybook = createCopybook({ brandId: "brand-1", year: 2026 });
    const month = createCopybookMonth({
      copybookId: copybook.id,
      month: 1,
      conversationId: "conversation-1",
    });
    const detail = getCopybookDetail(copybook.id);

    expect(copybook.title).toBe("Example Brand // 2026 Copybook");
    expect(month.documentSurfaceId).toBeString();
    expect(detail.months).toHaveLength(1);
    expect(detail.months[0]?.campaigns).toEqual([]);
  });

  test("captures immutable whole-month snapshots for approvals", () => {
    const copybook = createCopybook({ brandId: "brand-1", year: 2026 });
    const month = createCopybookMonth({
      copybookId: copybook.id,
      month: 1,
      conversationId: "conversation-1",
    });
    rawRun(
      "UPDATE documents SET content = ?, updated_at = ? WHERE surface_id = ?",
      "# January strategy\n\nApproved copy.",
      1234,
      month.documentSurfaceId!,
    );
    updateCopybookMonth(month.id, "in_review");
    updateCopybookMonth(month.id, "approved", "principal-1");

    const campaign = createCopybookCampaign({
      monthId: month.id,
      channel: "email",
      ordinal: 1,
      title: "New Year Email",
    });
    for (const status of [
      "brief_review",
      "brief_approved",
      "copy_draft",
      "copy_review",
    ] as const) {
      updateCopybookCampaign(campaign.id, { status }, "principal-1");
    }
    expect(approveCopybookCampaign(campaign.id, "principal-1").status).toBe(
      "approved",
    );
    expect(
      markCopybookCampaignReadyForDesign(campaign.id, "principal-1").status,
    ).toBe("ready_for_design");

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
      snapshots.every((snapshot) =>
        snapshot.documentContent.includes("Approved copy"),
      ),
    ).toBe(true);
    expect(
      snapshots.every(
        (snapshot) => snapshot.actorPrincipalId === "principal-1",
      ),
    ).toBe(true);
  });
});
