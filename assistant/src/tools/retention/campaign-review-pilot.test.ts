import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import { ProviderError } from "../../util/errors.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  type CampaignReviewPilotDependencies,
  executeRetentionCampaignReviewPilot,
} from "./campaign-review-pilot.js";

const BRAND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_OWNER = "segment-run:cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    name: "Recent browsers without a purchase",
    description: "People showing recent product interest without an order.",
    expression: {
      type: "all",
      expressions: [
        {
          type: "predicate",
          namespace: "metric",
          key: "order_count",
          operator: "equals",
          value: 0,
        },
        {
          type: "predicate",
          namespace: "evidence",
          key: "product_view_30d",
          operator: "exists",
        },
      ],
    },
    evidence: [
      {
        signal: "Recent product browsing",
        explanation: "The account records product views in the last 30 days.",
        strength: "strong",
        source: "event",
      },
    ],
    confidence: 0.84,
    campaignConcept: {
      objective: "Help interested non-buyers choose a first product.",
      angle: "Reduce choice friction with a short product guide.",
      timing: "Within 24 hours of renewed browsing.",
      callToAction: "Explore the guide",
    },
    representativeMessages: [
      {
        customerReference: "archetype_example_1",
        subject: "A simpler way to choose",
        preheader: "A short guide to finding the right option.",
        body: "Still comparing options? This short guide makes it easier to choose based on what matters most to you.",
        rationale: "Addresses demonstrated browsing without inventing intent.",
      },
      {
        customerReference: "archetype_example_2",
        subject: "Start with what fits",
        preheader: "Use this quick guide before you decide.",
        body: "Not sure where to begin? See the key differences and choose the option that fits your needs.",
        rationale: "Uses the same evidence with a different practical angle.",
      },
    ],
    safety: {
      sensitiveInferenceUsed: false,
      unsupportedPersonalFactUsed: false,
    },
    ...overrides,
  };
}

function providerReturning(
  input: Record<string, unknown>,
  calls: SendMessageOptions[] = [],
  prompts: string[] = [],
): Provider {
  return {
    name: "openai",
    async sendMessage(
      messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      calls.push(options ?? {});
      prompts.push(JSON.stringify(messages));
      return {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "submit_retention_segment_tranche",
            input,
          },
        ],
        model: "gpt-5.4",
        usage: { inputTokens: 400, outputTokens: 900 },
        stopReason: "tool_use",
      };
    },
  };
}

function json(value: unknown, isError = false): ToolExecutionResult {
  return { content: JSON.stringify(value), isError };
}

function context(sent: unknown[] = []): ToolContext {
  return {
    conversationId: "conversation-1",
    workingDir: "/tmp",
    trustClass: "guardian",
    platformOrganizationId: "11111111-1111-4111-8111-111111111111",
    platformUserId: "auth0|user-1",
    platformAssistantId: "assistant-1",
    sendToClient: (message) => sent.push(message),
  } as ToolContext;
}

