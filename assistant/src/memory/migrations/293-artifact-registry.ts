import type { DrizzleDb } from "../db-connection.js";

/** Create the unified artifact registry and register existing canonical sources. */
export function createArtifactRegistry(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      brand_id TEXT REFERENCES retention_brands(id) ON DELETE SET NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      parent_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      project_id TEXT,
      metadata_json TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_resource ON artifacts (resource_type, resource_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_artifacts_brand_updated ON artifacts (brand_id, updated_at DESC)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_artifacts_type_updated ON artifacts (artifact_type, updated_at DESC)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts (parent_artifact_id)`,
  );

  database.run(/*sql*/ `
    INSERT OR IGNORE INTO artifacts (
      id, brand_id, resource_type, resource_id, artifact_type,
      metadata_json, created_at, updated_at
    )
    SELECT
      'copybook:' || id,
      brand_id,
      'copybook',
      id,
      'copy',
      json_object('year', year),
      created_at,
      updated_at
    FROM retention_copybooks
  `);

  database.run(/*sql*/ `
    INSERT OR IGNORE INTO artifacts (
      id, brand_id, resource_type, resource_id, artifact_type,
      metadata_json, created_at, updated_at
    )
    SELECT
      'document:' || document.surface_id,
      scope.brand_id,
      'document',
      document.surface_id,
      'document',
      json_object('conversationId', document.conversation_id),
      document.created_at,
      document.updated_at
    FROM documents AS document
    LEFT JOIN retention_conversation_brand_scopes AS scope
      ON scope.conversation_id = document.conversation_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM retention_copybook_months AS month
      WHERE month.document_surface_id = document.surface_id
    )
  `);
}
