import { z } from "zod";

import {
  createComment,
  listComments,
} from "../../documents/document-comments-store.js";
import {
  getDocumentById,
  updateDocumentContent,
} from "../../documents/document-store.js";
import { getCopybookDetail } from "../../memory/copybook-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const sharedArtifactId = z.string().regex(/^copybook:[^/]+$/);

function requireSharedCopybook(
  artifactId: string,
  authContext: { artifactId?: string } | undefined,
) {
  if (!authContext?.artifactId || authContext.artifactId !== artifactId) {
    throw new ForbiddenError(
      "This collaboration token does not grant access to this artifact",
    );
  }
  const parsed = sharedArtifactId.safeParse(artifactId);
  if (!parsed.success) {
    throw new NotFoundError("Shared artifact not found");
  }
  try {
    return getCopybookDetail(artifactId.slice("copybook:".length));
  } catch {
    throw new NotFoundError("Shared artifact not found");
  }
}

function requireSharedMonth(
  artifactId: string,
  monthId: string,
  authContext: { artifactId?: string } | undefined,
) {
  const detail = requireSharedCopybook(artifactId, authContext);
  const month = detail.months.find((candidate) => candidate.id === monthId);
  if (!month?.documentSurfaceId)
    throw new NotFoundError("Shared month document not found");
  const document = getDocumentById(month.documentSurfaceId);
  if (!document) throw new NotFoundError("Shared month document not found");
  return { detail, month, document };
}

const snapshotSchema = z.object({
  artifactId: z.string(),
  collaborationRole: z.enum(["viewer", "commenter", "editor", "owner"]),
  copybook: z.object({ id: z.string(), title: z.string(), year: z.number() }),
  brand: z.object({ id: z.string(), name: z.string() }).nullable(),
  months: z.array(
    z.object({
      id: z.string(),
      month: z.number(),
      strategyStatus: z.string(),
      document: z
        .object({
          surfaceId: z.string(),
          title: z.string(),
          content: z.string(),
          updatedAt: z.number(),
        })
        .nullable(),
    }),
  ),
});

const commentSchema = z.object({
  id: z.string(),
  surfaceId: z.string(),
  conversationId: z.string(),
  author: z.string(),
  content: z.string(),
  anchorStart: z.number().nullable(),
  anchorEnd: z.number().nullable(),
  anchorText: z.string().nullable(),
  parentCommentId: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const commentBodySchema = z.object({
  content: z.string().min(1),
  anchorStart: z.number().nullable().optional(),
  anchorEnd: z.number().nullable().optional(),
  anchorText: z.string().nullable().optional(),
  parentCommentId: z.string().nullable().optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getSharedCopybookSnapshot",
    endpoint: "shared-artifacts/:artifactId/snapshot",
    method: "GET",
    policy: {
      requiredScopes: ["artifact.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a shared Copybook snapshot",
    tags: ["shared-artifacts"],
    responseBody: snapshotSchema,
    handler: ({ pathParams, authContext }) => {
      const artifactId = pathParams!.artifactId;
      const detail = requireSharedCopybook(artifactId, authContext);
      return {
        artifactId,
        collaborationRole: authContext?.collaborationRole ?? "viewer",
        copybook: {
          id: detail.copybook.id,
          title: detail.copybook.title,
          year: detail.copybook.year,
        },
        brand: detail.brand,
        months: detail.months.map((month) => {
          const document = month.documentSurfaceId
            ? getDocumentById(month.documentSurfaceId)
            : null;
          return {
            id: month.id,
            month: month.month,
            strategyStatus: month.strategyStatus,
            document: document
              ? {
                  surfaceId: document.surfaceId,
                  title: document.title,
                  content: document.content,
                  updatedAt: document.updatedAt,
                }
              : null,
          };
        }),
      };
    },
  },
  {
    operationId: "updateSharedCopybookMonthDocument",
    endpoint: "shared-artifacts/:artifactId/months/:monthId/document",
    method: "PATCH",
    policy: {
      requiredScopes: ["artifact.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a shared Copybook month document",
    tags: ["shared-artifacts"],
    requestBody: z.object({ content: z.string() }),
    responseBody: z.object({ success: z.literal(true) }),
    handler: ({ pathParams, body, authContext }) => {
      const content = body?.content;
      if (typeof content !== "string")
        throw new BadRequestError("content is required");
      const { document } = requireSharedMonth(
        pathParams!.artifactId,
        pathParams!.monthId,
        authContext,
      );
      const updated = updateDocumentContent(
        document.surfaceId,
        content,
        "replace",
      );
      if (!updated.success)
        throw new NotFoundError("Shared month document not found");
      return { success: true as const };
    },
  },
  {
    operationId: "listSharedCopybookMonthComments",
    endpoint: "shared-artifacts/:artifactId/months/:monthId/comments",
    method: "GET",
    policy: {
      requiredScopes: ["artifact.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List comments on a shared Copybook month",
    tags: ["shared-artifacts"],
    responseBody: z.object({ comments: z.array(commentSchema) }),
    handler: ({ pathParams, authContext }) => {
      const { document } = requireSharedMonth(
        pathParams!.artifactId,
        pathParams!.monthId,
        authContext,
      );
      return { comments: listComments(document.surfaceId, { status: "all" }) };
    },
  },
  {
    operationId: "createSharedCopybookMonthComment",
    endpoint: "shared-artifacts/:artifactId/months/:monthId/comments",
    method: "POST",
    policy: {
      requiredScopes: ["artifact.comment"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Comment on a shared Copybook month",
    tags: ["shared-artifacts"],
    requestBody: commentBodySchema,
    responseBody: commentSchema,
    handler: ({ pathParams, body, authContext }) => {
      const parsed = commentBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues[0]?.message ?? "Invalid comment",
        );
      }
      const { document } = requireSharedMonth(
        pathParams!.artifactId,
        pathParams!.monthId,
        authContext,
      );
      return createComment({
        surfaceId: document.surfaceId,
        conversationId: document.conversationId,
        author: `collaborator:${authContext?.actorPrincipalId ?? "unknown"}`,
        ...parsed.data,
      });
    },
  },
];
