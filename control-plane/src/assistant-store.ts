import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  ensureOrganizationMembershipSchema,
  getOrCreateOrganizationMembership,
} from "./organization-membership-store.js";

export interface OrganizationRow {
  id: string;
  user_id: string;
  name: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface AssistantRow {
  id: string;
  user_id: string;
  org_id: string;
  name: string;
  runtime_stack_id: string | null;
  isolation_version: number;
  admin_access_consented: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const initializedDatabases = new WeakSet<Database>();

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((row) => row.name));
}

function addDefaultMarkerIfMissing(db: Database, table: string): void {
  if (tableColumns(db, table).has("is_default")) return;
  db.exec(`
    ALTER TABLE ${table}
      ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0
      CHECK(is_default IN (0, 1))
  `);
}

function addAdminAccessConsentIfMissing(db: Database): void {
  if (tableColumns(db, "assistants").has("admin_access_consented")) return;
  db.exec(`
    ALTER TABLE assistants
      ADD COLUMN admin_access_consented INTEGER NOT NULL DEFAULT 0
      CHECK(admin_access_consented IN (0, 1))
  `);
}

export function ensureAssistantStoreSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;

  db.exec("PRAGMA busy_timeout = 5000;");
  ensureOrganizationMembershipSchema(db);

  const migrate = db.transaction(() => {
    addDefaultMarkerIfMissing(db, "organizations");
    addDefaultMarkerIfMissing(db, "assistants");
    addAdminAccessConsentIfMissing(db);

    // Preserve an existing default where possible, otherwise choose the oldest
    // legacy row deterministically before adding the uniqueness constraints.
    db.exec(`
      UPDATE assistants
      SET is_default = CASE WHEN id = (
        SELECT candidate.id
        FROM assistants AS candidate
        WHERE candidate.user_id = assistants.user_id
        ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id
        LIMIT 1
      ) THEN 1 ELSE 0 END;

      WITH organization_defaults AS (
        SELECT
          owner.user_id,
          COALESCE(
            (
              SELECT selected.org_id
              FROM assistants AS selected
              JOIN organizations AS selected_organization
                ON selected_organization.id = selected.org_id
               AND selected_organization.user_id = selected.user_id
              WHERE selected.user_id = owner.user_id
                AND selected.is_default = 1
              LIMIT 1
            ),
            (
              SELECT candidate.id
              FROM organizations AS candidate
              WHERE candidate.user_id = owner.user_id
              ORDER BY
                candidate.is_default DESC,
                candidate.created_at,
                candidate.id
              LIMIT 1
            )
          ) AS organization_id
        FROM (SELECT DISTINCT user_id FROM organizations) AS owner
      )
      UPDATE organizations
      SET is_default = CASE WHEN id = (
        SELECT organization_id
        FROM organization_defaults
        WHERE organization_defaults.user_id = organizations.user_id
      ) THEN 1 ELSE 0 END;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_default_per_user
        ON organizations(user_id) WHERE is_default = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_assistants_default_per_user
        ON assistants(user_id) WHERE is_default = 1;

      INSERT INTO organization_memberships (
        org_id,
        user_id,
        role,
        created_at,
        updated_at
      )
      SELECT id, user_id, 'admin', created_at, updated_at
      FROM organizations
      WHERE 1
      ON CONFLICT(org_id, user_id) DO NOTHING;
    `);
  });
  migrate.immediate();
  initializedDatabases.add(db);
}

export function hasAcceptedAssistantConsent(
  consentJson: string | null,
): boolean {
  if (!consentJson) return false;
  try {
    const consent = JSON.parse(consentJson) as Record<string, unknown>;
    return (
      typeof consent.tos_accepted_version === "string" &&
      consent.tos_accepted_version.length > 0 &&
      typeof consent.privacy_policy_accepted_version === "string" &&
      consent.privacy_policy_accepted_version.length > 0 &&
      typeof consent.ai_data_sharing_accepted_version === "string" &&
      consent.ai_data_sharing_accepted_version.length > 0
    );
  } catch {
    return false;
  }
}

export function getOrCreateOrganization(
  db: Database,
  userId: string,
  nowIso: () => string,
): OrganizationRow {
  ensureAssistantStoreSchema(db);

  const upsertDefault = db.transaction(() => {
    const timestamp = nowIso();
    db.query(
      `
      INSERT INTO organizations (
        id,
        user_id,
        name,
        is_default,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id) WHERE is_default = 1 DO NOTHING
    `,
    ).run(randomUUID(), userId, "Worklin Workspace", timestamp, timestamp);

    const organization = db
      .query<
        OrganizationRow,
        [string]
      >("SELECT * FROM organizations WHERE user_id = ? AND is_default = 1")
      .get(userId);
    if (!organization) {
      throw new Error("Default organization upsert did not produce a row.");
    }

    getOrCreateOrganizationMembership(
      db,
      organization.id,
      userId,
      "admin",
      nowIso,
    );
    return organization;
  });
  return upsertDefault.immediate();
}

export function getActiveAssistant(
  db: Database,
  userId: string,
): AssistantRow | null {
  ensureAssistantStoreSchema(db);
  return db
    .query<
      AssistantRow,
      [string]
    >("SELECT * FROM assistants WHERE user_id = ? AND is_default = 1")
    .get(userId);
}

export function getAssistantAdminAccessConsent(
  db: Database,
  assistantId: string,
  organizationId: string,
): boolean | null {
  ensureAssistantStoreSchema(db);
  const row = db
    .query<{ admin_access_consented: number }, [string, string]>(
      `SELECT admin_access_consented
       FROM assistants
       WHERE id = ?
         AND org_id = ?`,
    )
    .get(assistantId, organizationId);
  return row ? row.admin_access_consented === 1 : null;
}

export function setAssistantAdminAccessConsent(
  db: Database,
  assistantId: string,
  organizationId: string,
  accessConsented: boolean,
  nowIso: () => string,
): boolean | null {
  ensureAssistantStoreSchema(db);
  db.query(
    `UPDATE assistants
     SET admin_access_consented = ?, updated_at = ?
     WHERE id = ?
       AND org_id = ?`,
  ).run(accessConsented ? 1 : 0, nowIso(), assistantId, organizationId);
  return getAssistantAdminAccessConsent(db, assistantId, organizationId);
}

export function getOrCreateAssistant(
  db: Database,
  userId: string,
  nowIso: () => string,
): AssistantRow {
  ensureAssistantStoreSchema(db);
  const organization = getOrCreateOrganization(db, userId, nowIso);

  const upsertDefault = db.transaction(() => {
    const timestamp = nowIso();
    db.query(
      `
      INSERT INTO assistants (
        id,
        user_id,
        org_id,
        name,
        runtime_stack_id,
        isolation_version,
        is_default,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id) WHERE is_default = 1 DO NOTHING
    `,
    ).run(
      `worklin-${randomUUID()}`,
      userId,
      organization.id,
      "Worklin",
      null,
      2,
      timestamp,
      timestamp,
    );

    const assistant = getActiveAssistant(db, userId);
    if (!assistant) {
      throw new Error("Default assistant upsert did not produce a row.");
    }
    return assistant;
  });
  return upsertDefault.immediate();
}
