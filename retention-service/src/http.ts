import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  bearerToken,
  RetentionAuthenticationError,
  type RetentionActorClaims,
  verifyRetentionActorToken,
} from "./auth.js";
import type { RetentionServiceConfig } from "./config.js";
import { retentionConnector } from "./connectors.js";
import type { RetentionDatabase } from "./database.js";
import {
  RetentionRepository,
  tenantContextFromClaims,
  type SegmentRunCompletionInput,
} from "./repository.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionServiceError } from "./types.js";
import type { RetentionServiceWorker } from "./worker.js";

const brandInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  websiteUrl: z.string().url().max(2_048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const klaviyoPropertyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(504)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !["__proto__", "constructor", "prototype"].includes(value),
    "Property name is invalid.",
  );

const integrationInputSchema = z
  .object({
    brandId: z.string().uuid(),
    provider: z.enum(["shopify", "klaviyo"]),
    controlPlaneConnectionId: z.string().trim().min(1).max(256),
    externalAccountId: z.string().trim().min(1).max(512).optional(),
    credential: z.string().min(1).max(16_384).optional(),
    webhookSecret: z.string().min(8).max(16_384),
    propertyAccessMode: z.enum(["allowlist", "all"]).optional(),
    propertyAllowlist: z.array(klaviyoPropertyNameSchema).max(500).optional(),
  })
  .superRefine((input, context) => {
    if (
      input.propertyAccessMode === "all" &&
      (input.propertyAllowlist?.length ?? 0) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["propertyAllowlist"],
        message: "An allowlist cannot be combined with all-property access.",
      });
    }
    if (
      input.provider !== "klaviyo" &&
      (input.propertyAccessMode !== undefined ||
        (input.propertyAllowlist?.length ?? 0) > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["propertyAccessMode"],
        message: "Klaviyo property settings require the Klaviyo provider.",
      });
    }
  });

const programInputSchema = z.object({
  brandId: z.string().uuid(),
  type: z.enum(["non_buyer_conversion", "re_engagement", "repeat_purchase"]),
  name: z.string().trim().min(1).max(200),
  policyVersion: z.string().trim().min(1).max(128),
  policy: z.record(z.string(), z.unknown()),
});

const programListQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
});

const programActivationInputSchema = z.object({
  expectedPolicySha256: z.string().regex(/^[0-9a-f]{64}$/iu),
  note: z.string().trim().min(1).max(2_000).optional(),
});

const programPauseInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const campaignInputSchema = z.object({
  brandId: z.string().uuid(),
  programId: z.string().uuid(),
  segmentDefinitionId: z.string().uuid().optional(),
  mode: z.enum(["dynamic_template", "individual_message"]),
  name: z.string().trim().min(1).max(200),
});

const segmentDefinitionInputSchema = z.object({
  brandId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  version: z.number().int().positive().max(1_000_000),
  expression: z.unknown(),
});

const segmentRunInputSchema = z.object({
  brandId: z.string().uuid(),
  maxSegments: z.number().int().min(1).max(50).default(50),
  sampleLimitPerSegment: z.number().int().min(1).max(2).default(2),
  trancheSize: z.number().int().min(1).max(10).default(10),
  cohortLimit: z.number().int().min(1).max(500).default(500),
  evidenceCutoffAt: z.string().datetime({ offset: true }).optional(),
});

const segmentRunClaimInputSchema = z.object({
  resume: z.boolean().default(false),
});

const campaignPreviewSampleSchema = z.object({
  customerReference: z
    .string()
    .regex(/^(?:customer_[a-f0-9]{12}|archetype_[a-z0-9_-]{1,64})$/u),
  subject: z.string().trim().min(1).max(1_000),
  preheader: z.string().trim().min(1).max(2_000).optional(),
  body: z.string().trim().min(1).max(500_000),
  explanation: z.string().trim().min(1).max(20_000),
});

