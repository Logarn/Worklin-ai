import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const COLLABORATION_ROLES = [
  "viewer",
  "commenter",
  "editor",
  "owner",
] as const;

export type CollaborationRole = (typeof COLLABORATION_ROLES)[number];

export interface ArtifactInvitationRow {
  id: string;
  assistant_id: string;
  artifact_id: string;
  email_normalized: string;
  role: CollaborationRole;
  token_hash: string;
  expires_at: number;
  created_by_user_id: string;
  accepted_by_user_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ArtifactGrantRow {
  id: string;
  assistant_id: string;
  artifact_id: string;
  recipient_user_id: string;
  role: CollaborationRole;
  created_by_user_id: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function isCollaborationRole(
  value: unknown,
): value is CollaborationRole {
  return (
    typeof value === "string" &&
    (COLLABORATION_ROLES as readonly string[]).includes(value)
  );
}

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function ensureArtifactSharingSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_invitations (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      email_normalized TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'owner')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_by_user_id TEXT NOT NULL,
      accepted_by_user_id TEXT,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_invitations_email
      ON artifact_invitations(email_normalized, expires_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_invitations_artifact
      ON artifact_invitations(assistant_id, artifact_id);

    CREATE TABLE IF NOT EXISTS artifact_grants (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'owner')),
      created_by_user_id TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(assistant_id, artifact_id, recipient_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_grants_recipient
      ON artifact_grants(recipient_user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_grants_artifact
      ON artifact_grants(assistant_id, artifact_id, revoked_at);
  `);
}

export function createArtifactInvitation(
  db: Database,
  input: Omit<
    ArtifactInvitationRow,
    "id" | "accepted_by_user_id" | "accepted_at" | "revoked_at"
  >,
): ArtifactInvitationRow {
  const invitation: ArtifactInvitationRow = {
    id: randomUUID(),
    ...input,
    accepted_by_user_id: null,
    accepted_at: null,
    revoked_at: null,
  };
  db.query(
    `
    INSERT INTO artifact_invitations (
      id, assistant_id, artifact_id, email_normalized, role, token_hash,
      expires_at, created_by_user_id, accepted_by_user_id, accepted_at,
      revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    invitation.id,
    invitation.assistant_id,
    invitation.artifact_id,
    invitation.email_normalized,
    invitation.role,
    invitation.token_hash,
    invitation.expires_at,
    invitation.created_by_user_id,
    null,
    null,
    null,
    invitation.created_at,
  );
  return invitation;
}

export function getActiveInvitationByTokenHash(
  db: Database,
  tokenHash: string,
  nowSeconds: number,
): ArtifactInvitationRow | null {
  return (
    db
      .query<ArtifactInvitationRow, [string, number]>(
        `
    SELECT * FROM artifact_invitations
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND accepted_at IS NULL
      AND expires_at > ?
  `,
      )
      .get(tokenHash, nowSeconds) ?? null
  );
}

export function acceptArtifactInvitation(
  db: Database,
  invitation: ArtifactInvitationRow,
  recipientUserId: string,
  acceptedAt: string,
): ArtifactGrantRow {
  const existing = db
    .query<ArtifactGrantRow, [string, string, string]>(
      `
    SELECT * FROM artifact_grants
    WHERE assistant_id = ? AND artifact_id = ? AND recipient_user_id = ?
  `,
    )
    .get(invitation.assistant_id, invitation.artifact_id, recipientUserId);
  const grant: ArtifactGrantRow = existing ?? {
    id: randomUUID(),
    assistant_id: invitation.assistant_id,
    artifact_id: invitation.artifact_id,
    recipient_user_id: recipientUserId,
    role: invitation.role,
    created_by_user_id: invitation.created_by_user_id,
    revoked_at: null,
    created_at: acceptedAt,
    updated_at: acceptedAt,
  };

  const accept = db.transaction(() => {
    if (existing) {
      db.query(
        `
        UPDATE artifact_grants
        SET role = ?, revoked_at = NULL, updated_at = ?
        WHERE id = ?
      `,
      ).run(invitation.role, acceptedAt, existing.id);
    } else {
      db.query(
        `
        INSERT INTO artifact_grants (
          id, assistant_id, artifact_id, recipient_user_id, role,
          created_by_user_id, revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        grant.id,
        grant.assistant_id,
        grant.artifact_id,
        grant.recipient_user_id,
        grant.role,
        grant.created_by_user_id,
        null,
        grant.created_at,
        acceptedAt,
      );
    }
    db.query(
      `
      UPDATE artifact_invitations
      SET accepted_by_user_id = ?, accepted_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
    `,
    ).run(recipientUserId, acceptedAt, invitation.id);
  });
  accept();
  return {
    ...grant,
    role: invitation.role,
    revoked_at: null,
    updated_at: acceptedAt,
  };
}

export function listActiveArtifactGrantsForRecipient(
  db: Database,
  recipientUserId: string,
): ArtifactGrantRow[] {
  return db
    .query<ArtifactGrantRow, [string]>(
      `
    SELECT * FROM artifact_grants
    WHERE recipient_user_id = ? AND revoked_at IS NULL
    ORDER BY updated_at DESC
  `,
    )
    .all(recipientUserId);
}

export function getActiveArtifactGrantForRecipient(
  db: Database,
  recipientUserId: string,
  artifactId: string,
): ArtifactGrantRow | null {
  return (
    db
      .query<ArtifactGrantRow, [string, string]>(
        `
    SELECT * FROM artifact_grants
    WHERE recipient_user_id = ? AND artifact_id = ? AND revoked_at IS NULL
    LIMIT 1
  `,
      )
      .get(recipientUserId, artifactId) ?? null
  );
}
