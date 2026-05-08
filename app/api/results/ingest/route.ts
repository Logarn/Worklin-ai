import { NextResponse } from "next/server";
import {
  ingestRecommendationResult,
  parseResultIngestionRequest,
} from "@/lib/results/ingestion";

export const runtime = "nodejs";

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      stateOnly: true,
      externalActionsTaken: false,
      error,
      issues,
      result: null,
      learningSignal: null,
      linkedRecommendationOutcome: null,
      campaignMemoryUpdated: false,
      caveats: ["No external action was attempted."],
    },
    { status },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = parseResultIngestionRequest(body);

  if (!parsed.ok) {
    return safeError(400, "Invalid result ingestion request", parsed.issues);
  }

  try {
    const response = await ingestRecommendationResult(parsed.data);
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("POST /api/results/ingest failed", error);
    return safeError(500, "Failed to ingest result", [
      "The result was not stored and no external action was attempted.",
    ]);
  }
}
