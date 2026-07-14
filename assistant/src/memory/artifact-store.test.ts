import { beforeEach, describe, expect, test } from "bun:test";

import { saveDocument } from "../documents/document-store.js";
import {
  getArtifact,
  listArtifacts,
  listBrandArtifactSummaries,
  updateArtifact,
} from "./artifact-store.js";
import { createCopybook } from "./copybook-store.js";
import { getDb } from "./db-connection.js";
import { initializeDb } from "./db-init.js";
import { rawRun } from "./raw-query.js";
import { conversations, retentionBrands } from "./schema.js";

initializeDb();

beforeEach(() => {
  rawRun("DELETE FROM artifacts");
  rawRun("DELETE FROM retention_copybook_campaigns");
  rawRun("DELETE FROM retention_copybook_months");
  rawRun("DELETE FROM retention_copybooks");
  rawRun("DELETE FROM document_conversations");
  rawRun("DELETE FROM documents");
  rawRun("DELETE FROM retention_conversation_brand_scopes");
  rawRun("DELETE FROM retention_brands");
  rawRun("DELETE FROM conversations");
  const now = Date.now();
  getDb()
    .insert(retentionBrands)
    .values({
      id: "brand-1",
      name: "Example Brand",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getDb()
    .insert(conversations)
    .values({
      id: "conversation-1",
      title: "Campaign planning",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  rawRun(
    "INSERT INTO retention_conversation_brand_scopes (conversation_id, brand_id, updated_at) VALUES (?, ?, ?)",
    "conversation-1",
    "brand-1",
    now,
  );
});

describe("artifact store", () => {
  test("registers canonical copybooks and documents", () => {
    const copybook = createCopybook({ brandId: "brand-1", year: 2026 });
    expect(
      saveDocument({
        surfaceId: "document-1",
        conversationId: "conversation-1",
        title: "Campaign notes",
        content: "Notes",
        wordCount: 1,
      }).success,
    ).toBe(true);

    expect(
      listArtifacts({ brandId: "brand-1" }).map((item) => item.id),
    ).toEqual(["document:document-1", `copybook:${copybook.id}`]);
    expect(getArtifact(`copybook:${copybook.id}`).title).toContain(
      "2026 Copybook",
    );
  });

  test("filters, reassigns, favorites, and archives without changing the source", () => {
    saveDocument({
      surfaceId: "document-1",
      conversationId: "conversation-1",
      title: "Welcome campaign",
      content: "Hello",
      wordCount: 1,
    });

    const updated = updateArtifact("document:document-1", {
      brandId: null,
      artifactType: "social",
      favorite: true,
      archived: true,
      metadata: { channel: "instagram" },
    });
    expect(updated).toMatchObject({
      brandId: null,
      artifactType: "social",
      favorite: true,
      archived: true,
      metadata: { channel: "instagram" },
    });
    expect(
      listArtifacts({
        brandId: null,
        artifactType: "social",
        search: "welcome",
        status: "archived",
        favorite: true,
      }),
    ).toHaveLength(1);
    expect(getArtifact("document:document-1").sourceExists).toBe(true);
  });

  test("returns brand counts and an explicit unassigned count", () => {
    createCopybook({ brandId: "brand-1", year: 2026 });
    rawRun(
      `INSERT INTO artifacts
        (id, resource_type, resource_id, artifact_type, created_at, updated_at)
       VALUES ('future:1', 'future', '1', 'unknown', 1, 1)`,
    );
    const summary = listBrandArtifactSummaries();
    expect(summary.brands).toEqual([
      expect.objectContaining({ id: "brand-1", artifactCount: 1 }),
    ]);
    expect(summary.unassignedArtifactCount).toBe(1);
  });
});
