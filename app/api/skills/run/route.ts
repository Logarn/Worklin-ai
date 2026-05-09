import { NextResponse } from "next/server";
import { parseSkillRunRequest, runSkill } from "@/lib/skills/registry";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_request",
      error: "Invalid skill run request.",
      issues,
      result: null,
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
    const parsed = parseSkillRunRequest(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await runSkill(parsed.data);
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/skills/run failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_run_failed",
        error: "Failed to run skill.",
        result: null,
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
