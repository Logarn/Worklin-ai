import { describe, expect, test } from "bun:test";

import {
  CONCURRENT_RUNTIME_MIGRATION_BOOTSTRAP,
  CONCURRENT_RUNTIME_MIGRATIONS,
} from "./index.js";

describe("concurrent runtime migrations", () => {
  test("remain append-only and ordered", () => {
    expect(
      CONCURRENT_RUNTIME_MIGRATIONS.map(({ version, name }) => ({
        version,
        name,
      })),
    ).toEqual([
      { version: 1, name: "initial_concurrent_runtime" },
      { version: 2, name: "browser_broker" },
      { version: 3, name: "onboarding_context" },
    ]);
    expect(CONCURRENT_RUNTIME_MIGRATION_BOOTSTRAP).toContain(
      "concurrent_runtime_schema_migrations",
    );
  });

  test("migration 2 enforces actor scope and durable browser recovery state", () => {
    const migration = CONCURRENT_RUNTIME_MIGRATIONS[1]?.sql ?? "";
    for (const required of [
      "owner_user_id",
      "owner_actor_id",
      "waiting_for_browser",
      "concurrent_browser_clients",
      "concurrent_browser_connections",
      "concurrent_browser_access_grants",
      "concurrent_browser_sessions",
      "concurrent_run_steps",
      "concurrent_browser_actions",
      "concurrent_browser_outbox",
      "worklin.user_id",
      "worklin.actor_id",
      "FORCE ROW LEVEL SECURITY",
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain("idx_concurrent_runs_one_active");
    expect(migration).toContain(
      "WHERE status IN ('processing', 'waiting_for_browser')",
    );
    expect(migration).not.toContain("DROP TABLE");
  });

  test("migration 3 stores bounded onboarding context on its conversation", () => {
    expect(CONCURRENT_RUNTIME_MIGRATIONS[2]?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS onboarding_context JSONB",
    );
    expect(CONCURRENT_RUNTIME_MIGRATIONS[2]?.sql).not.toContain("DROP TABLE");
  });
});
