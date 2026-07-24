import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateLlmUsageAddRawUsage } from "../261-llm-usage-add-raw-usage.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function createLegacyDb(checkpointValue: string | null = "1") {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE llm_usage_events (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL
    );

    INSERT INTO llm_usage_events (
      id, created_at, provider, model, input_tokens, output_tokens
    ) VALUES (
      'legacy-usage', 1, 'anthropic', 'claude-sonnet-4', 10, 20
    );

  `);
  if (checkpointValue !== null) {
    sqlite
      .query(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, 1)`,
      )
      .run("migration_llm_usage_add_raw_usage_v1", checkpointValue);
  }
  return drizzle(sqlite, { schema });
}

describe("migration 261 — llm_usage_events add raw_usage", () => {
  test("repairs a legacy table when the completed checkpoint exists but raw_usage does not", () => {
    const db = createLegacyDb();
    const raw = getSqliteFrom(db);

    const before = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    expect(before.map((column) => column.name)).not.toContain("raw_usage");

    migrateLlmUsageAddRawUsage(db);

    const after = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    const column = after.find(({ name }) => name === "raw_usage");
    expect(column).toBeDefined();
    expect(column!.type).toBe("TEXT");
    expect(column!.notnull).toBe(0);
    expect(column!.dflt_value).toBeNull();

    const rows = raw
      .query(`SELECT id, raw_usage FROM llm_usage_events`)
      .all() as Array<{ id: string; raw_usage: string | null }>;
    expect(rows).toEqual([{ id: "legacy-usage", raw_usage: null }]);
  });

  test("retries a failed checkpoint and records a completed repair", () => {
    const db = createLegacyDb("failed");
    const raw = getSqliteFrom(db);

    migrateLlmUsageAddRawUsage(db);

    const columns = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    expect(columns.map(({ name }) => name)).toContain("raw_usage");
    expect(
      raw
        .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
        .get("migration_llm_usage_add_raw_usage_v1"),
    ).toEqual({ value: "1" });
  });

  test("is idempotent after the schema has been repaired", () => {
    const db = createLegacyDb(null);
    const raw = getSqliteFrom(db);

    migrateLlmUsageAddRawUsage(db);
    migrateLlmUsageAddRawUsage(db);

    const columns = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    expect(columns.filter(({ name }) => name === "raw_usage")).toHaveLength(1);
    expect(
      raw
        .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
        .get("migration_llm_usage_add_raw_usage_v1"),
    ).toEqual({ value: "1" });
  });
});
