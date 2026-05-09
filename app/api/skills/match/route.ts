import { NextResponse } from "next/server";
import { matchSkill, parseSkillMatchRequest } from "@/lib/skills/registry";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_request",
      error: "Invalid skill match request.",
      issues,
      matchedSkillId: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
    },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = parseSkillMatchRequest(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await matchSkill(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/skills/match failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_match_failed",
        error: "Failed to match skill.",
        matchedSkillId: null,
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
