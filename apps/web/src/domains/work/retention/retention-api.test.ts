import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/api/client.gen";

import {
  activateRetentionProgram,
  approveRetentionImport,
  approveRetentionCampaign,
  fetchRetentionCampaignApprovalPreview,
  fetchRetentionCampaignPreview,
  fetchRetentionCampaigns,
  fetchRetentionImports,
  fetchRetentionProgramApprovalPreview,
  fetchRetentionPrograms,
  fetchRetentionStatus,
  releaseRetentionCampaign,
  RetentionApiError,
} from "./retention-api";

const originalGet = client.get;
const originalPost = client.post;

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const BRAND_ID = "22222222-2222-4222-8222-222222222222";
const PROGRAM_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const AUDIENCE_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "66666666-6666-4666-8666-666666666666";
const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const DISPATCH_ID = "88888888-8888-4888-8888-888888888888";
const IMPORT_ID = "99999999-9999-4999-8999-999999999999";
const SNAPSHOT_SHA256 = "a".repeat(64);
const AUDIENCE_SHA256 = "b".repeat(64);
const MESSAGE_SHA256 = "c".repeat(64);

afterEach(() => {
  client.get = originalGet;
  client.post = originalPost;
});

describe("fetchRetentionStatus", () => {
  test("uses the authenticated platform client with the selected assistant", async () => {
    const request = mock(async () => ({
      data: {
        organizationId: "org-1",
        integrations: [
          {
            provider: "shopify",
            status: "active",
            lastWebhookAt: "2026-07-28T10:00:00.000Z",
            lastPolledAt: null,
            lastReconciledAt: null,
            lastErrorCode: null,
          },
        ],
        jobs: { queued: 2 },
        externalWritesEnabled: false,
        sendEnabled: false,
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    client.get = request as typeof client.get;

    const result = await fetchRetentionStatus("assistant-1");

    expect(request).toHaveBeenCalledWith({
      url: "/v1/retention/status",
      headers: { "X-Worklin-Assistant-Id": "assistant-1" },
      throwOnError: false,
    });
    expect(result).toEqual({
      integrations: [
        {
          provider: "shopify",
          status: "active",
          lastWebhookAt: "2026-07-28T10:00:00.000Z",
          lastPolledAt: null,
          lastReconciledAt: null,
          lastErrorCode: null,
        },
      ],
      jobs: { queued: 2 },
      externalWritesEnabled: false,
      sendEnabled: false,
    });
    expect(result).not.toHaveProperty("organizationId");
  });

  test("rejects malformed status responses", async () => {
    client.get = mock(async () => ({
      data: {
        organizationId: "org-1",
        integrations: [],
        jobs: { queued: -1 },
        externalWritesEnabled: false,
        sendEnabled: false,
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as typeof client.get;

    expect(fetchRetentionStatus("assistant-1")).rejects.toThrow(
      "Retention status response was invalid.",
    );
  });
});

describe("retention campaign API", () => {
  test("loads campaign summaries without returning control-plane identifiers", async () => {
    const request = mock(async () => ({
      data: {
        campaigns: [
          {
            id: CAMPAIGN_ID,
            brandId: BRAND_ID,
            programId: PROGRAM_ID,
            programName: "First purchase",
            programType: "non_buyer_conversion",
            name: "July conversion",
            mode: "individual_message",
            status: "review_required",
            revision: 3,
            audienceMemberCount: 12,
            sensitiveMemberCount: 2,
            renderedMessageCount: 12,
            dispatchStatus: null,
            acceptedCount: 0,
            failedCount: 0,
            estimatedCostUsd: 1.25,
            updatedAt: "2026-07-28T10:00:00.000Z",
          },
        ],
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    client.get = request as typeof client.get;

    const campaigns = await fetchRetentionCampaigns("assistant-1");

    expect(request).toHaveBeenCalledWith({
      url: "/v1/retention/campaigns",
      headers: { "X-Worklin-Assistant-Id": "assistant-1" },
      throwOnError: false,
    });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).not.toHaveProperty("brandId");
    expect(campaigns[0]).not.toHaveProperty("programId");
    expect(campaigns[0]?.audienceMemberCount).toBe(12);
  });

  test("redacts customer and message identifiers from representative samples", async () => {
    client.get = mock(async () => ({
      data: {
        campaign: {
          id: CAMPAIGN_ID,
          name: "July conversion",
          mode: "individual_message",
          status: "review_required",
          revision: 3,
          programName: "First purchase",
          programType: "non_buyer_conversion",
          approvedAt: null,
        },
        audience: {
          id: AUDIENCE_ID,
          memberCount: 12,
          sensitiveMemberCount: 2,
          snapshotSha256: AUDIENCE_SHA256,
          frozenAt: "2026-07-28T09:00:00.000Z",
        },
        messageSamples: [
          {
            customerReference: "customer_private",
            messageId: MESSAGE_ID,
            qualityStatus: "passed",
            subject: "A useful subject",
            preheader: "A useful preheader",
            body: "A useful message",
            bodyTruncated: false,
            contentWithheld: false,
            messageSha256: MESSAGE_SHA256,
          },
        ],
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as typeof client.get;

    const preview = await fetchRetentionCampaignPreview(
      "assistant-1",
      CAMPAIGN_ID,
    );

    expect(preview.messageSamples[0]).toEqual({
      qualityStatus: "passed",
      subject: "A useful subject",
      preheader: "A useful preheader",
      body: "A useful message",
      bodyTruncated: false,
      contentWithheld: false,
    });
    expect(preview.messageSamples[0]).not.toHaveProperty("customerReference");
    expect(preview.messageSamples[0]).not.toHaveProperty("messageId");
    expect(preview.messageSamples[0]).not.toHaveProperty("messageSha256");
  });

  test("reduces approval material to safe aggregate review data", async () => {
    client.get = mock(async () => ({
      data: {
        snapshotSha256: SNAPSHOT_SHA256,
        material: {
          orgId: ORG_ID,
          campaignId: CAMPAIGN_ID,
          campaignRevision: 3,
          program: "non_buyer_conversion",
          mode: "individual_message",
          audienceSnapshotId: AUDIENCE_ID,
          audienceChecksum: AUDIENCE_SHA256,
          recipientDecisions: [
            { id: DECISION_ID, checksum: "d".repeat(64) },
          ],
          content: [{ id: MESSAGE_ID, checksum: MESSAGE_SHA256 }],
          modelReferences: ["provider:model"],
          promptReferences: ["retention-v1"],
          offerChecksum: "e".repeat(64),
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as typeof client.get;

    const preview = await fetchRetentionCampaignApprovalPreview(
      "assistant-1",
      CAMPAIGN_ID,
    );

    expect(preview.recipientDecisionCount).toBe(1);
    expect(preview.contentCount).toBe(1);
    expect(preview).not.toHaveProperty("orgId");
    expect(preview).not.toHaveProperty("recipientDecisions");
    expect(preview).not.toHaveProperty("content");
  });

  test("posts the expected snapshot for named approval", async () => {
    const request = mock(async () => ({
      data: {
        campaignId: CAMPAIGN_ID,
        status: "approved",
        snapshotSha256: SNAPSHOT_SHA256,
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    client.post = request as typeof client.post;

    await approveRetentionCampaign(
      "assistant-1",
      CAMPAIGN_ID,
      SNAPSHOT_SHA256,
    );

    expect(request).toHaveBeenCalledWith({
      url: "/v1/retention/campaigns/{campaign_id}/approve",
      path: { campaign_id: CAMPAIGN_ID },
      body: { expectedSnapshotSha256: SNAPSHOT_SHA256 },
      headers: {
        "Content-Type": "application/json",
        "X-Worklin-Assistant-Id": "assistant-1",
      },
      throwOnError: false,
    });
  });

  test("posts a caller-provided idempotency key and approved checksum for release", async () => {
    const request = mock(async () => ({
      data: {
        dispatchId: DISPATCH_ID,
        status: "pending",
        duplicate: false,
      },
      error: undefined,
      response: new Response(null, { status: 202 }),
    }));
    client.post = request as typeof client.post;

    const result = await releaseRetentionCampaign(
      "assistant-1",
      CAMPAIGN_ID,
      SNAPSHOT_SHA256,
      "retention-send:unique-request",
    );

    expect(request).toHaveBeenCalledWith({
      url: "/v1/retention/campaigns/{campaign_id}/release",
      path: { campaign_id: CAMPAIGN_ID },
      body: {
        idempotencyKey: "retention-send:unique-request",
        snapshotSha256: SNAPSHOT_SHA256,
      },
      headers: {
        "Content-Type": "application/json",
        "X-Worklin-Assistant-Id": "assistant-1",
      },
      throwOnError: false,
    });
    expect(result).toEqual({ status: "pending", duplicate: false });
  });

  test("preserves structured error codes for sanitized UI decisions", async () => {
    client.post = mock(async () => ({
      data: undefined,
      error: {
        error: {
          code: "approval_invalidated",
          message: "internal snapshot detail",
        },
      },
      response: new Response(null, { status: 409 }),
    })) as typeof client.post;

    try {
      await approveRetentionCampaign(
        "assistant-1",
        CAMPAIGN_ID,
        SNAPSHOT_SHA256,
      );
      throw new Error("Expected approval to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RetentionApiError);
      expect((error as RetentionApiError).code).toBe(
        "approval_invalidated",
      );
      expect((error as RetentionApiError).status).toBe(409);
    }
  });
});

describe("retention setup API", () => {
  test("loads a frozen program policy and binds activation to its checksum", async () => {
    const getRequest = mock(async () => ({
      data: {
        programId: PROGRAM_ID,
        status: "draft",
        snapshotSha256: SNAPSHOT_SHA256,
        material: {
          orgId: ORG_ID,
          programId: PROGRAM_ID,
          program: "re_engagement",
          name: "Re-engagement",
          policyVersion: "v1",
          policy: { objective: "Earn a useful return visit." },
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    const postRequest = mock(async () => ({
      data: {
        programId: PROGRAM_ID,
        status: "active",
        snapshotSha256: SNAPSHOT_SHA256,
        duplicate: false,
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    client.get = getRequest as typeof client.get;
    client.post = postRequest as typeof client.post;

    const preview = await fetchRetentionProgramApprovalPreview(
      "assistant-1",
      PROGRAM_ID,
    );
    await activateRetentionProgram(
      "assistant-1",
      PROGRAM_ID,
      preview.snapshotSha256,
    );

    expect(preview.material.policy).toEqual({
      objective: "Earn a useful return visit.",
    });
    expect(postRequest).toHaveBeenCalledWith({
      url: "/v1/retention/programs/{program_id}/activate",
      path: { program_id: PROGRAM_ID },
      body: { expectedPolicySha256: SNAPSHOT_SHA256 },
      headers: {
        "Content-Type": "application/json",
        "X-Worklin-Assistant-Id": "assistant-1",
      },
      throwOnError: false,
    });
  });

  test("loads programs and starts only the selected reviewed import", async () => {
    const getRequest = mock(async (input: { url?: string }) => ({
      data:
        input.url === "/v1/retention/programs"
          ? {
              programs: [
                {
                  id: PROGRAM_ID,
                  brandId: BRAND_ID,
                  type: "re_engagement",
                  name: "Re-engagement",
                  status: "draft",
                  policyVersion: "v1",
                  policyApprovalSha256: null,
                  approvedBy: null,
                  approvedAt: null,
                  updatedAt: "2026-07-28T10:00:00.000Z",
                },
              ],
            }
          : {
              imports: [
                {
                  id: IMPORT_ID,
                  brandId: BRAND_ID,
                  integrationId: DISPATCH_ID,
                  provider: "shopify",
                  status: "preview",
                  importedCount: 0,
                  rejectedCount: 0,
                  approvedAt: null,
                  startedAt: null,
                  completedAt: null,
                  lastErrorCode: null,
                  updatedAt: "2026-07-28T10:00:00.000Z",
                  hasCheckpoint: false,
                },
              ],
            },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    const postRequest = mock(async () => ({
      data: {
        migrationRunId: IMPORT_ID,
        integrationId: DISPATCH_ID,
        status: "running",
        duplicate: false,
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    client.get = getRequest as typeof client.get;
    client.post = postRequest as typeof client.post;

    expect(await fetchRetentionPrograms("assistant-1")).toHaveLength(1);
    expect(await fetchRetentionImports("assistant-1")).toHaveLength(1);
    await approveRetentionImport("assistant-1", IMPORT_ID);

    expect(postRequest).toHaveBeenCalledWith({
      url: "/v1/retention/imports/{migration_run_id}/approve",
      path: { migration_run_id: IMPORT_ID },
      headers: { "X-Worklin-Assistant-Id": "assistant-1" },
      throwOnError: false,
    });
  });
});
