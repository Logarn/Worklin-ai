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
const FIRST_EMAIL_BODY =
  "Still comparing options? We made the next step easier. Start with the result you want most, then use our short guide to compare the choices that support it. You will see what each option is designed to do, who it tends to suit, and the practical differences worth noticing before you decide. There is no need to work through every detail at once. Pick the outcome that matters today and follow the matching recommendation. If you are still unsure after reading, keep the guide nearby and return when the timing feels right. Explore the guide to find a clear, comfortable place to begin.";
const SECOND_EMAIL_BODY =
  "Not sure where to begin? Instead of comparing every option at the same time, narrow the decision to one question: what would make the biggest difference for you right now? Our quick guide organizes the choices around common goals, useful tradeoffs, and simple next steps. It is designed to help you understand the range without pressure or guesswork. Read the section that matches your priority, note the option that feels most practical, and ignore the rest until you need it. When you are ready, use the guide to choose the path that fits your needs and your pace.";

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
          key: "source_event_count",
          operator: "greater_than",
          value: 0,
        },
        {
          type: "predicate",
          namespace: "evidence",
          key: "event_type",
          operator: "contains",
          value: "product_view",
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
        body: FIRST_EMAIL_BODY,
        rationale:
          "Addresses demonstrated browsing with practical decision support without inventing personal intent.",
      },
      {
        customerReference: "archetype_example_2",
        subject: "Start with what fits",
        preheader: "Use this quick guide before you decide.",
        body: SECOND_EMAIL_BODY,
        rationale:
          "Uses the same evidence with a distinct goal-first decision approach and no personal guess.",
      },
    ],
    safety: {
      sensitiveInferenceUsed: false,
      unsupportedPersonalFactUsed: false,
    },
    ...overrides,
  };
}

function numberedProposal(index: number) {
  return proposal({
    name: `Audience ${index}`,
    expression: {
      type: "predicate",
      namespace: "metric",
      key: "source_event_count",
      operator: "greater_than",
      value: index,
    },
    representativeMessages: proposal().representativeMessages.map(
      (message, messageIndex) => ({
        ...message,
        subject: `${message.subject} ${index}`,
        body: `${message.body} Audience ${index}, version ${messageIndex + 1}.`,
      }),
    ),
  });
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
  const existingSegments: Array<{
    name: string;
    expression: unknown;
  }> = [];
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
          existingSegments,
          dossier: {
            aggregates: { recentBrowsers: 120 },
            availableTraits: [
              {
                key: "klaviyo.Source quiz?",
                customerCount: 12,
                observedValues: [],
              },
              {
                key: "klaviyo.health_status",
                customerCount: 2,
                observedValues: [],
              },
            ],
            expressionGrammar: {
              namespaces: {
                profile: [
                  "status",
                  "has_email",
                  "has_phone",
                  "created_at",
                  "source_updated_at",
                ],
                consent: ["email"],
                metric: [
                  "source_event_count",
                  "klaviyo_event_count",
                  "days_since_last_event",
                ],
                evidence: ["provider", "event_type"],
                trait: ["klaviyo.Source quiz?", "klaviyo.health_status"],
              },
              operators: [
                "equals",
                "not_equals",
                "exists",
                "not_exists",
                "contains",
                "not_contains",
                "in",
                "not_in",
                "greater_than",
                "greater_than_or_equal",
                "less_than",
                "less_than_or_equal",
                "after",
                "before",
              ],
            },
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
          definitions: Array<{ name: string; expression: unknown }>;
        };
        existingSegments.push(
          ...completion.definitions.map((definition) => ({
            name: definition.name,
            expression: definition.expression,
          })),
        );
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
    saveToCopybook: () => ({
      saved: true,
      copybookId: "copybook-1",
      monthId: "month-1",
      documentSurfaceId: "copybook-doc-1",
      campaignsCreated: 1,
    }),
  };
}

