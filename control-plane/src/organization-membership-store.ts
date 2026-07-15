import type { Database } from "bun:sqlite";

export type OrganizationRole = "admin" | "manager" | "collaborator";

export interface OrganizationMembershipRow {
  org_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  updated_at: string;
}

const initializedDatabases = new WeakSet<Database>();

export function ensureOrganizationMembershipSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;

  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS organization_memberships (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'collaborator')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
      ON organization_memberships(user_id, org_id);
  `);
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
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, user_id) DO NOTHING
  `,
  ).run(orgId, userId, role, timestamp, timestamp);

  const membership = getOrganizationMembership(db, orgId, userId);
  if (!membership) {
    throw new Error("Organization membership upsert did not produce a row.");
  }
  return membership;
}
