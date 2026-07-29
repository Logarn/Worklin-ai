import type { Database } from "bun:sqlite";

export interface UserOnboardingRow {
  onboarding_completed_at: string | null;
}

function userColumns(db: Database): Set<string> {
  const rows = db.query<{ name: string }, []>("PRAGMA table_info(users)").all();
  return new Set(rows.map((row) => row.name));
}

export function ensureUserOnboardingSchema(
  db: Database,
  _nowIso: () => string,
): void {
  if (!userColumns(db).has("onboarding_completed_at")) {
    db.exec("ALTER TABLE users ADD COLUMN onboarding_completed_at TEXT");
  }
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
      .query<
        UserOnboardingRow,
        [string]
      >("SELECT onboarding_completed_at FROM users WHERE id = ?")
      .get(userId)?.onboarding_completed_at ?? completedAt
  );
}
