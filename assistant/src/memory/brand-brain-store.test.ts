import { beforeEach, describe, expect, test } from "bun:test";

import { createDraftBrandBrain } from "@vellumai/retention-domain";

import {
  applyStoredBrandBrainCorrection,
  getStoredBrandBrain,
  recordStoredBrandBrainCampaignLearning,
  saveBrandBrain,
} from "./brand-brain-store.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import {
  retentionBrandBrainEvents,
  retentionBrandBrains,
  retentionBrands,
  retentionConversationBrandScopes,
} from "./schema.js";

initializeDb();

function resetBrandBrains(): void {
  const db = getDb();
  db.delete(retentionBrandBrainEvents).run();
  db.delete(retentionConversationBrandScopes).run();
  db.delete(retentionBrandBrains).run();
  db.delete(retentionBrands).run();
}

describe("Brand Brain store", () => {
  beforeEach(resetBrandBrains);

  test("persists onboarding context and resolves its conversation binding", () => {
    const brain = createDraftBrandBrain({
      brandName: "Acme Studio",
      websiteUrl: "https://acme.example",
    });
    const saved = saveBrandBrain({
      brain,
      source: "onboarding",
      conversationId: "conversation-acme",
    });

    const resolved = getStoredBrandBrain({
      conversationId: "conversation-acme",
    });
    expect(resolved?.brandId).toBe(saved.brandId);
    expect(resolved?.brain.brandName).toBe("Acme Studio");
    expect(resolved?.revision).toBe(1);
  });

  test("does not guess when multiple brands are unscoped", () => {
    saveBrandBrain({
      brain: createDraftBrandBrain({ brandName: "Acme Studio" }),
      source: "onboarding",
      conversationId: "conversation-acme",
    });
    saveBrandBrain({
      brain: createDraftBrandBrain({ brandName: "Beta Works" }),
      source: "onboarding",
      conversationId: "conversation-beta",
    });

    expect(getStoredBrandBrain()).toBeUndefined();
    expect(
      getStoredBrandBrain({ brandName: "Beta Works" })?.brain.brandName,
    ).toBe("Beta Works");
  });

  test("records approved corrections and campaign learnings as revisions", () => {
    saveBrandBrain({
      brain: createDraftBrandBrain({ brandName: "Acme Studio" }),
      source: "onboarding",
      conversationId: "conversation-acme",
    });
    const corrected = applyStoredBrandBrainCorrection({
      selector: { conversationId: "conversation-acme" },
      conversationId: "conversation-acme",
      correction: {
        field: "approved_cta",
        operation: "add",
        value: "See how it works",
      },
    });
    const learned = recordStoredBrandBrainCampaignLearning({
      selector: { conversationId: "conversation-acme" },
      conversationId: "conversation-acme",
      learning: {
        campaignType: "product_video",
        insight: "A concrete workflow demonstration improved completion.",
        outcome: "winning",
      },
      evidence: "User-confirmed production analytics review.",
    });

    expect(corrected.revision).toBe(2);
    expect(corrected.brain.ctas).toContain("See how it works");
    expect(learned.revision).toBe(3);
    expect(learned.brain.campaignMemory).toHaveLength(1);
    expect(getDb().select().from(retentionBrandBrainEvents).all()).toHaveLength(
      3,
    );
  });
});
