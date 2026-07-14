import type { DrizzleDb } from "../db-connection.js";

/** Create the campaign copybook workflow tables and their lookup indexes. */
export function createRetentionCopybookTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_copybooks (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_copybook_months (
      id TEXT PRIMARY KEY,
      copybook_id TEXT NOT NULL REFERENCES retention_copybooks(id) ON DELETE CASCADE,
      month INTEGER NOT NULL,
      document_surface_id TEXT REFERENCES documents(surface_id) ON DELETE SET NULL,
      strategy_status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_copybook_campaigns (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL REFERENCES retention_copybook_months(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'brief_draft',
      package_id TEXT REFERENCES retention_micro_campaign_packages(id) ON DELETE SET NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_copybook_snapshots (
      id TEXT PRIMARY KEY,
      month_id TEXT NOT NULL REFERENCES retention_copybook_months(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES retention_copybook_campaigns(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      document_content TEXT NOT NULL,
      document_updated_at INTEGER NOT NULL,
      campaign_state_json TEXT NOT NULL,
      actor_principal_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_copybooks_brand_year ON retention_copybooks (brand_id, year)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_copybook_months_copybook_month ON retention_copybook_months (copybook_id, month)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_copybook_months_document ON retention_copybook_months (document_surface_id)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_copybook_campaigns_position ON retention_copybook_campaigns (month_id, channel, ordinal)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_copybook_campaigns_package ON retention_copybook_campaigns (package_id)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_copybook_snapshots_revision ON retention_copybook_snapshots (month_id, kind, revision)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_copybook_snapshots_campaign ON retention_copybook_snapshots (campaign_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items (source_type, source_id)`,
  );
}
