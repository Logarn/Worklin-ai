import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const BRAND_RESEARCH_TRACKS = [
  "identity_and_offers",
  "competitors",
  "seo_and_content",
  "social",
  "email_and_lifecycle",
  "sms",
  "products_and_launches",
  "customer_market_investor_trends",
] as const;

export type BrandResearchTrack = (typeof BRAND_RESEARCH_TRACKS)[number];
export type BrandResearchRunStatus =
  | "queued"
  | "running"
  | "partial"
  | "complete"
  | "failed"
  | "cancelled";

export interface BrandResearchRunRow {
  id: string;
  org_id: string;
  user_id: string;
  assistant_id: string;
  brand_name: string;
  website_url: string | null;
  brand_brain_id: string | null;
  status: BrandResearchRunStatus;
  parent_task_id: string | null;
  child_task_ids_json: string;
  tracks_json: string;
  evidence_count: number;
  provider_usage_json: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateBrandResearchRunInput {
  orgId: string;
  userId: string;
  assistantId: string;
  brandName?: string;
  websiteUrl?: string;
}

const initializedDatabases = new WeakSet<Database>();

export function ensureBrandResearchRunSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS brand_research_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      website_url TEXT,
      brand_brain_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled')),
      parent_task_id TEXT,
      child_task_ids_json TEXT NOT NULL DEFAULT '[]',
      tracks_json TEXT NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      provider_usage_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      failed_at TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_brand_research_runs_user
      ON brand_research_runs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_brand_research_runs_status
      ON brand_research_runs(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_research_active_seed
      ON brand_research_runs(assistant_id, brand_name, COALESCE(website_url, ''))
      WHERE status IN ('queued', 'running', 'partial');
  `);
  initializedDatabases.add(db);
}

function normalizedBrandName(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ") ?? ""
  );
}

function normalizedWebsiteUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed.replace(/[\r\n\t]/g, "");
  }
}

function tracksJson(): string {
  return JSON.stringify(BRAND_RESEARCH_TRACKS);
}

export function createOrGetBrandResearchRun(
  db: Database,
  input: CreateBrandResearchRunInput,
  nowIso: () => string,
): BrandResearchRunRow {
  ensureBrandResearchRunSchema(db);
  const brandName = normalizedBrandName(input.brandName);
  const websiteUrl = normalizedWebsiteUrl(input.websiteUrl);
  if (!brandName && !websiteUrl) {
    throw new Error("A brand name or public website is required.");
  }
  const resolvedBrandName =
    brandName || websiteUrl!.replace(/^https?:\/\//, "");
  const existing = db
    .query<BrandResearchRunRow, [string, string, string]>(
      `SELECT * FROM brand_research_runs
       WHERE assistant_id = ?
         AND brand_name = ?
         AND COALESCE(website_url, '') = COALESCE(?, '')
         AND status IN ('queued', 'running', 'partial')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.assistantId, resolvedBrandName, websiteUrl ?? "");
  if (existing) return existing;

  const timestamp = nowIso();
  const row: BrandResearchRunRow = {
    id: `research-${randomUUID()}`,
    org_id: input.orgId,
    user_id: input.userId,
    assistant_id: input.assistantId,
    brand_name: resolvedBrandName,
    website_url: websiteUrl,
    brand_brain_id: null,
    status: "queued",
    parent_task_id: null,
    child_task_ids_json: "[]",
    tracks_json: tracksJson(),
    evidence_count: 0,
    provider_usage_json: "{}",
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    failed_at: null,
    error: null,
    retry_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  try {
    db.query(
      `INSERT INTO brand_research_runs (
        id, org_id, user_id, assistant_id, brand_name, website_url,
        brand_brain_id, status, parent_task_id, child_task_ids_json,
        tracks_json, evidence_count, provider_usage_json, started_at,
        completed_at, cancelled_at, failed_at, error, retry_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.org_id,
      row.user_id,
      row.assistant_id,
      row.brand_name,
      row.website_url,
      row.brand_brain_id,
      row.status,
      row.parent_task_id,
      row.child_task_ids_json,
      row.tracks_json,
      row.evidence_count,
      row.provider_usage_json,
      row.started_at,
      row.completed_at,
      row.cancelled_at,
      row.failed_at,
      row.error,
      row.retry_count,
      row.created_at,
      row.updated_at,
    );
    return row;
  } catch (error) {
    // Concurrent onboarding tabs can race the partial unique index. Return the
    // winner so both tabs display one durable run rather than two jobs.
    const winner = db
      .query<BrandResearchRunRow, [string, string, string]>(
        `SELECT * FROM brand_research_runs
         WHERE assistant_id = ? AND brand_name = ?
           AND COALESCE(website_url, '') = COALESCE(?, '')
           AND status IN ('queued', 'running', 'partial')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.assistantId, resolvedBrandName, websiteUrl ?? "");
    if (winner) return winner;
    throw error;
  }
}

export function getBrandResearchRunForUser(
  db: Database,
  runId: string,
  userId: string,
): BrandResearchRunRow | null {
  ensureBrandResearchRunSchema(db);
  return (
    db
      .query<
        BrandResearchRunRow,
        [string, string]
      >("SELECT * FROM brand_research_runs WHERE id = ? AND user_id = ?")
      .get(runId, userId) ?? null
  );
}

export function listBrandResearchRunsForUser(
  db: Database,
  userId: string,
): BrandResearchRunRow[] {
  ensureBrandResearchRunSchema(db);
  return db
    .query<
      BrandResearchRunRow,
      [string]
    >("SELECT * FROM brand_research_runs WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId);
}

export function markBrandResearchRunRunning(
  db: Database,
  runId: string,
  nowIso: () => string,
): void {
  ensureBrandResearchRunSchema(db);
  const timestamp = nowIso();
  db.query(
    `UPDATE brand_research_runs
     SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status IN ('queued', 'partial')`,
  ).run(timestamp, timestamp, runId);
}

export function markBrandResearchRunCancelled(
  db: Database,
  runId: string,
  nowIso: () => string,
): boolean {
  ensureBrandResearchRunSchema(db);
  const timestamp = nowIso();
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running', 'partial')`,
    )
    .run(timestamp, timestamp, runId);
  return result.changes > 0;
}

export function brandResearchRunPayload(row: BrandResearchRunRow) {
  const parseArray = (value: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  const parseRecord = (value: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    id: row.id,
    assistant_id: row.assistant_id,
    brand_name: row.brand_name,
    website_url: row.website_url,
    brand_brain_id: row.brand_brain_id,
    status: row.status,
    parent_task_id: row.parent_task_id,
    child_task_ids: parseArray(row.child_task_ids_json),
    tracks: parseArray(row.tracks_json),
    evidence_count: row.evidence_count,
    provider_usage: parseRecord(row.provider_usage_json),
    started_at: row.started_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    failed_at: row.failed_at,
    error: row.error,
    retry_count: row.retry_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
