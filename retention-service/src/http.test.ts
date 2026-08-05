import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { RetentionServiceConfig } from "./config.js";
import {
  createRetentionHttpHandler,
  type RetentionHttpDependencies,
} from "./http.js";

const signingKey = Buffer.from(
  "retention-jwt-secret-at-least-32-bytes",
  "utf8",
);
const organizationId = "11111111-1111-4111-8111-111111111111";
const assistantId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const customerId = "44444444-4444-4444-8444-444444444444";
const decisionId = "55555555-5555-4555-8555-555555555555";
const audienceId = "66666666-6666-4666-8666-666666666666";
const brandId = "77777777-7777-4777-8777-777777777777";
const integrationId = "88888888-8888-4888-8888-888888888888";
const programId = "99999999-9999-4999-8999-999999999999";
const segmentRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const config: RetentionServiceConfig = {
  databaseUrl: "postgres://runtime:secret@postgres.internal/worklin",
  migrationDatabaseUrl: null,
  port: 8080,
  host: "::",
  signingKey,
  providerWebhookKey: Buffer.from(
    "retention-webhook-secret-at-least-32",
    "utf8",
  ),
  encryptionKey: Buffer.alloc(32, 1),
  tokenIssuer: "worklin-control-plane",
  tokenAudience: "worklin-retention-service",
  externalWritesEnabled: false,
  sendEnabled: false,
  runMigrations: false,
  maxBodyBytes: 2 * 1024 * 1024,
  databaseTimeoutMs: 10_000,
  jobLeaseSeconds: 120,
  maxJobAttempts: 8,
  bucket: {
    endpoint: "https://storage.example.test",
    name: "test",
    accessKeyId: "access",
    secretAccessKey: "secret",
    virtualHostedStyle: true,
  },
};

function token(permissions: string[]): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.tokenIssuer,
      aud: config.tokenAudience,
      sub: "user:test-user",
      organization_id: organizationId,
      user_id: "test-user",
      assistant_id: assistantId,
      token_use: "retention_service",
      roles: ["retention_marketer"],
      permissions,
      iat: now,
      nbf: now,
      exp: now + 60,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function dependencies(
  repositoryOverrides: Partial<RetentionHttpDependencies["repository"]> = {},
): RetentionHttpDependencies {
  const unavailable = async () => {
    throw new Error("unexpected repository call");
  };
  return {
    config,
    database: {
      ready: async () => true,
      migrationsReady: async () => true,
      tenantIsolationReady: async () => true,
    },
    rawPayloadStore: {
      ready: async () => true,
    },
    worker: {
      wakeTenant: () => undefined,
    },
    repository: {
      approveImport: unavailable,
      appendSourceEvent: unavailable,
      analyzeCampaignOutcomes: unavailable,
      approveCampaign: unavailable,
      activateProgram: unavailable,
      activateSegment: unavailable,
      cancelCampaign: unavailable,
      campaignApprovalPreview: unavailable,
      claimRecipientReasoning: unavailable,
      claimSegmentRun: unavailable,
      correctCustomer: unavailable,
      createBrand: unavailable,
      createCampaign: unavailable,
      createIntegration: unavailable,
      createProgram: unavailable,
      createSegmentDefinition: unavailable,
      createSegmentRun: unavailable,
      customerConsentHistory: unavailable,
      customerPrivacyAccess: unavailable,
      deleteCustomer: unavailable,
      explainCustomer: unavailable,
      exportCustomerData: unavailable,
      freezeCampaignAudience: unavailable,
      initializeTenant: unavailable,
      integrationForWebhook: unavailable,
      getSegmentRun: unavailable,
      listCampaigns: unavailable,
      listPrograms: unavailable,
      listSegments: unavailable,
      listSegmentsForRun: unavailable,
      pauseProgram: unavailable,
      prepareCampaignGeneration: unavailable,
      previewAudience: unavailable,
      previewCampaign: unavailable,
      programPolicyApprovalPreview: unavailable,
      recordRecipientDecision: unavailable,
      recordRenderedMessage: unavailable,
      completeSegmentRun: unavailable,
      releaseCampaign: unavailable,
      revokeIntegration: unavailable,
      reviewImports: unavailable,
      status: unavailable,
      ...repositoryOverrides,
    } as RetentionHttpDependencies["repository"],
  };
}

