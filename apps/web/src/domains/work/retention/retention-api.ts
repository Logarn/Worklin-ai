import { z } from "zod";

import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/utils/api-errors";
import { throwRetentionResponseError } from "@/lib/retention/api-error";

export { RetentionApiError } from "@/lib/retention/api-error";
export {
  connectRetentionKlaviyo,
  createRetentionBrand,
  createRetentionKlaviyoIntegration,
  type ConnectKlaviyoInput,
  type RetentionKlaviyoConnection,
} from "@/lib/retention/klaviyo";
export {
  fetchRetentionStatus,
  type RetentionIntegrationStatus,
  type RetentionStatus,
} from "@/lib/retention/status";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/iu);
const campaignModeSchema = z.enum(["dynamic_template", "individual_message"]);
const campaignStatusSchema = z.enum([
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
]);
const programStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
const importStatusSchema = z.enum([
  "preview",
  "approved",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
const segmentRunStatusSchema = z.enum([
  "queued",
  "claimed",
  "paused",
  "completed",
  "failed",
]);

const campaignSummarySchema = z.object({
  id: uuidSchema,
  brandId: uuidSchema,
  programId: uuidSchema,
  programName: z.string(),
  programType: z.string(),
  name: z.string(),
  mode: campaignModeSchema,
  status: campaignStatusSchema,
  revision: z.number().int().nonnegative(),
  audienceMemberCount: z.number().int().nonnegative(),
  sensitiveMemberCount: z.number().int().nonnegative(),
  renderedMessageCount: z.number().int().nonnegative(),
  dispatchStatus: z.string().nullable(),
  acceptedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  updatedAt: z.string().datetime(),
});

const campaignListSchema = z.object({
  campaigns: z.array(campaignSummarySchema),
});

export type RetentionCampaignMode = z.infer<typeof campaignModeSchema>;
export type RetentionCampaignStatus = z.infer<typeof campaignStatusSchema>;

export interface RetentionCampaignSummary {
  id: string;
  programName: string;
  programType: string;
  name: string;
  mode: RetentionCampaignMode;
  status: RetentionCampaignStatus;
  revision: number;
  audienceMemberCount: number;
  sensitiveMemberCount: number;
  renderedMessageCount: number;
  dispatchStatus: string | null;
  acceptedCount: number;
  failedCount: number;
  estimatedCostUsd: number;
  updatedAt: string;
}

const campaignPreviewSchema = z.object({
  campaign: z.object({
    id: uuidSchema,
    name: z.string(),
    mode: campaignModeSchema,
    status: campaignStatusSchema,
    revision: z.number().int().nonnegative(),
    programName: z.string(),
    programType: z.string(),
    approvedAt: z.string().datetime().nullable(),
  }),
  audience: z
    .object({
      id: uuidSchema,
      memberCount: z.number().int().nonnegative(),
      sensitiveMemberCount: z.number().int().nonnegative(),
      snapshotSha256: sha256Schema,
      frozenAt: z.string().datetime(),
    })
    .nullable(),
  messageSamples: z.array(
    z.object({
      customerReference: z.string(),
      messageId: uuidSchema,
      qualityStatus: z.enum(["passed", "needs_review", "blocked"]),
      subject: z.string().nullable(),
      preheader: z.string().nullable(),
      body: z.string().nullable(),
      bodyTruncated: z.boolean(),
      contentWithheld: z.boolean(),
      messageSha256: sha256Schema,
    }),
  ),
});

export interface RetentionCampaignPreview {
  campaign: z.infer<typeof campaignPreviewSchema>["campaign"];
  audience: z.infer<typeof campaignPreviewSchema>["audience"];
  messageSamples: Array<{
    qualityStatus: "passed" | "needs_review" | "blocked";
    subject: string | null;
    preheader: string | null;
    body: string | null;
    bodyTruncated: boolean;
    contentWithheld: boolean;
  }>;
}

const approvalPreviewSchema = z.object({
  snapshotSha256: sha256Schema,
  material: z.object({
    orgId: uuidSchema,
    campaignId: uuidSchema,
    campaignRevision: z.number().int().nonnegative(),
    program: z.string(),
    mode: campaignModeSchema,
    audienceSnapshotId: uuidSchema,
    audienceChecksum: sha256Schema,
    recipientDecisions: z.array(
      z.object({ id: uuidSchema, checksum: sha256Schema }),
    ),
    content: z.array(z.object({ id: uuidSchema, checksum: sha256Schema })),
    modelReferences: z.array(z.string()),
    promptReferences: z.array(z.string()),
    offerChecksum: sha256Schema.nullable().optional(),
  }),
});

export interface RetentionCampaignApprovalPreview {
  snapshotSha256: string;
  campaignId: string;
  campaignRevision: number;
  program: string;
  mode: RetentionCampaignMode;
  audienceSnapshotId: string;
  audienceChecksum: string;
  recipientDecisionCount: number;
  contentCount: number;
  modelReferences: string[];
  promptReferences: string[];
  offerChecksum: string | null;
}

const campaignApprovalSchema = z.object({
  campaignId: uuidSchema,
  status: z.literal("approved"),
  snapshotSha256: sha256Schema,
});

export type RetentionCampaignApproval = z.infer<typeof campaignApprovalSchema>;

const campaignReleaseSchema = z.object({
  dispatchId: uuidSchema,
  status: z.enum([
    "pending",
    "sending",
    "sent",
    "partially_sent",
    "failed",
    "cancelled",
  ]),
  duplicate: z.boolean(),
});

export interface RetentionCampaignRelease {
  status: z.infer<typeof campaignReleaseSchema>["status"];
  duplicate: boolean;
}

const programListSchema = z.object({
  programs: z.array(
    z.object({
      id: uuidSchema,
      brandId: uuidSchema,
      type: z.string(),
      name: z.string(),
      status: programStatusSchema,
      policyVersion: z.string(),
      policyApprovalSha256: sha256Schema.nullable(),
      approvedBy: z.string().nullable(),
      approvedAt: z.string().datetime().nullable(),
      updatedAt: z.string().datetime(),
    }),
  ),
});

const programApprovalPreviewSchema = z.object({
  programId: uuidSchema,
  status: programStatusSchema,
  snapshotSha256: sha256Schema,
  material: z.object({
    orgId: uuidSchema,
    programId: uuidSchema,
    program: z.string(),
    name: z.string(),
    policyVersion: z.string(),
    policy: z.unknown(),
  }),
});

const programActivationSchema = z.object({
  programId: uuidSchema,
  status: z.literal("active"),
  snapshotSha256: sha256Schema,
  duplicate: z.boolean(),
});

const programPauseSchema = z.object({
  programId: uuidSchema,
  status: z.literal("paused"),
  duplicate: z.boolean(),
});

const importListSchema = z.object({
  imports: z.array(
    z.object({
      id: uuidSchema,
      brandId: uuidSchema,
      integrationId: uuidSchema,
      provider: z.enum(["shopify", "klaviyo"]),
      status: importStatusSchema,
      importedCount: z.number().int().nonnegative(),
      rejectedCount: z.number().int().nonnegative(),
      approvedAt: z.string().datetime().nullable(),
      startedAt: z.string().datetime().nullable(),
      completedAt: z.string().datetime().nullable(),
      lastErrorCode: z.string().nullable(),
      updatedAt: z.string().datetime(),
      hasCheckpoint: z.boolean(),
    }),
  ),
});

const importApprovalSchema = z.object({
  migrationRunId: uuidSchema,
  integrationId: uuidSchema,
  status: z.literal("running"),
  duplicate: z.boolean(),
});

const segmentRunCreateSchema = z.object({
  id: uuidSchema,
  status: segmentRunStatusSchema,
  maxSegments: z.number().int().min(1).max(50),
  sampleLimitPerSegment: z.number().int().min(1).max(2),
  trancheSize: z.number().int().min(1).max(10),
  cohortCount: z.number().int().min(0).max(500).optional(),
  evidenceCutoffAt: z.string().datetime(),
  duplicate: z.boolean(),
});

const segmentRunDetailSchema = z.object({
  id: uuidSchema,
  brandId: uuidSchema,
  status: segmentRunStatusSchema,
  maxSegments: z.number().int().min(1).max(50),
  sampleLimitPerSegment: z.number().int().min(1).max(2),
  cohortCount: z.number().int().min(0).max(500).optional(),
  completedSegmentCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

const segmentEvidenceItemSchema = z.object({
  signal: z.string(),
  explanation: z.string(),
  strength: z.enum(["strong", "medium", "weak"]),
  source: z.enum(["metric", "event", "imported_trait", "consent"]),
});

const segmentEvidenceSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, segmentEvidenceItemSchema);

const segmentSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  changeSincePriorRun: z.number().int().nullable().optional(),
  campaignPreview: z
    .object({
      description: z.string(),
      confidence: z.number().min(0).max(1),
      strategy: z.object({
        objective: z.string(),
        angle: z.string(),
        offer: z.string().optional(),
        timing: z.string(),
        callToAction: z.string(),
      }),
      evidence: z.array(segmentEvidenceSchema),
      qualityStatus: z.enum(["passed", "needs_review", "blocked"]),
      samples: z.array(
        z.object({
          subject: z.string(),
          preheader: z.string().nullable(),
          body: z.string(),
          explanation: z.string(),
        }),
      ),
    })
    .nullable(),
  createdAt: z.string().datetime(),
});

const segmentListSchema = z.object({
  segments: z.array(segmentSchema),
});

export type RetentionProgramSummary = z.infer<
  typeof programListSchema
>["programs"][number];
export type RetentionProgramApprovalPreview = z.infer<
  typeof programApprovalPreviewSchema
>;
export type RetentionImportSummary = z.infer<
  typeof importListSchema
>["imports"][number];
export interface RetentionSegmentRun {
  id: string;
  brandId: string;
  status: z.infer<typeof segmentRunStatusSchema>;
  maxSegments: number;
  sampleLimitPerSegment: number;
  cohortCount?: number;
  completedSegments: number;
  totalSegments: number;
  lastErrorCode: string | null;
  updatedAt: string;
}

export interface RetentionSegment {
  id: string;
  name: string;
  description: string;
  totalCount: number;
  eligibleCount: number;
  evidence: Array<{
    signal: string;
    explanation: string;
    strength: "strong" | "medium" | "weak";
    source: "metric" | "event" | "imported_trait" | "consent";
  }>;
  confidence: number;
  changeSincePriorRun: number | null;
  campaignConcept: {
    objective: string;
    angle: string;
    offer?: string;
    timing: string;
    callToAction: string;
  } | null;
  sampleMessages: Array<{
    subject: string;
    preheader: string | null;
    body: string;
    explanation: string;
    qualityStatus: "passed" | "needs_review" | "blocked";
  }>;
  updatedAt: string;
}

export async function fetchRetentionCampaigns(
  assistantId: string,
  brandId: string,
): Promise<RetentionCampaignSummary[]> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/campaigns",
    query: { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retention campaigns.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load retention campaigns.",
    );
  }

  const parsed = campaignListSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention campaign list response was invalid.");
  }

  return parsed.data.campaigns.map(
    ({
      brandId: _brandId,
      programId: _programId,
      ...campaign
    }): RetentionCampaignSummary => campaign,
  );
}

