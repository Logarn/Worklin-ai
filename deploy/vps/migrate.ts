import postgres from "postgres";
import { PostgresConcurrentRuntimeStore } from "./src/concurrent-runtime/postgres-store.js";

const url = process.env.CONCURRENT_RUNTIME_MIGRATION_DATABASE_URL;
if (!url) throw new Error("Migration database URL is required.");
const store = new PostgresConcurrentRuntimeStore({
  applicationDatabaseUrl: url,
  maxConnections: 1,
});
try {
  await store.initialize();
} finally {
  await store.close();
}
const sql = postgres(url, { max: 1 });
try {
  await sql.unsafe(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO worklin_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO worklin_runtime;
    REVOKE INSERT, UPDATE, DELETE ON concurrent_runtime_schema_migrations FROM worklin_runtime;
  `);
} finally {
  await sql.end();
}
