import { randomUUID } from "node:crypto";

import {
  validateWorklinSegmentExpression,
  type WorklinSegmentExpression,
} from "@vellumai/retention-domain";
import type { ToolDefinition } from "@vellumai/skill-host-contracts";
import { z } from "zod";

import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { ProviderError } from "../../util/errors.js";
import { executeDocumentCreate } from "../document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  type CampaignReviewCopybookInput,
  type CampaignReviewCopybookResult,
  saveCampaignReviewToCopybook,
} from "./campaign-review-copybook.js";
import { retentionOperatorRequest } from "./central-service.js";

const PROVIDER_CONNECTION = "chatgpt-subscription";
const PROVIDER_NAME = "openai";
const MODEL = "gpt-5.4";
const PROMPT_VERSION = "retention_campaign_review_v2";
const STRUCTURED_TOOL_NAME = "submit_retention_segment_tranche";
const DOCUMENT_SUFFIX = "Customer Segments & Campaign Ideas";
const MAX_SEGMENTS = 50;
const MAX_SEGMENTS_PER_TRANCHE = 3;
const MAX_SERVICE_TRANCHE_SIZE = 10;
const SAMPLE_MESSAGES_PER_SEGMENT = 2;
const MAX_SAMPLE_MESSAGES = 100;
const MAX_MODEL_CALLS = 5;
const MAX_OUTPUT_TOKENS_PER_CALL = 12_000;
const MAX_TOTAL_INPUT_TOKENS = 500_000;
const MAX_TOTAL_OUTPUT_TOKENS = 60_000;
const MAX_MODEL_CONTEXT_BYTES = 160_000;

const UUID_SCHEMA = z.string().uuid();

const InputSchema = z
  .object({
    brand_id: UUID_SCHEMA,
    run_id: UUID_SCHEMA.optional(),
    max_segments: z.number().int().min(1).max(MAX_SEGMENTS).default(10),
  })
  .strict();

const EvidenceSchema = z
  .object({
    signal: z.string().trim().min(1).max(240),
    explanation: z.string().trim().min(1).max(800),
    strength: z.enum(["strong", "medium", "weak"]),
    source: z.enum(["metric", "event", "imported_trait", "consent"]),
  })
  .strict();

const CampaignConceptSchema = z
  .object({
    objective: z.string().trim().min(1).max(500),
    angle: z.string().trim().min(1).max(800),
    offer: z.string().trim().min(1).max(500).optional(),
    timing: z.string().trim().min(1).max(300),
    callToAction: z.string().trim().min(1).max(240),
  })
  .strict();

const RepresentativeMessageSchema = z
  .object({
    customerReference: z
      .string()
      .trim()
      .regex(/^archetype_[a-z0-9_-]{1,64}$/u),
    subject: z.string().trim().min(1).max(160),
    preheader: z.string().trim().min(1).max(220),
    body: z.string().trim().min(1).max(5_000),
    rationale: z.string().trim().min(1).max(700),
  })
  .strict();

const RetentionScalarSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const SegmentPredicateSchema = z
  .object({
    type: z.literal("predicate"),
    namespace: z.enum(["consent", "evidence", "metric", "profile", "trait"]),
    key: z.string().trim().min(1).max(160),
    operator: z.enum([
      "after",
      "before",
      "contains",
      "equals",
      "exists",
      "greater_than",
      "greater_than_or_equal",
      "in",
      "less_than",
      "less_than_or_equal",
      "not_contains",
      "not_equals",
      "not_exists",
      "not_in",
    ]),
    value: z
      .union([RetentionScalarSchema, z.array(RetentionScalarSchema).max(100)])
      .optional(),
  })
  .strict();

const SegmentExpressionSchema: z.ZodType<WorklinSegmentExpression> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      SegmentPredicateSchema,
      z
        .object({
          type: z.literal("all"),
          expressions: z.array(SegmentExpressionSchema).min(1).max(40),
        })
        .strict(),
      z
        .object({
          type: z.literal("any"),
          expressions: z.array(SegmentExpressionSchema).min(1).max(40),
        })
        .strict(),
      z
        .object({
          type: z.literal("not"),
          expression: SegmentExpressionSchema,
        })
        .strict(),
    ]),
);

const SegmentProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1_000),
    expression: SegmentExpressionSchema,
    evidence: z.array(EvidenceSchema).min(1).max(10),
    confidence: z.number().min(0).max(1),
    campaignConcept: CampaignConceptSchema,
    representativeMessages: z
      .array(RepresentativeMessageSchema)
      .length(SAMPLE_MESSAGES_PER_SEGMENT),
    safety: z
      .object({
        sensitiveInferenceUsed: z.literal(false),
        unsupportedPersonalFactUsed: z.literal(false),
      })
      .strict(),
  })
  .strict();

const TrancheOutputSchema = z
  .object({
    proposals: z
      .array(SegmentProposalSchema)
      .min(1)
      .max(MAX_SEGMENTS_PER_TRANCHE),
  })
  .strict();

type SegmentProposal = z.infer<typeof SegmentProposalSchema>;
type ReviewSegment = SegmentProposal & {
  memberCount?: number;
  eligibleCount?: number;
};

type OperatorRequest = (
  context: ToolContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<ToolExecutionResult>;

export interface CampaignReviewPilotDependencies {
  operatorRequest: OperatorRequest;
  resolveProvider: () => Promise<Provider | null>;
  createDocument: typeof executeDocumentCreate;
  saveToCopybook: (
    input: CampaignReviewCopybookInput,
    context: ToolContext,
  ) => CampaignReviewCopybookResult;
}

const defaultDependencies: CampaignReviewPilotDependencies = {
  operatorRequest: retentionOperatorRequest,
  resolveProvider: () =>
    getConfiguredProvider("workflowLeaf", {
      requiredConnection: {
        name: PROVIDER_CONNECTION,
        provider: PROVIDER_NAME,
        authType: "oauth_subscription",
        model: MODEL,
      },
    }),
  createDocument: executeDocumentCreate,
  saveToCopybook: saveCampaignReviewToCopybook,
};

class PilotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PilotError";
  }
}

interface RunState {
  id: string;
  brandId: string;
  status: string;
  maxSegments: number;
  completedSegments: number;
}

