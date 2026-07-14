import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { createArtifactRegistry } from "./293-artifact-registry.js";

function testDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE retention_brands (id TEXT PRIMARY KEY);
    CREATE TABLE retention_conversation_brand_scopes (
      conversation_id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id)
    );
    CREATE TABLE retention_copybooks (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES retention_brands(id),
      year INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE retention_copybook_months (
      id TEXT PRIMARY KEY,
      document_surface_id TEXT
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("migration 293: artifact registry", () => {
  test("creates and backfills the registry idempotently", () => {
    const { sqlite, db } = testDatabase();
    sqlite.exec(/*sql*/ `
      INSERT INTO retention_brands (id) VALUES ('brand-1');
      INSERT INTO retention_conversation_brand_scopes (conversation_id, brand_id)
        VALUES ('conversation-1', 'brand-1');
      INSERT INTO retention_copybooks (id, brand_id, year, created_at, updated_at)
        VALUES ('copybook-1', 'brand-1', 2026, 10, 20);
      INSERT INTO documents (surface_id, conversation_id, created_at, updated_at)
        VALUES ('document-1', 'conversation-1', 11, 21),
               ('document-2', 'conversation-2', 12, 22),
               ('month-document', 'conversation-1', 13, 23);
      INSERT INTO retention_copybook_months (id, document_surface_id)
        VALUES ('month-1', 'month-document');
    `);

    createArtifactRegistry(db);
    expect(() => createArtifactRegistry(db)).not.toThrow();

    const rows = sqlite
      .query(
        "SELECT id, brand_id AS brandId, resource_type AS resourceType FROM artifacts ORDER BY id",
      )
      .all() as Array<{
      id: string;
      brandId: string | null;
      resourceType: string;
    }>;
    expect(rows).toEqual([
      {
        id: "copybook:copybook-1",
        brandId: "brand-1",
        resourceType: "copybook",
      },
      {
        id: "document:document-1",
        brandId: "brand-1",
        resourceType: "document",
      },
      { id: "document:document-2", brandId: null, resourceType: "document" },
    ]);
  });

  test("enforces one artifact per canonical resource", () => {
    const { sqlite, db } = testDatabase();
    createArtifactRegistry(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO artifacts
        (id, resource_type, resource_id, artifact_type, created_at, updated_at)
      VALUES ('artifact-1', 'document', 'document-1', 'document', 1, 1);
    `);
    expect(() =>
      sqlite.exec(/*sql*/ `
        INSERT INTO artifacts
          (id, resource_type, resource_id, artifact_type, created_at, updated_at)
        VALUES ('artifact-2', 'document', 'document-1', 'document', 1, 1)
      `),
    ).toThrow();
  });
});
