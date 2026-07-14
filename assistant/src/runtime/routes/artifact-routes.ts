import { z } from "zod";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import {
  ArtifactStoreError,
  getArtifact,
  listArtifacts,
  listBrandArtifactSummaries,
  updateArtifact,
} from "../../memory/artifact-store.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const readPolicy: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

const writePolicy: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

const metadataSchema = z.record(z.string(), z.unknown());

const artifactSchema = z.object({
  id: z.string(),
  brandId: z.string().nullable(),
  resourceType: z.string(),
  resourceId: z.string(),
  artifactType: z.string(),
  parentArtifactId: z.string().nullable(),
  projectId: z.string().nullable(),
  metadata: metadataSchema.nullable(),
  favorite: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  title: z.string(),
  sourceExists: z.boolean(),
  childCount: z.number(),
});

const patchSchema = z
  .object({
    brandId: z.string().min(1).nullable().optional(),
    artifactType: z.string().min(1).max(64).optional(),
    favorite: z.boolean().optional(),
    archived: z.boolean().optional(),
    metadata: metadataSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one change is required",
  });

function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid request",
    );
  }
  return parsed.data;
}

function translateStoreError(error: unknown): never {
  if (!(error instanceof ArtifactStoreError)) throw error;
  if (error.code === "not_found") throw new NotFoundError(error.message);
  throw new BadRequestError(error.message);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new BadRequestError("favorite must be true or false");
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listArtifactBrands",
    endpoint: "brands",
    method: "GET",
    policy: readPolicy,
    summary: "List artifact brands",
    description: "Return brand summaries with active artifact counts.",
    tags: ["artifacts"],
    responseBody: z.object({
      brands: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          artifactCount: z.number(),
          updatedAt: z.number(),
        }),
      ),
      unassignedArtifactCount: z.number(),
    }),
    handler: () => listBrandArtifactSummaries(),
  },
  {
    operationId: "listArtifacts",
    endpoint: "artifacts",
    method: "GET",
    policy: readPolicy,
    summary: "List artifacts",
    description:
      "Return artifacts across canonical sources. Use brandId=unassigned for artifacts without a brand.",
    tags: ["artifacts"],
    queryParams: [
      { name: "brandId", schema: { type: "string" } },
      { name: "type", schema: { type: "string" } },
      { name: "search", schema: { type: "string" } },
      {
        name: "status",
        schema: { type: "string", enum: ["active", "archived"] },
      },
      { name: "favorite", schema: { type: "boolean" } },
    ],
    responseBody: z.object({ artifacts: z.array(artifactSchema) }),
    handler: ({ queryParams }) => {
      const status = queryParams?.status
        ? parseOrBadRequest(z.enum(["active", "archived"]), queryParams.status)
        : undefined;
      const rawBrandId = queryParams?.brandId?.trim();
      return {
        artifacts: listArtifacts({
          brandId: rawBrandId === "unassigned" ? null : rawBrandId || undefined,
          artifactType: queryParams?.type?.trim() || undefined,
          search: queryParams?.search?.trim() || undefined,
          status,
          favorite: parseBoolean(queryParams?.favorite),
        }),
      };
    },
  },
  {
    operationId: "getArtifact",
    endpoint: "artifacts/:id",
    method: "GET",
    policy: readPolicy,
    summary: "Get an artifact",
    tags: ["artifacts"],
    responseBody: artifactSchema,
    additionalResponses: { "404": { description: "Artifact not found" } },
    handler: ({ pathParams }) => {
      try {
        return getArtifact(pathParams!.id);
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "updateArtifact",
    endpoint: "artifacts/:id",
    method: "PATCH",
    policy: writePolicy,
    summary: "Update artifact organization",
    description:
      "Update an artifact's brand, classification, favorite, archive, or metadata state without changing canonical content.",
    tags: ["artifacts"],
    requestBody: patchSchema,
    responseBody: artifactSchema,
    additionalResponses: {
      "400": { description: "Invalid artifact update" },
      "404": { description: "Artifact or brand not found" },
    },
    handler: async ({ pathParams, body }) => {
      const patch = parseOrBadRequest(patchSchema, body ?? {});
      try {
        const artifact = updateArtifact(pathParams!.id, patch);
        await publishSyncInvalidation([SYNC_TAGS.artifactsList]);
        return artifact;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
];
