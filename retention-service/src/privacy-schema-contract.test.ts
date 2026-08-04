import { describe, expect, test } from "bun:test";

const privacyMigrationUrl = new URL(
  "./migrations/002_privacy_workflows.sql",
  import.meta.url,
);
const databaseUrl = new URL("./database.ts", import.meta.url);
const rawPayloadDeletionMigrationUrl = new URL(
  "./migrations/004_raw_payload_deletion_outbox.sql",
  import.meta.url,
);

describe("retention privacy schema contract", () => {
  test("uses append-only privacy migration with forced tenant isolation", async () => {
    const sql = await Bun.file(privacyMigrationUrl).text();
    expect(sql).toContain("retention_privacy_requests");
    expect(sql).toContain("retention_customer_erasure_tombstones");
    expect(sql).toContain("retention_identity_erasure_tombstones");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("org_id = worklin_current_org_id()");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).not.toContain("credential_ciphertext");
    expect(sql).not.toContain("webhook_secret_ciphertext");
  });

  test("migration runner applies every version and requires the latest one", async () => {
    const source = await Bun.file(databaseUrl).text();
    expect(source).toContain('version: "001_initial"');
    expect(source).toContain('version: "002_privacy_workflows"');
    expect(source).toContain('version: "003_program_policy_approvals"');
    expect(source).toContain('version: "004_raw_payload_deletion_outbox"');
    expect(source).toContain('version: "005_segment_review_pilot"');
    expect(source).toContain('version: "006_klaviyo_property_access_mode"');
    expect(source).toContain("for (const migration of migrationSources)");
    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS retention_schema_migrations",
    );
    expect(source).toContain("count(*) = ${migrations.length}");
  });

  test("tracks raw-payload deletion outside privacy transactions", async () => {
    const sql = await Bun.file(rawPayloadDeletionMigrationUrl).text();
    expect(sql).toContain("retention_raw_payload_deletions");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("org_id = worklin_current_org_id()");
    expect(sql).toContain("privacy_request_id");
    expect(sql).not.toContain("SECURITY DEFINER");
  });
});