const segmentRunCompletionSchema = z.object({
  leaseOwner: z.string().trim().min(20).max(128),
  outcome: z.enum(["continue", "pause", "complete"]),
  errorCode: z.string().trim().min(1).max(128).optional(),
  definitions: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(10_000),
        expression: z.unknown(),
        confidence: z.number().min(0).max(1),
        evidence: z.array(z.string().trim().min(1).max(2_000)).max(50),
        campaignPreview: z.object({
          strategy: z.unknown(),
          qualityStatus: z.enum(["passed", "needs_review", "blocked"]),
          qualityIssues: z.array(z.string().trim().min(1).max(2_000)).max(100),
          modelProvider: z.string().trim().min(1).max(128),
          modelId: z.string().trim().min(1).max(256),
          promptVersion: z.string().trim().min(1).max(256),
          usage: z.object({
            inputTokens: z.number().int().nonnegative().max(100_000),
            outputTokens: z.number().int().nonnegative().max(20_000),
            cachedInputTokens: z
              .number()
              .int()
              .nonnegative()
              .max(100_000)
              .optional(),
          }),
          samples: z.array(campaignPreviewSampleSchema).max(2),
        }),
      }),
    )
    .max(10),
});

const segmentListQuerySchema = z.object({
  brandId: z.string().uuid(),
});

const segmentActivationInputSchema = z.object({
  expectedVersion: z.number().int().positive().max(1_000_000),
  expectedChecksum: z.string().regex(/^[0-9a-f]{64}$/iu),
});

const recipientDecisionInputSchema = z.object({
  jobId: z.string().uuid(),
  leaseOwner: z.string().trim().min(11).max(128),
  decisionId: z.string().uuid(),
  customerId: z.string().uuid(),
  programId: z.string().uuid(),
  status: z.enum(["eligible", "ineligible", "needs_review"]),
  dossierSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
  objective: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(20_000),
  recommendation: z.object({
    action: z.string().trim().min(1).max(512),
    channel: z.literal("email"),
    timing: z.string().trim().min(1).max(512).optional(),
    offer: z.string().trim().min(1).max(2_000).optional(),
    personalizationBrief: z.string().trim().min(1).max(10_000),
  }),
  hypotheses: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(256),
        statement: z.string().trim().min(1).max(2_000),
        confidence: z.number().min(0).max(1),
        evidenceIds: z.array(z.string().uuid()).max(500),
      }),
    )
    .max(50),
  evidenceIds: z.array(z.string().uuid()).max(1_000),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(["standard", "personal", "sensitive", "restricted"]),
  requiresHumanReview: z.boolean(),
  model: z.object({
    provider: z.string().trim().min(1).max(128),
    id: z.string().trim().min(1).max(256),
    promptVersion: z.string().trim().min(1).max(256),
    responseId: z.string().trim().min(1).max(512).optional(),
  }),
  generatedAt: z.string().datetime({ offset: true }),
  evidenceCutoffAt: z.string().datetime({ offset: true }),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      estimatedProviderCost: z.number().nonnegative().optional(),
    })
    .optional(),
});

const freezeAudienceInputSchema = z.object({
  definitionVersion: z.number().int().positive().max(1_000_000),
  evidenceCutoffAt: z.string().datetime({ offset: true }),
  members: z
    .array(
      z.object({
        customerId: z.string().uuid(),
        decisionId: z.string().uuid(),
        inclusionExplanation: z.string().trim().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(10_000),
});

const prepareGenerationInputSchema = z.object({
  strategy: z.unknown(),
  strategyVersion: z.string().trim().min(1).max(256),
  modelProvider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
  promptVersion: z.string().trim().min(1).max(256),
  estimatedMaxCostUsd: z.number().nonnegative().max(1_000_000),
  campaignSpendCeilingUsd: z.number().nonnegative().max(1_000_000).optional(),
});

const renderedMessageInputSchema = z.object({
  customerId: z.string().uuid(),
  subject: z.string().trim().min(1).max(1_000),
  preheader: z.string().trim().min(1).max(2_000).optional(),
  body: z.string().trim().min(1).max(500_000),
  offer: z.string().trim().min(1).max(10_000).optional(),
  explanation: z.string().trim().min(1).max(20_000),
  modelProvider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
  promptVersion: z.string().trim().min(1).max(256),
  generatedAt: z.string().datetime({ offset: true }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  }),
});

const approvalInputSchema = z.object({
  expectedSnapshotSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu)
    .optional(),
  note: z.string().trim().min(1).max(2_000).optional(),
});

const releaseInputSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(256),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
});

const importReviewQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
  status: z
    .enum([
      "preview",
      "approved",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const customerExplanationQuerySchema = z.object({
  programId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
});

const customerCorrectionInputSchema = z
  .object({
    email: z.string().trim().email().max(512).nullable().optional(),
    phone: z.string().trim().min(3).max(64).nullable().optional(),
    displayName: z.string().trim().min(1).max(512).nullable().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine(
    (value) =>
      Object.prototype.hasOwnProperty.call(value, "email") ||
      Object.prototype.hasOwnProperty.call(value, "phone") ||
      Object.prototype.hasOwnProperty.call(value, "displayName"),
    { message: "At least one customer field must be corrected." },
  );

const customerDeletionInputSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(256),
  reason: z.string().trim().min(1).max(500),
});

const consentHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const integrationRevocationInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const campaignListQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  status: z
    .enum([
      "draft",
      "audience_frozen",
      "generating",
      "review_required",
      "approved",
      "ready_to_send",
      "sending",
      "sent",
      "partially_sent",
      "failed",
      "cancelled",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const previewQuerySchema = z.object({
  sampleLimit: z.coerce.number().int().min(1).max(25).default(10),
});

const cancellationInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export interface RetentionHttpDependencies {
  config: RetentionServiceConfig;
  database: Pick<
    RetentionDatabase,
    "ready" | "migrationsReady" | "tenantIsolationReady"
  >;
  rawPayloadStore: Pick<RawPayloadStore, "ready">;
  worker: Pick<RetentionServiceWorker, "wakeTenant">;
  repository: Pick<
    RetentionRepository,
    | "approveImport"
    | "appendSourceEvent"
    | "analyzeCampaignOutcomes"
    | "approveCampaign"
    | "activateProgram"
    | "activateSegment"
    | "cancelCampaign"
    | "campaignApprovalPreview"
    | "claimRecipientReasoning"
    | "claimSegmentRun"
    | "correctCustomer"
    | "createBrand"
    | "createCampaign"
    | "createIntegration"
    | "createProgram"
    | "createSegmentDefinition"
    | "createSegmentRun"
    | "freezeCampaignAudience"
    | "customerConsentHistory"
    | "customerPrivacyAccess"
    | "deleteCustomer"
    | "exportCustomerData"
    | "initializeTenant"
    | "integrationForWebhook"
    | "getSegmentRun"
    | "listCampaigns"
    | "listPrograms"
    | "listSegments"
    | "listSegmentsForRun"
    | "pauseProgram"
    | "prepareCampaignGeneration"
    | "previewAudience"
    | "previewCampaign"
    | "programPolicyApprovalPreview"
    | "recordRecipientDecision"
    | "recordRenderedMessage"
    | "completeSegmentRun"
    | "releaseCampaign"
    | "revokeIntegration"
    | "reviewImports"
    | "explainCustomer"
    | "status"
  >;
}

function json(status: number, value: unknown, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function boundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    throw new RetentionServiceError(
      "request_body_too_large",
      "The request body is too large.",
      413,
    );
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > maxBodyBytes) {
    throw new RetentionServiceError(
      "request_body_too_large",
      "The request body is too large.",
      413,
    );
  }
  return body;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new RetentionServiceError(
      "invalid_json",
      "The request body must contain valid JSON.",
      400,
    );
  }
}

function requirePermission(
  claims: RetentionActorClaims,
  permission: string,
): void {
  if (
    !claims.permissions.includes(permission) &&
    !claims.permissions.includes("retention:*")
  ) {
    throw new RetentionServiceError(
      "retention_permission_required",
      "The requested retention permission is required.",
      403,
    );
  }
}

function authenticate(
  request: Request,
  config: RetentionServiceConfig,
): RetentionActorClaims {
  return verifyRetentionActorToken({
    token: bearerToken(request),
    signingKey: config.signingKey,
    issuer: config.tokenIssuer,
    audience: config.tokenAudience,
  });
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function verifyInternalWebhookSignature(input: {
  request: Request;
  body: Uint8Array;
  claims: RetentionActorClaims;
  config: RetentionServiceConfig;
  provider: "shopify" | "klaviyo";
  connectionId: string;
}): void {
  const timestamp = input.request.headers.get("x-worklin-webhook-timestamp");
  const digest = input.request.headers.get("x-worklin-webhook-content-sha256");
  const signature = input.request.headers.get("x-worklin-webhook-signature");
  const expectedDigest = createHash("sha256")
    .update(input.body)
    .digest("base64url");
  if (
    !timestamp ||
    !digest ||
    !signature?.startsWith("v1=") ||
    input.request.headers.get("x-worklin-provider") !== input.provider ||
    input.request.headers.get("x-worklin-integration-connection-id") !==
      input.connectionId ||
    !safeEqualText(digest, expectedDigest)
  ) {
    throw new RetentionServiceError(
      "retention_webhook_binding_invalid",
      "The internal webhook binding is invalid.",
      403,
    );
  }
  const issuedAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > 60) {
    throw new RetentionServiceError(
      "retention_webhook_binding_expired",
      "The internal webhook binding expired.",
      403,
    );
  }
  const signatureInput = [
    issuedAt,
    input.provider,
    input.connectionId,
    input.claims.organization_id,
    input.claims.user_id,
    input.claims.assistant_id,
    expectedDigest,
  ].join("\n");
  const expectedSignature = createHmac(
    "sha256",
    input.config.providerWebhookKey,
  )
    .update(signatureInput)
    .digest("base64url");
  if (!safeEqualText(signature.slice(3), expectedSignature)) {
    throw new RetentionServiceError(
      "retention_webhook_binding_invalid",
      "The internal webhook binding is invalid.",
      403,
    );
  }
}

function routeMatch(
  pathname: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  if (
    pathname.includes("\\") ||
    /%(?:2f|5c)/iu.test(pathname) ||
    /[\u0000-\u001f\u007f]/u.test(pathname)
  ) {
    return null;
  }
  return pathname.match(pattern);
}

function queryParameters(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function handleWebhook(
  request: Request,
  dependencies: RetentionHttpDependencies,
  claims: RetentionActorClaims,
  provider: "shopify" | "klaviyo",
  connectionId: string,
): Promise<Response> {
  if (
    claims.token_use !== "provider_webhook" ||
    claims.provider !== provider ||
    claims.integration_connection_id !== connectionId ||
    !claims.permissions.includes("retention:webhook:ingest")
  ) {
    throw new RetentionServiceError(
      "retention_webhook_binding_invalid",
      "The webhook token does not match this connection.",
      403,
    );
  }
  const body = await boundedBody(request, dependencies.config.maxBodyBytes);
  verifyInternalWebhookSignature({
    request,
    body,
    claims,
    config: dependencies.config,
    provider,
    connectionId,
  });
  const integration = await dependencies.repository.integrationForWebhook({
    organizationId: claims.organization_id,
    controlPlaneConnectionId: connectionId,
    provider,
  });
  const connector = retentionConnector(provider);
  const connectorInput = {
    integrationId: integration.id,
    headers: request.headers,
    rawBody: body,
    secret: integration.secret,
  };
  if (!connector.verifyWebhook(connectorInput)) {
    throw new RetentionServiceError(
      "webhook_signature_invalid",
      "The provider webhook signature could not be verified.",
      401,
    );
  }
  const normalized = connector.normalizeWebhook(connectorInput);
  const results = [];
  for (const event of normalized) {
    results.push(
      await dependencies.repository.appendSourceEvent(
        claims.organization_id,
        event,
      ),
    );
  }
  dependencies.worker.wakeTenant(claims.organization_id);
  return json(202, {
    accepted: results.filter((result) => !result.duplicate).length,
    duplicates: results.filter((result) => result.duplicate).length,
  });
}

export function createRetentionHttpHandler(
  dependencies: RetentionHttpDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, {
          ok: true,
          service: "worklin-retention",
        });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const [
          databaseReady,
          migrationsReady,
          tenantIsolationReady,
          rawPayloadStoreReady,
        ] = await Promise.all([
          dependencies.database.ready(),
          dependencies.database.migrationsReady(),
          dependencies.database.tenantIsolationReady(),
          dependencies.rawPayloadStore.ready(),
        ]);
        const ok =
          databaseReady &&
          migrationsReady &&
          tenantIsolationReady &&
          rawPayloadStoreReady;
        return json(ok ? 200 : 503, {
          ok,
          database: databaseReady ? "ready" : "unavailable",
          migrations: migrationsReady ? "ready" : "pending",
          tenantIsolation: tenantIsolationReady ? "ready" : "unsafe",
          rawPayloadStore: rawPayloadStoreReady ? "ready" : "unavailable",
          externalWritesEnabled: dependencies.config.externalWritesEnabled,
          sendEnabled: dependencies.config.sendEnabled,
        });
      }
      if (!url.pathname.startsWith("/v1/retention")) {
        return json(404, { error: { code: "route_not_found" } });
      }

      const claims = authenticate(request, dependencies.config);
      const webhookMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/integrations\/(shopify|klaviyo)\/webhooks\/([^/]+)$/u,
      );
      if (request.method === "POST" && webhookMatch) {
        return handleWebhook(
          request,
          dependencies,
          claims,
          webhookMatch[1] as "shopify" | "klaviyo",
          decodeURIComponent(webhookMatch[2]!),
        );
      }
      if (claims.token_use !== "retention_service") {
        throw new RetentionServiceError(
          "retention_access_denied",
          "This token cannot access the operator API.",
          403,
        );
      }
      const context = tenantContextFromClaims(claims);

      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/jobs/wake"
      ) {
        requirePermission(claims, "retention:write");
        dependencies.worker.wakeTenant(context.organizationId);
        return json(202, { accepted: true });
      }
      if (request.method === "GET" && url.pathname === "/v1/retention/status") {
        requirePermission(claims, "retention:read");
        return json(200, await dependencies.repository.status(context));
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/retention/imports"
      ) {
        requirePermission(claims, "retention:read");
        const input = importReviewQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.reviewImports(context, input),
        );
      }
      const importApprovalMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/imports\/([0-9a-f-]+)\/approve$/iu,
      );
      if (request.method === "POST" && importApprovalMatch) {
        requirePermission(claims, "retention:integrations");
        const result = await dependencies.repository.approveImport(context, {
          migrationRunId: importApprovalMatch[1]!,
        });
        dependencies.worker.wakeTenant(context.organizationId);
        return json(200, result);
      }
      const customerExplanationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/customers\/([0-9a-f-]+)\/explanation$/iu,
      );
      if (request.method === "GET" && customerExplanationMatch) {
        requirePermission(claims, "retention:read");
        const input = customerExplanationQuerySchema.parse(
          queryParameters(url),
        );
        return json(
          200,
          await dependencies.repository.explainCustomer(context, {
            customerId: customerExplanationMatch[1]!,
            ...input,
          }),
        );
      }
      const customerPrivacyAccessMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/customers\/([0-9a-f-]+)\/privacy\/access$/iu,
      );
      if (request.method === "GET" && customerPrivacyAccessMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.customerPrivacyAccess(
            context,
            customerPrivacyAccessMatch[1]!,
          ),
        );
      }
      const customerPrivacyExportMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/customers\/([0-9a-f-]+)\/privacy\/export$/iu,
      );
      if (request.method === "GET" && customerPrivacyExportMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.exportCustomerData(
            context,
            customerPrivacyExportMatch[1]!,
          ),
          {
            "content-disposition": `attachment; filename="worklin-customer-${customerPrivacyExportMatch[1]!}.json"`,
            "x-content-type-options": "nosniff",
          },
        );
      }
      const customerConsentHistoryMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/customers\/([0-9a-f-]+)\/consent-history$/iu,
      );
      if (request.method === "GET" && customerConsentHistoryMatch) {
        requirePermission(claims, "retention:read");
        const input = consentHistoryQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.customerConsentHistory(context, {
            customerId: customerConsentHistoryMatch[1]!,
            ...input,
          }),
        );
      }
      const customerPrivacyMutationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/customers\/([0-9a-f-]+)\/privacy$/iu,
      );
      if (request.method === "PATCH" && customerPrivacyMutationMatch) {
        requirePermission(claims, "retention:write");
        const input = customerCorrectionInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.correctCustomer(context, {
            customerId: customerPrivacyMutationMatch[1]!,
            ...input,
          }),
        );
      }
      if (request.method === "DELETE" && customerPrivacyMutationMatch) {
        requirePermission(claims, "retention:write");
        const input = customerDeletionInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.deleteCustomer(context, {
            customerId: customerPrivacyMutationMatch[1]!,
            ...input,
          }),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/brands"
      ) {
        requirePermission(claims, "retention:write");
        await dependencies.repository.initializeTenant(context);
        const input = brandInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createBrand(context, input),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/integrations"
      ) {
        requirePermission(claims, "retention:integrations");
        const input = integrationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createIntegration(context, input),
        );
      }
      const integrationRevocationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/integrations\/([0-9a-f-]+)\/revoke$/iu,
      );
      if (request.method === "POST" && integrationRevocationMatch) {
        requirePermission(claims, "retention:integrations");
        const input = integrationRevocationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.revokeIntegration(context, {
            integrationId: integrationRevocationMatch[1]!,
            ...input,
          }),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/programs"
      ) {
        requirePermission(claims, "retention:write");
        const input = programInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createProgram(context, input),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/retention/programs"
      ) {
        requirePermission(claims, "retention:read");
        const input = programListQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.listPrograms(context, input),
        );
      }
      const programApprovalPreviewMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/programs\/([0-9a-f-]+)\/approval-preview$/iu,
      );
      if (request.method === "GET" && programApprovalPreviewMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.programPolicyApprovalPreview(
            context,
            programApprovalPreviewMatch[1]!,
          ),
        );
      }
      const programActivationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/programs\/([0-9a-f-]+)\/activate$/iu,
      );
      if (request.method === "POST" && programActivationMatch) {
        requirePermission(claims, "retention:approve");
        const input = programActivationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.activateProgram(context, {
            programId: programActivationMatch[1]!,
            ...input,
          }),
        );
      }
      const programPauseMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/programs\/([0-9a-f-]+)\/pause$/iu,
      );
      if (request.method === "POST" && programPauseMatch) {
        requirePermission(claims, "retention:approve");
        const input = programPauseInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.pauseProgram(context, {
            programId: programPauseMatch[1]!,
            ...input,
          }),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/segment-runs"
      ) {
        requirePermission(claims, "retention:write");
        const input = segmentRunInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createSegmentRun(context, input),
        );
      }
      const segmentRunMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/segment-runs\/([0-9a-f-]+)$/iu,
      );
      if (request.method === "GET" && segmentRunMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.getSegmentRun(
            context,
            segmentRunMatch[1]!,
          ),
        );
      }
      const segmentRunSegmentsMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/segment-runs\/([0-9a-f-]+)\/segments$/iu,
      );
      if (request.method === "GET" && segmentRunSegmentsMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.listSegmentsForRun(
            context,
            segmentRunSegmentsMatch[1]!,
          ),
        );
      }
      const segmentRunClaimMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/segment-runs\/([0-9a-f-]+)\/claim$/iu,
      );
      if (request.method === "POST" && segmentRunClaimMatch) {
        requirePermission(claims, "retention:generate");
        const input = segmentRunClaimInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.claimSegmentRun(context, {
            runId: segmentRunClaimMatch[1]!,
            ...input,
          }),
        );
      }
      const segmentRunCompleteMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/segment-runs\/([0-9a-f-]+)\/complete$/iu,
      );
      if (request.method === "POST" && segmentRunCompleteMatch) {
        requirePermission(claims, "retention:generate");
        const input = segmentRunCompletionSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.completeSegmentRun(context, {
            ...input,
            runId: segmentRunCompleteMatch[1]!,
            definitions: input.definitions.map((definition) => ({
              ...definition,
              expression:
                definition.expression as SegmentRunCompletionInput["definitions"][number]["expression"],
            })),
          }),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/segments"
      ) {
        requirePermission(claims, "retention:write");
        const input = segmentDefinitionInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createSegmentDefinition(context, {
            ...input,
            expression: input.expression as Parameters<
              RetentionRepository["createSegmentDefinition"]
            >[1]["expression"],
          }),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/retention/segments"
      ) {
        requirePermission(claims, "retention:read");
        const input = segmentListQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.listSegments(context, input),
        );
      }
      const segmentActivationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/segments\/([0-9a-f-]+)\/activate$/iu,
      );
      if (request.method === "POST" && segmentActivationMatch) {
        requirePermission(claims, "retention:approve");
        const input = segmentActivationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.activateSegment(context, {
            segmentId: segmentActivationMatch[1]!,
            ...input,
          }),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/reasoning/claim"
      ) {
        requirePermission(claims, "retention:generate");
        return json(200, {
          work: await dependencies.repository.claimRecipientReasoning(context),
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/decisions/complete"
      ) {
        requirePermission(claims, "retention:generate");
        const input = recipientDecisionInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.recordRecipientDecision(context, input),
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/retention/campaigns"
      ) {
        requirePermission(claims, "retention:write");
        const input = campaignInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.createCampaign(context, input),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/retention/campaigns"
      ) {
        requirePermission(claims, "retention:read");
        const input = campaignListQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.listCampaigns(context, input),
        );
      }

      const audienceFreezeMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/audience\/freeze$/iu,
      );
      if (request.method === "POST" && audienceFreezeMatch) {
        requirePermission(claims, "retention:generate");
        const input = freezeAudienceInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.freezeCampaignAudience(context, {
            campaignId: audienceFreezeMatch[1]!,
            ...input,
          }),
        );
      }
      const prepareGenerationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/generation\/prepare$/iu,
      );
      if (request.method === "POST" && prepareGenerationMatch) {
        requirePermission(claims, "retention:generate");
        const input = prepareGenerationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.prepareCampaignGeneration(context, {
            campaignId: prepareGenerationMatch[1]!,
            ...input,
          }),
        );
      }
      const messageMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/messages$/iu,
      );
      if (request.method === "POST" && messageMatch) {
        requirePermission(claims, "retention:generate");
        const input = renderedMessageInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          201,
          await dependencies.repository.recordRenderedMessage(context, {
            campaignId: messageMatch[1]!,
            ...input,
          }),
        );
      }
      const previewMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/approval-preview$/iu,
      );
      if (request.method === "GET" && previewMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.campaignApprovalPreview(
            context,
            previewMatch[1]!,
          ),
        );
      }
      const approvalMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/approve$/iu,
      );
      if (request.method === "POST" && approvalMatch) {
        requirePermission(claims, "retention:approve");
        const input = approvalInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.approveCampaign(context, {
            campaignId: approvalMatch[1]!,
            ...input,
          }),
        );
      }
      const releaseMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/release$/iu,
      );
      if (request.method === "POST" && releaseMatch) {
        requirePermission(claims, "retention:send");
        const input = releaseInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          202,
          await dependencies.repository.releaseCampaign(context, {
            campaignId: releaseMatch[1]!,
            ...input,
          }),
        );
      }
      const audiencePreviewMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/audiences\/([0-9a-f-]+)\/preview$/iu,
      );
      if (request.method === "GET" && audiencePreviewMatch) {
        requirePermission(claims, "retention:read");
        const input = previewQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.previewAudience(context, {
            audienceSnapshotId: audiencePreviewMatch[1]!,
            ...input,
          }),
        );
      }
      const campaignPreviewMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/preview$/iu,
      );
      if (request.method === "GET" && campaignPreviewMatch) {
        requirePermission(claims, "retention:read");
        const input = previewQuerySchema.parse(queryParameters(url));
        return json(
          200,
          await dependencies.repository.previewCampaign(context, {
            campaignId: campaignPreviewMatch[1]!,
            ...input,
          }),
        );
      }
      const outcomesMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/outcomes$/iu,
      );
      if (request.method === "GET" && outcomesMatch) {
        requirePermission(claims, "retention:read");
        return json(
          200,
          await dependencies.repository.analyzeCampaignOutcomes(
            context,
            outcomesMatch[1]!,
          ),
        );
      }
      const cancellationMatch = routeMatch(
        url.pathname,
        /^\/v1\/retention\/campaigns\/([0-9a-f-]+)\/cancel$/iu,
      );
      if (request.method === "POST" && cancellationMatch) {
        requirePermission(claims, "retention:write");
        const input = cancellationInputSchema.parse(
          parseJson(
            await boundedBody(request, dependencies.config.maxBodyBytes),
          ),
        );
        return json(
          200,
          await dependencies.repository.cancelCampaign(context, {
            campaignId: cancellationMatch[1]!,
            ...input,
          }),
        );
      }
      return json(404, { error: { code: "route_not_found" } });
    } catch (error) {
      if (error instanceof RetentionServiceError) {
        return json(error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }
      if (error instanceof RetentionAuthenticationError) {
        return json(401, {
          error: {
            code: error.code,
            message: "Retention authentication failed.",
          },
        });
      }
      if (error instanceof z.ZodError) {
        return json(400, {
          error: {
            code: "invalid_request",
            message: "The retention request is invalid.",
          },
        });
      }
      console.error("retention_request_failed", {
        method: request.method,
        pathname: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return json(500, {
        error: {
          code: "retention_internal_error",
          message: "The retention service could not complete the request.",
        },
      });
    }
  };
}
