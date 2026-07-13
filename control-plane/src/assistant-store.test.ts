import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  getActiveAssistant,
  getOrCreateAssistant,
  hasAcceptedAssistantConsent,
} from "./assistant-store.js";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      runtime_stack_id TEXT,
      isolation_version INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const NOW = () => "2026-07-13T12:00:00.000Z";

describe("default assistant store", () => {
  test("creates one Worklin assistant and organization for a new user", () => {
    const db = setupDb();

    const assistant = getOrCreateAssistant(db, "user-1", NOW);

    expect(assistant).toMatchObject({
      user_id: "user-1",
      name: "Worklin",
      isolation_version: 2,
      runtime_stack_id: null,
    });
    expect(getActiveAssistant(db, "user-1")?.id).toBe(assistant.id);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM organizations WHERE user_id = 'user-1'",
      ).get()?.count,
    ).toBe(1);
  });

  test("is idempotent across repeated session bootstrap calls", () => {
    const db = setupDb();

    const first = getOrCreateAssistant(db, "user-1", NOW);
    const second = getOrCreateAssistant(db, "user-1", NOW);

    expect(second.id).toBe(first.id);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM assistants WHERE user_id = 'user-1'",
      ).get()?.count,
    ).toBe(1);
  });

  test("does not replace an existing assistant during backfill", () => {
    const db = setupDb();
    db.exec(`
      INSERT INTO organizations (id, user_id, name, created_at, updated_at)
      VALUES ('org-existing', 'user-1', 'Existing', '${NOW()}', '${NOW()}');
      INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version, created_at, updated_at
      ) VALUES (
        'assistant-existing', 'user-1', 'org-existing', 'Kim', NULL, 2, '${NOW()}', '${NOW()}'
      );
    `);

    const assistant = getOrCreateAssistant(db, "user-1", NOW);

    expect(assistant).toMatchObject({
      id: "assistant-existing",
      name: "Kim",
    });
  });
});

describe("assistant provisioning consent", () => {
  test("requires terms, privacy, and AI-data consent", () => {
    expect(
      hasAcceptedAssistantConsent(
        JSON.stringify({
          tos_accepted_version: "2026-06-08",
          privacy_policy_accepted_version: "2026-06-08",
          ai_data_sharing_accepted_version: "2026-06-08",
        }),
      ),
    ).toBe(true);
    expect(
      hasAcceptedAssistantConsent(
        JSON.stringify({
          tos_accepted_version: "2026-06-08",
          privacy_policy_accepted_version: "2026-06-08",
          ai_data_sharing_accepted_version: "",
        }),
      ),
    ).toBe(false);
    expect(hasAcceptedAssistantConsent("not-json")).toBe(false);
  });
});
