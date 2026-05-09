import { NextResponse } from "next/server";
import {
  parseSkillTransitionRequest,
  transitionSkill,
} from "@/lib/skills/registry";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_request",
      error: "Invalid skill transition request.",
      issues,
      skill: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
    },
    { status: 400 },
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const body = await request.json().catch(() => null);
    const parsed = parseSkillTransitionRequest(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await transitionSkill(id, parsed.data);
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/skills/[id]/transition failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_transition_failed",
        error: "Failed to transition skill.",
        skill: null,
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          blocked: true,
        },
      },
      { status: 500 },
    );
  }
}
