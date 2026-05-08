import { NextResponse } from "next/server";
import { serializeRecommendationOutcome } from "@/lib/recommendations/outcomes";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      stateOnly: true,
      externalActionsTaken: false,
      error,
      issues,
      outcome: null,
    },
    { status },
  );
}

export async function GET(_: Request, context: RouteContext) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();

  if (!id) {
    return safeError(400, "Invalid recommendation outcome request", ["outcome id is required."]);
  }

  try {
    const outcome = await prisma.recommendationOutcome.findUnique({
      where: { id },
    });

    if (!outcome) {
      return safeError(404, "Recommendation outcome not found");
    }

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      outcome: serializeRecommendationOutcome(outcome),
    });
  } catch (error) {
    console.error("GET /api/recommendations/outcomes/[id] failed", error);
    return safeError(500, "Failed to load recommendation outcome");
  }
}
