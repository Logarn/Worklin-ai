import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureAssistantStoreSchema,
  getActiveAssistant,
  getOrCreateAssistant,
  hasAcceptedAssistantConsent,
} from "./assistant-store.js";
import { getOrganizationMembership } from "./organization-membership-store.js";

function setupDb(filename = ":memory:"): Database {
  const db = new Database(filename);
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
      is_default: 1,
    });
    expect(getActiveAssistant(db, "user-1")?.id).toBe(assistant.id);
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM organizations WHERE user_id = 'user-1'")
        .get()?.count,
    ).toBe(1);
    expect(
      getOrganizationMembership(db, assistant.org_id, "user-1")?.role,
    ).toBe("admin");
  });

  test("creates separate default assistants and organizations per user", () => {
    const db = setupDb();

    const first = getOrCreateAssistant(db, "user-1", NOW);
    const second = getOrCreateAssistant(db, "user-2", NOW);

    expect(second.id).not.toBe(first.id);
    expect(second.org_id).not.toBe(first.org_id);
    expect(getActiveAssistant(db, "user-1")?.id).toBe(first.id);
    expect(getActiveAssistant(db, "user-2")?.id).toBe(second.id);
    expect(
      getOrganizationMembership(db, first.org_id, "user-1")?.role,
    ).toBe("admin");
    expect(
      getOrganizationMembership(db, second.org_id, "user-2")?.role,
    ).toBe("admin");
    expect(getOrganizationMembership(db, first.org_id, "user-2")).toBeNull();
    expect(getOrganizationMembership(db, second.org_id, "user-1")).toBeNull();
  });

  test("is idempotent across repeated session bootstrap calls", () => {
    const db = setupDb();

    const first = getOrCreateAssistant(db, "user-1", NOW);
    const second = getOrCreateAssistant(db, "user-1", NOW);

    expect(second.id).toBe(first.id);
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM assistants WHERE user_id = 'user-1'")
        .get()?.count,
    ).toBe(1);
  });

  test("converges repeated bootstrap calls from independent connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "worklin-assistant-store-"));
    const filename = join(directory, "control-plane.sqlite");
    const firstDb = setupDb(filename);
    const secondDb = new Database(filename);

    try {
      const first = getOrCreateAssistant(firstDb, "user-1", NOW);
      const second = getOrCreateAssistant(secondDb, "user-1", NOW);

      expect(second.id).toBe(first.id);
      expect(
        secondDb
          .query<
            { count: number },
            []
          >("SELECT COUNT(*) AS count FROM organizations WHERE user_id = 'user-1' AND is_default = 1")
          .get()?.count,
      ).toBe(1);
      expect(
        secondDb
          .query<
            { count: number },
            []
          >("SELECT COUNT(*) AS count FROM assistants WHERE user_id = 'user-1' AND is_default = 1")
          .get()?.count,
      ).toBe(1);
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
      is_default: 1,
    });
  });

  test("backfills one deterministic default without deleting legacy duplicates", () => {
    const db = setupDb();
    db.exec(`
      INSERT INTO organizations (id, user_id, name, created_at, updated_at) VALUES
        ('org-old', 'user-1', 'Old', '2026-01-01T00:00:00.000Z', '${NOW()}'),
        ('org-new', 'user-1', 'New', '2026-02-01T00:00:00.000Z', '${NOW()}');
      INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version, created_at, updated_at
      ) VALUES
        ('assistant-old', 'user-1', 'org-new', 'Old', NULL, 2, '2026-01-01T00:00:00.000Z', '${NOW()}'),
        ('assistant-new', 'user-1', 'org-old', 'New', NULL, 2, '2026-02-01T00:00:00.000Z', '${NOW()}');
    `);

    ensureAssistantStoreSchema(db);

    expect(getActiveAssistant(db, "user-1")?.id).toBe("assistant-old");
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM organizations WHERE user_id = 'user-1' AND is_default = 1")
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<
          { id: string },
          []
        >("SELECT id FROM organizations WHERE user_id = 'user-1' AND is_default = 1")
        .get()?.id,
    ).toBe("org-new");
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM assistants WHERE user_id = 'user-1'")
        .get()?.count,
    ).toBe(2);
    expect(getOrganizationMembership(db, "org-old", "user-1")?.role).toBe(
      "admin",
    );
    expect(getOrganizationMembership(db, "org-new", "user-1")?.role).toBe(
      "admin",
    );
  });

  test("database constraints reject a second default for the same user", () => {
    const db = setupDb();
    const assistant = getOrCreateAssistant(db, "user-1", NOW);

    expect(() =>
      db
        .query(
          `
        INSERT INTO assistants (
          id, user_id, org_id, name, runtime_stack_id, isolation_version,
          is_default, created_at, updated_at
        ) VALUES (
          'assistant-racing', 'user-1', ?, 'Other', NULL, 2, 1, ?, ?
        )
      `,
        )
        .run(assistant.org_id, NOW(), NOW()),
    ).toThrow();
    expect(() =>
      db
        .query(
          `
        INSERT INTO organizations (
          id, user_id, name, is_default, created_at, updated_at
        ) VALUES (
          'org-racing', 'user-1', 'Other', 1, ?, ?
        )
      `,
        )
        .run(NOW(), NOW()),
    ).toThrow();
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
