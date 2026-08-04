import { createHash } from "node:crypto";

import type { BrandIntelligenceQualityResult } from "@vellumai/retention-domain";
import { and, desc, eq } from "drizzle-orm";

import type { BrandResearchDocumentReport } from "../documents/brand-research-document.js";
import { getDb } from "./db-connection.js";
import { retentionSourceSnapshots } from "./schema.js";

const BRAND_RESEARCH_SNAPSHOT_PROVIDER = "worklin_brand_research";
const BRAND_RESEARCH_SNAPSHOT_VERSION = "brand_research_snapshot_v1";

interface StoredBrandResearchSnapshotPayload {
  version: typeof BRAND_RESEARCH_SNAPSHOT_VERSION;
  report: BrandResearchDocumentReport;
  quality: BrandIntelligenceQualityResult | null;
}

export interface BrandResearchSnapshotSummary {
  snapshotId: string;
  status: "accepted" | "partial";
  generatedAt: string;
  savedAt: string;
  evidenceCount: number;
  competitorCount: number;
  visualEvidenceCount: number;
  qualityScore: number | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function snapshotPayload(
  report: BrandResearchDocumentReport,
  quality: BrandIntelligenceQualityResult | undefined,
): StoredBrandResearchSnapshotPayload {
  return {
    version: BRAND_RESEARCH_SNAPSHOT_VERSION,
    report,
    quality: quality ?? null,
  };
}

export function brandResearchSnapshotId(params: {
  brandId: string;
  report: BrandResearchDocumentReport;
  quality?: BrandIntelligenceQualityResult;
}): string {
  const digest = createHash("sha256")
    .update(params.brandId)
    .update("\0")
    .update(canonicalJson(snapshotPayload(params.report, params.quality)))
    .digest("hex");
  return `brand_research_${digest}`;
}

export function saveBrandResearchSnapshot(params: {
  brandId: string;
  report: BrandResearchDocumentReport;
  quality?: BrandIntelligenceQualityResult;
}): BrandResearchSnapshotSummary {
  const payload = snapshotPayload(params.report, params.quality);
  const snapshotId = brandResearchSnapshotId(params);
  const now = Date.now();
  const generatedAt = new Date(params.report.generatedAt).getTime();
  const status = params.quality?.accepted === false ? "partial" : "accepted";

  getDb()
    .insert(retentionSourceSnapshots)
    .values({
      id: snapshotId,
      brandId: params.brandId,
      provider: BRAND_RESEARCH_SNAPSHOT_PROVIDER,
      status,
      sourceFreshnessAt: Number.isFinite(generatedAt) ? generatedAt : null,
      snapshotJson: JSON.stringify(payload),
      caveatsJson: JSON.stringify([
        ...params.report.gaps,
        ...(params.quality?.blockingFailures ?? []),
      ]),
      safetyJson: JSON.stringify(params.report.safety),
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();

  const stored = getDb()
    .select()
    .from(retentionSourceSnapshots)
    .where(eq(retentionSourceSnapshots.id, snapshotId))
    .get();
  if (!stored) {
    throw new Error("The research history snapshot could not be verified.");
  }
  return summarizeSnapshot(stored);
}

function summarizeSnapshot(
  row: typeof retentionSourceSnapshots.$inferSelect,
): BrandResearchSnapshotSummary {
  const payload = JSON.parse(
    row.snapshotJson,
  ) as StoredBrandResearchSnapshotPayload;
  const report = payload.report;
  return {
    snapshotId: row.id,
    status: row.status === "partial" ? "partial" : "accepted",
    generatedAt: report.generatedAt,
    savedAt: new Date(row.createdAt).toISOString(),
    evidenceCount: report.evidence.length,
    competitorCount: report.competitorLandscape.length,
    visualEvidenceCount: report.visualEvidence?.length ?? 0,
    qualityScore: payload.quality?.score ?? null,
  };
}

export function listBrandResearchSnapshotSummaries(
  brandId: string,
  limit = 20,
): BrandResearchSnapshotSummary[] {
  return getDb()
    .select()
    .from(retentionSourceSnapshots)
    .where(
      and(
        eq(retentionSourceSnapshots.brandId, brandId),
        eq(retentionSourceSnapshots.provider, BRAND_RESEARCH_SNAPSHOT_PROVIDER),
      ),
    )
    .orderBy(desc(retentionSourceSnapshots.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all()
    .map(summarizeSnapshot);
}
