import { createHash, randomUUID } from "node:crypto";

import {
  applyBrandBrainCorrection,
  BRAND_BRAIN_VERSION,
  type BrandBrainCampaignLearning,
  type BrandBrainContext,
  type BrandBrainCorrection,
  recordBrandBrainCampaignLearning,
} from "@vellumai/retention-domain";
import { desc, eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import {
  retentionBrandBrainEvents,
  retentionBrandBrains,
  retentionBrands,
  retentionConversationBrandScopes,
} from "./schema.js";

export type BrandBrainSource =
  | "onboarding"
  | "research"
  | "import"
  | "correction"
  | "campaign_learning";

export interface StoredBrandBrain {
  brandId: string;
  brain: BrandBrainContext;
  source: BrandBrainSource;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrandBrainSelector {
  conversationId?: string;
  brandId?: string;
  brandName?: string;
  websiteUrl?: string;
}

function normalizeWebsite(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    const host = parsed.hostname.toLocaleLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path === "/" ? "" : path}`;
  } catch {
    return trimmed.toLocaleLowerCase().replace(/\/+$/, "");
  }
}

function brandIdentity(brain: BrandBrainContext): string {
  return (
    normalizeWebsite(brain.websiteUrl) ??
    brain.brandName.trim().toLocaleLowerCase()
  );
}

export function deriveRetentionBrandId(brain: BrandBrainContext): string {
  const digest = createHash("sha256")
    .update(brandIdentity(brain))
    .digest("hex")
    .slice(0, 24);
  return `brand_${digest}`;
}

function parseStoredBrain(
  row: typeof retentionBrandBrains.$inferSelect,
): StoredBrandBrain | undefined {
  try {
    const brain = JSON.parse(row.profileJson) as BrandBrainContext;
    if (
      brain.version !== BRAND_BRAIN_VERSION ||
      typeof brain.brandName !== "string"
    ) {
      return undefined;
    }
    return {
      brandId: row.brandId,
      brain,
      source: row.source as BrandBrainSource,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function allStoredBrandBrains(): StoredBrandBrain[] {
  return getDb()
    .select()
    .from(retentionBrandBrains)
    .orderBy(desc(retentionBrandBrains.updatedAt))
    .all()
    .map(parseStoredBrain)
    .filter((brain): brain is StoredBrandBrain => brain !== undefined);
}

export function listStoredBrandBrains(): StoredBrandBrain[] {
  return allStoredBrandBrains();
}

export function bindConversationToBrand(
  conversationId: string,
  brandId: string,
): void {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) return;
  getDb()
    .insert(retentionConversationBrandScopes)
    .values({
      conversationId: normalizedConversationId,
      brandId,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: retentionConversationBrandScopes.conversationId,
      set: { brandId, updatedAt: Date.now() },
    })
    .run();
}

/** Resolve only an explicitly scoped or unambiguous profile. */
export function getStoredBrandBrain(
  selector: BrandBrainSelector = {},
): StoredBrandBrain | undefined {
  const profiles = allStoredBrandBrains();
  if (profiles.length === 0) return undefined;

  if (selector.conversationId) {
    const scope = getDb()
      .select()
      .from(retentionConversationBrandScopes)
      .where(
        eq(
          retentionConversationBrandScopes.conversationId,
          selector.conversationId,
        ),
      )
      .get();
    const scoped = scope
      ? profiles.find((profile) => profile.brandId === scope.brandId)
      : undefined;
    if (scoped) return scoped;
  }

  if (selector.brandId) {
    const byId = profiles.find(
      (profile) => profile.brandId === selector.brandId,
    );
    if (byId) return byId;
  }

  const website = normalizeWebsite(selector.websiteUrl);
  if (website) {
    const byWebsite = profiles.find(
      (profile) => normalizeWebsite(profile.brain.websiteUrl) === website,
    );
    if (byWebsite) return byWebsite;
  }

  const brandName = selector.brandName?.trim().toLocaleLowerCase();
  if (brandName) {
    const byName = profiles.find(
      (profile) =>
        profile.brain.brandName.trim().toLocaleLowerCase() === brandName,
    );
    if (byName) return byName;
  }

  return profiles.length === 1 ? profiles[0] : undefined;
}

export function saveBrandBrain(params: {
  brain: BrandBrainContext;
  source: BrandBrainSource;
  conversationId?: string;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
}): StoredBrandBrain {
  const { brain, source, conversationId } = params;
  if (brain.version !== BRAND_BRAIN_VERSION) {
    throw new Error(`Unsupported Brand Brain version: ${brain.version}`);
  }
  const db = getDb();
  const brandId = deriveRetentionBrandId(brain);
  const now = Date.now();
  const existing = db
    .select()
    .from(retentionBrandBrains)
    .where(eq(retentionBrandBrains.brandId, brandId))
    .get();
  const revision = (existing?.revision ?? 0) + 1;

  db.insert(retentionBrands)
    .values({
      id: brandId,
      name: brain.brandName,
      source: "worklin",
      metadataJson: JSON.stringify({ websiteUrl: brain.websiteUrl ?? null }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: retentionBrands.id,
      set: {
        name: brain.brandName,
        metadataJson: JSON.stringify({ websiteUrl: brain.websiteUrl ?? null }),
        updatedAt: now,
      },
    })
    .run();

  db.insert(retentionBrandBrains)
    .values({
      id: existing?.id ?? randomUUID(),
      brandId,
      brandName: brain.brandName,
      websiteUrl: brain.websiteUrl ?? null,
      schemaVersion: brain.version,
      profileJson: JSON.stringify(brain),
      source,
      revision,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: retentionBrandBrains.brandId,
      set: {
        brandName: brain.brandName,
        websiteUrl: brain.websiteUrl ?? null,
        schemaVersion: brain.version,
        profileJson: JSON.stringify(brain),
        source,
        revision,
        updatedAt: now,
      },
    })
    .run();

  if (conversationId) bindConversationToBrand(conversationId, brandId);

  db.insert(retentionBrandBrainEvents)
    .values({
      id: randomUUID(),
      brandId,
      eventType: params.eventType ?? source,
      payloadJson: JSON.stringify({
        revision,
        source,
        ...(params.eventPayload ?? {}),
      }),
      conversationId: conversationId ?? null,
      createdAt: now,
    })
    .run();

  return {
    brandId,
    brain,
    source,
    revision,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function applyStoredBrandBrainCorrection(params: {
  selector: BrandBrainSelector;
  correction: BrandBrainCorrection;
  conversationId?: string;
  reason?: string;
}): StoredBrandBrain {
  const stored = getStoredBrandBrain(params.selector);
  if (!stored) {
    throw new Error(
      "No unambiguous persisted Brand Brain matched this correction.",
    );
  }
  const brain = applyBrandBrainCorrection(stored.brain, params.correction);
  return saveBrandBrain({
    brain,
    source: "correction",
    conversationId: params.conversationId,
    eventType: "approved_correction",
    eventPayload: {
      correction: params.correction,
      reason: params.reason ?? null,
    },
  });
}

export function recordStoredBrandBrainCampaignLearning(params: {
  selector: BrandBrainSelector;
  learning: BrandBrainCampaignLearning;
  conversationId?: string;
  evidence?: string;
}): StoredBrandBrain {
  const stored = getStoredBrandBrain(params.selector);
  if (!stored) {
    throw new Error(
      "No unambiguous persisted Brand Brain matched this campaign learning.",
    );
  }
  const brain = recordBrandBrainCampaignLearning(stored.brain, params.learning);
  return saveBrandBrain({
    brain,
    source: "campaign_learning",
    conversationId: params.conversationId,
    eventType: "verified_campaign_learning",
    eventPayload: {
      learning: params.learning,
      evidence: params.evidence ?? null,
    },
  });
}

export function formatBrandBrainSkillContext(stored: StoredBrandBrain): string {
  return [
    `<worklin_brand_brain source="persisted" brand_id="${stored.brandId}" revision="${stored.revision}">`,
    "Use this persisted profile as the default brand context. Respect source status, readiness, and caveats; draft narrowly when fields remain unapproved.",
    JSON.stringify(
      {
        storage: {
          brandId: stored.brandId,
          revision: stored.revision,
          updatedAt: new Date(stored.updatedAt).toISOString(),
        },
        profile: stored.brain,
      },
      null,
      2,
    ),
    "</worklin_brand_brain>",
  ].join("\n");
}
