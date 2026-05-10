import { NextResponse } from "next/server";
import {
  computeCustomerScores,
  parseCustomerScoreComputeInput,
} from "@/lib/customers/scoring";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_customer_score_compute_request",
      error: "Customer score compute request is invalid.",
      issues,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      canGoLiveNow: false,
    },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = parseCustomerScoreComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeCustomerScores(parsed.data);
    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          externalActionTaken: false,
          rawContactFieldsReturned: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/customers/scores/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "customer_score_compute_failed",
        error: "Failed to compute customer score records.",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