interface ClaimState {
  leaseOwner: string;
  dossierSha256: string;
  requestedSegments: number;
  modelContext: unknown;
  existingSegments: Array<{
    name: string;
    expression: WorklinSegmentExpression;
  }>;
}

type SegmentReferenceAllowlist = Readonly<
  Record<
    "consent" | "evidence" | "metric" | "profile" | "trait",
    ReadonlySet<string>
  >
>;

interface RequestJsonResult {
  body: unknown;
}

export async function executeRetentionCampaignReviewPilot(
  input: Record<string, unknown>,
  context: ToolContext,
  dependencies: CampaignReviewPilotDependencies = defaultDependencies,
): Promise<ToolExecutionResult> {
  const parsedInput = InputSchema.safeParse(input);
  if (!parsedInput.success) {
    return errorResult(
      "invalid_campaign_review_input",
      "brand_id must be a UUID, run_id must be a UUID when provided, and max_segments must be between 1 and 50.",
    );
  }
  if (
    !context.platformOrganizationId ||
    !context.platformUserId ||
    !context.platformAssistantId
  ) {
    return errorResult(
      "platform_context_required",
      "This campaign review requires an authenticated Worklin workspace.",
    );
  }

  const { brand_id: brandId, max_segments: maxSegments } = parsedInput.data;

  try {
    let run = parsedInput.data.run_id
      ? parseRunState(
          (
            await requestJson(
              dependencies,
              context,
              "GET",
              `/v1/retention/segment-runs/${parsedInput.data.run_id}`,
            )
          ).body,
          brandId,
        )
      : parseRunState(
          (
            await requestJson(
              dependencies,
              context,
              "POST",
              "/v1/retention/segment-runs",
              {
                brandId,
                maxSegments,
                trancheSize: MAX_SEGMENTS_PER_TRANCHE,
                sampleLimitPerSegment: SAMPLE_MESSAGES_PER_SEGMENT,
              },
            )
          ).body,
          brandId,
          undefined,
          0,
        );

    if (run.brandId !== brandId) {
      return errorResult(
        "segment_run_brand_mismatch",
        "The selected segment run belongs to a different brand.",
      );
    }

    if (run.status === "completed") {
      return await finishCompletedRun(run, context, dependencies);
    }
    if (run.status === "failed") {
      return errorResult(
        "segment_run_failed",
        "This segment run failed and cannot be resumed.",
      );
    }

    let modelCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    while (
      modelCalls < MAX_MODEL_CALLS &&
      run.completedSegments < run.maxSegments
    ) {
      if (context.signal?.aborted) {
        return pausedResult(run, "cancelled", context);
      }

      const remaining = Math.min(
        MAX_SEGMENTS_PER_TRANCHE,
        run.maxSegments - run.completedSegments,
      );
      const claimResponse = await requestJson(
        dependencies,
        context,
        "POST",
        `/v1/retention/segment-runs/${run.id}/claim`,
        { resume: run.status === "paused" },
      );
      const claim = parseClaimState(claimResponse.body, run, remaining);

      modelCalls += 1;
      let provider: Provider | null;
      try {
        provider = await dependencies.resolveProvider();
      } catch {
        await completeClaim(dependencies, context, run.id, claim, {
          outcome: "pause",
          errorCode: "chatgpt_subscription_unavailable",
          definitions: [],
        });
        return pausedResult(run, "chatgpt_subscription_unavailable", context);
      }
      if (!provider) {
        await completeClaim(dependencies, context, run.id, claim, {
          outcome: "pause",
          errorCode: "chatgpt_subscription_unavailable",
          definitions: [],
        });
        return pausedResult(run, "chatgpt_subscription_unavailable", context);
      }

      let proposals: SegmentProposal[];
      let usage: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
      };
      try {
        const generated = await generateTranche(provider, claim, context);
        proposals = generated.proposals;
        usage = generated.usage;
      } catch (error) {
        if (isQuotaError(error)) {
          await completeClaim(dependencies, context, run.id, claim, {
            outcome: "pause",
            errorCode: "provider_quota",
            definitions: [],
          });
          return pausedResult(run, "provider_quota", context);
        }
        await completeClaim(dependencies, context, run.id, claim, {
          outcome: "pause",
          errorCode:
            error instanceof PilotError
              ? error.code
              : "campaign_review_generation_failed",
          definitions: [],
        });
        return pausedResult(
          run,
          error instanceof PilotError
            ? error.code
            : "campaign_review_generation_failed",
          context,
        );
      }

      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      if (
        totalInputTokens > MAX_TOTAL_INPUT_TOKENS ||
        totalOutputTokens > MAX_TOTAL_OUTPUT_TOKENS
      ) {
        await completeClaim(dependencies, context, run.id, claim, {
          outcome: "pause",
          errorCode: "model_token_limit",
          definitions: [],
        });
        return pausedResult(run, "model_token_limit", context);
      }

      const completionOutcome =
        proposals.length < claim.requestedSegments ||
        run.completedSegments + proposals.length >= run.maxSegments
          ? "complete"
          : "continue";
      const completion = await completeClaim(
        dependencies,
        context,
        run.id,
        claim,
        {
          outcome: completionOutcome,
          definitions: completionDefinitions(proposals, usage),
        },
      );
      run = parseRunState(completion.body, brandId, run.maxSegments);
      if (run.completedSegments > MAX_SEGMENTS) {
        throw new PilotError(
          "segment_run_limit_exceeded",
          "The central service reported more than 50 segment proposals.",
        );
      }
      if (
        run.completedSegments * SAMPLE_MESSAGES_PER_SEGMENT >
        MAX_SAMPLE_MESSAGES
      ) {
        throw new PilotError(
          "sample_message_limit_exceeded",
          "The central service reported more than 100 sample messages.",
        );
      }
      if (run.status === "completed") {
        return await finishCompletedRun(run, context, dependencies);
      }
    }

    return pausedResult(run, "model_call_limit_reached", context);
  } catch (error) {
    if (error instanceof PilotError) {
      return errorResult(error.code, error.message);
    }
    return errorResult(
      "campaign_review_unavailable",
      "Worklin could not reach the customer-intelligence service.",
    );
  }
}

