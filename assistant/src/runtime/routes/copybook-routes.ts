import { z } from "zod";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import {
  approveCopybookCampaign,
  CopybookStoreError,
  createCopybook,
  createCopybookCampaign,
  createCopybookMonth,
  getCopybookDetail,
  listCopybooks,
  markCopybookCampaignReadyForDesign,
  updateCopybookCampaign,
  updateCopybookMonth,
} from "../../memory/copybook-store.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
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
const strategyStatusSchema = z.enum(["draft", "in_review", "approved"]);
const editableCampaignStatusSchema = z.enum([
  "brief_draft",
  "brief_review",
  "brief_approved",
  "copy_draft",
  "copy_review",
]);

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
  if (!(error instanceof CopybookStoreError)) throw error;
  if (error.code === "not_found") throw new NotFoundError(error.message);
  if (error.code === "conflict") throw new ConflictError(error.message);
  throw new BadRequestError(error.message);
}

async function invalidateCopybooks(): Promise<void> {
  await publishSyncInvalidation([SYNC_TAGS.copybooksList]);
}

function actorPrincipalId(
  headers?: Record<string, string>,
): string | undefined {
  return headers?.["x-vellum-actor-principal-id"]?.trim() || undefined;
}

const copybookSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  year: z.number(),
  title: z.string(),
  status: z.enum(["active", "archived"]),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const monthSchema = z.object({
  id: z.string(),
  copybookId: z.string(),
  month: z.number(),
  documentSurfaceId: z.string().nullable(),
  strategyStatus: strategyStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const campaignSchema = z.object({
  id: z.string(),
  monthId: z.string(),
  channel: z.enum(["email", "sms"]),
  ordinal: z.number(),
  title: z.string(),
  status: z.enum([
    "brief_draft",
    "brief_review",
    "brief_approved",
    "copy_draft",
    "copy_review",
    "approved",
    "ready_for_design",
  ]),
  packageId: z.string().nullable(),
  metadata: metadataSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const campaignDetailSchema = campaignSchema.extend({
  workItems: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      updatedAt: z.number(),
    }),
  ),
});

const copybookDetailSchema = z.object({
  copybook: copybookSchema,
  brand: z.object({ id: z.string(), name: z.string() }).nullable(),
  brandBrain: z
    .object({ revision: z.number(), updatedAt: z.number() })
    .nullable(),
  months: z.array(
    monthSchema.extend({ campaigns: z.array(campaignDetailSchema) }),
  ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listCopybooks",
    endpoint: "copybooks",
    method: "GET",
    policy: readPolicy,
    tags: ["copybooks"],
    queryParams: [
      { name: "brandId", schema: { type: "string" } },
      { name: "year", schema: { type: "integer" } },
    ],
    responseBody: z.object({ copybooks: z.array(copybookSchema) }),
    handler: ({ queryParams }) => {
      const year = queryParams?.year
        ? parseOrBadRequest(
            z.coerce.number().int().min(2000).max(2200),
            queryParams.year,
          )
        : undefined;
      return {
        copybooks: listCopybooks({
          brandId: queryParams?.brandId || undefined,
          year,
        }),
      };
    },
  },
  {
    operationId: "createCopybook",
    endpoint: "copybooks",
    method: "POST",
    policy: writePolicy,
    tags: ["copybooks"],
    requestBody: z.object({
      brandId: z.string().min(1),
      year: z.number().int().min(2000).max(2200),
      title: z.string().min(1).optional(),
    }),
    responseBody: copybookSchema,
    responseStatus: "201",
    handler: async ({ body }) => {
      const input = parseOrBadRequest(
        z.object({
          brandId: z.string().min(1),
          year: z.number().int().min(2000).max(2200),
          title: z.string().min(1).optional(),
        }),
        body ?? {},
      );
      try {
        const copybook = createCopybook(input);
        await invalidateCopybooks();
        return copybook;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "getCopybook",
    endpoint: "copybooks/:id",
    method: "GET",
    policy: readPolicy,
    tags: ["copybooks"],
    responseBody: copybookDetailSchema,
    handler: ({ pathParams }) => {
      try {
        return getCopybookDetail(pathParams!.id);
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "createCopybookMonth",
    endpoint: "copybooks/:id/months",
    method: "POST",
    policy: writePolicy,
    tags: ["copybooks"],
    requestBody: z.object({
      month: z.number().int().min(1).max(12),
      conversationId: z.string().min(1),
      title: z.string().min(1).optional(),
    }),
    responseBody: monthSchema,
    responseStatus: "201",
    handler: async ({ pathParams, body }) => {
      const input = parseOrBadRequest(
        z.object({
          month: z.number().int().min(1).max(12),
          conversationId: z.string().min(1),
          title: z.string().min(1).optional(),
        }),
        body ?? {},
      );
      try {
        const month = createCopybookMonth({
          copybookId: pathParams!.id,
          ...input,
        });
        await invalidateCopybooks();
        return month;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "updateCopybookMonth",
    endpoint: "copybook-months/:id",
    method: "PATCH",
    policy: writePolicy,
    tags: ["copybooks"],
    requestBody: z.object({ strategyStatus: strategyStatusSchema }),
    responseBody: monthSchema,
    handler: async ({ pathParams, body, headers }) => {
      const input = parseOrBadRequest(
        z.object({ strategyStatus: strategyStatusSchema }),
        body ?? {},
      );
      try {
        const month = updateCopybookMonth(
          pathParams!.id,
          input.strategyStatus,
          actorPrincipalId(headers),
        );
        await invalidateCopybooks();
        return month;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "createCopybookCampaign",
    endpoint: "copybook-months/:id/campaigns",
    method: "POST",
    policy: writePolicy,
    tags: ["copybooks"],
    requestBody: z.object({
      channel: z.enum(["email", "sms"]),
      ordinal: z.number().int().positive(),
      title: z.string().min(1),
      packageId: z.string().min(1).optional(),
      metadata: metadataSchema.optional(),
    }),
    responseBody: campaignSchema,
    responseStatus: "201",
    handler: async ({ pathParams, body }) => {
      const input = parseOrBadRequest(
        z.object({
          channel: z.enum(["email", "sms"]),
          ordinal: z.number().int().positive(),
          title: z.string().min(1),
          packageId: z.string().min(1).optional(),
          metadata: metadataSchema.optional(),
        }),
        body ?? {},
      );
      try {
        const campaign = createCopybookCampaign({
          monthId: pathParams!.id,
          ...input,
        });
        await invalidateCopybooks();
        return campaign;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "updateCopybookCampaign",
    endpoint: "copybook-campaigns/:id",
    method: "PATCH",
    policy: writePolicy,
    tags: ["copybooks"],
    requestBody: z
      .object({
        title: z.string().min(1).optional(),
        status: editableCampaignStatusSchema.optional(),
        packageId: z.string().min(1).nullable().optional(),
        metadata: metadataSchema.nullable().optional(),
      })
      .refine(
        (value) => Object.keys(value).length > 0,
        "At least one field is required",
      ),
    responseBody: campaignSchema,
    handler: async ({ pathParams, body }) => {
      const input = parseOrBadRequest(
        z
          .object({
            title: z.string().min(1).optional(),
            status: editableCampaignStatusSchema.optional(),
            packageId: z.string().min(1).nullable().optional(),
            metadata: metadataSchema.nullable().optional(),
          })
          .refine((value) => Object.keys(value).length > 0),
        body ?? {},
      );
      try {
        const campaign = updateCopybookCampaign(pathParams!.id, input);
        await invalidateCopybooks();
        return campaign;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "approveCopybookCampaign",
    endpoint: "copybook-campaigns/:id/approve",
    method: "POST",
    policy: writePolicy,
    tags: ["copybooks"],
    responseBody: campaignSchema,
    handler: async ({ pathParams, headers }) => {
      try {
        const campaign = approveCopybookCampaign(
          pathParams!.id,
          actorPrincipalId(headers),
        );
        await invalidateCopybooks();
        return campaign;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
  {
    operationId: "markCopybookCampaignReadyForDesign",
    endpoint: "copybook-campaigns/:id/ready-for-design",
    method: "POST",
    policy: writePolicy,
    tags: ["copybooks"],
    responseBody: campaignSchema,
    handler: async ({ pathParams, headers }) => {
      try {
        const campaign = markCopybookCampaignReadyForDesign(
          pathParams!.id,
          actorPrincipalId(headers),
        );
        await invalidateCopybooks();
        return campaign;
      } catch (error) {
        translateStoreError(error);
      }
    },
  },
];
