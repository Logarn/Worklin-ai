import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureOrganizationMembershipSchema } from "./organization-membership-store.js";
import {
  acceptWorkspaceInvitationForUser,
  assignAssistant,
  createWorkspaceInvitation,
  deactivateWorkspaceMember,
  ensureWorkspaceManagementSchema,
  getWorkspaceOrganizationContext,
  listAssistantAssignments,
  listPendingWorkspaceInvitations,
  listWorkspaceOrganizationsForUser,
  revokeWorkspaceInvitation,
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

  test("does not consume an invitation for the wrong signed-in email", () => {
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

    expect(() =>
      acceptWorkspaceInvitationForUser(
        db,
        invite.token,
        { id: "member", email: "someone-else@example.com" },
        now,
      ),
    ).toThrow("does not match");
    expect(listPendingWorkspaceInvitations(db, "org-1", now)).toHaveLength(1);
  });

  test("lists and revokes only pending invitations", () => {
    const db = makeDb();
    const invite = createWorkspaceInvitation(
      db,
      {
        orgId: "org-1",
        invitedByUserId: "owner",
        email: "member@example.com",
        role: "manager",
      },
      now,
    );

    expect(listPendingWorkspaceInvitations(db, "org-1", now)).toEqual([
      expect.objectContaining({
        id: invite.id,
        email: "member@example.com",
        role: "manager",
      }),
    ]);
    expect(revokeWorkspaceInvitation(db, "org-1", invite.id)).toBe(true);
    expect(listPendingWorkspaceInvitations(db, "org-1", now)).toEqual([]);
    expect(() =>
      acceptWorkspaceInvitationForUser(
        db,
        invite.token,
        { id: "member", email: "member@example.com" },
        now,
      ),
    ).toThrow("revoked");
  });

  test("reactivates a returning member with the invited role", () => {
    const db = makeDb();
    db.query(
      "INSERT INTO organization_memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("org-1", "member", "collaborator", "deactivated", nowIso(), nowIso());
    const invite = createWorkspaceInvitation(
      db,
      {
        orgId: "org-1",
        invitedByUserId: "owner",
        email: "member@example.com",
        role: "manager",
      },
      now,
    );

    const membership = acceptWorkspaceInvitationForUser(
      db,
      invite.token,
      { id: "member", email: "member@example.com" },
      now,
    );

    expect(membership.status).toBe("active");
    expect(membership.role).toBe("manager");
  });

  test("selects an invited workspace and honors an explicit workspace choice", () => {
    const db = makeDb();
    db.query("INSERT INTO organizations VALUES (?, ?, ?, ?, ?)").run(
      "org-member",
      "member",
      "Member workspace",
      nowIso(),
      nowIso(),
    );
    db.query(
      "INSERT INTO organization_memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("org-member", "member", "admin", "active", nowIso(), nowIso());
    db.query(
      "INSERT INTO organization_memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("org-1", "member", "manager", "active", nowIso(), nowIso());

    expect(
      listWorkspaceOrganizationsForUser(db, "member").map(
        (organization) => organization.id,
      ),
    ).toEqual(["org-1", "org-member"]);
    expect(getWorkspaceOrganizationContext(db, "member")?.organization.id).toBe(
      "org-1",
    );
    expect(
      getWorkspaceOrganizationContext(db, "member", "org-member")?.organization
        .id,
    ).toBe("org-member");
    expect(
      getWorkspaceOrganizationContext(db, "member", "org-unrelated"),
    ).toBeNull();
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
