import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { retentionBrands } from "./retention.js";

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => retentionBrands.id, {
      onDelete: "set null",
    }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    artifactType: text("artifact_type").notNull(),
    parentArtifactId: text("parent_artifact_id"),
    projectId: text("project_id"),
    metadataJson: text("metadata_json"),
    isFavorite: integer("is_favorite", { mode: "boolean" })
      .notNull()
      .default(false),
    isArchived: integer("is_archived", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_artifacts_resource").on(
      table.resourceType,
      table.resourceId,
    ),
    index("idx_artifacts_brand_updated").on(table.brandId, table.updatedAt),
    index("idx_artifacts_type_updated").on(table.artifactType, table.updatedAt),
    index("idx_artifacts_parent").on(table.parentArtifactId),
  ],
);
