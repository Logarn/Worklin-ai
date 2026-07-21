import type { Database } from "bun:sqlite";

export type OrganizationRole = "admin" | "manager" | "collaborator";

export interface OrganizationMembershipRow {
  org_id: string;
  user_id: string;
  role: OrganizationRole;
  status: "active" | "deactivated";
  created_at: string;
  updated_at: string;
}

const initializedDatabases = new WeakSet<Database>();

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

export function ensureOrganizationMembershipSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;

  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS organization_memberships (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'collaborator')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deactivated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
      ON organization_memberships(user_id, org_id);
  `);
  if (!tableColumns(db, "organization_memberships").has("status")) {
    db.exec(
      "ALTER TABLE organization_memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deactivated'))",
    );
  }
  initializedDatabases.add(db);
}

export function getOrganizationMembership(
  db: Database,
  orgId: string,
  userId: string,
): OrganizationMembershipRow | null {
  ensureOrganizationMembershipSchema(db);
  return db
    .query<
      OrganizationMembershipRow,
      [string, string]
    >("SELECT * FROM organization_memberships WHERE org_id = ? AND user_id = ?")
    .get(orgId, userId);
}

export function getOrCreateOrganizationMembership(
  db: Database,
  orgId: string,
  userId: string,
  role: OrganizationRole,
  nowIso: () => string,
): OrganizationMembershipRow {
  ensureOrganizationMembershipSchema(db);
  const timestamp = nowIso();
  db.query(
    `
    INSERT INTO organization_memberships (
      org_id,
      user_id,
      role,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(org_id, user_id) DO NOTHING
  `,
  ).run(orgId, userId, role, timestamp, timestamp);

  const membership = getOrganizationMembership(db, orgId, userId);
  if (!membership) {
    throw new Error("Organization membership upsert did not produce a row.");
  }
  return membership;
}
