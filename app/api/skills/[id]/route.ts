import { NextResponse } from "next/server";
import { getSkill, skillNotFoundResponse } from "@/lib/skills/registry";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const skill = await getSkill(id);
    if (!skill) {
      return NextResponse.json(skillNotFoundResponse(id), { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      skill,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
      },
    });
  } catch (error) {
    console.error("GET /api/skills/[id] failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skill_lookup_failed",
        error: "Failed to load skill.",
        skill: null,
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
        },
      },
      { status: 500 },
    );
  }
}
