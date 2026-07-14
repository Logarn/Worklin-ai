import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { rawGet } from "./raw-query.js";
import {
  artifacts,
  conversations,
  retentionBrandBrains,
  retentionBrands,
  retentionCopybookCampaigns,
  retentionCopybookMonths,
  retentionCopybooks,
  retentionCopybookSnapshots,
  workItems,
} from "./schema.js";

export type CopybookStatus = "active" | "archived";
export type StrategyStatus = "draft" | "in_review" | "approved";
export type CampaignChannel = "email" | "sms";
export type CampaignStatus =
  | "brief_draft"
  | "brief_review"
  | "brief_approved"
  | "copy_draft"
  | "copy_review"
  | "approved"
  | "ready_for_design";

export class CopybookStoreError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid_transition",
    message: string,
  ) {
    super(message);
    this.name = "CopybookStoreError";
  }
}

export interface CopybookRecord {
  id: string;
  brandId: string;
  year: number;
  title: string;
  status: CopybookStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CopybookMonthRecord {
  id: string;
  copybookId: string;
  month: number;
  documentSurfaceId: string | null;
  strategyStatus: StrategyStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CopybookCampaignRecord {
  id: string;
  monthId: string;
  channel: CampaignChannel;
  ordinal: number;
  title: string;
  status: CampaignStatus;
  packageId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapCopybook(
  row: typeof retentionCopybooks.$inferSelect,
): CopybookRecord {
  return { ...row, status: row.status as CopybookStatus };
}

function mapMonth(
  row: typeof retentionCopybookMonths.$inferSelect,
): CopybookMonthRecord {
  return { ...row, strategyStatus: row.strategyStatus as StrategyStatus };
}

function mapCampaign(
  row: typeof retentionCopybookCampaigns.$inferSelect,
): CopybookCampaignRecord {
  const { metadataJson, ...rest } = row;
  return {
    ...rest,
    channel: row.channel as CampaignChannel,
    status: row.status as CampaignStatus,
    metadata: parseMetadata(metadataJson),
  };
}

function requireMonth(id: string) {
  const month = getDb()
    .select()
    .from(retentionCopybookMonths)
    .where(eq(retentionCopybookMonths.id, id))
    .get();
  if (!month)
    throw new CopybookStoreError("not_found", "Copybook month not found");
  return month;
}

function requireCampaign(id: string) {
  const campaign = getDb()
    .select()
    .from(retentionCopybookCampaigns)
    .where(eq(retentionCopybookCampaigns.id, id))
    .get();
  if (!campaign)
    throw new CopybookStoreError("not_found", "Copybook campaign not found");
  return campaign;
}

export function listCopybooks(
  filters: {
    brandId?: string;
    year?: number;
  } = {},
): CopybookRecord[] {
  const conditions = [];
  if (filters.brandId)
    conditions.push(eq(retentionCopybooks.brandId, filters.brandId));
  if (filters.year !== undefined)
    conditions.push(eq(retentionCopybooks.year, filters.year));
  const rows = getDb()
    .select()
    .from(retentionCopybooks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(retentionCopybooks.year))
    .all();
  return rows.map(mapCopybook);
}

export function createCopybook(params: {
  brandId: string;
  year: number;
  title?: string;
}): CopybookRecord {
  const db = getDb();
  const brand = db
    .select()
    .from(retentionBrands)
    .where(eq(retentionBrands.id, params.brandId))
    .get();
  if (!brand) throw new CopybookStoreError("not_found", "Brand not found");
  if (listCopybooks({ brandId: params.brandId, year: params.year }).length) {
    throw new CopybookStoreError(
      "conflict",
      "A copybook already exists for this brand and year",
    );
  }
  const now = Date.now();
  const row: typeof retentionCopybooks.$inferInsert = {
    id: randomUUID(),
    brandId: params.brandId,
    year: params.year,
    title: params.title?.trim() || `${brand.name} // ${params.year} Copybook`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  db.transaction((tx) => {
    tx.insert(retentionCopybooks).values(row).run();
    tx.insert(artifacts)
      .values({
        id: `copybook:${row.id}`,
        brandId: row.brandId,
        resourceType: "copybook",
        resourceId: row.id,
        artifactType: "copy",
        metadataJson: JSON.stringify({ year: row.year }),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
      .run();
  });
  return mapCopybook(row as typeof retentionCopybooks.$inferSelect);
}

export function getCopybookDetail(id: string) {
  const db = getDb();
  const copybookRow = db
    .select()
    .from(retentionCopybooks)
    .where(eq(retentionCopybooks.id, id))
    .get();
  if (!copybookRow)
    throw new CopybookStoreError("not_found", "Copybook not found");
  const brand = db
    .select()
    .from(retentionBrands)
    .where(eq(retentionBrands.id, copybookRow.brandId))
    .get();
  const brain = db
    .select({
      revision: retentionBrandBrains.revision,
      updatedAt: retentionBrandBrains.updatedAt,
    })
    .from(retentionBrandBrains)
    .where(eq(retentionBrandBrains.brandId, copybookRow.brandId))
    .get();
  const monthRows = db
    .select()
    .from(retentionCopybookMonths)
    .where(eq(retentionCopybookMonths.copybookId, id))
    .orderBy(asc(retentionCopybookMonths.month))
    .all();
  const months = monthRows.map((month) => ({
    ...mapMonth(month),
    campaigns: db
      .select()
      .from(retentionCopybookCampaigns)
      .where(eq(retentionCopybookCampaigns.monthId, month.id))
      .orderBy(
        asc(retentionCopybookCampaigns.channel),
        asc(retentionCopybookCampaigns.ordinal),
      )
      .all()
      .map((campaign) => ({
        ...mapCampaign(campaign),
        workItems: db
          .select({
            id: workItems.id,
            title: workItems.title,
            status: workItems.status,
            updatedAt: workItems.updatedAt,
          })
          .from(workItems)
          .where(
            and(
              eq(workItems.sourceType, "retention_copybook_campaign"),
              eq(workItems.sourceId, campaign.id),
            ),
          )
          .all(),
      })),
  }));
  return {
    copybook: mapCopybook(copybookRow),
    brand: brand ? { id: brand.id, name: brand.name } : null,
    brandBrain: brain ?? null,
    months,
  };
}

export function createCopybookMonth(params: {
  copybookId: string;
  month: number;
  conversationId: string;
  title?: string;
}): CopybookMonthRecord {
  const db = getDb();
  const copybook = db
    .select()
    .from(retentionCopybooks)
    .where(eq(retentionCopybooks.id, params.copybookId))
    .get();
  if (!copybook)
    throw new CopybookStoreError("not_found", "Copybook not found");
  const conversation = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, params.conversationId))
    .get();
  if (!conversation) {
    throw new CopybookStoreError("not_found", "Conversation not found");
  }
  const existing = db
    .select()
    .from(retentionCopybookMonths)
    .where(
      and(
        eq(retentionCopybookMonths.copybookId, params.copybookId),
        eq(retentionCopybookMonths.month, params.month),
      ),
    )
    .get();
  if (existing)
    throw new CopybookStoreError("conflict", "Copybook month already exists");

  const now = Date.now();
  const monthId = randomUUID();
  const surfaceId = randomUUID();
  const title =
    params.title?.trim() || `${copybook.title} — Month ${params.month}`;
  db.transaction((tx) => {
    tx.run(sql`INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
      VALUES (${surfaceId}, ${params.conversationId}, ${title}, ${""}, ${0}, ${now}, ${now})`);
    tx.run(sql`INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at)
      VALUES (${surfaceId}, ${params.conversationId}, ${now})`);
    tx.insert(retentionCopybookMonths)
      .values({
        id: monthId,
        copybookId: params.copybookId,
        month: params.month,
        documentSurfaceId: surfaceId,
        strategyStatus: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  return mapMonth(requireMonth(monthId));
}

function captureSnapshot(params: {
  monthId: string;
  campaignId?: string;
  kind:
    | "strategy_approved"
    | "brief_approved"
    | "copy_approved"
    | "ready_for_design";
  actorPrincipalId?: string;
}): void {
  const db = getDb();
  const month = requireMonth(params.monthId);
  if (!month.documentSurfaceId) {
    throw new CopybookStoreError("conflict", "Copybook month has no document");
  }
  const document = rawGet<{ content: string; updated_at: number }>(
    /*sql*/ `SELECT content, updated_at FROM documents WHERE surface_id = ?`,
    month.documentSurfaceId,
  );
  if (!document)
    throw new CopybookStoreError("conflict", "Copybook document not found");
  const campaigns = db
    .select()
    .from(retentionCopybookCampaigns)
    .where(eq(retentionCopybookCampaigns.monthId, params.monthId))
    .all()
    .map(mapCampaign);
  const maxRevision =
    db
      .select({
        value: sql<number>`coalesce(max(${retentionCopybookSnapshots.revision}), 0)`,
      })
      .from(retentionCopybookSnapshots)
      .where(
        and(
          eq(retentionCopybookSnapshots.monthId, params.monthId),
          eq(retentionCopybookSnapshots.kind, params.kind),
        ),
      )
      .get()?.value ?? 0;
  db.insert(retentionCopybookSnapshots)
    .values({
      id: randomUUID(),
      monthId: params.monthId,
      campaignId: params.campaignId ?? null,
      kind: params.kind,
      revision: Number(maxRevision) + 1,
      documentContent: document.content,
      documentUpdatedAt: document.updated_at,
      campaignStateJson: JSON.stringify(campaigns),
      actorPrincipalId: params.actorPrincipalId ?? null,
      createdAt: Date.now(),
    })
    .run();
}

const STRATEGY_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["in_review"],
};

export function updateCopybookMonth(
  id: string,
  strategyStatus: StrategyStatus,
  actorPrincipalId?: string,
): CopybookMonthRecord {
  const current = requireMonth(id);
  if (current.strategyStatus === strategyStatus) return mapMonth(current);
  if (
    !(
      STRATEGY_TRANSITIONS[current.strategyStatus as StrategyStatus] ?? []
    ).includes(strategyStatus)
  ) {
    throw new CopybookStoreError(
      "invalid_transition",
      "Invalid monthly strategy status transition",
    );
  }
  getDb().transaction((tx) => {
    tx.update(retentionCopybookMonths)
      .set({ strategyStatus, updatedAt: Date.now() })
      .where(eq(retentionCopybookMonths.id, id))
      .run();
    if (strategyStatus === "approved") {
      captureSnapshot({
        monthId: id,
        kind: "strategy_approved",
        actorPrincipalId,
      });
    }
  });
  return mapMonth(requireMonth(id));
}

export function createCopybookCampaign(params: {
  monthId: string;
  channel: CampaignChannel;
  ordinal: number;
  title: string;
  packageId?: string;
  metadata?: Record<string, unknown>;
}): CopybookCampaignRecord {
  requireMonth(params.monthId);
  const db = getDb();
  const conflict = db
    .select()
    .from(retentionCopybookCampaigns)
    .where(
      and(
        eq(retentionCopybookCampaigns.monthId, params.monthId),
        eq(retentionCopybookCampaigns.channel, params.channel),
        eq(retentionCopybookCampaigns.ordinal, params.ordinal),
      ),
    )
    .get();
  if (conflict)
    throw new CopybookStoreError(
      "conflict",
      "Campaign position already exists",
    );
  const now = Date.now();
  const row: typeof retentionCopybookCampaigns.$inferInsert = {
    id: randomUUID(),
    monthId: params.monthId,
    channel: params.channel,
    ordinal: params.ordinal,
    title: params.title.trim(),
    status: "brief_draft",
    packageId: params.packageId ?? null,
    metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(retentionCopybookCampaigns).values(row).run();
  return mapCampaign(row as typeof retentionCopybookCampaigns.$inferSelect);
}

const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  brief_draft: ["brief_review"],
  brief_review: ["brief_draft", "brief_approved"],
  brief_approved: ["copy_draft"],
  copy_draft: ["copy_review"],
  copy_review: ["copy_draft"],
  approved: ["copy_review"],
  ready_for_design: ["copy_review"],
};

export function updateCopybookCampaign(
  id: string,
  updates: {
    title?: string;
    status?: Exclude<CampaignStatus, "approved" | "ready_for_design">;
    packageId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  actorPrincipalId?: string,
): CopybookCampaignRecord {
  const current = requireCampaign(id);
  if (
    updates.status &&
    updates.status !== current.status &&
    !(CAMPAIGN_TRANSITIONS[current.status as CampaignStatus] ?? []).includes(
      updates.status,
    )
  ) {
    throw new CopybookStoreError(
      "invalid_transition",
      "Invalid campaign status transition",
    );
  }
  getDb().transaction((tx) => {
    tx.update(retentionCopybookCampaigns)
      .set({
        ...(updates.title !== undefined ? { title: updates.title.trim() } : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.packageId !== undefined
          ? { packageId: updates.packageId }
          : {}),
        ...(updates.metadata !== undefined
          ? {
              metadataJson: updates.metadata
                ? JSON.stringify(updates.metadata)
                : null,
            }
          : {}),
        updatedAt: Date.now(),
      })
      .where(eq(retentionCopybookCampaigns.id, id))
      .run();
    if (updates.status === "brief_approved") {
      captureSnapshot({
        monthId: current.monthId,
        campaignId: id,
        kind: "brief_approved",
        actorPrincipalId,
      });
    }
  });
  return mapCampaign(requireCampaign(id));
}

export function approveCopybookCampaign(
  id: string,
  actorPrincipalId?: string,
): CopybookCampaignRecord {
  const campaign = requireCampaign(id);
  if (campaign.status !== "copy_review") {
    throw new CopybookStoreError(
      "invalid_transition",
      "Campaign must be in copy review before approval",
    );
  }
  getDb().transaction((tx) => {
    tx.update(retentionCopybookCampaigns)
      .set({ status: "approved", updatedAt: Date.now() })
      .where(eq(retentionCopybookCampaigns.id, id))
      .run();
    captureSnapshot({
      monthId: campaign.monthId,
      campaignId: id,
      kind: "copy_approved",
      actorPrincipalId,
    });
  });
  return mapCampaign(requireCampaign(id));
}

export function markCopybookCampaignReadyForDesign(
  id: string,
  actorPrincipalId?: string,
): CopybookCampaignRecord {
  const campaign = requireCampaign(id);
  if (campaign.status !== "approved") {
    throw new CopybookStoreError(
      "invalid_transition",
      "Campaign must be approved before design handoff",
    );
  }
  getDb().transaction((tx) => {
    tx.update(retentionCopybookCampaigns)
      .set({ status: "ready_for_design", updatedAt: Date.now() })
      .where(eq(retentionCopybookCampaigns.id, id))
      .run();
    captureSnapshot({
      monthId: campaign.monthId,
      campaignId: id,
      kind: "ready_for_design",
      actorPrincipalId,
    });
  });
  return mapCampaign(requireCampaign(id));
}