async function requestJson(
  dependencies: CampaignReviewPilotDependencies,
  context: ToolContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<RequestJsonResult> {
  const result = await dependencies.operatorRequest(
    context,
    method,
    path,
    body,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned an invalid response.",
    );
  }
  if (result.isError) {
    throw new PilotError(
      "retention_service_request_failed",
      "The customer-intelligence service could not complete this request.",
      parsed,
    );
  }
  return { body: parsed };
}

function parseRunState(
  value: unknown,
  fallbackBrandId?: string,
  fallbackMaxSegments?: number,
  fallbackCompletedSegments?: number,
): RunState {
  const root = recordValue(value);
  const run = recordValue(root.run ?? root.segmentRun ?? root);
  const id = stringValue(run.id ?? run.runId);
  const brandId = stringValue(run.brandId) || fallbackBrandId || "";
  const status = stringValue(run.status);
  const maxSegments = integerValue(run.maxSegments ?? fallbackMaxSegments);
  const completedSegments = integerValue(
    run.completedSegmentCount ?? fallbackCompletedSegments,
  );
  if (
    !UUID_SCHEMA.safeParse(id).success ||
    !UUID_SCHEMA.safeParse(brandId).success ||
    !["queued", "claimed", "paused", "completed", "failed"].includes(status) ||
    maxSegments < 1 ||
    maxSegments > MAX_SEGMENTS ||
    completedSegments < 0 ||
    completedSegments > maxSegments
  ) {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned an invalid segment run.",
    );
  }
  return {
    id,
    brandId,
    status,
    maxSegments,
    completedSegments,
  };
}

function parseClaimState(
  value: unknown,
  run: RunState,
  requested: number,
): ClaimState {
  const claim = recordValue(value);
  const limits = recordValue(claim.limits);
  const runId = stringValue(claim.runId);
  const leaseOwner = stringValue(claim.leaseOwner);
  const leaseExpiresAt = stringValue(claim.leaseExpiresAt);
  const dossierSha256 = stringValue(claim.dossierSha256);
  const maxSegments = integerValue(limits.maxSegments);
  const completedSegments = integerValue(limits.completedSegments);
  const remainingSegments = integerValue(limits.remainingSegments);
  const trancheSize = integerValue(limits.trancheSize);
  const sampleLimitPerSegment = integerValue(limits.sampleLimitPerSegment);
  const existingSegments = parseExistingSegments(claim.existingSegments);
  if (
    runId !== run.id ||
    !leaseOwner.startsWith("segment-run:") ||
    leaseOwner.length < 20 ||
    leaseOwner.length > 128 ||
    !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    !/^[0-9a-f]{64}$/iu.test(dossierSha256) ||
    maxSegments !== run.maxSegments ||
    completedSegments !== run.completedSegments ||
    remainingSegments !== run.maxSegments - run.completedSegments ||
    trancheSize < 1 ||
    trancheSize > MAX_SERVICE_TRANCHE_SIZE ||
    sampleLimitPerSegment !== SAMPLE_MESSAGES_PER_SEGMENT ||
    existingSegments.length !== completedSegments
  ) {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned an invalid segment claim.",
    );
  }
  const requestedSegments = Math.min(requested, remainingSegments, trancheSize);
  if (requestedSegments < 1) {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned an empty segment claim.",
    );
  }
  return {
    leaseOwner,
    dossierSha256,
    requestedSegments,
    modelContext: claim.dossier,
    existingSegments,
  };
}

function parseExistingSegments(value: unknown): ClaimState["existingSegments"] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned invalid prior audiences.",
    );
  }
  const names = new Set<string>();
  return value.map((item) => {
    const record = recordValue(item);
    const name = stringValue(record.name).trim();
    const expression = SegmentExpressionSchema.safeParse(record.expression);
    const normalizedName = name.toLocaleLowerCase();
    if (
      name.length === 0 ||
      name.length > 200 ||
      names.has(normalizedName) ||
      !expression.success
    ) {
      throw new PilotError(
        "retention_service_response_invalid",
        "The customer-intelligence service returned invalid prior audiences.",
      );
    }
    names.add(normalizedName);
    return { name, expression: expression.data };
  });
}

async function generateTranche(
  provider: Provider,
  claim: ClaimState,
  context: ToolContext,
): Promise<{
  proposals: SegmentProposal[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}> {
  const modelContext = sanitizeSegmentModelContext(
    sanitizeForModel(claim.modelContext),
  );
  const referenceAllowlist = segmentReferenceAllowlist(modelContext);
  const serializedContext = JSON.stringify({
    evidence: modelContext,
    previouslyGeneratedAudiences: claim.existingSegments,
  });
  if (Buffer.byteLength(serializedContext, "utf8") > MAX_MODEL_CONTEXT_BYTES) {
    throw new PilotError(
      "segment_claim_context_too_large",
      "The claimed customer evidence is too large for a bounded reasoning pass.",
    );
  }

  const tool: ToolDefinition = {
    name: STRUCTURED_TOOL_NAME,
    description:
      "Return evidence-backed Worklin segment proposals and complete review-only email drafts.",
    input_schema: trancheOutputJsonSchema(
      claim.requestedSegments,
      referenceAllowlist,
    ),
  };
  const response = await provider.sendMessage(
    [userMessage(buildPrompt(serializedContext, claim.requestedSegments))],
    {
      tools: [tool],
      systemPrompt:
        "You are Worklin's retention decisioning analyst. Use only supplied aggregate evidence. Return the required tool call and no prose.",
      config: {
        callSite: "workflowLeaf",
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS_PER_CALL,
        effort: "medium",
        verbosity: "low",
        disableCache: true,
        retryMode: "none",
      },
      ...(context.signal ? { signal: context.signal } : {}),
    },
  );
  const toolUse = extractToolUse(response);
  if (!toolUse || toolUse.name !== STRUCTURED_TOOL_NAME) {
    throw new PilotError(
      "structured_segment_output_missing",
      "The model did not return the required structured segment result.",
    );
  }
  const parsed = TrancheOutputSchema.safeParse(toolUse.input);
  if (
    !parsed.success ||
    parsed.data.proposals.length > claim.requestedSegments
  ) {
    throw new PilotError(
      "structured_segment_output_invalid",
      "The model returned an invalid or oversized segment result.",
    );
  }
  validateProposals(
    parsed.data.proposals,
    referenceAllowlist,
    claim.existingSegments,
    hasBehaviorCombinations(modelContext),
  );
  return {
    proposals: parsed.data.proposals,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      ...(response.usage.cacheReadInputTokens !== undefined
        ? { cachedInputTokens: response.usage.cacheReadInputTokens }
        : {}),
    },
  };
}

