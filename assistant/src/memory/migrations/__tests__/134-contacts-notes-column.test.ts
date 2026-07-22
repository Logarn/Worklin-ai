import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateContactsNotesColumn } from "../134-contacts-notes-column.js";

const CHECKPOINT_KEY = "migration_contacts_notes_column_v1";

function createLegacyDb(checkpointValue: string | null = "1") {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      last_interaction INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO contacts (
      id, display_name, last_interaction, interaction_count, created_at, updated_at
    ) VALUES ('contact-1', 'Alex', NULL, 0, 1, 1);
  `);
  if (checkpointValue !== null) {
    sqlite
      .query(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, 1)`,
      )
      .run(CHECKPOINT_KEY, checkpointValue);
  }
  return drizzle(sqlite, { schema });
}

function contactColumnNames(db: ReturnType<typeof createLegacyDb>) {
  return (
    getSqliteFrom(db).query(`PRAGMA table_info(contacts)`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

describe("migration 134 — contacts notes column", () => {
  test.each(["1", "failed"])(
    "repairs the missing notes column when checkpoint %s is stale",
    (checkpointValue) => {
      const db = createLegacyDb(checkpointValue);
      const raw = getSqliteFrom(db);

      migrateContactsNotesColumn(db);

      expect(contactColumnNames(db)).toContain("notes");
      expect(
        raw.query(`SELECT id, display_name, notes FROM contacts`).all(),
      ).toEqual([{ id: "contact-1", display_name: "Alex", notes: null }]);
      expect(
        raw
          .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
          .get(CHECKPOINT_KEY),
      ).toEqual({ value: "1" });
    },
  );

  test("is idempotent after the column has been repaired", () => {
    const db = createLegacyDb(null);

    migrateContactsNotesColumn(db);
    migrateContactsNotesColumn(db);

    expect(contactColumnNames(db).filter((name) => name === "notes")).toEqual([
      "notes",
    ]);
  });
});
