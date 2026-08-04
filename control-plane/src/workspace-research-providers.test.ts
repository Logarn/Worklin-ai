import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  deleteWorkspaceResearchProviderCredential,
  ensureWorkspaceResearchProviderSchema,
  getWorkspaceResearchProviderCredential,
  listWorkspaceResearchProviders,
  saveWorkspaceResearchProviderCredential,
} from "./workspace-research-providers.js";

const NOW = () => "2026-07-20T00:00:00.000Z";

describe("workspace research providers", () => {
  test("stores credentials encrypted and exposes only connection metadata", () => {
    const db = new Database(":memory:");
    ensureWorkspaceResearchProviderSchema(db);
    const saved = saveWorkspaceResearchProviderCredential(
      db,
      {
        orgId: "org-1",
        providerId: "trendtrack",
        credential: "trendtrack-secret",
      },
      "a".repeat(64),
      NOW,
    );

    expect(saved).toMatchObject({
      provider_id: "trendtrack",
      credential_status: "stored",
    });
    expect(listWorkspaceResearchProviders(db, "org-1")).toEqual([saved]);
    expect(
      db
        .query<
          { credential_ciphertext: string },
          []
        >("SELECT credential_ciphertext FROM workspace_research_providers")
        .get()?.credential_ciphertext,
    ).not.toContain("trendtrack-secret");
    expect(
      getWorkspaceResearchProviderCredential(
        db,
        "org-1",
        "trendtrack",
        "a".repeat(64),
      ),
    ).toBe("trendtrack-secret");
  });

  test("replaces and disconnects a provider without exposing its secret", () => {
    const db = new Database(":memory:");
    saveWorkspaceResearchProviderCredential(
      db,
      { orgId: "org-1", providerId: "youtube", credential: "first" },
      "b".repeat(64),
      NOW,
    );
    saveWorkspaceResearchProviderCredential(
      db,
      { orgId: "org-1", providerId: "youtube", credential: "second" },
      "b".repeat(64),
      NOW,
    );
    expect(
      getWorkspaceResearchProviderCredential(
        db,
        "org-1",
        "youtube",
        "b".repeat(64),
      ),
    ).toBe("second");
    expect(
      deleteWorkspaceResearchProviderCredential(db, "org-1", "youtube"),
    ).toBe(true);
    expect(listWorkspaceResearchProviders(db, "org-1")).toEqual([]);
  });
});
