import type { Database } from "bun:sqlite";

import { hasAcceptedAssistantConsent } from "./assistant-store.js";

export interface UserOnboardingRow {
  onboarding_completed_at: string | null;
}

function userColumns(db: Database): Set<string> {
  const rows = db
    .query<{ name: string }, []>("PRAGMA table_info(users)")
    .all();
  return new Set(rows.map((row) => row.name));
}

export function ensureUserOnboardingSchema(
  db: Database,
  nowIso: () => string,
): void {
  if (!userColumns(db).has("onboarding_completed_at")) {
    db.exec("ALTER TABLE users ADD COLUMN onboarding_completed_at TEXT");
  }

  const acceptedUsers = db
    .query<
      { id: string; consent_json: string | null; updated_at: string },
      []
    >(
      `SELECT id, consent_json, updated_at
       FROM users
       WHERE onboarding_completed_at IS NULL
         AND consent_json IS NOT NULL`,
    )
    .all();
  const markCompleted = db.query(
    `UPDATE users
     SET onboarding_completed_at = ?
     WHERE id = ? AND onboarding_completed_at IS NULL`,
  );
  for (const user of acceptedUsers) {
    if (hasAcceptedAssistantConsent(user.consent_json)) {
      markCompleted.run(user.updated_at || nowIso(), user.id);
    }
  }

  db.query(
    `UPDATE users
     SET onboarding_completed_at = COALESCE(updated_at, ?)
     WHERE onboarding_completed_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM assistants
         JOIN runtime_stacks
           ON runtime_stacks.assistant_id = assistants.id
         WHERE assistants.user_id = users.id
           AND (
             runtime_stacks.gateway_url IS NOT NULL
             OR runtime_stacks.service_ref IS NOT NULL
             OR runtime_stacks.service_create_attempted_at IS NOT NULL
           )
       )`,
  ).run(nowIso());
}

export function markUserOnboardingCompleted(
  db: Database,
  userId: string,
  nowIso: () => string,
): string {
  const completedAt = nowIso();
  db.query(
    `UPDATE users
     SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(completedAt, completedAt, userId);
  return (
    db
      .query<UserOnboardingRow, [string]>(
        "SELECT onboarding_completed_at FROM users WHERE id = ?",
      )
      .get(userId)?.onboarding_completed_at ?? completedAt
  );
}