function validateProposals(
  proposals: SegmentProposal[],
  referenceAllowlist?: SegmentReferenceAllowlist,
  existingSegments: ClaimState["existingSegments"] = [],
  requireMultiSignal = false,
): void {
  const names = new Set(
    existingSegments.map((segment) => segment.name.toLocaleLowerCase()),
  );
  const expressionFingerprints = new Set(
    existingSegments.map((segment) =>
      segmentExpressionFingerprint(segment.expression),
    ),
  );
  const messageFingerprints = new Set<string>();
  for (const proposal of proposals) {
    const normalizedName = proposal.name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      throw new PilotError(
        "duplicate_segment_proposal",
        "The model returned duplicate segment proposals.",
      );
    }
    names.add(normalizedName);

    const expression = proposal.expression;
    const expressionValidation = validateWorklinSegmentExpression(expression, {
      maxDepth: 6,
      maxNodes: 40,
    });
    if (!expressionValidation.ok) {
      throw new PilotError(
        "invalid_segment_expression",
        expressionValidation.error.message,
      );
    }
    if (requireMultiSignal) {
      if (strategicPredicateFingerprints(expression).size < 2) {
        throw new PilotError(
          "segment_proposal_too_obvious",
          "The model returned a single-signal audience even though stronger cross-signal evidence was available.",
        );
      }
    }
    validateServiceCompatibleExpression(expression, referenceAllowlist);
    const expressionFingerprint = segmentExpressionFingerprint(expression);
    if (expressionFingerprints.has(expressionFingerprint)) {
      throw new PilotError(
        "duplicate_segment_proposal",
        "The model returned a segment that duplicates an audience already saved in this run.",
      );
    }
    expressionFingerprints.add(expressionFingerprint);
    if (containsSensitiveExpressionKey(expression)) {
      throw new PilotError(
        "sensitive_segment_expression",
        "The model attempted to use a sensitive or protected trait in a segment.",
      );
    }
    assertNoDirectIdentifiers(proposal);
    if (containsSensitiveGuessLanguage(proposal)) {
      throw new PilotError(
        "sensitive_personalization_guess",
        "The model attempted to state or imply a sensitive personal guess.",
      );
    }
    validateCampaignPreviewQuality(proposal, messageFingerprints);
  }
}

function strategicPredicateFingerprints(
  expression: WorklinSegmentExpression,
): ReadonlySet<string> {
  if (expression.type === "predicate") {
    return new Set(
      ["evidence", "metric", "trait"].includes(expression.namespace)
        ? [segmentExpressionFingerprint(expression)]
        : [],
    );
  }
  if (expression.type === "not") {
    return strategicPredicateFingerprints(expression.expression);
  }
  return new Set(
    expression.expressions.flatMap((child) => [
      ...strategicPredicateFingerprints(child),
    ]),
  );
}

function segmentExpressionFingerprint(
  expression: WorklinSegmentExpression,
): string {
  if (expression.type === "predicate") {
    return JSON.stringify({
      type: expression.type,
      namespace: expression.namespace,
      key: expression.key,
      operator: expression.operator,
      ...(expression.value !== undefined ? { value: expression.value } : {}),
    });
  }
  if (expression.type === "not") {
    return JSON.stringify({
      type: expression.type,
      expression: segmentExpressionFingerprint(expression.expression),
    });
  }
  return JSON.stringify({
    type: expression.type,
    expressions: expression.expressions
      .map(segmentExpressionFingerprint)
      .sort(),
  });
}

function validateCampaignPreviewQuality(
  proposal: SegmentProposal,
  messageFingerprints: Set<string>,
): void {
  for (const message of proposal.representativeMessages) {
    if (
      wordCount(message.subject) < 2 ||
      wordCount(message.body) < 80 ||
      wordCount(message.body) > 300 ||
      wordCount(message.rationale) < 8
    ) {
      throw new PilotError(
        "campaign_preview_quality_failed",
        "A campaign sample was too thin to be useful for human review.",
      );
    }
    const normalized = `${message.subject}\n${message.body}`
      .toLocaleLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
    if (messageFingerprints.has(normalized)) {
      throw new PilotError(
        "campaign_preview_quality_failed",
        "The campaign samples were repetitive across the generated tranche.",
      );
    }
    messageFingerprints.add(normalized);
  }
}

function completionDefinitions(
  proposals: SegmentProposal[],
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  },
): Array<Record<string, unknown>> {
  return proposals.map((proposal, index) => ({
    name: proposal.name,
    description: proposal.description,
    expression: proposal.expression,
    confidence: proposal.confidence,
    evidence: proposal.evidence.map((evidence) => JSON.stringify(evidence)),
    campaignPreview: {
      strategy: proposal.campaignConcept,
      qualityStatus: "passed",
      qualityIssues: [],
      modelProvider: PROVIDER_NAME,
      modelId: MODEL,
      promptVersion: PROMPT_VERSION,
      usage: {
        inputTokens: apportionedUsage(
          usage.inputTokens,
          proposals.length,
          index,
        ),
        outputTokens: apportionedUsage(
          usage.outputTokens,
          proposals.length,
          index,
        ),
        ...(usage.cachedInputTokens !== undefined
          ? {
              cachedInputTokens: apportionedUsage(
                usage.cachedInputTokens,
                proposals.length,
                index,
              ),
            }
          : {}),
      },
      samples: proposal.representativeMessages.map((message) => ({
        customerReference: message.customerReference,
        subject: message.subject,
        preheader: message.preheader,
        body: message.body,
        explanation: message.rationale,
      })),
    },
  }));
}

function apportionedUsage(total: number, count: number, index: number): number {
  const base = Math.floor(total / count);
  return base + (index < total % count ? 1 : 0);
}