export async function fetchRetentionCampaignPreview(
  assistantId: string,
  campaignId: string,
): Promise<RetentionCampaignPreview> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/campaigns/{campaign_id}/preview",
    path: { campaign_id: campaignId },
    query: { sampleLimit: 6 },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load the campaign preview.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load the campaign preview.",
    );
  }

  const parsed = campaignPreviewSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention campaign preview response was invalid.");
  }

  return {
    campaign: parsed.data.campaign,
    audience: parsed.data.audience,
    messageSamples: parsed.data.messageSamples.map(
      ({
        customerReference: _customerReference,
        messageId: _messageId,
        messageSha256: _messageSha256,
        ...sample
      }) => sample,
    ),
  };
}

export async function fetchRetentionCampaignApprovalPreview(
  assistantId: string,
  campaignId: string,
  brandId: string,
): Promise<RetentionCampaignApprovalPreview> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/campaigns/{campaign_id}/approval-preview",
    path: { campaign_id: campaignId },
    query: { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load the approval snapshot.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load the approval snapshot.",
    );
  }

  const parsed = approvalPreviewSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention approval preview response was invalid.");
  }

  return {
    snapshotSha256: parsed.data.snapshotSha256,
    campaignId: parsed.data.material.campaignId,
    campaignRevision: parsed.data.material.campaignRevision,
    program: parsed.data.material.program,
    mode: parsed.data.material.mode,
    audienceSnapshotId: parsed.data.material.audienceSnapshotId,
    audienceChecksum: parsed.data.material.audienceChecksum,
    recipientDecisionCount: parsed.data.material.recipientDecisions.length,
    contentCount: parsed.data.material.content.length,
    modelReferences: parsed.data.material.modelReferences,
    promptReferences: parsed.data.material.promptReferences,
    offerChecksum: parsed.data.material.offerChecksum ?? null,
  };
}

