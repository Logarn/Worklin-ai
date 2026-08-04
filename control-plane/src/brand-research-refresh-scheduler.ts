import type { Database } from "bun:sqlite";

import {
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
  type BrandResearchRunKind,
  type BrandResearchRunRow,
} from "./brand-research-runs.js";

export interface BrandResearchRefreshSchedulerConfig {
  enabled: boolean;
  dailyChecksEnabled?: boolean;
  weeklyUpdatesEnabled?: boolean;
  monthlyReviewsEnabled?: boolean;
  maxRunsPerWorkspacePer30Days: number;
  pollIntervalMs?: number;
}

export interface BrandResearchRefreshScheduleRow {
  assistant_id: string;
  brand_id: string;
  org_id: string;
  user_id: string;
  brand_name: string;
  website_url: string | null;
  enabled: number;
  next_daily_at: string;
  next_weekly_at: string;
  next_monthly_at: string;
  last_daily_at: string | null;
  last_weekly_at: string | null;
  last_monthly_at: string | null;
  last_enqueued_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

function addMilliseconds(iso: string, milliseconds: number): string {
  const timestamp = Date.parse(iso);
  return new Date(
    (Number.isFinite(timestamp) ? timestamp : Date.now()) + milliseconds,
  ).toISOString();
}

function ensureRefreshScheduleSchema(db: Database): void {
  ensureBrandResearchRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_research_refresh_schedules (
      assistant_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      website_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_daily_at TEXT NOT NULL,
      next_weekly_at TEXT NOT NULL,
      next_monthly_at TEXT NOT NULL,
      last_daily_at TEXT,
      last_weekly_at TEXT,
      last_monthly_at TEXT,
      last_enqueued_run_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (assistant_id, brand_id)
    );
    CREATE INDEX IF NOT EXISTS idx_brand_research_refresh_due
      ON brand_research_refresh_schedules(enabled, next_weekly_at, next_monthly_at);
  `);
}

function backfillRefreshSchedules(
  db: Database,
  now: string,
): void {
  const brands = db
    .query<
      Pick<
        BrandResearchRunRow,
        | "assistant_id"
        | "brand_id"
        | "org_id"
        | "user_id"
        | "brand_name"
        | "website_url"
      >,
      []
    >(
      `SELECT assistant_id, brand_id, org_id, user_id, brand_name, website_url
       FROM brand_research_runs
       WHERE seed_missing_reason IS NULL
         AND brand_id IS NOT NULL
         AND TRIM(brand_id) <> ''
       GROUP BY assistant_id, brand_id
       ORDER BY created_at ASC`,
    )
    .all();
  const insert = db.query(
    `INSERT INTO brand_research_refresh_schedules (
      assistant_id, brand_id, org_id, user_id, brand_name, website_url,
      enabled, next_daily_at, next_weekly_at, next_monthly_at,
      last_daily_at, last_weekly_at, last_monthly_at,
      last_enqueued_run_id, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(assistant_id, brand_id) DO UPDATE SET
      org_id = excluded.org_id,
      user_id = excluded.user_id,
      brand_name = excluded.brand_name,
      website_url = excluded.website_url,
      updated_at = excluded.updated_at`,
  );
  for (const brand of brands) {
    insert.run(
      brand.assistant_id,
      brand.brand_id,
      brand.org_id,
      brand.user_id,
      brand.brand_name,
      brand.website_url,
      addMilliseconds(now, DAY_MS),
      addMilliseconds(now, WEEK_MS),
      addMilliseconds(now, MONTH_MS),
      now,
      now,
    );
  }
}

function recentRefreshRunCount(
  db: Database,
  orgId: string,
  since: string,
): number {
  const row = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count
       FROM brand_research_runs
       WHERE org_id = ?
         AND run_kind IN ('daily_check', 'weekly_update', 'monthly_review')
         AND created_at >= ?`,
    )
    .get(orgId, since);
  return row?.count ?? 0;
}

function hasActiveResearchRun(
  db: Database,
  assistantId: string,
  brandId: string,
): boolean {
  return Boolean(
    db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM brand_research_runs
         WHERE assistant_id = ?
           AND brand_id = ?
           AND status IN ('queued', 'running', 'partial')
         LIMIT 1`,
      )
      .get(assistantId, brandId),
  );
}

function dueKind(
  schedule: BrandResearchRefreshScheduleRow,
  now: string,
  config: BrandResearchRefreshSchedulerConfig,
): BrandResearchRunKind | null {
  if (
    config.monthlyReviewsEnabled !== false &&
    schedule.next_monthly_at <= now
  ) {
    return "monthly_review";
  }
  if (
    config.weeklyUpdatesEnabled !== false &&
    schedule.next_weekly_at <= now
  ) {
    return "weekly_update";
  }
  if (
    config.dailyChecksEnabled === true &&
    schedule.next_daily_at <= now
  ) {
    return "daily_check";
  }
  return null;
}

function coverageFor(
  runKind: BrandResearchRunKind,
  now: string,
): { coverageStart: string; coverageEnd: string } {
  const duration =
    runKind === "daily_check"
      ? DAY_MS
      : runKind === "weekly_update"
        ? WEEK_MS
        : 365 * DAY_MS;
  return {
    coverageStart: addMilliseconds(now, -duration),
    coverageEnd: now,
  };
}

function updateScheduleAfterEnqueue(
  db: Database,
  schedule: BrandResearchRefreshScheduleRow,
  runKind: BrandResearchRunKind,
  runId: string,
  now: string,
): void {
  const updates =
    runKind === "daily_check"
      ? {
          lastColumn: "last_daily_at",
          nextColumn: "next_daily_at",
          nextValue: addMilliseconds(now, DAY_MS),
        }
      : runKind === "weekly_update"
        ? {
            lastColumn: "last_weekly_at",
            nextColumn: "next_weekly_at",
            nextValue: addMilliseconds(now, WEEK_MS),
          }
        : {
            lastColumn: "last_monthly_at",
            nextColumn: "next_monthly_at",
            nextValue: addMilliseconds(now, MONTH_MS),
          };
  db.query(
    `UPDATE brand_research_refresh_schedules
     SET ${updates.lastColumn} = ?,
         ${updates.nextColumn} = ?,
         last_enqueued_run_id = ?,
         last_error = NULL,
         updated_at = ?
     WHERE assistant_id = ? AND brand_id = ?`,
  ).run(
    now,
    updates.nextValue,
    runId,
    now,
    schedule.assistant_id,
    schedule.brand_id,
  );
}

function recordScheduleError(
  db: Database,
  schedule: BrandResearchRefreshScheduleRow,
  message: string,
  now: string,
): void {
  db.query(
    `UPDATE brand_research_refresh_schedules
     SET last_error = ?, updated_at = ?
     WHERE assistant_id = ? AND brand_id = ?`,
  ).run(
    message.slice(0, 1_000),
    now,
    schedule.assistant_id,
    schedule.brand_id,
  );
}

export function createBrandResearchRefreshScheduler(
  db: Database,
  config: BrandResearchRefreshSchedulerConfig,
  nowIso: () => string = () => new Date().toISOString(),
) {
  const pollIntervalMs = Math.max(config.pollIntervalMs ?? 15 * 60_000, 60_000);
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = (): number => {
    ensureRefreshScheduleSchema(db);
    const now = nowIso();
    backfillRefreshSchedules(db, now);
    if (
      !config.enabled ||
      config.maxRunsPerWorkspacePer30Days <= 0
    ) {
      return 0;
    }

    const schedules = db
      .query<BrandResearchRefreshScheduleRow, []>(
        `SELECT * FROM brand_research_refresh_schedules
         WHERE enabled = 1
         ORDER BY MIN(next_daily_at, next_weekly_at, next_monthly_at) ASC`,
      )
      .all();
    const since = addMilliseconds(now, -MONTH_MS);
    let enqueued = 0;

    for (const schedule of schedules) {
      const runKind = dueKind(schedule, now, config);
      if (!runKind) continue;
      if (
        hasActiveResearchRun(
          db,
          schedule.assistant_id,
          schedule.brand_id,
        )
      ) {
        continue;
      }
      if (
        recentRefreshRunCount(db, schedule.org_id, since) >=
        config.maxRunsPerWorkspacePer30Days
      ) {
        recordScheduleError(
          db,
          schedule,
          "The workspace refresh limit was reached. No research was queued.",
          now,
        );
        continue;
      }
      try {
        const coverage = coverageFor(runKind, now);
        const run = createOrGetBrandResearchRun(
          db,
          {
            orgId: schedule.org_id,
            userId: schedule.user_id,
            assistantId: schedule.assistant_id,
            brandId: schedule.brand_id,
            brandName: schedule.brand_name,
            websiteUrl: schedule.website_url ?? undefined,
            runKind,
            ...coverage,
          },
          nowIso,
        );
        updateScheduleAfterEnqueue(
          db,
          schedule,
          runKind,
          run.id,
          now,
        );
        enqueued += 1;
      } catch (error) {
        recordScheduleError(
          db,
          schedule,
          error instanceof Error ? error.message : String(error),
          now,
        );
      }
    }
    return enqueued;
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = setInterval(runOnce, pollIntervalMs);
    timer.unref?.();
    runOnce();
  };

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    start,
    stop,
    runOnce,
    enabled:
      config.enabled && config.maxRunsPerWorkspacePer30Days > 0,
  };
}
