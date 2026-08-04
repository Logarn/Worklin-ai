import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "./migrations/006_klaviyo_property_access_mode.sql",
  import.meta.url,
);
const databaseUrl = new URL("./database.ts", import.meta.url);

describe("Klaviyo property access schema contract", () => {
  test("registers append-only migration 006", async () => {
    const source = await Bun.file(databaseUrl).text();
    expect(source).toContain('version: "006_klaviyo_property_access_mode"');
    expect(source).toContain("006_klaviyo_property_access_mode.sql");
  });

  test("stores an explicit constrained access mode", async () => {
    const sql = await Bun.file(migrationUrl).text();
    expect(sql).toContain(
      "property_access_mode TEXT NOT NULL DEFAULT 'allowlist'",
    );
    expect(sql).toContain("property_access_mode IN ('allowlist', 'all')");
  });
});
