import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  createOrGetBrandResearchRun,
  getBrandResearchRunForUser,
  listBrandResearchRunsForUser,
  markBrandResearchRunCompleted,
} from "./brand-research-runs.js";
import { createBrandResearchRefreshScheduler } from "./brand-research-refresh-scheduler.js";

function day(value: number): string {
  return new Date(Date.UTC(2026, 0, value)).toISOString();
}

function completedOnboarding(db: Database, nowIso: () => string) {
  const run = createOrGetBrandResearchRun(
    db,
    {
      orgId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      brandName: "Acme Studio",
      websiteUrl: "https://acme.example",
    },
    nowIso,
  );
  markBrandResearchRunCompleted(db, run.id, nowIso);
  return run;
}

describe("brand research refresh scheduler", () => {
  test("does not queue automatic work while the spending guard is off", () => {
    const db = new Database(":memory:");
    let now = day(1);
    completedOnboarding(db, () => now);
    now = day(40);

    const scheduler = createBrandResearchRefreshScheduler(
      db,
      {
        enabled: false,
        maxRunsPerWorkspacePer30Days: 0,
      },
      () => now,
    );

    expect(scheduler.runOnce()).toBe(0);
    expect(listBrandResearchRunsForUser(db, "user-1")).toHaveLength(1);
  });

  test("queues a weekly update, then gives a monthly review priority", () => {
    const db = new Database(":memory:");
    let now = day(1);
    const onboarding = completedOnboarding(db, () => now);
    const scheduler = createBrandResearchRefreshScheduler(
      db,
      {
        enabled: true,
        dailyChecksEnabled: false,
        maxRunsPerWorkspacePer30Days: 3,
      },
      () => now,
    );

    expect(scheduler.runOnce()).toBe(0);
    now = day(9);
    expect(scheduler.runOnce()).toBe(1);

    const weekly = listBrandResearchRunsForUser(db, "user-1")[0];
    expect(weekly.run_kind).toBe("weekly_update");
    expect(weekly.brand_id).toBe(onboarding.brand_id);
    expect(weekly.coverage_start).toBe(day(2));
    expect(weekly.coverage_end).toBe(day(9));
    markBrandResearchRunCompleted(db, weekly.id, () => now);

    now = day(32);
    expect(scheduler.runOnce()).toBe(1);
    const monthly = listBrandResearchRunsForUser(db, "user-1")[0];
    expect(monthly.run_kind).toBe("monthly_review");
    expect(monthly.brand_id).toBe(onboarding.brand_id);
  });

  test("keeps daily checks off and respects the workspace run limit", () => {
    const db = new Database(":memory:");
    let now = day(1);
    completedOnboarding(db, () => now);
    const scheduler = createBrandResearchRefreshScheduler(
      db,
      {
        enabled: true,
        dailyChecksEnabled: false,
        maxRunsPerWorkspacePer30Days: 1,
      },
      () => now,
    );

    expect(scheduler.runOnce()).toBe(0);
    now = day(3);
    expect(scheduler.runOnce()).toBe(0);

    now = day(9);
    expect(scheduler.runOnce()).toBe(1);
    const weekly = listBrandResearchRunsForUser(db, "user-1")[0];
    markBrandResearchRunCompleted(db, weekly.id, () => now);

    now = day(32);
    expect(scheduler.runOnce()).toBe(0);
    expect(listBrandResearchRunsForUser(db, "user-1")).toHaveLength(2);
    expect(getBrandResearchRunForUser(db, weekly.id, "user-1")?.status).toBe(
      "complete",
    );
  });
});