async function completeClaim(
  dependencies: CampaignReviewPilotDependencies,
  context: ToolContext,
  runId: string,
  claim: ClaimState,
  result: Record<string, unknown>,
): Promise<RequestJsonResult> {
  return requestJson(
    dependencies,
    context,
    "POST",
    `/v1/retention/segment-runs/${runId}/complete`,
    {
      leaseOwner: claim.leaseOwner,
      ...result,
    },
  );
}

async function finishCompletedRun(
  run: RunState,
  context: ToolContext,
  dependencies: CampaignReviewPilotDependencies,
): Promise<ToolExecutionResult> {
  const response = await requestJson(
    dependencies,
    context,
    "GET",
    `/v1/retention/segment-runs/${run.id}/segments`,
  );
  const storedResult = parseStoredSegmentResult(response.body);
  const { segments } = storedResult;
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) {
    throw new PilotError(
      "retention_segments_unavailable",
      "The completed run did not return a bounded set of review segments.",
    );
  }
  const documentTitle = `${storedResult.brandName}: ${DOCUMENT_SUFFIX}`;
  assertNoDirectIdentifiers(documentTitle);
  const markdown = buildDocumentMarkdown(documentTitle, segments);
  assertNoDirectIdentifiers(markdown);
  let copybook: CampaignReviewCopybookResult;
  try {
    copybook = dependencies.saveToCopybook(
      {
        runId: run.id,
        brandName: storedResult.brandName,
        markdown,
        campaigns: segments.map((segment) => ({
          title: segment.name,
          ...(segment.memberCount !== undefined
            ? { memberCount: segment.memberCount }
            : {}),
          ...(segment.eligibleCount !== undefined
            ? { eligibleCount: segment.eligibleCount }
            : {}),
        })),
      },
      context,
    );
  } catch {
    copybook = { saved: false, reason: "copybook_document_unavailable" };
  }
  const document = copybook.saved
    ? { surfaceId: copybook.documentSurfaceId, opened: false }
    : parseDocumentResult(
        dependencies.createDocument(
          { title: documentTitle, initial_content: markdown },
          context,
        ),
      );
  const sampleCount = segments.reduce(
    (total, segment) => total + segment.representativeMessages.length,
    0,
  );

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `retention-review-result-${randomUUID()}`,
    surfaceType: "work_result",
    display: "inline",
    title: copybook.saved ? "Copybook Drafts Ready" : "Campaign Review Ready",
    data: {
      eyebrow: "Worklin retention",
      status: "completed",
      summary: copybook.saved
        ? "Worklin added complete, editable email drafts to this brand's Copybook for human review. Nothing was written to or sent through Klaviyo."
        : "Worklin prepared complete email drafts in an editable Work document. Add a matching Brand Brain to place future runs directly in Copybook. Nothing was written to or sent through Klaviyo.",
      metrics: [
        {
          label: "Audiences",
          value: segments.length,
          detail: "Evidence-backed Worklin definitions",
          tone: "positive",
        },
        {
          label: "Email drafts",
          value: sampleCount,
          detail: "Two complete alternatives per audience",
          tone: "neutral",
        },
        {
          label: "Delivery status",
          value: "Review only",
          detail: "No Klaviyo writes or sends",
          tone: "positive",
        },
      ],
      sections: [
        {
          id: "artifact",
          title: copybook.saved ? "Copybook" : "Editable result",
          type: "artifacts",
          items: [
            {
              id: document.surfaceId,
              title: documentTitle,
              description: copybook.saved
                ? "Open this month's Copybook to review and edit the drafts."
                : "Open the Worklin document to edit the drafts.",
              status: "Ready",
              tone: "positive",
            },
          ],
        },
      ],
    },
  });

  return jsonResult({
    success: true,
    status: "completed",
    reviewOnly: true,
    externalActionTaken: false,
    runId: run.id,
    brandId: run.brandId,
    segmentCount: segments.length,
    sampleMessageCount: sampleCount,
    providerConnection: PROVIDER_CONNECTION,
    model: MODEL,
    document: {
      surfaceId: document.surfaceId,
      title: documentTitle,
      opened: document.opened,
    },
    copybook: copybook.saved
      ? {
          saved: true,
          copybookId: copybook.copybookId,
          monthId: copybook.monthId,
          campaignsCreated: copybook.campaignsCreated,
        }
      : { saved: false, reason: copybook.reason },
  });
}

function pausedResult(
  run: RunState,
  reason: string,
  context: ToolContext,
): ToolExecutionResult {
  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `retention-review-paused-${randomUUID()}`,
    surfaceType: "work_result",
    display: "inline",
    title: "Campaign Review Paused",
    data: {
      eyebrow: "Worklin retention",
      status: "partial",
      summary:
        reason === "provider_quota"
          ? "The ChatGPT subscription reached a usage limit. Progress is saved and this run can resume later."
          : "Progress is saved and this campaign review can resume safely.",
      metrics: [
        {
          label: "Audiences completed",
          value: run.completedSegments,
          tone: "neutral",
        },
        {
          label: "Status",
          value: "Resumable",
          tone: "warning",
        },
        {
          label: "Klaviyo changes",
          value: "None",
          tone: "positive",
        },
      ],
    },
  });
  return jsonResult({
    success: true,
    status: "paused",
    resumable: true,
    reviewOnly: true,
    externalActionTaken: false,
    reason,
    runId: run.id,
    brandId: run.brandId,
    completedSegments: run.completedSegments,
    completedSamples: run.completedSegments * SAMPLE_MESSAGES_PER_SEGMENT,
    providerConnection: PROVIDER_CONNECTION,
    model: MODEL,
  });
}

