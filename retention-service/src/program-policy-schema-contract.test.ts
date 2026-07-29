import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "./migrations/003_program_policy_approvals.sql",
  import.meta.url,
);

describe("retention program policy approval schema", () => {
  test("fails closed for active programs without frozen approval material", async () => {
    const sql = await Bun.file(migrationUrl).text();

    expect(sql).toContain("policy_approval_sha256");
    expect(sql).toContain("policy_material_ciphertext");
    expect(sql).toContain("status = 'paused'");
    expect(sql).toContain("retention_programs_active_policy_approval");
    expect(sql).toContain("status <> 'active'");
    expect(sql).not.toContain("SECURITY DEFINER");
  });
});
