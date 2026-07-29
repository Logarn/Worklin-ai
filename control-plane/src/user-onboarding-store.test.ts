import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  ensureUserOnboardingSchema,
  markUserOnboardingCompleted,
} from "./user-onboarding-store.js";

function createDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      consent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE runtime_stacks (
      assistant_id TEXT NOT NULL,
      gateway_url TEXT,
      service_ref TEXT,
      service_create_attempted_at INTEGER
    );
  `);
  return db;
}

describe("user onboarding store", () => {
  test("does not infer onboarding completion from legal consent or runtime attempts", () => {
    const db = createDatabase();
    db.query(
      `INSERT INTO users (id, consent_json, created_at, updated_at)
       VALUES
         ('new-user', NULL, '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z'),
         ('accepted-user', '{"tos_accepted_version":"2026-06-08"}', '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z'),
         ('active-user', NULL, '2026-07-01T10:00:00.000Z', '2026-07-01T12:00:00.000Z')`,
    ).run();
    db.query(
      "INSERT INTO assistants (id, user_id) VALUES ('assistant-active', 'active-user')",
    ).run();
    db.query(
      `INSERT INTO runtime_stacks (
        assistant_id, gateway_url, service_ref, service_create_attempted_at
      ) VALUES ('assistant-active', NULL, 'service-active', NULL)`,
    ).run();

    ensureUserOnboardingSchema(db, () => "2026-07-28T12:00:00.000Z");

    const rows = db
      .query<
        { id: string; onboarding_completed_at: string | null },
        []
      >("SELECT id, onboarding_completed_at FROM users ORDER BY id")
      .all();
    expect(rows).toEqual([
      {
        id: "accepted-user",
        onboarding_completed_at: null,
      },
      {
        id: "active-user",
        onboarding_completed_at: null,
      },
      { id: "new-user", onboarding_completed_at: null },
    ]);
  });

  test("completion is monotonic and keeps the first completion time", () => {
    const db = createDatabase();
    db.query(
      `INSERT INTO users (id, consent_json, created_at, updated_at)
       VALUES ('user-1', NULL, '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z')`,
    ).run();
    ensureUserOnboardingSchema(db, () => "2026-07-28T12:00:00.000Z");

    expect(
      markUserOnboardingCompleted(
        db,
        "user-1",
        () => "2026-07-28T12:30:00.000Z",
      ),
    ).toBe("2026-07-28T12:30:00.000Z");
    expect(
      markUserOnboardingCompleted(
        db,
        "user-1",
        () => "2026-07-28T13:00:00.000Z",
      ),
    ).toBe("2026-07-28T12:30:00.000Z");
  });
});
