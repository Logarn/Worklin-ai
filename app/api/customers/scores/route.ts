import { NextResponse } from "next/server";
import {
  listCustomerScores,
  parseCustomerScoreListInput,
} from "@/lib/customers/scoring";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_customer_score_list_request",
      error: "Customer score list request is invalid.",
      issues,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      canGoLiveNow: false,
    },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = parseCustomerScoreListInput({
      identityId: searchParams.get("identityId"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listCustomerScores(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/customers/scores failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "customer_score_list_failed",
        error: "Failed to list customer score records.",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
