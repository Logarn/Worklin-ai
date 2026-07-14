import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { rawAll, rawGet, rawRun } from "./raw-query.js";
import { artifacts, retentionBrands } from "./schema.js";

export type ArtifactStatus = "active" | "archived";

export class ArtifactStoreError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_brand",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

interface ArtifactRow {
  id: string;
  brandId: string | null;
  resourceType: string;
  resourceId: string;
  artifactType: string;
  parentArtifactId: string | null;
  projectId: string | null;
  metadataJson: string | null;
  isFavorite: number;
  isArchived: number;
  createdAt: number;
  updatedAt: number;
  title: string;
  sourceExists: number;
  childCount: number;
}

export interface ArtifactRecord {
  id: string;
  brandId: string | null;
  resourceType: string;
  resourceId: string;
  artifactType: string;
  parentArtifactId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown> | null;
  favorite: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  title: string;
  sourceExists: boolean;
  childCount: number;
}

export interface BrandArtifactSummary {
  id: string;
  name: string;
  artifactCount: number;
  updatedAt: number;
}

const artifactSelect = /*sql*/ `
  SELECT
    artifact.id,
    artifact.brand_id AS brandId,
    artifact.resource_type AS resourceType,
    artifact.resource_id AS resourceId,
    artifact.artifact_type AS artifactType,
    artifact.parent_artifact_id AS parentArtifactId,
    artifact.project_id AS projectId,
    artifact.metadata_json AS metadataJson,
    artifact.is_favorite AS isFavorite,
    artifact.is_archived AS isArchived,
    artifact.created_at AS createdAt,
    artifact.updated_at AS updatedAt,
    COALESCE(
      copybook.title,
      document.title,
      CASE WHEN json_valid(artifact.metadata_json)
        THEN json_extract(artifact.metadata_json, '$.title')
      END,
      'Untitled artifact'
    ) AS title,
    CASE
      WHEN artifact.resource_type = 'copybook' THEN copybook.id IS NOT NULL
      WHEN artifact.resource_type = 'document' THEN document.surface_id IS NOT NULL
      ELSE 1
    END AS sourceExists,
    CASE
      WHEN artifact.resource_type = 'copybook' THEN (
        SELECT COUNT(*)
        FROM retention_copybook_months AS month
        WHERE month.copybook_id = artifact.resource_id
      )
      ELSE 0
    END AS childCount
  FROM artifacts AS artifact
  LEFT JOIN retention_copybooks AS copybook
    ON artifact.resource_type = 'copybook'
    AND copybook.id = artifact.resource_id
  LEFT JOIN documents AS document
    ON artifact.resource_type = 'document'
    AND document.surface_id = artifact.resource_id
`;

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    brandId: row.brandId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    artifactType: row.artifactType,
    parentArtifactId: row.parentArtifactId,
    projectId: row.projectId,
    metadata: parseMetadata(row.metadataJson),
    favorite: Boolean(row.isFavorite),
    archived: Boolean(row.isArchived),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title: row.title,
    sourceExists: Boolean(row.sourceExists),
    childCount: row.childCount,
  };
}

export function listBrandArtifactSummaries(): {
  brands: BrandArtifactSummary[];
  unassignedArtifactCount: number;
} {
  const brands = rawAll<{
    id: string;
    name: string;
    artifactCount: number;
    updatedAt: number;
  }>(/*sql*/ `
    SELECT
      brand.id,
      brand.name,
      COUNT(artifact.id) AS artifactCount,
      MAX(COALESCE(artifact.updated_at, brand.updated_at)) AS updatedAt
    FROM retention_brands AS brand
    LEFT JOIN artifacts AS artifact
      ON artifact.brand_id = brand.id AND artifact.is_archived = 0
    GROUP BY brand.id, brand.name
    ORDER BY MAX(COALESCE(artifact.updated_at, brand.updated_at)) DESC, brand.name
  `);
  const unassigned = rawGet<{ artifactCount: number }>(/*sql*/ `
    SELECT COUNT(*) AS artifactCount
    FROM artifacts
    WHERE brand_id IS NULL AND is_archived = 0
  `);
  return {
    brands,
    unassignedArtifactCount: unassigned?.artifactCount ?? 0,
  };
}

