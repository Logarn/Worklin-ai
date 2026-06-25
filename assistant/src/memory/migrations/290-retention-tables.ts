import type { DrizzleDb } from "../db-connection.js";

/**
 * Create the Worklin Retention namespace. These tables are intentionally
 * additive and namespaced so Worklin's Prisma/Postgres history is not merged
 * into Vellum's assistant database.
 */
export function createRetentionTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_brands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'worklin',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_customers (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      email TEXT,
      shopify_customer_id TEXT,
      klaviyo_profile_id TEXT,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      avg_order_value REAL NOT NULL DEFAULT 0,
      accepts_marketing INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_source_snapshots (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      source_freshness_at INTEGER,
      snapshot_json TEXT NOT NULL,
      caveats_json TEXT,
      safety_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_feature_snapshots (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      customer_id TEXT REFERENCES retention_customers(id) ON DELETE CASCADE,
      identity_id TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      timeframe_days INTEGER NOT NULL,
      status TEXT NOT NULL,
      features_json TEXT NOT NULL,
      labels_json TEXT,
      caveats_json TEXT,
      computed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_customer_scores (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      customer_id TEXT REFERENCES retention_customers(id) ON DELETE CASCADE,
      identity_id TEXT NOT NULL,
      scoring_version TEXT NOT NULL,
      status TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      action_hints_json TEXT,
      caveats_json TEXT,
      computed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_micro_segment_definitions (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      definition_key TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      activation_status TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      safety_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_campaign_opportunities (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      opportunity_key TEXT NOT NULL,
      opportunity_version TEXT NOT NULL,
      status TEXT NOT NULL,
      opportunity_type TEXT NOT NULL,
      opportunity_json TEXT NOT NULL,
      safety_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_micro_campaign_packages (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      opportunity_id TEXT REFERENCES retention_campaign_opportunities(id) ON DELETE SET NULL,
      package_version TEXT NOT NULL,
      activation_status TEXT NOT NULL,
      status TEXT NOT NULL,
      package_json TEXT NOT NULL,
      safety_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_qa_checks (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      package_id TEXT REFERENCES retention_micro_campaign_packages(id) ON DELETE CASCADE,
      qa_version TEXT NOT NULL,
      status TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      safety_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_action_logs (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'assistant',
      target_json TEXT,
      risk TEXT NOT NULL DEFAULT 'low',
      requires_approval INTEGER NOT NULL DEFAULT 0,
      external_action_taken INTEGER NOT NULL DEFAULT 0,
      can_go_live_now INTEGER NOT NULL DEFAULT 0,
      input_summary TEXT,
      output_summary TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS retention_external_drafts (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE CASCADE,
      package_id TEXT REFERENCES retention_micro_campaign_packages(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      provider_draft_id TEXT,
      status TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      safety_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customers_brand ON retention_customers (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customers_email ON retention_customers (email)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customers_shopify ON retention_customers (shopify_customer_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customers_klaviyo ON retention_customers (klaviyo_profile_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_source_snapshots_brand_provider ON retention_source_snapshots (brand_id, provider)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_source_snapshots_created_at ON retention_source_snapshots (created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_feature_snapshots_identity ON retention_feature_snapshots (identity_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_feature_snapshots_brand ON retention_feature_snapshots (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_feature_snapshots_computed_at ON retention_feature_snapshots (computed_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customer_scores_identity ON retention_customer_scores (identity_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customer_scores_brand ON retention_customer_scores (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_customer_scores_computed_at ON retention_customer_scores (computed_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_micro_segments_key ON retention_micro_segment_definitions (definition_key)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_micro_segments_brand ON retention_micro_segment_definitions (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_campaign_opportunities_key ON retention_campaign_opportunities (opportunity_key)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_campaign_opportunities_brand ON retention_campaign_opportunities (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_campaign_opportunities_computed_at ON retention_campaign_opportunities (computed_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_micro_packages_brand ON retention_micro_campaign_packages (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_micro_packages_opportunity ON retention_micro_campaign_packages (opportunity_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_qa_checks_package ON retention_qa_checks (package_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_qa_checks_brand ON retention_qa_checks (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_action_logs_brand ON retention_action_logs (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_action_logs_created_at ON retention_action_logs (created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_external_drafts_brand ON retention_external_drafts (brand_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_retention_external_drafts_package ON retention_external_drafts (package_id)`,
  );
}