describe("retention campaign review pilot", () => {
  test("completes one structured tranche and saves review drafts to Copybook", async () => {
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
        trancheSize: 3,
      },
    });
    expect(JSON.stringify(providerPrompts)).not.toContain(
      "must-not-reach-model@example.com",
    );
    expect(JSON.stringify(providerPrompts)).toContain("[redacted]");
    expect(JSON.stringify(providerPrompts)).toContain("complete email drafts");

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
            promptVersion: "retention_campaign_review_v2",
            usage: { inputTokens: 400, outputTokens: 900 },
          },
        },
      ],
    });
    expect(completion?.body).not.toHaveProperty("claimId");
    expect(completion?.body).not.toHaveProperty("leaseToken");
    expect(documentInputs).toHaveLength(0);
    expect(JSON.parse(result.content)).toMatchObject({
      document: { surfaceId: "copybook-doc-1" },
      copybook: { saved: true, campaignsCreated: 1 },
    });
    expect(JSON.stringify(sent)).toContain("Copybook Drafts Ready");
    expect(JSON.stringify(sent)).toContain("No Klaviyo writes or sends");
  });

  test("pauses resumably on subscription quota without creating a document", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const documentInputs: Record<string, unknown>[] = [];
    const providerCalls: SendMessageOptions[] = [];
    const provider: Provider = {
      name: "openai",
      async sendMessage(
        _messages: Message[],
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        providerCalls.push(options ?? {});
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
    expect(providerCalls).toHaveLength(1);
    expect(
      (
        providerCalls[0]?.tools?.[0]?.input_schema as {
          $defs?: { segmentExpression?: unknown };
          properties?: { proposals?: { maxItems?: number } };
        }
      ).properties?.proposals?.maxItems,
    ).toBe(3);
    const toolSchema = providerCalls[0]?.tools?.[0]?.input_schema as {
      $defs?: { segmentExpression?: unknown };
      properties?: {
        proposals?: {
          items?: {
            properties?: { expression?: Record<string, unknown> };
          };
        };
      };
    };
    expect(toolSchema.$defs?.segmentExpression).toBeDefined();
    expect(
      toolSchema.properties?.proposals?.items?.properties?.expression,
    ).toEqual({ $ref: "#/$defs/segmentExpression" });
    const schemaJson = JSON.stringify(toolSchema);
    expect(schemaJson).toContain("klaviyo.Source quiz?");
    expect(schemaJson).not.toContain("klaviyo.health_status");
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

  test("gives later tranches the audiences already saved in the run", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const prompts: string[] = [];
    const tranches = [
      [numberedProposal(1), numberedProposal(2), numberedProposal(3)],
      [numberedProposal(4)],
    ];
    let callIndex = 0;
    const provider: Provider = {
      name: "openai",
      async sendMessage(messages: Message[]): Promise<ProviderResponse> {
        prompts.push(JSON.stringify(messages));
        return {
          content: [
            {
              type: "tool_use",
              id: `tool-${callIndex + 1}`,
              name: "submit_retention_segment_tranche",
              input: { proposals: tranches[callIndex++] },
            },
          ],
          model: "gpt-5.4",
          usage: { inputTokens: 400, outputTokens: 900 },
          stopReason: "tool_use",
        };
      },
    };

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 4 },
      context(),
      successfulDependencies(provider, requests, []),
    );

    expect(result.isError).toBe(false);
    expect(prompts).toHaveLength(2);
    const promptText = (value: string) =>
      (
        JSON.parse(value) as Array<{
          content: Array<{ text: string }>;
        }>
      )[0]!.content[0]!.text;
    expect(promptText(prompts[0]!)).toContain(
      '"previouslyGeneratedAudiences":[]',
    );
    expect(promptText(prompts[1]!)).toContain('"name":"Audience 1"');
    expect(promptText(prompts[1]!)).toContain('"name":"Audience 3"');
    expect(
      requests.filter((request) => request.path.endsWith("/complete")),
    ).toHaveLength(2);
  });

  test("pauses before storage when a later tranche repeats prior targeting", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const first = [
      numberedProposal(1),
      numberedProposal(2),
      numberedProposal(3),
    ];
    let callIndex = 0;
    const provider: Provider = {
      name: "openai",
      async sendMessage(): Promise<ProviderResponse> {
        const repeated = proposal({
          name: "Renamed audience",
          expression: first[0]!.expression,
        });
        return {
          content: [
            {
              type: "tool_use",
              id: `tool-${callIndex + 1}`,
              name: "submit_retention_segment_tranche",
              input: {
                proposals: callIndex++ === 0 ? first : [repeated],
              },
            },
          ],
          model: "gpt-5.4",
          usage: { inputTokens: 400, outputTokens: 900 },
          stopReason: "tool_use",
        };
      },
    };

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 4 },
      context(),
      successfulDependencies(provider, requests, []),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "paused",
      reason: "duplicate_segment_proposal",
      completedSegments: 3,
    });
    const completions = requests.filter((request) =>
      request.path.endsWith("/complete"),
    );
    expect(completions).toHaveLength(2);
    expect(completions[1]?.body).toMatchObject({
      outcome: "pause",
      errorCode: "duplicate_segment_proposal",
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

  test("accepts an imported punctuated Klaviyo property", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const dependencies = successfulDependencies(
      providerReturning({
        proposals: [
          proposal({
            expression: {
              type: "predicate",
              namespace: "trait",
              key: "klaviyo.Source quiz?",
              operator: "exists",
            },
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
    expect(JSON.parse(result.content)).toMatchObject({ status: "completed" });
  });

  test("pauses when the model references a field outside the frozen dossier", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const dependencies = successfulDependencies(
      providerReturning({
        proposals: [
          proposal({
            expression: {
              type: "predicate",
              namespace: "trait",
              key: "klaviyo.Unlisted property?",
              operator: "exists",
            },
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
      reason: "unsafe_segment_reference",
      resumable: true,
    });
    expect(
      requests.find((request) => request.path.endsWith("/complete"))?.body,
    ).toMatchObject({
      outcome: "pause",
      errorCode: "unsafe_segment_reference",
      definitions: [],
    });
  });

  test("rejects an obvious single-signal audience when profile combinations are available", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const dependencies = successfulDependencies(
      providerReturning({
        proposals: [
          proposal({
            expression: {
              type: "predicate",
              namespace: "evidence",
              key: "event_type",
              operator: "contains",
              value: "product_view",
            },
          }),
        ],
      }),
      requests,
      [],
    );
    const originalRequest = dependencies.operatorRequest;
    dependencies.operatorRequest = async (toolContext, method, path, body) => {
      const result = await originalRequest(toolContext, method, path, body);
      if (!path.endsWith("/claim") || result.isError) return result;
      const claim = JSON.parse(result.content) as Record<string, unknown>;
      claim.dossier = {
        ...(claim.dossier as Record<string, unknown>),
        profileCoverage: {
          profilesAnalyzed: 120,
          allActiveProfilesIncluded: true,
        },
        behaviorCombinations: [
          {
            memberCount: 24,
            signals: [
              { label: "Recent product activity" },
              { label: "Imported quiz preference" },
            ],
          },
        ],
      };
      return json(claim);
    };

    const result = await executeRetentionCampaignReviewPilot(
      { brand_id: BRAND_ID, max_segments: 1 },
      context(),
      dependencies,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "paused",
      reason: "segment_proposal_too_obvious",
    });
  });

  test("pauses with a typed error when the model nests campaign fields inside the expression", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> =
      [];
    const malformed = proposal({
      expression: {
        all: [],
        confidence: 0.8,
        campaignConcept: proposal().campaignConcept,
        representativeMessages: proposal().representativeMessages,
        safety: proposal().safety,
      },
    });
    const dependencies = successfulDependencies(
      providerReturning({ proposals: [malformed] }),
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
      reason: "structured_segment_output_invalid",
      resumable: true,
    });
    const completion = requests.find((request) =>
      request.path.endsWith("/complete"),
    );
    expect(completion?.body).toMatchObject({
      outcome: "pause",
      errorCode: "structured_segment_output_invalid",
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
        saveToCopybook: () => ({
          saved: false,
          reason: "brand_brain_required",
        }),
      },
    );

    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});