export async function approveRetentionCampaign(
  assistantId: string,
  campaignId: string,
  brandId: string,
  expectedSnapshotSha256: string,
): Promise<RetentionCampaignApproval> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/campaigns/{campaign_id}/approve",
    path: { campaign_id: campaignId },
    query: { brandId },
    body: { expectedSnapshotSha256 },
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to approve the campaign.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to approve the campaign.",
    );
  }

  const parsed = campaignApprovalSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention campaign approval response was invalid.");
  }
  return parsed.data;
}

export async function releaseRetentionCampaign(
  assistantId: string,
  campaignId: string,
  brandId: string,
  snapshotSha256: string,
  idempotencyKey: string,
): Promise<RetentionCampaignRelease> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/campaigns/{campaign_id}/release",
    path: { campaign_id: campaignId },
    query: { brandId },
    body: { idempotencyKey, snapshotSha256 },
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to send the campaign.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to send the campaign.",
    );
  }

  const parsed = campaignReleaseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention campaign release response was invalid.");
  }
  return {
    status: parsed.data.status,
    duplicate: parsed.data.duplicate,
  };
}

export async function fetchRetentionPrograms(
  assistantId: string,
  brandId: string,
): Promise<RetentionProgramSummary[]> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/programs",
    query: { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retention programs.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load retention programs.",
    );
  }
  const parsed = programListSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention program list response was invalid.");
  }
  return parsed.data.programs;
}

