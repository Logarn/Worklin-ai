import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateRenameVerificationTable } from "../141-rename-verification-table.js";

const CHECKPOINT_KEY = "migration_rename_verification_table_v1";

function createLegacyDb(checkpointValue: string | null = "1") {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE channel_guardian_verification_challenges (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      challenge_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by_session_id TEXT,
      consumed_by_external_user_id TEXT,
      consumed_by_chat_id TEXT,
      expected_external_user_id TEXT,
      expected_chat_id TEXT,
      expected_phone_e164 TEXT,
      identity_binding_status TEXT DEFAULT 'bound',
      destination_address TEXT,
      last_sent_at INTEGER,
      send_count INTEGER DEFAULT 0,
      next_resend_at INTEGER,
      code_digits INTEGER DEFAULT 6,
      max_attempts INTEGER DEFAULT 3,
      verification_purpose TEXT DEFAULT 'guardian',
      bootstrap_token_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO channel_guardian_verification_challenges (
      id, channel, challenge_hash, expires_at, status, created_by_session_id, created_at, updated_at
    ) VALUES (
      'legacy-session', 'telegram', 'hash', 1000, 'pending', 'conversation-1', 1, 1
    );
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

function hasTable(db: ReturnType<typeof createLegacyDb>, name: string) {
  return Boolean(
    getSqliteFrom(db)
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

describe("migration 141 — rename verification table", () => {
  test.each(["1", "failed"])(
    "repairs a legacy table when checkpoint %s is stale",
    (checkpointValue) => {
      const db = createLegacyDb(checkpointValue);
      const raw = getSqliteFrom(db);

      migrateRenameVerificationTable(db);

      expect(hasTable(db, "channel_verification_sessions")).toBe(true);
      expect(hasTable(db, "channel_guardian_verification_challenges")).toBe(false);
      expect(
        raw.query(`SELECT id, channel FROM channel_verification_sessions`).all(),
      ).toEqual([{ id: "legacy-session", channel: "telegram" }]);
      expect(
        raw
          .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
          .get(CHECKPOINT_KEY),
      ).toEqual({ value: "1" });
      expect(
        raw
          .query(
            `SELECT id, created_by_session_id FROM channel_verification_sessions`,
          )
          .all(),
      ).toEqual([
        { id: "legacy-session", created_by_session_id: "conversation-1" },
      ]);
    },
  );

  test("is idempotent after the schema has been repaired", () => {
    const db = createLegacyDb(null);
    const raw = getSqliteFrom(db);

    migrateRenameVerificationTable(db);
    migrateRenameVerificationTable(db);

    expect(hasTable(db, "channel_verification_sessions")).toBe(true);
    expect(
      raw
        .query(
          `SELECT COUNT(*) AS count FROM channel_verification_sessions WHERE id = 'legacy-session'`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });
});
