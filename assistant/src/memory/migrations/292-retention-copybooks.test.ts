import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { createRetentionCopybookTables } from "./292-retention-copybooks.js";

function testDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE retention_brands (id TEXT PRIMARY KEY);
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE retention_micro_campaign_packages (id TEXT PRIMARY KEY);
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      source_type TEXT,
      source_id TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("migration 292: retention copybooks", () => {
  test("creates the copybook workflow tables and indexes idempotently", () => {
    const { sqlite, db } = testDatabase();
    createRetentionCopybookTables(db);
    expect(() => createRetentionCopybookTables(db)).not.toThrow();

    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "retention_copybooks",
        "retention_copybook_months",
        "retention_copybook_campaigns",
        "retention_copybook_snapshots",
      ]),
    );
    const indexes = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_work_items_source");
  });

  test("enforces one copybook per brand and year", () => {
    const { sqlite, db } = testDatabase();
    createRetentionCopybookTables(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO retention_brands (id) VALUES ('brand-1');
      INSERT INTO retention_copybooks
        (id, brand_id, year, title, status, created_at, updated_at)
      VALUES ('copy-1', 'brand-1', 2026, 'Copybook', 'active', 1, 1);
    `);
    expect(() =>
      sqlite.exec(/*sql*/ `
        INSERT INTO retention_copybooks
          (id, brand_id, year, title, status, created_at, updated_at)
        VALUES ('copy-2', 'brand-1', 2026, 'Duplicate', 'active', 1, 1)
      `),
    ).toThrow();
  });
});
