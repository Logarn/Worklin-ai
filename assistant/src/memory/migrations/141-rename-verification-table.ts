import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_rename_verification_table_v1";
const OLD_TABLE = "channel_guardian_verification_challenges";
const NEW_TABLE = "channel_verification_sessions";

function tableExists(database: DrizzleDb, name: string): boolean {
  return Boolean(
    getSqliteFrom(database)
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

/**
 * Reverse v21: rename channel_verification_sessions back to
 * channel_guardian_verification_challenges and recreate old indexes.
 */
export function downRenameVerificationTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Check the new table exists before attempting anything
  const newTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${NEW_TABLE}'`,
    )
    .get();
  if (!newTableExists) return;

  // If the old table already exists, skip (already rolled back)
  const oldTableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${OLD_TABLE}'`,
    )
    .get();
  if (oldTableExists) return;

  // Rename back to old name
  raw.exec(/*sql*/ `ALTER TABLE ${NEW_TABLE} RENAME TO ${OLD_TABLE}`);

  // Drop new-style indexes and recreate old-style ones
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_lookup`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_active`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_identity`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_destination`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_verification_sessions_bootstrap`);

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_guardian_challenges_lookup ON ${OLD_TABLE}(channel, challenge_hash, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_active ON ${OLD_TABLE}(channel, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_identity ON ${OLD_TABLE}(channel, expected_external_user_id, expected_chat_id, status)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_destination ON ${OLD_TABLE}(channel, destination_address)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_sessions_bootstrap ON ${OLD_TABLE}(channel, bootstrap_token_hash, status)`,
  );
}

/**
 * One-shot migration: rename channel_guardian_verification_challenges →
 * channel_verification_sessions, including all indexes that reference the
 * old table name.
 */
export function migrateRenameVerificationTable(database: DrizzleDb): void {
  // Restored database files can preserve a completed checkpoint while reverting the
  // live table back to its legacy name. Trust the live schema and retry the
  // migration when that happens.
  if (!tableExists(database, NEW_TABLE) && tableExists(database, OLD_TABLE)) {
    getSqliteFrom(database)
      .query(`DELETE FROM memory_checkpoints WHERE key = ?`)
      .run(CHECKPOINT_KEY);
  }

  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    // Check the old table exists before attempting anything
    const oldTableExists = tableExists(database, OLD_TABLE);
    if (!oldTableExists) return;

    // If the new table already exists, the rename would collide — skip
    const newTableExists = tableExists(database, NEW_TABLE);
    if (newTableExists) return;

    // Rename the physical table
    raw.exec(/*sql*/ `ALTER TABLE ${OLD_TABLE} RENAME TO ${NEW_TABLE}`);

    // Drop and recreate indexes that referenced the old table name.
    // SQLite auto-updates index table references on RENAME, but index names still
    // reference the legacy naming convention.
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_channel_guardian_challenges_lookup`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_active`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_identity`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_destination`);
    raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_guardian_sessions_bootstrap`);

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_lookup ON ${NEW_TABLE}(channel, challenge_hash, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_active ON ${NEW_TABLE}(channel, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_identity ON ${NEW_TABLE}(channel, expected_external_user_id, expected_chat_id, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_destination ON ${NEW_TABLE}(destination_address, channel)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_verification_sessions_bootstrap ON ${NEW_TABLE}(channel, bootstrap_token_hash, status)`,
    );
  });

  if (!tableExists(database, NEW_TABLE)) {
    throw new Error(`${NEW_TABLE} migration postcondition failed`);
  }
}
