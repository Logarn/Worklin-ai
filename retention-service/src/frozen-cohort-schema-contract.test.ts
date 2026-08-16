import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "./migrations/007_frozen_segment_run_cohort.sql",
  import.meta.url,
);
const databaseUrl = new URL("./database.ts", import.meta.url);

describe("frozen segment cohort schema contract", () => {
  test("registers append-only migration 007", async () => {
    const source = await Bun.file(databaseUrl).text();
    expect(source).toContain('version: "007_frozen_segment_run_cohort"');
    expect(source).toContain("007_frozen_segment_run_cohort.sql");
  });

  test("caps and isolates the run cohort", async () => {
    const sql = await Bun.file(migrationUrl).text();
    expect(sql).toContain("cohort_limit BETWEEN 1 AND 500");
    expect(sql).toContain("cohort_count BETWEEN 0 AND 500");
    expect(sql).toContain("recent_non_open_activity_v1");
    expect(sql).toContain("retention_segment_run_cohort");
    expect(sql).toContain("selected_rank BETWEEN 1 AND 500");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("org_id = worklin_current_org_id()");
    expect(sql).not.toContain("SECURITY DEFINER");
  });
});
