import { NextResponse } from "next/server";
import { parseSkillPatchRequest, patchSkill } from "@/lib/skills/registry";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_request",
      error: "Invalid skill patch request.",
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
    const parsed = parseSkillPatchRequest(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await patchSkill(id, parsed.data);
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/skills/[id]/patch failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_patch_failed",
        error: "Failed to patch skill.",
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
