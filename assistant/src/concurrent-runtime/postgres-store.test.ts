import { describe, expect, test } from "bun:test";

import { CONCURRENT_RUNTIME_MIGRATION_001 } from "./migrations/001-initial-schema.js";
import { PostgresConcurrentRuntimeStore } from "./postgres-store.js";

describe("PostgresConcurrentRuntimeStore contract", () => {
  test("requires an explicit application database URL", () => {
    expect(
      () =>
        new PostgresConcurrentRuntimeStore({
          applicationDatabaseUrl: "",
        }),
    ).toThrow("Concurrent runtime database URL is required.");
  });

  test("migration establishes compound tenant keys and forced RLS", () => {
    for (const table of [
      "concurrent_assistants",
      "concurrent_conversations",
      "concurrent_messages",
      "concurrent_runs",
      "concurrent_events",
    ]) {
      expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
      "PRIMARY KEY (organization_id, assistant_id, conversation_id)",
    );
    expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
      "UNIQUE (organization_id, assistant_id, idempotency_key)",
    );
    expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
      "current_setting('worklin.organization_id', true)",
    );
    expect(CONCURRENT_RUNTIME_MIGRATION_001).toContain(
      "current_setting('worklin.assistant_id', true)",
    );
  });
});
