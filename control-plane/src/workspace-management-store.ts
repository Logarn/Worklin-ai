import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  type OrganizationMembershipRow,
  type OrganizationRole,
  ensureOrganizationMembershipSchema,
  getOrganizationMembership,
  getOrCreateOrganizationMembership,
} from "./organization-membership-store.js";

export interface WorkspaceMemberRow extends OrganizationMembershipRow {
  email: string;
  username: string;
  first_name: string;
  last_name: string;
}

export interface AssistantAssignmentRow {
  org_id: string;
  assistant_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

const initializedDatabases = new WeakSet<Database>();

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ensureWorkspaceManagementSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  ensureOrganizationMembershipSchema(db);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      invited_by_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'collaborator')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_invitations_org
      ON workspace_invitations(org_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS assistant_assignments (
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (assistant_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_assignments_user
      ON assistant_assignments(org_id, user_id, assistant_id);
  `);
  initializedDatabases.add(db);
}

export function listWorkspaceMembers(
  db: Database,
  orgId: string,
): WorkspaceMemberRow[] {
  ensureWorkspaceManagementSchema(db);
  return db
    .query<WorkspaceMemberRow, [string]>(
      `SELECT m.*, u.email, u.username, u.first_name, u.last_name
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ?
       ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.email`,
    )
    .all(orgId);
}

export function canManageMembers(role: OrganizationRole | undefined): boolean {
  return role === "admin";
}

export function canManageAssignments(
  role: OrganizationRole | undefined,
): boolean {
  return role === "admin" || role === "manager";
}

export function createWorkspaceInvitation(
  db: Database,
  input: {
    orgId: string;
    invitedByUserId: string;
    email: string;
    role: OrganizationRole;
  },
  now: Date,
): { token: string; id: string; expiresAt: string } {
  ensureWorkspaceManagementSchema(db);
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@"))
    throw new Error("A valid email is required.");
  const token = randomBytes(32).toString("base64url");
  const id = `invite-${randomUUID()}`;
  const expiresAt = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.query(
    `INSERT INTO workspace_invitations (
      id, org_id, invited_by_user_id, email, token_hash, role, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.orgId,
    input.invitedByUserId,
    email,
    hashToken(token),
    input.role,
    expiresAt,
    now.toISOString(),
  );
  return { token, id, expiresAt };
}

export function acceptWorkspaceInvitationForUser(
  db: Database,
  token: string,
  user: { id: string; email: string },
  now: Date,
): OrganizationMembershipRow {
  ensureWorkspaceManagementSchema(db);
  const invitation = db
    .query<
      {
        id: string;
        org_id: string;
        email: string;
        role: OrganizationRole;
        expires_at: string;
        used_at: string | null;
        revoked_at: string | null;
      },
      [string]
    >("SELECT * FROM workspace_invitations WHERE token_hash = ?")
    .get(hashToken(token));
  if (!invitation) throw new Error("Invitation not found.");
  if (invitation.used_at) throw new Error("Invitation has already been used.");
  if (invitation.revoked_at) throw new Error("Invitation has been revoked.");
  if (Date.parse(invitation.expires_at) <= now.getTime()) {
    throw new Error("Invitation has expired.");
  }
  if (normalizeEmail(user.email) !== invitation.email) {
    throw new Error("Invitation email does not match the signed-in account.");
  }
  const timestamp = now.toISOString();
  const membership = getOrCreateOrganizationMembership(
    db,
    invitation.org_id,
    user.id,
    invitation.role,
    () => timestamp,
  );
  const result = db
    .query(
      "UPDATE workspace_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL",
    )
    .run(timestamp, invitation.id);
  if (result.changes === 0)
    throw new Error("Invitation has already been used.");
  return membership;
}

export function setWorkspaceMemberRole(
  db: Database,
  orgId: string,
  userId: string,
  role: OrganizationRole,
  ownerUserId: string,
  nowIso: () => string,
): OrganizationMembershipRow {
  ensureWorkspaceManagementSchema(db);
  if (userId === ownerUserId && role !== "admin") {
    throw new Error("The workspace creator must remain an admin.");
  }
  db.query(
    "UPDATE organization_memberships SET role = ?, status = 'active', updated_at = ? WHERE org_id = ? AND user_id = ?",
  ).run(role, nowIso(), orgId, userId);
  const membership = getOrganizationMembership(db, orgId, userId);
  if (!membership) throw new Error("Workspace member not found.");
  return membership;
}

export function deactivateWorkspaceMember(
  db: Database,
  orgId: string,
  userId: string,
  ownerUserId: string,
  nowIso: () => string,
): void {
  ensureWorkspaceManagementSchema(db);
  if (userId === ownerUserId) {
    throw new Error("The assistant owner cannot be removed.");
  }
  const timestamp = nowIso();
  db.query(
    "UPDATE organization_memberships SET status = 'deactivated', updated_at = ? WHERE org_id = ? AND user_id = ?",
  ).run(timestamp, orgId, userId);
  db.query(
    "DELETE FROM assistant_assignments WHERE org_id = ? AND user_id = ?",
  ).run(orgId, userId);
}

export function assignAssistant(
  db: Database,
  orgId: string,
  assistantId: string,
  userId: string,
  nowIso: () => string,
): AssistantAssignmentRow {
  ensureWorkspaceManagementSchema(db);
  const timestamp = nowIso();
  db.query(
    `INSERT INTO assistant_assignments (org_id, assistant_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(assistant_id, user_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(orgId, assistantId, userId, timestamp, timestamp);
  return {
    org_id: orgId,
    assistant_id: assistantId,
    user_id: userId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function unassignAssistant(
  db: Database,
  orgId: string,
  assistantId: string,
  userId: string,
): void {
  ensureWorkspaceManagementSchema(db);
  db.query(
    "DELETE FROM assistant_assignments WHERE org_id = ? AND assistant_id = ? AND user_id = ?",
  ).run(orgId, assistantId, userId);
}

export function listAssistantAssignments(
  db: Database,
  orgId: string,
): AssistantAssignmentRow[] {
  ensureWorkspaceManagementSchema(db);
  return db
    .query<
      AssistantAssignmentRow,
      [string]
    >("SELECT * FROM assistant_assignments WHERE org_id = ? ORDER BY assistant_id, user_id")
    .all(orgId);
}

export function revokeWorkspaceInvitation(
  db: Database,
  orgId: string,
  invitationId: string,
): boolean {
  ensureWorkspaceManagementSchema(db);
  const result = db
    .query(
      `UPDATE workspace_invitations
       SET revoked_at = COALESCE(revoked_at, datetime('now'))
       WHERE id = ? AND org_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(invitationId, orgId);
  return result.changes > 0;
}

export function listAccessibleAssistantIds(
  db: Database,
  orgId: string,
  userId: string,
  role: OrganizationRole,
): string[] {
  ensureWorkspaceManagementSchema(db);
  if (role === "admin" || role === "manager") {
    return db
      .query<{ id: string }, [string]>(
        "SELECT id FROM assistants WHERE org_id = ? ORDER BY created_at, id",
      )
      .all(orgId)
      .map((row) => row.id);
  }
  return db
    .query<{ assistant_id: string }, [string, string]>(
      `SELECT a.assistant_id
       FROM assistant_assignments a
       JOIN organization_memberships m
         ON m.org_id = a.org_id AND m.user_id = a.user_id AND m.status = 'active'
       WHERE a.org_id = ? AND a.user_id = ?
       ORDER BY a.assistant_id`,
    )
    .all(orgId, userId)
    .map((row) => row.assistant_id);
}
