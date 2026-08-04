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
export type BrandResearchSeedMissingReason = "seedMissing";
export type BrandResearchTrackState =
  | "pending"
  | "running"
  | "complete"
  | "partial"
  | "unavailable"
  | "not_observable";
export type BrandResearchRunStatus =
  | "queued"
  | "running"
  | "partial"
  | "complete"
  | "failed"
  | "cancelled";
export type BrandResearchRunKind =
  | "onboarding"
  | "daily_check"
  | "weekly_update"
  | "monthly_review"
  | "manual";

export interface BrandResearchTrackProgress {
  track: BrandResearchTrack;
  status: BrandResearchTrackState;
  evidence_count: number;
  evidence_ids: string[];
  provider_usage: string[];
  provider_gaps: string[];
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface BrandResearchRunRow {
  id: string;
  org_id: string;
  user_id: string;
  assistant_id: string;
  brand_id: string;
  brand_name: string;
  website_url: string | null;
  run_kind: BrandResearchRunKind;
  coverage_start: string | null;
  coverage_end: string | null;
  seed_missing_reason: BrandResearchSeedMissingReason | null;
  brand_brain_id: string | null;
  status: BrandResearchRunStatus;
  parent_task_id: string | null;
  child_task_ids_json: string;
  tracks_json: string;
  track_progress_json: string;
  evidence_count: number;
  provider_usage_json: string;
  provider_gaps_json: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  processing_lease_token: string | null;
  processing_lease_expires_at: string | null;
  cancellation_metadata_json: string;
  error: string | null;
  retry_count: number;
  elapsed_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface BrandResearchRunPayload {
  id: string;
  assistant_id: string;
  brand_id: string;
  brand_name: string;
  website_url: string | null;
  run_kind: BrandResearchRunKind;
  coverage_start: string | null;
  coverage_end: string | null;
  seed_missing_reason: BrandResearchSeedMissingReason | null;
  brand_brain_id: string | null;
  status: BrandResearchRunStatus;
  parent_task_id: string | null;
  child_task_ids: string[];
  tracks: string[];
  track_progress: Record<BrandResearchTrack, BrandResearchTrackProgress>;
  evidence_count: number;
  provider_usage: Record<string, unknown>;
  provider_gaps: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  error: string | null;
  retry_count: number;
  elapsed_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBrandResearchRunInput {
  orgId: string;
  userId: string;
  assistantId: string;
  brandId?: string;
  brandName?: string;
  websiteUrl?: string;
  runKind?: BrandResearchRunKind;
  coverageStart?: string;
  coverageEnd?: string;
}

export interface TrackExecutionUpdate {
  track: BrandResearchTrack;
  status: BrandResearchTrackState;
  evidenceCount?: number;
  evidenceIds?: string[];
  providerUsage?: string[];
  providerGaps?: string[];
  error?: string;
}

const initializedDatabases = new WeakSet<Database>();

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(
  db: Database,
  table: string,
  columnName: string,
  definition: string,
): void {
  if (tableColumns(db, table).has(columnName)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`);
}

function normalizeBrandName(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ") ?? ""
  );
}

function normalizeBrandId(value: string | undefined): string {
  return value?.trim().replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 160) ?? "";
}

function normalizeRunKind(value: BrandResearchRunKind | undefined) {
  return value ?? "onboarding";
}

function normalizeIso(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeWebsiteUrl(value: string | undefined): string | null {
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
    return trimmed.replace(/[\r\n\t]+/g, "");
  }
}

function brandNameFromWebsite(websiteUrl: string | null): string {
  if (!websiteUrl) return "Brand research";
  try {
    const parsed = new URL(websiteUrl);
    return parsed.hostname.replace(/^www\./, "").replace(/\..+/, "");
  } catch {
    return "Brand research";
  }
}

function tracksJson(): string {
  return JSON.stringify(BRAND_RESEARCH_TRACKS);
}

function defaultTrackProgress(): Record<
  BrandResearchTrack,
  BrandResearchTrackProgress
> {
  return BRAND_RESEARCH_TRACKS.reduce(
    (acc, track) => {
      acc[track] = {
        track,
        status: "pending",
        evidence_count: 0,
        evidence_ids: [],
        provider_usage: [],
        provider_gaps: [],
        started_at: null,
        completed_at: null,
        error: null,
      };
      return acc;
    },
    {} as Record<BrandResearchTrack, BrandResearchTrackProgress>,
  );
}

function parseTrackProgress(
  json: string,
): Record<BrandResearchTrack, BrandResearchTrackProgress> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return defaultTrackProgress();
    const output = defaultTrackProgress();
    for (const track of BRAND_RESEARCH_TRACKS) {
      const raw = parsed[track];
      if (!raw || typeof raw !== "object") continue;
      const asRecord = raw as Record<string, unknown>;
      output[track] = {
        ...output[track],
        track,
        status:
          typeof asRecord.status === "string" && isTrackState(asRecord.status)
            ? (asRecord.status as BrandResearchTrackState)
            : "pending",
        evidence_count: Number(asRecord.evidence_count) || 0,
        evidence_ids: Array.isArray(asRecord.evidence_ids)
          ? asRecord.evidence_ids.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        provider_usage: Array.isArray(asRecord.provider_usage)
          ? asRecord.provider_usage.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        provider_gaps: Array.isArray(asRecord.provider_gaps)
          ? asRecord.provider_gaps.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        started_at:
          typeof asRecord.started_at === "string" ? asRecord.started_at : null,
        completed_at:
          typeof asRecord.completed_at === "string"
            ? asRecord.completed_at
            : null,
        error: typeof asRecord.error === "string" ? asRecord.error : null,
      };
    }
    return output;
  } catch {
    return defaultTrackProgress();
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isTrackState(value: string): value is BrandResearchTrackState {
  return [
    "pending",
    "running",
    "complete",
    "partial",
    "unavailable",
    "not_observable",
  ].includes(value);
}

function isTrackComplete(state: BrandResearchTrackState): boolean {
  return ["complete", "unavailable", "not_observable"].includes(state);
}

function recomputeTrackCounts(
  progress: Record<BrandResearchTrack, BrandResearchTrackProgress>,
) {
  let evidenceCount = 0;
  let running = false;
  let hasPending = false;
  for (const track of BRAND_RESEARCH_TRACKS) {
    const value = progress[track];
    evidenceCount += value.evidence_count;
    if (value.status === "running") running = true;
    if (value.status === "pending") hasPending = true;
  }
  let status: BrandResearchRunStatus = "queued";
  if (running) status = "running";
  else {
    const allDone = BRAND_RESEARCH_TRACKS.every((track) =>
      isTrackComplete(progress[track].status),
    );
    if (allDone) {
      status = "complete";
    } else if (hasPending) {
      status = "queued";
    } else {
      status = "partial";
    }
  }
  return { evidenceCount, status };
}

function mergeTrackProgress(
  current: Record<BrandResearchTrack, BrandResearchTrackProgress>,
  update: TrackExecutionUpdate,
): Record<BrandResearchTrack, BrandResearchTrackProgress> {
  const next = {
    ...current,
    [update.track]: {
      ...current[update.track],
      status: update.status,
      evidence_count:
        update.evidenceCount ?? current[update.track].evidence_count,
      evidence_ids:
        update.evidenceIds && update.evidenceIds.length > 0
          ? Array.from(
              new Set([
                ...(current[update.track].evidence_ids ?? []),
                ...update.evidenceIds,
              ]),
            )
          : current[update.track].evidence_ids,
      provider_usage:
        update.providerUsage && update.providerUsage.length > 0
          ? Array.from(
              new Set([
                ...(current[update.track].provider_usage ?? []),
                ...update.providerUsage,
              ]),
            )
          : current[update.track].provider_usage,
      provider_gaps:
        update.providerGaps && update.providerGaps.length > 0
          ? Array.from(
              new Set([
                ...(current[update.track].provider_gaps ?? []),
                ...update.providerGaps,
              ]),
            )
          : current[update.track].provider_gaps,
      error:
        typeof update.error === "string"
          ? update.error
          : current[update.track].error,
      completed_at:
        update.status === "complete" ||
        update.status === "partial" ||
        update.status === "unavailable" ||
        update.status === "not_observable"
          ? new Date().toISOString()
          : current[update.track].completed_at,
      started_at:
        update.status === "running" && !current[update.track].started_at
          ? new Date().toISOString()
          : current[update.track].started_at,
    },
  };
  return next;
}

export function ensureBrandResearchRunSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS brand_research_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      website_url TEXT,
      run_kind TEXT NOT NULL DEFAULT 'onboarding',
      coverage_start TEXT,
      coverage_end TEXT,
      seed_missing_reason TEXT,
      brand_brain_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled')),
      parent_task_id TEXT,
      child_task_ids_json TEXT NOT NULL DEFAULT '[]',
      tracks_json TEXT NOT NULL,
      track_progress_json TEXT NOT NULL DEFAULT '{}',
      evidence_count INTEGER NOT NULL DEFAULT 0,
      provider_usage_json TEXT NOT NULL DEFAULT '{}',
      provider_gaps_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      failed_at TEXT,
      processing_lease_token TEXT,
      processing_lease_expires_at TEXT,
      cancellation_metadata_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_brand_research_runs_user
      ON brand_research_runs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_brand_research_runs_status
      ON brand_research_runs(status, updated_at);
  `);
  addColumnIfMissing(db, "brand_research_runs", "brand_id", "TEXT");
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "run_kind",
    "TEXT NOT NULL DEFAULT 'onboarding'",
  );
  addColumnIfMissing(db, "brand_research_runs", "coverage_start", "TEXT");
  addColumnIfMissing(db, "brand_research_runs", "coverage_end", "TEXT");
  addColumnIfMissing(db, "brand_research_runs", "seed_missing_reason", "TEXT");
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "track_progress_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "provider_gaps_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "processing_lease_token",
    "TEXT",
  );
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "processing_lease_expires_at",
    "TEXT",
  );
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "cancellation_metadata_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(db, "brand_research_runs", "elapsed_ms", "INTEGER");
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "provider_usage_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(db, "brand_research_runs", "parent_task_id", "TEXT");
  addColumnIfMissing(
    db,
    "brand_research_runs",
    "child_task_ids_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  addColumnIfMissing(db, "brand_research_runs", "tracks_json", "TEXT NOT NULL");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_brand_research_runs_user ON brand_research_runs(user_id, created_at DESC);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_brand_research_runs_status ON brand_research_runs(status, updated_at);",
  );
  const missingBrandIds = db
    .query<
      Pick<BrandResearchRunRow, "id" | "brand_brain_id">,
      []
    >("SELECT id, brand_brain_id FROM brand_research_runs WHERE brand_id IS NULL OR TRIM(brand_id) = ''")
    .all();
  for (const row of missingBrandIds) {
    db.query(
      "UPDATE brand_research_runs SET brand_id = ? WHERE id = ?",
    ).run(
      row.brand_brain_id?.trim() || `brand-${randomUUID()}`,
      row.id,
    );
  }
  db.exec("DROP INDEX IF EXISTS uq_brand_research_active_seed;");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_research_active_brand ON brand_research_runs(assistant_id, brand_id) WHERE status IN ('queued', 'running', 'partial');",
  );
  initializedDatabases.add(db);
}

