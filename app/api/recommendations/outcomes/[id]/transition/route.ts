import { NextResponse } from "next/server";
import { z } from "zod";
import {
  RECOMMENDATION_OUTCOME_STATUSES,
  serializeRecommendationOutcome,
  transitionRecommendationOutcome,
} from "@/lib/recommendations/outcomes";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const transitionSchema = z
  .object({
    status: z.string().trim().min(1, "status is required.").max(80),
    approvalId: z.string().trim().min(1).max(200).optional().nullable(),
    actionLogId: z.string().trim().min(1).max(200).optional().nullable(),
    decisionNote: z.string().trim().min(1).max(4000).optional().nullable(),
    outcomeNote: z.string().trim().min(1).max(4000).optional().nullable(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

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
      allowedStatuses: RECOMMENDATION_OUTCOME_STATUSES,
      outcome: null,
    },
    { status },
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();

  if (!id) {
    return safeError(400, "Invalid recommendation outcome transition", ["outcome id is required."]);
  }

  const body = await request.json().catch(() => ({}));
  const parsed = transitionSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return safeError(400, "Invalid recommendation outcome transition", issueMessages(parsed.error));
  }

  try {
    const result = await transitionRecommendationOutcome(id, parsed.data);
    if (!result.ok) {
      return safeError(result.status, result.error, result.issues);
    }

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      changed: result.changed,
      message: `Recommendation outcome moved to ${result.outcome.status}. No external work was executed.`,
      outcome: serializeRecommendationOutcome(result.outcome),
    });
  } catch (error) {
    console.error("POST /api/recommendations/outcomes/[id]/transition failed", error);
    return safeError(500, "Failed to transition recommendation outcome", [
      "No external action was attempted.",
    ]);
  }
}
