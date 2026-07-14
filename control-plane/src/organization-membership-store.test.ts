import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  getOrCreateOrganizationMembership,
  getOrganizationMembership,
} from "./organization-membership-store.js";

const NOW = () => "2026-07-13T12:00:00.000Z";

describe("organization membership store", () => {
  test("creates one membership and preserves its existing role", () => {
    const db = new Database(":memory:");

    const created = getOrCreateOrganizationMembership(
      db,
      "org-1",
      "user-1",
      "admin",
      NOW,
    );
    const repeated = getOrCreateOrganizationMembership(
      db,
      "org-1",
      "user-1",
      "collaborator",
      NOW,
    );

    expect(created.role).toBe("admin");
    expect(repeated.role).toBe("admin");
    expect(getOrganizationMembership(db, "org-1", "user-1")?.role).toBe(
      "admin",
    );
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM organization_memberships")
        .get()?.count,
    ).toBe(1);
  });

  test("enforces the supported role set at the database boundary", () => {
    const db = new Database(":memory:");
    getOrCreateOrganizationMembership(db, "org-1", "user-1", "manager", NOW);

    expect(() =>
      db
        .query(
          `
        INSERT INTO organization_memberships (
          org_id, user_id, role, created_at, updated_at
        ) VALUES ('org-1', 'user-2', 'owner', '${NOW()}', '${NOW()}')
      `,
        )
        .run(),
    ).toThrow();
  });
});
