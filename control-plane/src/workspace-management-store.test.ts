import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureOrganizationMembershipSchema } from "./organization-membership-store.js";
import {
  acceptWorkspaceInvitationForUser,
  assignAssistant,
  createWorkspaceInvitation,
  deactivateWorkspaceMember,
  ensureWorkspaceManagementSchema,
  listAssistantAssignments,
  setWorkspaceMemberRole,
} from "./workspace-management-store.js";

const now = new Date("2026-07-20T00:00:00.000Z");
const nowIso = () => now.toISOString();

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureOrganizationMembershipSchema(db);
  ensureWorkspaceManagementSchema(db);
  db.query("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
    "owner",
    "owner@example.com",
    "Owner",
    "",
    "",
  );
  db.query("INSERT INTO users VALUES (?, ?, ?, ?, ?)").run(
    "member",
    "member@example.com",
    "Member",
    "",
    "",
  );
  db.query("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
    "org-1",
    "owner",
    "Worklin Workspace",
    nowIso(),
    nowIso(),
  );
  db.query(
    "INSERT INTO organization_memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("org-1", "owner", "admin", "active", nowIso(), nowIso());
  db.query("INSERT INTO assistants VALUES (?, ?, ?, ?, ?)").run(
    "assistant-1",
    "org-1",
    "owner",
    "Worklin",
    nowIso(),
  );
  return db;
}

describe("workspace management", () => {
  test("invites the exact email once and prevents reuse", () => {
    const db = makeDb();
    const invite = createWorkspaceInvitation(
      db,
      {
        orgId: "org-1",
        invitedByUserId: "owner",
        email: "member@example.com",
        role: "collaborator",
      },
      now,
    );

    const membership = acceptWorkspaceInvitationForUser(
      db,
      invite.token,
      { id: "member", email: "member@example.com" },
      now,
    );
    expect(membership.role).toBe("collaborator");
    expect(() =>
      acceptWorkspaceInvitationForUser(
        db,
        invite.token,
        { id: "member", email: "member@example.com" },
        now,
      ),
    ).toThrow("already been used");
  });

  test("keeps the creator an admin and cannot deactivate the owner", () => {
    const db = makeDb();
    expect(() =>
      setWorkspaceMemberRole(db, "org-1", "owner", "manager", "owner", nowIso),
    ).toThrow("must remain an admin");
    expect(() =>
      deactivateWorkspaceMember(db, "org-1", "owner", "owner", nowIso),
    ).toThrow("cannot be removed");
  });

  test("assignment is idempotent and can be removed", () => {
    const db = makeDb();
    assignAssistant(db, "org-1", "assistant-1", "owner", nowIso);
    assignAssistant(db, "org-1", "assistant-1", "owner", nowIso);
    expect(listAssistantAssignments(db, "org-1")).toHaveLength(1);
  });
});
