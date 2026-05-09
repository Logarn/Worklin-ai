import { NextResponse } from "next/server";
import {
  listSkills,
  parseSkillListFilters,
  summarizeSkills,
} from "@/lib/skills/registry";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const filters = parseSkillListFilters(url);
    const skills = await listSkills(filters);

    return NextResponse.json({
      ok: true,
      skills,
      summary: summarizeSkills(skills),
      count: skills.length,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
      },
    });
  } catch (error) {
    console.error("GET /api/skills failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "skills_list_failed",
        error: "Failed to list skills.",
        skills: [],
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
        },
      },
      { status: 500 },
    );
  }
}