function parseStoredSegmentResult(value: unknown): {
  brandName: string;
  segments: ReviewSegment[];
} {
  const root = recordValue(value);
  const brandName = stringValue(root.brandName);
  if (
    !brandName ||
    brandName.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(brandName)
  ) {
    throw new PilotError(
      "retention_service_response_invalid",
      "The customer-intelligence service returned an invalid brand name.",
    );
  }
  const raw = Array.isArray(root.segments)
    ? root.segments
    : Array.isArray(root.items)
      ? root.items
      : [];
  const segments = raw.map((item) => {
    const record = recordValue(item);
    const preview = recordValue(record.campaignPreview);
    const strategy = recordValue(
      preview.strategy ?? record.campaignConcept ?? preview,
    );
    const evidence = normalizeStoredEvidence(
      preview.evidence ?? record.evidence,
    );
    const samples = Array.isArray(preview.samples)
      ? preview.samples.map((item) => {
          const sample = recordValue(item);
          return {
            customerReference: sample.customerReference,
            subject: sample.subject,
            preheader: sample.preheader,
            body: sample.body,
            rationale: sample.explanation ?? sample.rationale,
          };
        })
      : record.representativeMessages;
    const candidate = {
      name: record.name,
      description: record.description ?? preview.description,
      expression: record.expression,
      evidence,
      confidence: record.confidence ?? preview.confidence,
      campaignConcept: strategy,
      representativeMessages: samples,
      safety: {
        sensitiveInferenceUsed: false,
        unsupportedPersonalFactUsed: false,
      },
    };
    const parsed = SegmentProposalSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new PilotError(
        "retention_service_response_invalid",
        "The customer-intelligence service returned an invalid stored segment.",
      );
    }
    validateProposals([parsed.data]);
    const memberCount = optionalBoundedCount(record.memberCount, 10_000_000);
    const eligibleCount = optionalBoundedCount(
      record.eligibleCount,
      10_000_000,
    );
    return {
      ...parsed.data,
      ...(memberCount !== undefined ? { memberCount } : {}),
      ...(eligibleCount !== undefined ? { eligibleCount } : {}),
    };
  });
  return { brandName, segments };
}

function normalizeStoredEvidence(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item !== "string") return item;
    try {
      return JSON.parse(item) as unknown;
    } catch {
      throw new PilotError(
        "retention_service_response_invalid",
        "The customer-intelligence service returned invalid segment evidence.",
      );
    }
  });
}

function parseDocumentResult(result: ToolExecutionResult): {
  surfaceId: string;
  opened: boolean;
} {
  if (result.isError) {
    throw new PilotError(
      "campaign_review_document_failed",
      "Worklin could not create the editable campaign review document.",
    );
  }
  try {
    const parsed = recordValue(JSON.parse(result.content));
    const surfaceId = stringValue(parsed.surface_id);
    if (!surfaceId) throw new Error("missing surface id");
    return { surfaceId, opened: parsed.opened === true };
  } catch {
    throw new PilotError(
      "campaign_review_document_failed",
      "Worklin could not create the editable campaign review document.",
    );
  }
}

function buildPrompt(
  serializedContext: string,
  requestedSegments: number,
): string {
  return [
    `Propose up to ${requestedSegments} distinct, useful retention audiences from the supplied account-wide evidence. Do not pad the result.`,
    "Study evidence.profileCoverage and evidence.behaviorCombinations first. When combinations are present, every proposed audience must combine at least two independent strategic signals from evidence, metric, or trait fields. Prefer non-obvious relationships that explain a useful customer moment, not generic groups such as all subscribers, all openers, or everyone with an email address.",
    "Use behaviorCombinations as anonymous evidence, then write a valid Worklin expression that recreates the combination. Do not claim causation from correlation, and do not use a small cohort merely because it is small.",
    "The evidence packet includes previouslyGeneratedAudiences. Do not repeat, rename, narrowly restate, or reuse the same targeting expression as any of them. Propose only materially different audiences supported by the evidence.",
    `Create exactly ${SAMPLE_MESSAGES_PER_SEGMENT} complete email drafts per proposed audience. Each body must be 120 to 250 words, ready for a marketer to edit and use, with a clear opening, useful substance, and one natural call to action. The two drafts must use materially different creative approaches rather than superficial rewrites.`,
    "Use only factual signals present in the evidence. Do not infer or mention health, religion, race, ethnicity, political views, sexuality, pregnancy, disability, marital status, financial hardship, or other sensitive personal facts.",
    "Never output an email address, phone number, full customer name, provider identifier, or internal lease data. customerReference must be an opaque archetype label such as archetype_example_1.",
    "Every expression must be a Worklin expression using predicate, all, any, or not nodes. Predicate namespaces are consent, evidence, metric, profile, and trait.",
    'Use exactly these node shapes: {"type":"predicate","namespace":"metric","key":"source_event_count","operator":"greater_than","value":0}; {"type":"all","expressions":[...]}; {"type":"any","expressions":[...]}; or {"type":"not","expression":{...}}. exists and not_exists omit value; every other operator includes value.',
    "Use only namespace and key pairs listed under evidence.expressionGrammar.namespaces. Copy every key exactly, including punctuation.",
    "Return false for both safety flags. If the evidence cannot support a safe proposal, return fewer proposals.",
    "Evidence packet:",
    serializedContext,
  ].join("\n\n");
}

function buildDocumentMarkdown(
  documentTitle: string,
  segments: ReviewSegment[],
): string {
  const lines = [
    `# ${escapeMarkdown(documentTitle)}`,
    "",
    "> Review only. Worklin has not created, changed, scheduled, or sent anything in Klaviyo.",
    "",
    `Prepared ${segments.length} evidence-backed audience ideas with ${segments.length * SAMPLE_MESSAGES_PER_SEGMENT} complete email drafts.`,
    "",
  ];
  segments.forEach((segment, index) => {
    lines.push(
      `## ${index + 1}. ${escapeMarkdown(segment.name)}`,
      "",
      escapeMarkdown(segment.description),
      "",
      `**Confidence:** ${Math.round(segment.confidence * 100)}%`,
      ...(segment.memberCount !== undefined
        ? [`**Customers:** ${segment.memberCount}`]
        : []),
      ...(segment.eligibleCount !== undefined
        ? [`**Eligible now:** ${segment.eligibleCount}`]
        : []),
      "",
      "### Evidence",
      "",
      ...segment.evidence.map(
        (evidence) =>
          `- **${escapeMarkdown(evidence.strength)}:** ${escapeMarkdown(evidence.signal)}. ${escapeMarkdown(evidence.explanation)}`,
      ),
      "",
      "### Campaign idea",
      "",
      `- **Objective:** ${escapeMarkdown(segment.campaignConcept.objective)}`,
      `- **Angle:** ${escapeMarkdown(segment.campaignConcept.angle)}`,
      `- **Timing:** ${escapeMarkdown(segment.campaignConcept.timing)}`,
      `- **Call to action:** ${escapeMarkdown(segment.campaignConcept.callToAction)}`,
      ...(segment.campaignConcept.offer
        ? [`- **Offer:** ${escapeMarkdown(segment.campaignConcept.offer)}`]
        : []),
      "",
      "### Complete email drafts",
      "",
    );
    segment.representativeMessages.forEach((message, messageIndex) => {
      lines.push(
        `#### Draft ${messageIndex + 1}`,
        "",
        `**Subject:** ${escapeMarkdown(message.subject)}`,
        "",
        `**Preheader:** ${escapeMarkdown(message.preheader)}`,
        "",
        message.body,
        "",
        `**Why this version:** ${escapeMarkdown(message.rationale)}`,
        "",
      );
    });
  });
  return lines.join("\n");
}