export async function fetchRetentionProgramApprovalPreview(
  assistantId: string,
  programId: string,
  brandId: string,
): Promise<RetentionProgramApprovalPreview> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/programs/{program_id}/approval-preview",
    path: { program_id: programId },
    query: { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load the program policy.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load the program policy.",
    );
  }
  const parsed = programApprovalPreviewSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention program policy response was invalid.");
  }
  return parsed.data;
}

export async function activateRetentionProgram(
  assistantId: string,
  programId: string,
  brandId: string,
  expectedPolicySha256: string,
): Promise<z.infer<typeof programActivationSchema>> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/programs/{program_id}/activate",
    path: { program_id: programId },
    query: { brandId },
    body: { expectedPolicySha256 },
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to activate the program.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to activate the program.",
    );
  }
  const parsed = programActivationSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention program activation response was invalid.");
  }
  return parsed.data;
}

export async function pauseRetentionProgram(
  assistantId: string,
  programId: string,
  brandId: string,
  reason: string,
): Promise<z.infer<typeof programPauseSchema>> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/programs/{program_id}/pause",
    path: { program_id: programId },
    query: { brandId },
    body: { reason },
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to pause the program.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to pause the program.",
    );
  }
  const parsed = programPauseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention program pause response was invalid.");
  }
  return parsed.data;
}

