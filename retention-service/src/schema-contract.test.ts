import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "./migrations/001_initial.sql",
  import.meta.url,
);

describe("retention schema security contract", () => {
  test("forces tenant RLS and covers every org-scoped table", async () => {
    const sql = await Bun.file(migrationUrl).text();
    const tableMatches = [
      ...sql.matchAll(
        /CREATE TABLE IF NOT EXISTS (retention_[a-z0-9_]+) \(\n[\s\S]*?\n\);/gu,
      ),
    ];
    const tenantTables = tableMatches
      .filter((match) => /\n  org_id UUID (?:NOT NULL|PRIMARY KEY)/u.test(match[0]))
      .map((match) => match[1]!)
      ;
    const policyBlock = sql.slice(sql.indexOf("FOREACH tenant_table"));

    expect(tenantTables.length).toBeGreaterThan(20);
    for (const table of tenantTables) {
      expect(policyBlock).toContain(`'${table}'`);
    }
    expect(policyBlock).toContain("FORCE ROW LEVEL SECURITY");
    expect(policyBlock).toContain("org_id = worklin_current_org_id()");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).not.toContain("worklin_available_tenant_jobs");
    expect(sql).not.toContain("worklin_register_tenant");
  });

  test("deduplicates by provider id and payload hash", async () => {
    const sql = await Bun.file(migrationUrl).text();
    expect(sql).toContain("retention_source_event_dedup");
    expect(sql).toContain("retention_source_payload_dedup");
    expect(sql).toContain(
      "PRIMARY KEY (org_id, integration_id, external_event_id, payload_sha256)",
    );
    expect(sql).toContain(
      "PRIMARY KEY (org_id, integration_id, payload_sha256)",
    );
  });
});