function trancheOutputJsonSchema(
  maxItems: number,
  referenceAllowlist: SegmentReferenceAllowlist,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    $defs: segmentExpressionJsonSchemaDefinitions(referenceAllowlist),
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        minItems: 1,
        maxItems,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "description",
            "expression",
            "evidence",
            "confidence",
            "campaignConcept",
            "representativeMessages",
            "safety",
          ],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", minLength: 1, maxLength: 1_000 },
            expression: { $ref: "#/$defs/segmentExpression" },
            evidence: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["signal", "explanation", "strength", "source"],
                properties: {
                  signal: { type: "string", maxLength: 240 },
                  explanation: { type: "string", maxLength: 800 },
                  strength: { enum: ["strong", "medium", "weak"] },
                  source: {
                    enum: ["metric", "event", "imported_trait", "consent"],
                  },
                },
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            campaignConcept: {
              type: "object",
              additionalProperties: false,
              required: ["objective", "angle", "timing", "callToAction"],
              properties: {
                objective: { type: "string", maxLength: 500 },
                angle: { type: "string", maxLength: 800 },
                offer: { type: "string", maxLength: 500 },
                timing: { type: "string", maxLength: 300 },
                callToAction: { type: "string", maxLength: 240 },
              },
            },
            representativeMessages: {
              type: "array",
              minItems: SAMPLE_MESSAGES_PER_SEGMENT,
              maxItems: SAMPLE_MESSAGES_PER_SEGMENT,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "customerReference",
                  "subject",
                  "preheader",
                  "body",
                  "rationale",
                ],
                properties: {
                  customerReference: {
                    type: "string",
                    pattern: "^archetype_[a-z0-9_-]{1,64}$",
                  },
                  subject: { type: "string", maxLength: 160 },
                  preheader: { type: "string", maxLength: 220 },
                  body: { type: "string", maxLength: 5_000 },
                  rationale: { type: "string", maxLength: 700 },
                },
              },
            },
            safety: {
              type: "object",
              additionalProperties: false,
              required: [
                "sensitiveInferenceUsed",
                "unsupportedPersonalFactUsed",
              ],
              properties: {
                sensitiveInferenceUsed: { const: false },
                unsupportedPersonalFactUsed: { const: false },
              },
            },
          },
        },
      },
    },
  };
}

function segmentExpressionJsonSchemaDefinitions(
  referenceAllowlist: SegmentReferenceAllowlist,
): Record<string, unknown> {
  const scalar = {
    anyOf: [
      { type: "string", maxLength: 512 },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
    ],
  };
  const predicateProperties = {
    type: { const: "predicate" },
    namespace: {
      enum: ["consent", "evidence", "metric", "profile", "trait"],
    },
    key: {
      type: "string",
      enum: [
        ...new Set(
          Object.values(referenceAllowlist).flatMap((keys) => [...keys]),
        ),
      ].sort(),
    },
  };

  return {
    segmentExpression: {
      oneOf: [
        { $ref: "#/$defs/predicateWithoutValue" },
        { $ref: "#/$defs/predicateWithValue" },
        { $ref: "#/$defs/allExpression" },
        { $ref: "#/$defs/anyExpression" },
        { $ref: "#/$defs/notExpression" },
      ],
    },
    predicateWithoutValue: {
      type: "object",
      additionalProperties: false,
      required: ["type", "namespace", "key", "operator"],
      properties: {
        ...predicateProperties,
        operator: { enum: ["exists", "not_exists"] },
      },
    },
    predicateWithValue: {
      type: "object",
      additionalProperties: false,
      required: ["type", "namespace", "key", "operator", "value"],
      properties: {
        ...predicateProperties,
        operator: {
          enum: [
            "after",
            "before",
            "contains",
            "equals",
            "greater_than",
            "greater_than_or_equal",
            "in",
            "less_than",
            "less_than_or_equal",
            "not_contains",
            "not_equals",
            "not_in",
          ],
        },
        value: {
          anyOf: [
            scalar,
            {
              type: "array",
              maxItems: 100,
              items: scalar,
            },
          ],
        },
      },
    },
    allExpression: {
      type: "object",
      additionalProperties: false,
      required: ["type", "expressions"],
      properties: {
        type: { const: "all" },
        expressions: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: { $ref: "#/$defs/segmentExpression" },
        },
      },
    },
    anyExpression: {
      type: "object",
      additionalProperties: false,
      required: ["type", "expressions"],
      properties: {
        type: { const: "any" },
        expressions: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: { $ref: "#/$defs/segmentExpression" },
        },
      },
    },
    notExpression: {
      type: "object",
      additionalProperties: false,
      required: ["type", "expression"],
      properties: {
        type: { const: "not" },
        expression: { $ref: "#/$defs/segmentExpression" },
      },
    },
  };
}

const DIRECT_IDENTIFIER_KEY =
  /(?:^|_)(?:email|phone|mobile|full_name)(?:$|_)/iu;
const INTERNAL_KEY =
  /(?:lease|token|checksum|secret|credential|claim_id|job_id)/iu;
const SENSITIVE_KEY =
  /(?:health|medical|diagnosis|religion|race|ethnicity|sexual|pregnan|disab|politic|marital|married|single_status|financial_hardship)/iu;
