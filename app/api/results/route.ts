import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  cleanResultFilter,
  parseResultLimit,
  serializeRecommendationResult,
} from "@/lib/results/ingestion";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      stateOnly: true,
      externalActionsTaken: false,
      error,
      issues,
      results: [],
    },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedLimit = parseResultLimit(searchParams.get("limit"));
    if (!parsedLimit.ok) {
      return safeError(400, "Invalid results request", [parsedLimit.error]);
    }

    const sourceType = cleanResultFilter(searchParams.get("sourceType"), 120);
    const sourceId = cleanResultFilter(searchParams.get("sourceId"));
    const recommendationOutcomeId = cleanResultFilter(searchParams.get("recommendationOutcomeId"));
    const workflowRunId = cleanResultFilter(searchParams.get("workflowRunId"));
    const campaignMemoryId = cleanResultFilter(searchParams.get("campaignMemoryId"));
    const externalPlatform = cleanResultFilter(searchParams.get("externalPlatform"), 80);
    const externalId = cleanResultFilter(searchParams.get("externalId"));
    const resultType = cleanResultFilter(searchParams.get("resultType"), 80);
    const status = cleanResultFilter(searchParams.get("status"), 80);
    const learningSignal = cleanResultFilter(searchParams.get("learningSignal"), 80);

    const where: Prisma.RecommendationResultWhereInput = {
      ...(sourceType ? { sourceType } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(recommendationOutcomeId ? { recommendationOutcomeId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(campaignMemoryId ? { campaignMemoryId } : {}),
      ...(externalPlatform ? { externalPlatform } : {}),
      ...(externalId ? { externalId } : {}),
      ...(resultType ? { resultType } : {}),
      ...(status ? { status } : {}),
      ...(learningSignal ? { learningSignal } : {}),
    };

    const results = await prisma.recommendationResult.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parsedLimit.limit,
    });

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      count: results.length,
      results: results.map(serializeRecommendationResult),
      filters: {
        sourceType,
        sourceId,
        recommendationOutcomeId,
        workflowRunId,
        campaignMemoryId,
        externalPlatform,
        externalId,
        resultType,
        status,
        learningSignal,
        limit: parsedLimit.limit,
      },
    });
  } catch (error) {
    console.error("GET /api/results failed", error);
    return safeError(500, "Failed to load results");
  }
}
