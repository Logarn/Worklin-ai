import postgres from "postgres";

export type RetentionSql = postgres.Sql;
export type RetentionTransactionSql = RetentionSql;

const migrations = [
  {
    version: "001_initial",
    url: new URL("./migrations/001_initial.sql", import.meta.url),
  },
  {
    version: "002_privacy_workflows",
    url: new URL("./migrations/002_privacy_workflows.sql", import.meta.url),
  },
  {
    version: "003_program_policy_approvals",
    url: new URL(
      "./migrations/003_program_policy_approvals.sql",
      import.meta.url,
    ),
  },
  {
    version: "004_raw_payload_deletion_outbox",
    url: new URL(
      "./migrations/004_raw_payload_deletion_outbox.sql",
      import.meta.url,
    ),
  },
  {
    version: "005_segment_review_pilot",
    url: new URL("./migrations/005_segment_review_pilot.sql", import.meta.url),
  },
] as const;

export class RetentionDatabase {
  readonly sql: RetentionSql;

  constructor(databaseUrl: string, options: { timeoutMs: number }) {
    this.sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
      max_lifetime: 60 * 30,
      onnotice: () => undefined,
    });
  }

  async migrate(): Promise<void> {
    const migrationSources = await Promise.all(
      migrations.map(async (migration) => ({
        ...migration,
        sql: await Bun.file(migration.url).text(),
      })),
    );
    await this.sql.begin(async (tx) => {
      const transaction = tx as unknown as RetentionTransactionSql;
      await transaction`SELECT pg_advisory_xact_lock(90120260728)`;
      await transaction`
        CREATE TABLE IF NOT EXISTS retention_schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      for (const migration of migrationSources) {
        const applied = await transaction<{ version: string }[]>`
          SELECT version
          FROM retention_schema_migrations
          WHERE version = ${migration.version}
        `;
        if (applied.length > 0) continue;
        await transaction.unsafe(migration.sql);
        await transaction`
          INSERT INTO retention_schema_migrations (version)
          VALUES (${migration.version})
          ON CONFLICT (version) DO NOTHING
        `;
      }
    });
  }

  async ready(): Promise<boolean> {
    try {
      const result = await this.sql<{ ready: number }[]>`SELECT 1 AS ready`;
      return result[0]?.ready === 1;
    } catch {
      return false;
    }
  }

  async migrationsReady(): Promise<boolean> {
    try {
      const rows = await this.sql<Array<{ applied: boolean }>>`
        SELECT count(*) = ${migrations.length} AS applied
        FROM retention_schema_migrations
        WHERE version IN ${this.sql(
          migrations.map((migration) => migration.version),
        )}
      `;
      return rows[0]?.applied === true;
    } catch {
      return false;
    }
  }

  async tenantIsolationReady(): Promise<boolean> {
    try {
      const rows = await this.sql<
        Array<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          owns_tenant_tables: boolean;
          unsafe_tenant_tables: string;
          current_org_is_empty: boolean;
        }>
      >`
        SELECT
          role.rolsuper,
          role.rolbypassrls,
          EXISTS (
            SELECT 1
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname LIKE 'retention_%'
              AND pg_get_userbyid(relation.relowner) = current_user
          ) AS owns_tenant_tables,
          (
            SELECT count(*)::TEXT
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname LIKE 'retention_%'
              AND relation.relname <> 'retention_schema_migrations'
              AND relation.relkind IN ('r', 'p')
              AND (
                NOT relation.relrowsecurity
                OR NOT relation.relforcerowsecurity
                OR NOT EXISTS (
                  SELECT 1
                  FROM pg_policies AS policy
                  WHERE policy.schemaname = namespace.nspname
                    AND policy.tablename = relation.relname
                    AND policy.policyname = 'retention_org_isolation'
                )
              )
          ) AS unsafe_tenant_tables,
          worklin_current_org_id() IS NULL AS current_org_is_empty
        FROM pg_roles AS role
        WHERE role.rolname = current_user
      `;
      const role = rows[0];
      return Boolean(
        role &&
        !role.rolsuper &&
        !role.rolbypassrls &&
        !role.owns_tenant_tables &&
        role.unsafe_tenant_tables === "0" &&
        role.current_org_is_empty,
      );
    } catch {
      return false;
    }
  }

  async withTenant<T>(
    organizationId: string,
    callback: (tx: RetentionTransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      const transaction = tx as unknown as RetentionTransactionSql;
      await transaction`SELECT set_config('worklin.org_id', ${organizationId}, true)`;
      return callback(transaction);
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
