import { describe, expect, test } from "bun:test";

import { CONCURRENT_RUNTIME_MIGRATION_001 } from "./migrations/001-initial-schema.js";
import { CONCURRENT_RUNTIME_MIGRATIONS } from "./migrations/index.js";
import { PostgresConcurrentRuntimeStore } from "./postgres-store.js";

describe("PostgresConcurrentRuntimeStore contract", () => {
  test("an already migrated runtime starts without issuing DDL", async () => {
    const applied = CONCURRENT_RUNTIME_MIGRATIONS.map(({ version, name }) => ({
      version,
      name,
    }));
    const queries: string[] = [];
    const sql = Object.assign(
      async (parts: TemplateStringsArray) => {
        const query = parts.join("");
        queries.push(query);
        return query.includes("to_regclass")
          ? [{ registry: "concurrent_runtime_schema_migrations" }]
          : applied;
      },
      {
        unsafe: async () => {
          throw new Error("DDL is forbidden for runtime role");
        },
        begin: async () => {
          throw new Error("Migrations must be applied separately");
        },
      },
    );
    const store = Object.create(PostgresConcurrentRuntimeStore.prototype);
    store.migrationSql = sql;
    await store.initialize();
    expect(queries).toHaveLength(2);
  });

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
