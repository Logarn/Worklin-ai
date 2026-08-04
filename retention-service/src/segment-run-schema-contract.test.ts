import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "./migrations/005_segment_review_pilot.sql",
  import.meta.url,
);
const databaseUrl = new URL("./database.ts", import.meta.url);

describe("segment review schema contract", () => {
  test("registers append-only migration 005", async () => {
    const source = await Bun.file(databaseUrl).text();
    expect(source).toContain('version: "005_segment_review_pilot"');
    expect(source).toContain("005_segment_review_pilot.sql");
  });

  test("forces tenant RLS on every new organization table", async () => {
    const sql = await Bun.file(migrationUrl).text();
    for (const table of [
      "retention_segment_runs",
      "retention_segment_memberships",
      "retention_campaign_previews",
      "retention_campaign_preview_samples",
    ]) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("org_id = worklin_current_org_id()");
    expect(sql).not.toContain("SECURITY DEFINER");
  });

  test("encrypts dossiers, strategies, evidence, and sample content", async () => {
    const sql = await Bun.file(migrationUrl).text();
    expect(sql).toContain("account_dossier_ciphertext TEXT NOT NULL");
    expect(sql).toContain("strategy_ciphertext TEXT NOT NULL");
    expect(sql).toContain("evidence_ciphertext TEXT NOT NULL");
    expect(sql).toContain("subject_ciphertext TEXT NOT NULL");
    expect(sql).toContain("body_ciphertext TEXT NOT NULL");
    expect(sql).toContain("max_segments BETWEEN 1 AND 50");
    expect(sql).toContain("sample_limit_per_segment BETWEEN 1 AND 2");
    expect(sql).toContain("tranche_size BETWEEN 1 AND 10");
  });
});