describe("retention operator HTTP boundary", () => {
  test("readiness fails closed when the raw payload bucket is unavailable", async () => {
    const deps = dependencies();
    deps.rawPayloadStore.ready = async () => false;
    const response = await createRetentionHttpHandler(deps)(
      new Request("http://retention.internal/readyz"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      rawPayloadStore: "unavailable",
    });
  });

  test("wakes only the authenticated tenant with write permission", async () => {
    const awakened: string[] = [];
    const deps = dependencies();
    deps.worker.wakeTenant = (id) => awakened.push(id);

    const denied = await createRetentionHttpHandler(deps)(
      new Request("http://retention.internal/v1/retention/jobs/wake", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(["retention:read"])}`,
        },
      }),
    );
    expect(denied.status).toBe(403);
    expect(awakened).toEqual([]);

    const accepted = await createRetentionHttpHandler(deps)(
      new Request("http://retention.internal/v1/retention/jobs/wake", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(["retention:write"])}`,
        },
      }),
    );
    expect(accepted.status).toBe(202);
    expect(awakened).toEqual([organizationId]);
  });

  test("generation routes require the generation permission", async () => {
    const response = await createRetentionHttpHandler(dependencies())(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/audience/freeze`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            definitionVersion: 1,
            evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
            members: [
              {
                customerId,
                decisionId,
                inclusionExplanation: "Included from verified evidence.",
              },
            ],
          }),
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "retention_permission_required" },
    });
  });

  test("validates and binds the segment review run routes", async () => {
    const received: Array<Record<string, unknown>> = [];
    const handler = createRetentionHttpHandler(
      dependencies({
        createSegmentRun: async (context, input) => {
          received.push({
            action: "create",
            organizationId: context.organizationId,
            ...input,
          });
          return {
            id: segmentRunId,
            status: "queued",
            maxSegments: input.maxSegments,
            sampleLimitPerSegment: input.sampleLimitPerSegment,
            trancheSize: input.trancheSize,
            evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
            duplicate: false,
          };
        },
        getSegmentRun: async (context, runId) => ({
          id: runId,
          brandId,
          status: "queued",
          maxSegments: 20,
          sampleLimitPerSegment: 2,
          trancheSize: 10,
          completedSegmentCount: 0,
          evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
          lastErrorCode: null,
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        }),
        claimSegmentRun: async (context, input) => {
          received.push({
            action: "claim",
            organizationId: context.organizationId,
            ...input,
          });
          return {
            runId: input.runId,
            leaseOwner: "segment-run:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            leaseExpiresAt: "2026-07-28T12:02:00.000Z",
            dossierSha256: "d".repeat(64),
            dossier: { customerCount: 10 },
            existingSegments: [],
            limits: {
              maxSegments: 20,
              completedSegments: 0,
              remainingSegments: 20,
              trancheSize: 10,
              sampleLimitPerSegment: 2,
            },
          };
        },
        completeSegmentRun: async (context, input) => {
          received.push({
            action: "complete",
            organizationId: context.organizationId,
            ...input,
          });
          return {
            runId: input.runId,
            status: "paused",
            completedSegmentCount: 0,
            definitions: [],
          };
        },
        listSegments: async (context, input) => {
          received.push({
            action: "list",
            organizationId: context.organizationId,
            ...input,
          });
          return { segments: [] };
        },
        listSegmentsForRun: async (context, runId) => {
          received.push({
            action: "list-run",
            organizationId: context.organizationId,
            runId,
          });
          return { brandName: "Example Brand", segments: [] };
        },
        activateSegment: async (context, input) => {
          received.push({
            action: "activate",
            organizationId: context.organizationId,
            ...input,
          });
          return {
            segmentId: input.segmentId,
            status: "active",
            version: input.expectedVersion,
            checksum: input.expectedChecksum,
            duplicate: false,
          };
        },
      }),
    );

    const invalid = await handler(
      new Request("http://retention.internal/v1/retention/segment-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(["retention:write"])}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ brandId, maxSegments: 51 }),
      }),
    );
    expect(invalid.status).toBe(400);

    const zeroSamples = await handler(
      new Request("http://retention.internal/v1/retention/segment-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(["retention:write"])}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brandId,
          maxSegments: 20,
          sampleLimitPerSegment: 0,
          trancheSize: 10,
        }),
      }),
    );
    expect(zeroSamples.status).toBe(400);

    const created = await handler(
      new Request("http://retention.internal/v1/retention/segment-runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(["retention:write"])}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brandId,
          maxSegments: 20,
          sampleLimitPerSegment: 2,
          trancheSize: 10,
        }),
      }),
    );
    expect(created.status).toBe(201);

    const read = await handler(
      new Request(
        `http://retention.internal/v1/retention/segment-runs/${segmentRunId}`,
        { headers: { authorization: `Bearer ${token(["retention:read"])}` } },
      ),
    );
    expect(read.status).toBe(200);

    const runSegments = await handler(
      new Request(
        `http://retention.internal/v1/retention/segment-runs/${segmentRunId}/segments`,
        { headers: { authorization: `Bearer ${token(["retention:read"])}` } },
      ),
    );
    expect(runSegments.status).toBe(200);
    expect(await runSegments.json()).toEqual({
      brandName: "Example Brand",
      segments: [],
    });

    const claimed = await handler(
      new Request(
        `http://retention.internal/v1/retention/segment-runs/${segmentRunId}/claim`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:generate"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ resume: true }),
        },
      ),
    );
    expect(claimed.status).toBe(200);

    const completed = await handler(
      new Request(
        `http://retention.internal/v1/retention/segment-runs/${segmentRunId}/complete`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:generate"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            leaseOwner: "segment-run:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            outcome: "pause",
            errorCode: "subscription_rate_limited",
            definitions: [],
          }),
        },
      ),
    );
    expect(completed.status).toBe(200);

    const directIdentifierSample = await handler(
      new Request(
        `http://retention.internal/v1/retention/segment-runs/${segmentRunId}/complete`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:generate"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            leaseOwner: "segment-run:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            outcome: "complete",
            definitions: [
              {
                name: "Example segment",
                description: "A safe example.",
                expression: {
                  type: "predicate",
                  namespace: "profile",
                  key: "has_email",
                  operator: "equals",
                  value: true,
                },
                confidence: 1,
                evidence: [],
                campaignPreview: {
                  strategy: {},
                  qualityStatus: "passed",
                  qualityIssues: [],
                  modelProvider: "test",
                  modelId: "test-model",
                  promptVersion: "test-v1",
                  usage: { inputTokens: 1, outputTokens: 1 },
                  samples: [
                    {
                      customerReference: "user@example.com",
                      subject: "Example",
                      body: "Example body",
                      explanation: "Example explanation",
                    },
                  ],
                },
              },
            ],
          }),
        },
      ),
    );
    expect(directIdentifierSample.status).toBe(400);

    const listed = await handler(
      new Request(
        `http://retention.internal/v1/retention/segments?brandId=${brandId}`,
        { headers: { authorization: `Bearer ${token(["retention:read"])}` } },
      ),
    );
    expect(listed.status).toBe(200);

    const activated = await handler(
      new Request(
        `http://retention.internal/v1/retention/segments/${segmentId}/activate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:approve"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expectedVersion: 1,
            expectedChecksum: "e".repeat(64),
          }),
        },
      ),
    );
    expect(activated.status).toBe(200);
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "claim",
          runId: segmentRunId,
          resume: true,
        }),
        expect.objectContaining({
          action: "complete",
          runId: segmentRunId,
          outcome: "pause",
        }),
        expect.objectContaining({
          action: "list",
          brandId,
        }),
        expect.objectContaining({
          action: "list-run",
          organizationId,
          runId: segmentRunId,
        }),
        expect.objectContaining({
          action: "activate",
          segmentId,
          expectedVersion: 1,
        }),
      ]),
    );
  });

  test("uses the campaign id from the authenticated route", async () => {
    const received = { campaignId: "" };
    const handler = createRetentionHttpHandler(
      dependencies({
        freezeCampaignAudience: async (_context, input) => {
          received.campaignId = input.campaignId;
          return {
            campaignId: input.campaignId,
            audienceSnapshotId: "66666666-6666-4666-8666-666666666666",
            snapshotSha256: "a".repeat(64),
            memberCount: 1,
            sensitiveMemberCount: 0,
            duplicate: false,
          };
        },
      }),
    );
    const response = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/audience/freeze`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token([
              "retention:read",
              "retention:generate",
            ])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            definitionVersion: 1,
            evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
            members: [
              {
                customerId,
                decisionId,
                inclusionExplanation: "Included from verified evidence.",
              },
            ],
          }),
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(received.campaignId).toBe(campaignId);
  });

  test("operator reads require retention read permission", async () => {
    const response = await createRetentionHttpHandler(dependencies())(
      new Request("http://retention.internal/v1/retention/imports", {
        headers: {
          authorization: `Bearer ${token(["retention:write"])}`,
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "retention_permission_required" },
    });
  });

  test("privacy reads require retention read and return no-store JSON", async () => {
    const handler = createRetentionHttpHandler(
      dependencies({
        customerPrivacyAccess: async (context, id) => ({
          customerId: id,
          brandId,
          status: "active",
          profile: {
            email: "user@example.com",
            phone: null,
            displayName: "Example User",
          },
          recordCounts: {
            identities: 1,
            traits: 0,
            consentEvents: 1,
            sourceEvents: 2,
            decisions: 0,
            messages: 0,
            segmentMemberships: 0,
          },
          updatedAt: "2026-07-28T12:00:00.000Z",
          organizationId: context.organizationId,
        }),
      }),
    );
    const denied = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/privacy/access`,
        {
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
          },
        },
      ),
    );
    expect(denied.status).toBe(403);

    const allowed = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/privacy/access`,
        {
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
          },
        },
      ),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await allowed.json())).not.toContain("secret");
  });

  test("privacy correction and deletion require retention write", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handler = createRetentionHttpHandler(
      dependencies({
        correctCustomer: async (_context, input) => {
          calls.push(input);
          return {
            customerId: input.customerId,
            status: "corrected",
            changedFields: ["email"],
          };
        },
        deleteCustomer: async (_context, input) => {
          calls.push(input);
          return {
            customerId: input.customerId,
            status: "deleted",
            rawPayloadsDeleted: 2,
            duplicate: false,
          };
        },
      }),
    );
    const denied = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/privacy`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: "privacy-request-0001",
            reason: "Verified customer request.",
          }),
        },
      ),
    );
    expect(denied.status).toBe(403);

    const corrected = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/privacy`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "user@example.com",
            reason: "Verified customer correction.",
          }),
        },
      ),
    );
    expect(corrected.status).toBe(200);

    const deleted = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/privacy`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: "privacy-request-0001",
            reason: "Verified customer request.",
          }),
        },
      ),
    );
    expect(deleted.status).toBe(200);
    expect(calls).toEqual([
      {
        customerId,
        email: "user@example.com",
        reason: "Verified customer correction.",
      },
      {
        customerId,
        idempotencyKey: "privacy-request-0001",
        reason: "Verified customer request.",
      },
    ]);
  });

  test("integration revocation requires integration permission and returns no secret", async () => {
    const handler = createRetentionHttpHandler(
      dependencies({
        revokeIntegration: async (_context, input) => ({
          integrationId: input.integrationId,
          provider: "shopify",
          status: "revoked",
          duplicate: false,
        }),
      }),
    );
    const denied = await handler(
      new Request(
        `http://retention.internal/v1/retention/integrations/${integrationId}/revoke`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reason: "Connection revoked." }),
        },
      ),
    );
    expect(denied.status).toBe(403);

    const revoked = await handler(
      new Request(
        `http://retention.internal/v1/retention/integrations/${integrationId}/revoke`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:integrations"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reason: "Connection revoked." }),
        },
      ),
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      integrationId,
      provider: "shopify",
      status: "revoked",
      duplicate: false,
    });
  });

  test("validates and forwards import review filters", async () => {
    const received: Record<string, unknown> = {};
    const handler = createRetentionHttpHandler(
      dependencies({
        reviewImports: async (context, input) => {
          Object.assign(received, {
            organizationId: context.organizationId,
            ...input,
          });
          return { imports: [] };
        },
      }),
    );
    const response = await handler(
      new Request(
        `http://retention.internal/v1/retention/imports?brandId=${brandId}&integrationId=${integrationId}&status=running&limit=12`,
        {
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      organizationId,
      brandId,
      integrationId,
      status: "running",
      limit: 12,
    });
  });

  test("binds customer explanations to the route customer", async () => {
    const received: Record<string, unknown> = {};
    const handler = createRetentionHttpHandler(
      dependencies({
        explainCustomer: async (context, input) => {
          Object.assign(received, {
            organizationId: context.organizationId,
            ...input,
          });
          return {
            customerReference: "customer_redacted",
            currentDecision: null,
            movement: null,
            decisionHistory: [],
            campaignMemberships: [],
          };
        },
      }),
    );
    const response = await handler(
      new Request(
        `http://retention.internal/v1/retention/customers/${customerId}/explanation?campaignId=${campaignId}`,
        {
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      organizationId,
      customerId,
      campaignId,
    });
  });

  test("routes campaign, audience, and outcome reads with bounded samples", async () => {
    const calls: string[] = [];
    const handler = createRetentionHttpHandler(
      dependencies({
        listCampaigns: async (_context, input) => {
          calls.push(`list:${input.limit}`);
          return { campaigns: [] };
        },
        previewAudience: async (_context, input) => {
          calls.push(
            `audience:${input.audienceSnapshotId}:${input.sampleLimit}`,
          );
          return {
            audience: {
              id: input.audienceSnapshotId,
              campaignId,
              campaignName: "Example campaign",
              definitionVersion: 1,
              snapshotSha256: "a".repeat(64),
              memberCount: 0,
              sensitiveMemberCount: 0,
              evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
              frozenAt: "2026-07-28T12:00:00.000Z",
            },
            samples: [],
          };
        },
        previewCampaign: async (_context, input) => {
          calls.push(`campaign:${input.campaignId}:${input.sampleLimit}`);
          return {
            campaign: {
              id: input.campaignId,
              name: "Example campaign",
              mode: "individual_message",
              status: "draft",
              revision: 1,
              programName: "Example program",
              programType: "re_engagement",
              approvedAt: null,
            },
            audience: null,
            messageSamples: [],
          };
        },
        analyzeCampaignOutcomes: async (_context, id) => {
          calls.push(`outcomes:${id}`);
          return {
            campaignId: id,
            campaignStatus: "draft",
            dispatches: [],
            recipientStatuses: {},
            deliveryEvents: {},
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 0,
            },
          };
        },
      }),
    );
    const headers = {
      authorization: `Bearer ${token(["retention:read"])}`,
    };
    const responses = await Promise.all([
      handler(
        new Request(
          "http://retention.internal/v1/retention/campaigns?limit=7",
          { headers },
        ),
      ),
      handler(
        new Request(
          `http://retention.internal/v1/retention/audiences/${audienceId}/preview?sampleLimit=4`,
          { headers },
        ),
      ),
      handler(
        new Request(
          `http://retention.internal/v1/retention/campaigns/${campaignId}/preview?sampleLimit=3`,
          { headers },
        ),
      ),
      handler(
        new Request(
          `http://retention.internal/v1/retention/campaigns/${campaignId}/outcomes`,
          { headers },
        ),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(calls.sort()).toEqual(
      [
        `list:7`,
        `audience:${audienceId}:4`,
        `campaign:${campaignId}:3`,
        `outcomes:${campaignId}`,
      ].sort(),
    );
  });

  test("requires write permission and a reason for cancellation", async () => {
    const handler = createRetentionHttpHandler(dependencies());
    const withoutPermission = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reason: "Campaign is no longer needed." }),
        },
      ),
    );
    expect(withoutPermission.status).toBe(403);

    const missingReason = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(missingReason.status).toBe(400);
    expect(await missingReason.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  test("forwards authenticated cancellation without exposing route control", async () => {
    const received: Record<string, unknown> = {};
    const handler = createRetentionHttpHandler(
      dependencies({
        cancelCampaign: async (context, input) => {
          Object.assign(received, {
            organizationId: context.organizationId,
            ...input,
          });
          return {
            campaignId: input.campaignId,
            status: "cancelled",
            cancelledDispatchCount: 0,
            cancelledRecipientCount: 0,
            duplicate: false,
          };
        },
      }),
    );
    const response = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            campaignId: "99999999-9999-4999-8999-999999999999",
            reason: "Campaign is no longer needed.",
          }),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      organizationId,
      campaignId,
      reason: "Campaign is no longer needed.",
    });
  });

  test("binds program activation to an approved policy checksum", async () => {
    const snapshotSha256 = "a".repeat(64);
    const received: Record<string, unknown> = {};
    const handler = createRetentionHttpHandler(
      dependencies({
        activateProgram: async (context, input) => {
          Object.assign(received, {
            organizationId: context.organizationId,
            ...input,
          });
          return {
            programId: input.programId,
            status: "active",
            snapshotSha256: input.expectedPolicySha256,
            duplicate: false,
          };
        },
      }),
    );
    const denied = await handler(
      new Request(
        `http://retention.internal/v1/retention/programs/${programId}/activate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ expectedPolicySha256: snapshotSha256 }),
        },
      ),
    );
    expect(denied.status).toBe(403);

    const accepted = await handler(
      new Request(
        `http://retention.internal/v1/retention/programs/${programId}/activate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:approve"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            programId: customerId,
            expectedPolicySha256: snapshotSha256,
            note: "Reviewed policy.",
          }),
        },
      ),
    );
    expect(accepted.status).toBe(200);
    expect(received).toEqual({
      organizationId,
      programId,
      expectedPolicySha256: snapshotSha256,
      note: "Reviewed policy.",
    });
  });

  test("checks approval and send permissions at the HTTP boundary", async () => {
    const handler = createRetentionHttpHandler(dependencies());
    const approval = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/approve`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:write"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      ),
    );
    const release = await handler(
      new Request(
        `http://retention.internal/v1/retention/campaigns/${campaignId}/release`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:approve"])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: "release-request-00000001",
            snapshotSha256: "b".repeat(64),
          }),
        },
      ),
    );

    expect(approval.status).toBe(403);
    expect(release.status).toBe(403);
  });

  test("approves an import with integration permission and wakes its tenant", async () => {
    const awakened: string[] = [];
    const deps = dependencies({
      approveImport: async (_context, input) => ({
        migrationRunId: input.migrationRunId,
        integrationId,
        status: "running",
        duplicate: false,
      }),
    });
    deps.worker.wakeTenant = (id) => awakened.push(id);
    const handler = createRetentionHttpHandler(deps);
    const denied = await handler(
      new Request(
        `http://retention.internal/v1/retention/imports/${programId}/approve`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:read"])}`,
          },
        },
      ),
    );
    expect(denied.status).toBe(403);

    const accepted = await handler(
      new Request(
        `http://retention.internal/v1/retention/imports/${programId}/approve`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token(["retention:integrations"])}`,
          },
        },
      ),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      migrationRunId: programId,
      integrationId,
      status: "running",
    });
    expect(awakened).toEqual([organizationId]);
  });
});
