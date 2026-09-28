import { RetentionDatabase } from "./src/database.js";

const url = process.env.WORKLIN_RETENTION_MIGRATION_DATABASE_URL;
if (!url) throw new Error("Retention migration database URL is required.");
const database = new RetentionDatabase(url, { timeoutMs: 60_000 });
try {
  await database.migrate();
  await database.sql.unsafe(`
    REVOKE CREATE ON SCHEMA public FROM worklin_retention_runtime;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO worklin_retention_runtime;
    GRANT SELECT ON retention_schema_migrations TO worklin_retention_runtime;
    DO $$
    DECLARE tenant_table record;
    BEGIN
      FOR tenant_table IN
        SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE 'retention_%'
          AND tablename <> 'retention_schema_migrations'
      LOOP
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO worklin_retention_runtime',
          tenant_table.schemaname, tenant_table.tablename
        );
      END LOOP;
    END
    $$;
    GRANT EXECUTE ON FUNCTION worklin_current_org_id() TO worklin_retention_runtime;
  `);
} finally {
  await database.close();
}
