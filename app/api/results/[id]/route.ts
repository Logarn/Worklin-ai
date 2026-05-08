import { NextResponse } from "next/server";
import { serializeRecommendationResult } from "@/lib/results/ingestion";
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
      result: null,
    },
    { status },
  );
}

export async function GET(_: Request, context: RouteContext) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();

  if (!id) {
    return safeError(400, "Invalid result request", ["result id is required."]);
  }

  try {
    const result = await prisma.recommendationResult.findUnique({
      where: { id },
    });

    if (!result) {
      return safeError(404, "Result not found");
    }

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      result: serializeRecommendationResult(result),
    });
  } catch (error) {
    console.error("GET /api/results/[id] failed", error);
    return safeError(500, "Failed to load result");
  }
}