const SEGMENT_MODEL_KEY_MAX_LENGTH = 160;

function sanitizeForModel(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[omitted]";
  if (typeof value === "string")
    return redactDirectIdentifiers(value).slice(0, 4_000);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value == null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeForModel(item, depth + 1));
  }
  if (typeof value !== "object") return String(value).slice(0, 200);
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 200)) {
    if (
      DIRECT_IDENTIFIER_KEY.test(key) ||
      INTERNAL_KEY.test(key) ||
      SENSITIVE_KEY.test(key)
    ) {
      continue;
    }
    result[key] = sanitizeForModel(nested, depth + 1);
  }
  return result;
}

function sanitizeSegmentModelContext(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = { ...(value as Record<string, unknown>) };
  const grammar =
    root.expressionGrammar &&
    typeof root.expressionGrammar === "object" &&
    !Array.isArray(root.expressionGrammar)
      ? { ...(root.expressionGrammar as Record<string, unknown>) }
      : {};
  const namespaces =
    grammar.namespaces &&
    typeof grammar.namespaces === "object" &&
    !Array.isArray(grammar.namespaces)
      ? { ...(grammar.namespaces as Record<string, unknown>) }
      : {};

  for (const namespace of [
    "consent",
    "evidence",
    "metric",
    "profile",
    "trait",
  ] as const) {
    const keys = Array.isArray(namespaces[namespace])
      ? namespaces[namespace]
      : [];
    namespaces[namespace] = keys.filter(
      (key): key is string =>
        isSafeSegmentModelKey(key) &&
        (namespace !== "trait" || !SENSITIVE_KEY.test(key)),
    );
  }
  grammar.namespaces = namespaces;
  root.expressionGrammar = grammar;

  const allowedTraits = new Set(
    (namespaces.trait as string[] | undefined) ?? [],
  );
  if (Array.isArray(root.availableTraits)) {
    root.availableTraits = root.availableTraits.filter((item) => {
      const trait = recordValue(item);
      const key = stringValue(trait.key);
      return allowedTraits.has(key);
    });
  }
  return root;
}

function hasBehaviorCombinations(value: unknown): boolean {
  const root = recordValue(value);
  return (
    Array.isArray(root.behaviorCombinations) &&
    root.behaviorCombinations.length > 0
  );
}

function isSafeSegmentModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= SEGMENT_MODEL_KEY_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function segmentReferenceAllowlist(value: unknown): SegmentReferenceAllowlist {
  const root = recordValue(value);
  const grammar = recordValue(root.expressionGrammar);
  const namespaces = recordValue(grammar.namespaces);
  const keys = (
    namespace: keyof SegmentReferenceAllowlist,
  ): ReadonlySet<string> =>
    new Set(
      (Array.isArray(namespaces[namespace])
        ? namespaces[namespace]
        : []
      ).filter(isSafeSegmentModelKey),
    );
  return {
    consent: keys("consent"),
    evidence: keys("evidence"),
    metric: keys("metric"),
    profile: keys("profile"),
    trait: keys("trait"),
  };
}

function validateServiceCompatibleExpression(
  expression: WorklinSegmentExpression,
  referenceAllowlist?: SegmentReferenceAllowlist,
): void {
  if (expression.type === "predicate") {
    if (
      referenceAllowlist &&
      !referenceAllowlist[expression.namespace].has(expression.key)
    ) {
      throw new PilotError(
        "unsafe_segment_reference",
        "The model used a customer field that was not included in the approved evidence grammar.",
      );
    }
    if (
      (expression.operator === "in" || expression.operator === "not_in") &&
      !Array.isArray(expression.value)
    ) {
      throw new PilotError(
        "invalid_segment_expression",
        "List segment operators require a list value.",
      );
    }
    if (
      [
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
      ].includes(expression.operator) &&
      typeof expression.value !== "number"
    ) {
      throw new PilotError(
        "invalid_segment_expression",
        "Numeric segment operators require a numeric value.",
      );
    }
    if (
      (expression.operator === "after" || expression.operator === "before") &&
      (typeof expression.value !== "string" ||
        !Number.isFinite(Date.parse(expression.value)))
    ) {
      throw new PilotError(
        "invalid_segment_expression",
        "Date segment operators require a valid date value.",
      );
    }
    return;
  }
  if (expression.type === "not") {
    validateServiceCompatibleExpression(
      expression.expression,
      referenceAllowlist,
    );
    return;
  }
  for (const child of expression.expressions) {
    validateServiceCompatibleExpression(child, referenceAllowlist);
  }
}

function redactDirectIdentifiers(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted]")
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, (candidate) =>
      candidate.replace(/\D/gu, "").length >= 9 ? "[redacted]" : candidate,
    );
}

function assertNoDirectIdentifiers(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const redacted = redactDirectIdentifiers(serialized);
  if (redacted !== serialized) {
    throw new PilotError(
      "direct_identifier_in_model_output",
      "The model output contained a direct customer identifier.",
    );
  }
}

function containsSensitiveExpressionKey(
  expression: WorklinSegmentExpression,
): boolean {
  if (expression.type === "predicate") {
    return SENSITIVE_KEY.test(expression.key);
  }
  if (expression.type === "not") {
    return containsSensitiveExpressionKey(expression.expression);
  }
  return expression.expressions.some(containsSensitiveExpressionKey);
}

function containsSensitiveGuessLanguage(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\b(?:likely|probably|appears?|seems?|assume[ds]?)\s+(?:to be\s+)?(?:married|single|pregnant|disabled|religious|[a-z]+ ethnicity)\b/iu.test(
    text,
  );
}

function isQuotaError(error: unknown): boolean {
  if (error instanceof ProviderError && error.statusCode === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:quota|rate.?limit|usage.?limit|insufficient.?credits)/iu.test(
    message,
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : -1;
}

function optionalBoundedCount(value: unknown, max: number): number | undefined {
  const parsed = integerValue(value);
  return parsed >= 0 && parsed <= max ? parsed : undefined;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>])/gu, "\\$1");
}

function jsonResult(value: unknown): ToolExecutionResult {
  return { content: JSON.stringify(value), isError: false };
}

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    content: JSON.stringify({ success: false, error: { code, message } }),
    isError: true,
  };
}
