import type { DrizzleDb } from "../db-connection.js";

/** Create durable Brand Brain profiles, conversation bindings, and audit events. */
export function createRetentionBrandBrainTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_brand_brains (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id) ON DELETE CASCADE,
      brand_name TEXT NOT NULL,
      website_url TEXT,
      schema_version TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      source TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_conversation_brand_scopes (
      conversation_id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_brand_brain_events (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      conversation_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_brand_brains_brand ON retention_brand_brains (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_brand_brains_name ON retention_brand_brains (brand_name)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_brand_brains_website ON retention_brand_brains (website_url)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_brand_brains_updated_at ON retention_brand_brains (updated_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_conversation_brand_scopes_brand ON retention_conversation_brand_scopes (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_brand_brain_events_brand_created ON retention_brand_brain_events (brand_id, created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_brand_brain_events_conversation ON retention_brand_brain_events (conversation_id)`,
  );
}