export function createOrGetBrandResearchRun(
  db: Database,
  input: CreateBrandResearchRunInput,
  nowIso: () => string,
): BrandResearchRunRow {
  ensureBrandResearchRunSchema(db);
  const brandName = normalizeBrandName(input.brandName);
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl);
  const resolvedBrandName = brandName || brandNameFromWebsite(websiteUrl);
  const runKind = normalizeRunKind(input.runKind);
  const coverageStart = normalizeIso(input.coverageStart);
  const coverageEnd = normalizeIso(input.coverageEnd);
  const seedMissingReason: BrandResearchSeedMissingReason | null =
    !brandName && !websiteUrl ? "seedMissing" : null;
  const requestedBrandId = normalizeBrandId(input.brandId);
  const priorBrand = requestedBrandId
    ? null
    : db
        .query<Pick<BrandResearchRunRow, "brand_id">, [string, string, string]>(
          `SELECT brand_id FROM brand_research_runs
           WHERE assistant_id = ?
             AND (
               (COALESCE(website_url, '') <> '' AND COALESCE(website_url, '') = COALESCE(?, ''))
               OR LOWER(brand_name) = LOWER(?)
             )
             AND brand_id IS NOT NULL
             AND TRIM(brand_id) <> ''
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(input.assistantId, websiteUrl ?? "", resolvedBrandName);
  const brandId =
    requestedBrandId || priorBrand?.brand_id || `brand-${randomUUID()}`;

  const existing = db
    .query<BrandResearchRunRow, [string, string]>(
      `SELECT * FROM brand_research_runs
       WHERE assistant_id = ?
         AND brand_id = ?
         AND status IN ('queued', 'running', 'partial')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.assistantId, brandId);
  if (existing) return existing;

  const timestamp = nowIso();
  const row: BrandResearchRunRow = {
    id: `research-${randomUUID()}`,
    org_id: input.orgId,
    user_id: input.userId,
    assistant_id: input.assistantId,
    brand_id: brandId,
    brand_name: resolvedBrandName,
    website_url: websiteUrl,
    run_kind: runKind,
    coverage_start: coverageStart,
    coverage_end: coverageEnd,
    seed_missing_reason: seedMissingReason,
    brand_brain_id: null,
    status: "queued",
    parent_task_id: null,
    child_task_ids_json: "[]",
    tracks_json: tracksJson(),
    track_progress_json: JSON.stringify(defaultTrackProgress()),
    evidence_count: 0,
    provider_usage_json: "{}",
    provider_gaps_json: "{}",
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    failed_at: null,
    processing_lease_token: null,
    processing_lease_expires_at: null,
    cancellation_metadata_json: "{}",
    error: null,
    retry_count: 0,
    elapsed_ms: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  try {
    db.query(
      `INSERT INTO brand_research_runs (
        id, org_id, user_id, assistant_id, brand_id, brand_name, website_url,
        run_kind, coverage_start, coverage_end, seed_missing_reason,
        brand_brain_id, status, parent_task_id, child_task_ids_json,
        tracks_json, track_progress_json, evidence_count,
        provider_usage_json, provider_gaps_json, started_at,
        completed_at, cancelled_at, failed_at,
        processing_lease_token, processing_lease_expires_at,
        cancellation_metadata_json, error, retry_count, elapsed_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.org_id,
      row.user_id,
      row.assistant_id,
      row.brand_id,
      row.brand_name,
      row.website_url,
      row.run_kind,
      row.coverage_start,
      row.coverage_end,
      row.seed_missing_reason,
      row.brand_brain_id,
      row.status,
      row.parent_task_id,
      row.child_task_ids_json,
      row.tracks_json,
      row.track_progress_json,
      row.evidence_count,
      row.provider_usage_json,
      row.provider_gaps_json,
      row.started_at,
      row.completed_at,
      row.cancelled_at,
      row.failed_at,
      row.processing_lease_token,
      row.processing_lease_expires_at,
      row.cancellation_metadata_json,
      row.error,
      row.retry_count,
      row.elapsed_ms,
      row.created_at,
      row.updated_at,
    );
    return row;
  } catch (error) {
    const winner = db
      .query<BrandResearchRunRow, [string, string]>(
        `SELECT * FROM brand_research_runs
         WHERE assistant_id = ? AND brand_id = ?
           AND status IN ('queued', 'running', 'partial')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.assistantId, brandId);
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

export function claimBrandResearchRunForExecution(
  db: Database,
  leaseToken: string,
  leaseExpiresAtIso: string,
  nowIso: () => string,
): BrandResearchRunRow | null {
  ensureBrandResearchRunSchema(db);
  const run = db
    .query<BrandResearchRunRow, [string]>(
      `SELECT * FROM brand_research_runs
       WHERE status = 'queued'
          OR (
            status = 'running'
            AND processing_lease_expires_at IS NOT NULL
            AND processing_lease_expires_at < ?
          )
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(nowIso());
  if (!run) return null;

  const now = nowIso();
  const updated = db
    .query(
      `UPDATE brand_research_runs
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           processing_lease_token = ?,
           processing_lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND (
           status = 'queued'
           OR (
             status = 'running'
             AND processing_lease_expires_at IS NOT NULL
             AND processing_lease_expires_at < ?
           )
         )`,
    )
    .run(now, leaseToken, leaseExpiresAtIso, now, run.id, now);
  if (!updated.changes) return null;

  return (
    db
      .query<
        BrandResearchRunRow,
        [string]
      >("SELECT * FROM brand_research_runs WHERE id = ?")
      .get(run.id) ?? null
  );
}

export function heartbeatBrandResearchRunLease(
  db: Database,
  runId: string,
  leaseToken: string,
  leaseExpiresAtIso: string,
  nowIso: () => string,
): boolean {
  ensureBrandResearchRunSchema(db);
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET processing_lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND processing_lease_token = ?
         AND status = 'running'`,
    )
    .run(leaseExpiresAtIso, nowIso(), runId, leaseToken);
  return result.changes > 0;
}

export function clearBrandResearchRunLease(
  db: Database,
  runId: string,
  leaseToken: string,
): void {
  ensureBrandResearchRunSchema(db);
  db.query(
    `UPDATE brand_research_runs
     SET processing_lease_token = NULL,
         processing_lease_expires_at = NULL,
         updated_at = ?
     WHERE id = ? AND processing_lease_token = ?`,
  ).run(new Date().toISOString(), runId, leaseToken);
}

export function releaseBrandResearchRunForRetry(
  db: Database,
  runId: string,
  nowIso: () => string,
): boolean {
  ensureBrandResearchRunSchema(db);
  const result = db
    .query(
      `UPDATE brand_research_runs
     SET status = 'queued',
         processing_lease_token = NULL,
         processing_lease_expires_at = NULL,
         parent_task_id = NULL,
         child_task_ids_json = '[]',
         brand_brain_id = NULL,
         error = NULL,
         failed_at = NULL,
         started_at = NULL,
         completed_at = NULL,
         track_progress_json = ?,
         evidence_count = ?,
         provider_usage_json = ?,
         provider_gaps_json = ?,
         retry_count = retry_count + 1,
         updated_at = ?
     WHERE id = ? AND status IN ('failed', 'cancelled', 'partial')`,
    )
    .run(
      JSON.stringify(defaultTrackProgress()),
      0,
      "{}",
      "{}",
      nowIso(),
      runId,
    );
  return result.changes > 0;
}

export function setBrandResearchRunParentTask(
  db: Database,
  runId: string,
  parentTaskId: string,
  nowIso: () => string,
): boolean {
  ensureBrandResearchRunSchema(db);
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET parent_task_id = ?, updated_at = ?
       WHERE id = ?
         AND status = 'running'
         AND (parent_task_id IS NULL OR parent_task_id = ?)`,
    )
    .run(parentTaskId, nowIso(), runId, parentTaskId);
  return result.changes > 0;
}

export function addBrandResearchRunChildTasks(
  db: Database,
  runId: string,
  childTaskIds: string[],
  nowIso: () => string,
): string[] {
  ensureBrandResearchRunSchema(db);
  const current = db
    .query<
      Pick<BrandResearchRunRow, "child_task_ids_json" | "status">,
      [string]
    >("SELECT child_task_ids_json, status FROM brand_research_runs WHERE id = ?")
    .get(runId);
  if (!current || current.status !== "running") return [];

  let existing: string[] = [];
  try {
    const parsed = JSON.parse(current.child_task_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      existing = parsed.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      );
    }
  } catch {
    existing = [];
  }

  const known = new Set(existing);
  const added: string[] = [];
  for (const rawId of childTaskIds) {
    const id = rawId.trim();
    if (!id || known.has(id)) continue;
    known.add(id);
    added.push(id);
  }
  if (added.length === 0) return [];

  const next = [...existing, ...added];
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET child_task_ids_json = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(next), nowIso(), runId);
  return result.changes > 0 ? added : [];
}

export function setBrandResearchRunBrandBrain(
  db: Database,
  runId: string,
  brandBrainId: string,
  nowIso: () => string,
): boolean {
  ensureBrandResearchRunSchema(db);
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET brand_brain_id = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(brandBrainId, nowIso(), runId);
  return result.changes > 0;
}

export function markBrandResearchRunProgress(
  db: Database,
  runId: string,
  trackUpdate: TrackExecutionUpdate,
  nowIso: () => string,
): BrandResearchRunRow | null {
  ensureBrandResearchRunSchema(db);
  const current = db
    .query<
      BrandResearchRunRow,
      [string]
    >("SELECT * FROM brand_research_runs WHERE id = ?")
    .get(runId);
  if (!current) return null;

  const trackProgress = mergeTrackProgress(
    parseTrackProgress(current.track_progress_json),
    trackUpdate,
  );
  const providerUsage = {
    ...parseRecord(current.provider_usage_json),
  } as Record<string, unknown>;
  for (const provider of trackUpdate.providerUsage ?? []) {
    providerUsage[provider] = trackUpdate.status;
  }

  const { evidenceCount, status } = recomputeTrackCounts(trackProgress);
  const timestamp = nowIso();
  let completedAt: string | null = current.completed_at;
  let failedAt: string | null = current.failed_at;
  const error =
    typeof trackUpdate.error === "string" ? trackUpdate.error : current.error;
  if (status === "complete") {
    completedAt = timestamp;
    failedAt = null;
  }

  const elapsedMs =
    status === "complete"
      ? current.started_at
        ? Math.max(
            0,
            new Date(timestamp).getTime() -
              new Date(current.started_at).getTime(),
          )
        : null
      : null;

  db.query(
    `UPDATE brand_research_runs
     SET track_progress_json = ?,
         evidence_count = ?,
         provider_usage_json = ?,
         provider_gaps_json = ?,
        status = ?,
        completed_at = ?,
        failed_at = ?,
        error = ?,
        elapsed_ms = CASE
            WHEN ? IS NULL THEN elapsed_ms
            ELSE ?
         END,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(trackProgress),
    evidenceCount,
    JSON.stringify(providerUsage),
    JSON.stringify(
      BRAND_RESEARCH_TRACKS.reduce<Record<string, string[]>>((acc, track) => {
        acc[track] = trackProgress[track].provider_gaps;
        return acc;
      }, {}),
    ),
    status,
    completedAt,
    failedAt,
    error,
    elapsedMs,
    elapsedMs,
    timestamp,
    runId,
  );

  return getBrandResearchRunForUser(db, runId, current.user_id);
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
       SET status = 'cancelled',
           cancelled_at = ?,
           updated_at = ?,
           processing_lease_token = NULL,
           processing_lease_expires_at = NULL,
           cancellation_metadata_json = ?,
           error = COALESCE(error, 'Cancelled by user.')
       WHERE id = ? AND status IN ('queued', 'running', 'partial')`,
    )
    .run(
      timestamp,
      timestamp,
      JSON.stringify({ requestedAt: timestamp, reason: "user" }),
      runId,
    );
  return result.changes > 0;
}

export function markBrandResearchRunFailed(
  db: Database,
  runId: string,
  nowIso: () => string,
  message: string,
): void {
  ensureBrandResearchRunSchema(db);
  const timestamp = nowIso();
  db.query(
    `UPDATE brand_research_runs
       SET status = 'failed',
           failed_at = ?,
           error = ?,
           updated_at = ?,
           processing_lease_token = NULL,
           processing_lease_expires_at = NULL
     WHERE id = ? AND status IN ('running', 'partial', 'queued')`,
  ).run(timestamp, message, timestamp, runId);
}

export function markBrandResearchRunCompleted(
  db: Database,
  runId: string,
  nowIso: () => string,
): void {
  ensureBrandResearchRunSchema(db);
  const timestamp = nowIso();
  db.query(
    `UPDATE brand_research_runs
       SET status = 'complete',
           completed_at = ?,
           updated_at = ?,
           processing_lease_token = NULL,
           processing_lease_expires_at = NULL,
           error = NULL
     WHERE id = ? AND status IN ('running', 'partial', 'queued')`,
  ).run(timestamp, timestamp, runId);
}

export function cancelExpiredBrandResearchRuns(
  db: Database,
  nowIso: () => string,
): number {
  ensureBrandResearchRunSchema(db);
  const now = nowIso();
  const result = db
    .query(
      `UPDATE brand_research_runs
       SET status = 'failed',
           failed_at = ?,
           error = 'Research run timed out waiting for execution.',
           processing_lease_token = NULL,
           processing_lease_expires_at = NULL,
           updated_at = ?
       WHERE status = 'running'
         AND processing_lease_expires_at IS NOT NULL
         AND processing_lease_expires_at < ?`,
    )
    .run(now, now, now);
  return result.changes;
}

export function brandResearchRunPayload(
  row: BrandResearchRunRow,
): BrandResearchRunPayload {
  return {
    id: row.id,
    assistant_id: row.assistant_id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    website_url: row.website_url,
    run_kind: row.run_kind,
    coverage_start: row.coverage_start,
    coverage_end: row.coverage_end,
    seed_missing_reason: row.seed_missing_reason,
    brand_brain_id: row.brand_brain_id,
    status: row.status,
    parent_task_id: row.parent_task_id,
    child_task_ids: parseArray(row.child_task_ids_json),
    tracks: parseArray(row.tracks_json),
    track_progress: parseTrackProgress(row.track_progress_json),
    evidence_count: row.evidence_count,
    provider_usage: parseRecord(row.provider_usage_json),
    provider_gaps: parseRecord(row.provider_gaps_json),
    started_at: row.started_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    failed_at: row.failed_at,
    error: row.error,
    retry_count: row.retry_count,
    elapsed_ms: row.elapsed_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
