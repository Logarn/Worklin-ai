import { beforeEach, describe, expect, test } from "bun:test";

import { createDraftBrandBrain } from "@vellumai/retention-domain";

import { getDocumentById } from "../../documents/document-store.js";
import { saveBrandBrain } from "../../memory/brand-brain-store.js";
import { getCopybookDetail } from "../../memory/copybook-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { rawRun } from "../../memory/raw-query.js";
import {
  conversations,
  retentionBrandBrainEvents,
  retentionBrandBrains,
  retentionBrands,
} from "../../memory/schema.js";
import type { ToolContext } from "../types.js";
import { saveCampaignReviewToCopybook } from "./campaign-review-copybook.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  rawRun("DELETE FROM artifacts");
  rawRun("DELETE FROM retention_copybook_snapshots");
  rawRun("DELETE FROM retention_copybook_campaigns");
  rawRun("DELETE FROM retention_copybook_months");
  rawRun("DELETE FROM retention_copybooks");
  rawRun("DELETE FROM document_conversations");
  rawRun("DELETE FROM documents");
  db.delete(retentionBrandBrainEvents).run();
  db.delete(retentionBrandBrains).run();
  db.delete(retentionBrands).run();
  db.delete(conversations).run();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id: "conversation-copybook-review",
      title: "Campaign review",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  saveBrandBrain({
    brain: createDraftBrandBrain({ brandName: "Example Brand" }),
    source: "onboarding",
    conversationId: "conversation-copybook-review",
  });
});

function context(): ToolContext {
  return {
    conversationId: "conversation-copybook-review",
    workingDir: "/tmp",
    trustClass: "guardian",
  } as ToolContext;
}

describe("campaign review Copybook writer", () => {
  test("stores complete drafts once and creates review-only campaign records", () => {
    const input = {
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      brandName: "Example Brand",
      markdown:
        "# Customer campaign drafts\n\n## Audience one\n\n**Subject:** A useful next step\n\nComplete editable email copy.",
      campaigns: [
        {
          title: "Audience one",
          description: "People showing high intent without a first purchase.",
          confidence: 0.82,
          memberCount: 42,
          eligibleCount: 37,
          evidence: [
            {
              signal: "Viewed buying guide twice",
              explanation: "Strong consideration behavior.",
              strength: "strong",
              source: "event",
            },
          ],
          campaignConcept: {
            objective: "Convert non-buyers",
            angle: "Remove first-purchase uncertainty",
            timing: "This week",
            callToAction: "Choose a starter bundle",
          },
          representativeMessages: [
            {
              customerReference: "archetype_high_intent",
              subject: "A useful next step",
              preheader: "Start with the simplest option.",
              body: "Complete editable email copy.",
              rationale: "This draft speaks to a buyer who needs clarity.",
            },
          ],
        },
      ],
    };

    const first = saveCampaignReviewToCopybook(
      input,
      context(),
      new Date("2026-08-11T12:00:00.000Z"),
    );
    const second = saveCampaignReviewToCopybook(
      input,
      context(),
      new Date("2026-08-11T12:00:00.000Z"),
    );

    expect(first).toMatchObject({ saved: true, campaignsCreated: 1 });
    expect(second).toMatchObject({ saved: true, campaignsCreated: 0 });
    if (!first.saved) throw new Error("Copybook save unexpectedly failed");
    const document = getDocumentById(first.documentSurfaceId);
    expect(
      document?.content.match(/worklin-retention-segment-run/gu),
    ).toHaveLength(1);
    expect(document?.content).toContain("Complete editable email copy");
    const detail = getCopybookDetail(first.copybookId);
    expect(detail.months).toHaveLength(1);
    expect(detail.months[0]?.campaigns).toEqual([
      expect.objectContaining({
        title: "Audience one - Convert non-buyers",
        status: "brief_draft",
        metadata: expect.objectContaining({
          reviewOnly: true,
          microSegmentName: "Audience one",
          campaignObjective: "Convert non-buyers",
          campaignAngle: "Remove first-purchase uncertainty",
          campaignTiming: "This week",
          campaignCallToAction: "Choose a starter bundle",
          sampleCount: 1,
          draftSubjects: ["A useful next step"],
          description: "People showing high intent without a first purchase.",
          confidence: 0.82,
          memberCount: 42,
          eligibleCount: 37,
          campaignConcept: expect.objectContaining({
            objective: "Convert non-buyers",
            angle: "Remove first-purchase uncertainty",
          }),
          representativeMessages: [
            expect.objectContaining({
              subject: "A useful next step",
              body: "Complete editable email copy.",
            }),
          ],
        }),
      }),
    ]);
  });
});
