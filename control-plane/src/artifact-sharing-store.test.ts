import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  acceptArtifactInvitation,
  createArtifactInvitation,
  ensureArtifactSharingSchema,
  getActiveInvitationByTokenHash,
  normalizeInviteEmail,
} from "./artifact-sharing-store.js";

const NOW = "2026-07-14T12:00:00.000Z";

function setupDb(): Database {
  const db = new Database(":memory:");
  ensureArtifactSharingSchema(db);
  return db;
}

describe("artifact sharing store", () => {
  test("normalizes recipient email before persisting an invitation", () => {
    const db = setupDb();
    const invitation = createArtifactInvitation(db, {
      assistant_id: "assistant-123",
      artifact_id: "copybook:copybook-123",
      email_normalized: normalizeInviteEmail(" User@Example.com "),
      role: "commenter",
      token_hash: "hash-123",
      expires_at: 2_000,
      created_by_user_id: "owner-123",
      created_at: NOW,
    });

    expect(invitation.email_normalized).toBe("user@example.com");
    expect(getActiveInvitationByTokenHash(db, "hash-123", 1_000)?.id).toBe(
      invitation.id,
    );
    expect(getActiveInvitationByTokenHash(db, "hash-123", 2_000)).toBeNull();
  });

  test("acceptance creates a scoped grant and consumes the invitation", () => {
    const db = setupDb();
    const invitation = createArtifactInvitation(db, {
      assistant_id: "assistant-123",
      artifact_id: "copybook:copybook-123",
      email_normalized: "user@example.com",
      role: "editor",
      token_hash: "hash-123",
      expires_at: 2_000,
      created_by_user_id: "owner-123",
      created_at: NOW,
    });

    const grant = acceptArtifactInvitation(
      db,
      invitation,
      "recipient-123",
      "2026-07-14T12:05:00.000Z",
    );

    expect(grant).toMatchObject({
      assistant_id: "assistant-123",
      artifact_id: "copybook:copybook-123",
      recipient_user_id: "recipient-123",
      role: "editor",
      revoked_at: null,
    });
    expect(getActiveInvitationByTokenHash(db, "hash-123", 1_000)).toBeNull();
  });
});
