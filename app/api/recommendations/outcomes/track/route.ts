import { NextResponse } from "next/server";
import { z } from "zod";
import {
  RECOMMENDATION_OUTCOME_STATUSES,
  serializeRecommendationOutcome,
  trackRecommendationOutcome,
  type TrackRecommendationOutcomeInput,
} from "@/lib/recommendations/outcomes";

export const runtime = "nodejs";

const outcomeSchema = z
  .object({
    sourceType: z.string().trim().min(1, "sourceType is required.").max(120),
    sourceId: z.string().trim().min(1).max(200).optional().nullable(),
    sourceWorkflowRunId: z.string().trim().min(1).max(200).optional().nullable(),
    recommendationId: z.string().trim().min(1).max(200).optional().nullable(),
    title: z.string().trim().min(1, "title is required.").max(240),
    summary: z.string().trim().min(1).max(4000).optional().nullable(),
    domain: z.string().trim().min(1).max(80).optional().nullable(),
    actionType: z.string().trim().min(1).max(120).optional().nullable(),
    targetType: z.string().trim().min(1).max(120).optional().nullable(),
    targetId: z.string().trim().min(1).max(200).optional().nullable(),
    status: z.enum(RECOMMENDATION_OUTCOME_STATUSES).optional().default("recommended"),
    priority: z.string().trim().min(1).max(40).optional().nullable(),
    confidence: z.number().finite().optional().nullable(),
    approvalId: z.string().trim().min(1).max(200).optional().nullable(),
    actionLogId: z.string().trim().min(1).max(200).optional().nullable(),
    decisionNote: z.string().trim().min(1).max(4000).optional().nullable(),
    outcomeNote: z.string().trim().min(1).max(4000).optional().nullable(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

const requestSchema = z.union([
  outcomeSchema,
  z.object({
    outcomes: z.array(outcomeSchema).min(1).max(50),
  }),
]);

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
}

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      stateOnly: true,
      externalActionsTaken: false,
      error,
      issues,
      outcomes: [],
    },
    { status },
  );
}

function outcomesFromBody(data: z.infer<typeof requestSchema>): TrackRecommendationOutcomeInput[] {
  const maybeBulk = data as { outcomes?: TrackRecommendationOutcomeInput[] };
  return Array.isArray(maybeBulk.outcomes) ? maybeBulk.outcomes : [data as TrackRecommendationOutcomeInput];
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return safeError(400, "Invalid recommendation outcome tracking request", issueMessages(parsed.error));
  }

  try {
    const tracked = [];

    for (const item of outcomesFromBody(parsed.data)) {
      tracked.push(await trackRecommendationOutcome(item));
    }

    return NextResponse.json(
      {
        ok: true,
        stateOnly: true,
        externalActionsTaken: false,
        count: tracked.length,
        created: tracked.filter((item) => item.created).length,
        updated: tracked.filter((item) => !item.created).length,
        duplicateKey: "sourceWorkflowRunId + recommendationId",
        outcomes: tracked.map((item) => serializeRecommendationOutcome(item.outcome)),
      },
      { status: tracked.some((item) => item.created) ? 201 : 200 },
    );
  } catch (error) {
    console.error("POST /api/recommendations/outcomes/track failed", error);
    return safeError(500, "Failed to track recommendation outcomes", [
      "No external action was attempted.",
    ]);
  }
}
