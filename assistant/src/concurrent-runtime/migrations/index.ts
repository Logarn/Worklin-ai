import { CONCURRENT_RUNTIME_MIGRATION_001 } from "./001-initial-schema.js";
import { CONCURRENT_RUNTIME_MIGRATION_002 } from "./002-browser-broker.js";
import { CONCURRENT_RUNTIME_MIGRATION_003 } from "./003-onboarding-context.js";

export interface ConcurrentRuntimeMigration {
  version: number;
  name: string;
  sql: string;
}

export const CONCURRENT_RUNTIME_MIGRATION_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS concurrent_runtime_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export const CONCURRENT_RUNTIME_MIGRATIONS: readonly ConcurrentRuntimeMigration[] =
  [
    {
      version: 1,
      name: "initial_concurrent_runtime",
      sql: CONCURRENT_RUNTIME_MIGRATION_001,
    },
    {
      version: 2,
      name: "browser_broker",
      sql: CONCURRENT_RUNTIME_MIGRATION_002,
    },
    {
      version: 3,
      name: "onboarding_context",
      sql: CONCURRENT_RUNTIME_MIGRATION_003,
    },
  ];