export async function fetchRetentionImports(
  assistantId: string,
  brandId: string,
): Promise<RetentionImportSummary[]> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/imports",
    query: { limit: 50, brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retention imports.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load retention imports.",
    );
  }
  const parsed = importListSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention import list response was invalid.");
  }
  return parsed.data.imports;
}

export async function approveRetentionImport(
  assistantId: string,
  migrationRunId: string,
): Promise<z.infer<typeof importApprovalSchema>> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/imports/{migration_run_id}/approve",
    path: { migration_run_id: migrationRunId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to start the retention import.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to start the retention import.",
    );
  }
  const parsed = importApprovalSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention import approval response was invalid.");
  }
  return parsed.data;
}

export async function startRetentionSegmentRun(
  assistantId: string,
  input: {
    brandId: string;
    maxSegments: number;
    sampleLimitPerSegment: number;
  },
): Promise<RetentionSegmentRun> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/segment-runs",
    body: input,
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to start audience review.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to start audience review.",
    );
  }
  const parsed = segmentRunCreateSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Audience run response was invalid.");
  }
  return {
    id: parsed.data.id,
    brandId: input.brandId,
    status: parsed.data.status,
    maxSegments: parsed.data.maxSegments,
    sampleLimitPerSegment: parsed.data.sampleLimitPerSegment,
    cohortCount: parsed.data.cohortCount,
    completedSegments: 0,
    totalSegments: parsed.data.maxSegments,
    lastErrorCode: null,
    updatedAt: parsed.data.evidenceCutoffAt,
  };
}

export async function fetchRetentionSegmentRun(
  assistantId: string,
  runId: string,
): Promise<RetentionSegmentRun> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/segment-runs/{run_id}",
    path: { run_id: runId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load audience progress.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to load audience progress.",
    );
  }
  const parsed = segmentRunDetailSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Audience run response was invalid.");
  }
  return {
    id: parsed.data.id,
    brandId: parsed.data.brandId,
    status: parsed.data.status,
    maxSegments: parsed.data.maxSegments,
    sampleLimitPerSegment: parsed.data.sampleLimitPerSegment,
    cohortCount: parsed.data.cohortCount,
    completedSegments: parsed.data.completedSegmentCount,
    totalSegments: parsed.data.maxSegments,
    lastErrorCode: parsed.data.lastErrorCode,
    updatedAt: parsed.data.updatedAt,
  };
}

export async function fetchRetentionSegments(
  assistantId: string,
  brandId: string,
): Promise<RetentionSegment[]> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/segments",
    query: { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load audiences.");
  if (!response.ok) {
    throwRetentionResponseError(response, error, "Failed to load audiences.");
  }
  const parsed = segmentListSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Audience list response was invalid.");
  }
  return parsed.data.segments.map((segment): RetentionSegment => {
    const preview = segment.campaignPreview;
    return {
      id: segment.id,
      name: segment.name,
      description:
        preview?.description ?? "Campaign direction is still being prepared.",
      totalCount: segment.memberCount,
      eligibleCount: segment.eligibleCount,
      evidence: preview?.evidence ?? [],
      confidence: preview?.confidence ?? 0,
      changeSincePriorRun: segment.changeSincePriorRun ?? null,
      campaignConcept: preview?.strategy ?? null,
      sampleMessages: (preview?.samples ?? []).map((sample) => ({
        subject: sample.subject,
        preheader: sample.preheader,
        body: sample.body,
        explanation: sample.explanation,
        qualityStatus: preview?.qualityStatus ?? "needs_review",
      })),
      updatedAt: segment.createdAt,
    };
  });
}