export function listArtifacts(
  filters: {
    brandId?: string | null;
    artifactType?: string;
    search?: string;
    status?: ArtifactStatus;
    favorite?: boolean;
  } = {},
): ArtifactRecord[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filters.brandId === null) {
    conditions.push("artifact.brand_id IS NULL");
  } else if (filters.brandId) {
    conditions.push("artifact.brand_id = ?");
    params.push(filters.brandId);
  }
  if (filters.artifactType) {
    conditions.push("artifact.artifact_type = ?");
    params.push(filters.artifactType);
  }
  if (filters.search) {
    conditions.push(/*sql*/ `LOWER(COALESCE(
      copybook.title,
      document.title,
      CASE WHEN json_valid(artifact.metadata_json)
        THEN json_extract(artifact.metadata_json, '$.title')
      END,
      ''
    )) LIKE ?`);
    params.push(`%${filters.search.toLowerCase()}%`);
  }
  if (filters.status) {
    conditions.push("artifact.is_archived = ?");
    params.push(filters.status === "archived" ? 1 : 0);
  }
  if (filters.favorite !== undefined) {
    conditions.push("artifact.is_favorite = ?");
    params.push(filters.favorite ? 1 : 0);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  return rawAll<ArtifactRow>(
    `${artifactSelect}${where} ORDER BY artifact.updated_at DESC, artifact.id`,
    ...params,
  ).map(mapArtifact);
}

export function getArtifact(id: string): ArtifactRecord {
  const row = rawGet<ArtifactRow>(
    `${artifactSelect} WHERE artifact.id = ?`,
    id,
  );
  if (!row) throw new ArtifactStoreError("not_found", "Artifact not found");
  return mapArtifact(row);
}

export function updateArtifact(
  id: string,
  patch: {
    brandId?: string | null;
    artifactType?: string;
    favorite?: boolean;
    archived?: boolean;
    metadata?: Record<string, unknown> | null;
  },
): ArtifactRecord {
  const db = getDb();
  const current = db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  if (!current) throw new ArtifactStoreError("not_found", "Artifact not found");
  if (patch.brandId) {
    const brand = db
      .select({ id: retentionBrands.id })
      .from(retentionBrands)
      .where(eq(retentionBrands.id, patch.brandId))
      .get();
    if (!brand)
      throw new ArtifactStoreError("invalid_brand", "Brand not found");
  }
  db.update(artifacts)
    .set({
      ...(patch.brandId !== undefined ? { brandId: patch.brandId } : {}),
      ...(patch.artifactType !== undefined
        ? { artifactType: patch.artifactType }
        : {}),
      ...(patch.favorite !== undefined ? { isFavorite: patch.favorite } : {}),
      ...(patch.archived !== undefined ? { isArchived: patch.archived } : {}),
      ...(patch.metadata !== undefined
        ? {
            metadataJson: patch.metadata
              ? JSON.stringify(patch.metadata)
              : null,
          }
        : {}),
      updatedAt: Date.now(),
    })
    .where(eq(artifacts.id, id))
    .run();
  return getArtifact(id);
}

export function registerDocumentArtifact(surfaceId: string): void {
  rawRun(
    /*sql*/ `INSERT INTO artifacts (
      id, brand_id, resource_type, resource_id, artifact_type,
      metadata_json, created_at, updated_at
    )
    SELECT
      'document:' || document.surface_id,
      scope.brand_id,
      'document',
      document.surface_id,
      'document',
      json_object('conversationId', document.conversation_id),
      document.created_at,
      document.updated_at
    FROM documents AS document
    LEFT JOIN retention_conversation_brand_scopes AS scope
      ON scope.conversation_id = document.conversation_id
    WHERE document.surface_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM retention_copybook_months AS month
        WHERE month.document_surface_id = document.surface_id
      )
    ON CONFLICT(resource_type, resource_id) DO UPDATE SET
      brand_id = COALESCE(artifacts.brand_id, excluded.brand_id),
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
    surfaceId,
  );
}
