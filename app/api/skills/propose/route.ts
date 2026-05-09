import { NextResponse } from "next/server";
import { parseSkillProposalRequest, proposeSkill } from "@/lib/skills/registry";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_request",
      error: "Invalid skill proposal request.",
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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = parseSkillProposalRequest(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await proposeSkill(parsed.data);
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/skills/propose failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_proposal_failed",
        error: "Failed to propose skill.",
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