function successfulDependencies(
  provider: Provider,
  requests: Array<{ method: string; path: string; body?: unknown }>,
  documentInputs: Record<string, unknown>[],
  initialStatus: "queued" | "paused" = "queued",
): CampaignReviewPilotDependencies {
  let activeMaxSegments = 1;
  let completedSegmentCount = 0;
  return {
    resolveProvider: async () => provider,
    operatorRequest: async (_context, method, path, body) => {
      requests.push({ method, path, body });
      if (path === "/v1/retention/segment-runs") {
        activeMaxSegments = Number(
          (body as { maxSegments?: number } | undefined)?.maxSegments ?? 1,
        );
        return json({
          id: RUN_ID,
          status: initialStatus,
          maxSegments: activeMaxSegments,
          sampleLimitPerSegment: 2,
          trancheSize: 10,
          completedSegmentCount: 0,
          evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
        });
      }
      if (method === "GET" && path === `/v1/retention/segment-runs/${RUN_ID}`) {
        return json({
          id: RUN_ID,
          brandId: BRAND_ID,
          status: initialStatus,
          maxSegments: activeMaxSegments,
          sampleLimitPerSegment: 2,
          trancheSize: 10,
          completedSegmentCount: 0,
          evidenceCutoffAt: "2026-07-28T12:00:00.000Z",
          lastErrorCode: initialStatus === "paused" ? "provider_quota" : null,
        });
      }
      if (path.endsWith("/claim")) {
        return json({
          runId: RUN_ID,
          leaseOwner: LEASE_OWNER,
          leaseExpiresAt: "2026-07-28T12:02:00.000Z",
          dossierSha256: "a".repeat(64),
          dossier: {
            aggregates: { recentBrowsers: 120 },
            email: "must-not-reach-model@example.com",
            notes: "Imported from must-not-reach-model@example.com",
          },
          limits: {
            maxSegments: activeMaxSegments,
            completedSegments: completedSegmentCount,
            remainingSegments: activeMaxSegments - completedSegmentCount,
            trancheSize: Math.min(
              10,
              activeMaxSegments - completedSegmentCount,
            ),
            sampleLimitPerSegment: 2,
          },
        });
      }
      if (path.endsWith("/complete")) {
        const completion = body as {
          outcome: "continue" | "pause" | "complete";
          definitions: unknown[];
        };
        completedSegmentCount += completion.definitions.length;
        return json({
          runId: RUN_ID,
          status:
            completion.outcome === "pause"
              ? "paused"
              : completion.outcome === "complete"
                ? "completed"
                : "queued",
          completedSegmentCount,
          definitions: [],
        });
      }
      if (path === `/v1/retention/segment-runs/${RUN_ID}/segments`) {
        const generated = proposal();
        return json({
          brandName: "Example Brand",
          segments: [
            {
              name: generated.name,
              description: generated.description,
              expression: generated.expression,
              confidence: generated.confidence,
              memberCount: 120,
              eligibleCount: 108,
              campaignPreview: {
                strategy: generated.campaignConcept,
                evidence: generated.evidence.map((item) =>
                  JSON.stringify(item),
                ),
                samples: generated.representativeMessages.map((message) => ({
                  customerReference: message.customerReference,
                  subject: message.subject,
                  preheader: message.preheader,
                  body: message.body,
                  explanation: message.rationale,
                })),
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    createDocument: (input) => {
      documentInputs.push(input);
      return json({
        surface_id: "doc-1",
        title: "Example Brand: Customer Segments & Campaign Ideas",
        opened: true,
      });
    },
  };
}

describe("retention campaign review pilot", () => {
  test("completes one structured tranche and creates a review-only document", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const documentInputs: Record<string, unknown>[] = [];
    const providerCalls: SendMessageOptions[] = [];
    const providerPrompts: string[] = [];
    const sent: unknown[] = [];
    const dependencies = successfulDependencies(
      providerReturning(
        { proposals: [proposal()] },
        providerCalls,
        providerPrompts,
      ),
      requests,
      documentInputs,
    );

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 1 },
      context(sent),
      dependencies,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "completed",
      reviewOnly: true,
      externalActionTaken: false,
      segmentCount: 1,
      sampleMessageCount: 2,
      providerConnection: "chatgpt-subscription",
      model: "gpt-5.4",
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.config).toMatchObject({
      callSite: "workflowLeaf",
      model: "gpt-5.4",
      max_tokens: 12_000,
      retryMode: "none",
    });
    expect(providerCalls[0]?.tools?.[0]?.name).toBe(
      "submit_retention_segment_tranche",
    );
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/v1/retention/segment-runs",
      body: {
        brandId: BRAND_ID,
        maxSegments: 1,
        sampleLimitPerSegment: 2,
        trancheSize: 10,
      },
    });
    expect(JSON.stringify(providerPrompts)).not.toContain(
      "must-not-reach-model@example.com",
    );
    expect(JSON.stringify(providerPrompts)).toContain("[redacted]");

    const completion = requests.find((request) =>
      request.path.endsWith("/complete"),
    );
    expect(completion?.body).toMatchObject({
      leaseOwner: LEASE_OWNER,
      outcome: "complete",
      definitions: [
        {
          name: "Recent browsers without a purchase",
          campaignPreview: {
            qualityStatus: "passed",
            modelProvider: "openai",
            modelId: "gpt-5.4",
            promptVersion: "retention_campaign_review_v1",
            usage: { inputTokens: 400, outputTokens: 900 },
          },
        },
      ],
    });
    expect(completion?.body).not.toHaveProperty("claimId");
    expect(completion?.body).not.toHaveProperty("leaseToken");
    expect(documentInputs).toHaveLength(1);
    expect(documentInputs[0]?.title).toBe(
      "Example Brand: Customer Segments & Campaign Ideas",
    );
    expect(documentInputs[0]?.initial_content).toContain("Review only");
    expect(JSON.stringify(sent)).toContain("Campaign Review Ready");
    expect(JSON.stringify(sent)).toContain("No Klaviyo writes or sends");
  });

  test("pauses resumably on subscription quota without creating a document", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const documentInputs: Record<string, unknown>[] = [];
    const provider: Provider = {
      name: "openai",
      async sendMessage(): Promise<ProviderResponse> {
        throw new ProviderError("usage limit reached", "openai", 429);
      },
    };
    const dependencies = successfulDependencies(
      provider,
      requests,
      documentInputs,
    );

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 10 },
      context(),
      dependencies,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "paused",
      resumable: true,
      reason: "provider_quota",
      providerConnection: "chatgpt-subscription",
    });
    expect(documentInputs).toHaveLength(0);
    const completion = requests.find((request) =>
      request.path.endsWith("/complete"),
    );
    expect(completion?.body).toMatchObject({
      leaseOwner: LEASE_OWNER,
      outcome: "pause",
      errorCode: "provider_quota",
      definitions: [],
    });
  });

  test("rejects direct identifiers from structured model output", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const dependencies = successfulDependencies(
      providerReturning({
        proposals: [
          proposal({
            representativeMessages: [
              {
                ...proposal().representativeMessages[0],
                body: "Write to customer@example.com for your offer.",
              },
              proposal().representativeMessages[1],
            ],
          }),
        ],
      }),
      requests,
      [],
    );

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 1 },
      context(),
      dependencies,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "paused",
      reason: "direct_identifier_in_model_output",
      resumable: true,
    });
    const completion = requests.find((request) =>
      request.path.endsWith("/complete"),
    );
    expect(completion?.body).toMatchObject({
      outcome: "pause",
      errorCode: "direct_identifier_in_model_output",
      definitions: [],
    });
  });

  test("resumes a paused run with the explicit resume claim", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const dependencies = successfulDependencies(
      providerReturning({ proposals: [proposal()] }),
      requests,
      [],
      "paused",
    );

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, run_id: RUN_ID, max_segments: 1 },
      context(),
      dependencies,
    );

    expect(result.isError).toBe(false);
    const claim = requests.find((request) => request.path.endsWith("/claim"));
    expect(claim?.body).toEqual({ resume: true });
  });

  test("enforces the 50-segment invocation limit before any service call", async () => {
    let calls = 0;
    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 51 },
      context(),
      {
        operatorRequest: async () => {
          calls += 1;
          return json({});
        },
        resolveProvider: async () => null,
        createDocument: () => json({}),
      },
    );

    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});
