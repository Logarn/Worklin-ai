import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  normalizeRecommendationOutcomeStatus,
  serializeRecommendationOutcome,
} from "@/lib/recommendations/outcomes";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      stateOnly: true,
      externalActionsTaken: false,
      error,
      issues,
      outcomes: [],
    },
    { status },
  );
}

function clean(value: string | null, max = 200) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseLimit(value: string | null) {
  if (!value) return { ok: true as const, limit: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, error: "limit must be a positive whole number." };
  }
  return { ok: true as const, limit: Math.min(parsed, MAX_LIMIT) };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedLimit = parseLimit(searchParams.get("limit"));
    if (!parsedLimit.ok) {
      return safeError(400, "Invalid recommendation outcome request", [parsedLimit.error]);
    }

    const rawStatus = clean(searchParams.get("status"), 80);
    const status = rawStatus ? normalizeRecommendationOutcomeStatus(rawStatus) : null;
    if (rawStatus && !status) {
      return safeError(400, "Invalid recommendation outcome request", [
        "status must be a known recommendation outcome status.",
      ]);
    }

    const sourceType = clean(searchParams.get("sourceType"), 120);
    const sourceId = clean(searchParams.get("sourceId"));
    const sourceWorkflowRunId = clean(searchParams.get("sourceWorkflowRunId"));
    const recommendationId = clean(searchParams.get("recommendationId"));
    const domain = clean(searchParams.get("domain"), 80);
    const actionType = clean(searchParams.get("actionType"), 120);
    const targetType = clean(searchParams.get("targetType"), 120);
    const targetId = clean(searchParams.get("targetId"));
    const approvalId = clean(searchParams.get("approvalId"));

    const where: Prisma.RecommendationOutcomeWhereInput = {
      ...(status ? { status } : {}),
      ...(sourceType ? { sourceType } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(sourceWorkflowRunId ? { sourceWorkflowRunId } : {}),
      ...(recommendationId ? { recommendationId } : {}),
      ...(domain ? { domain } : {}),
      ...(actionType ? { actionType } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(approvalId ? { approvalId } : {}),
    };

    const outcomes = await prisma.recommendationOutcome.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: parsedLimit.limit,
    });

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      count: outcomes.length,
      outcomes: outcomes.map(serializeRecommendationOutcome),
      filters: {
        status,
        sourceType,
        sourceId,
        sourceWorkflowRunId,
        recommendationId,
        domain,
        actionType,
        targetType,
        targetId,
        approvalId,
        limit: parsedLimit.limit,
      },
    });
  } catch (error) {
    console.error("GET /api/recommendations/outcomes failed", error);
    return safeError(500, "Failed to load recommendation outcomes");
  }
}
