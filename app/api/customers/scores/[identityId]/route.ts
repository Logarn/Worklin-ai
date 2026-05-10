import { NextResponse } from "next/server";
import { getCustomerScoreRecord } from "@/lib/customers/scoring";

export const runtime = "nodejs";

type RouteCtx = {
  params: Promise<{ identityId: string }>;
};

export async function GET(request: Request, context: RouteCtx) {
  try {
    const { identityId } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const result = await getCustomerScoreRecord(identityId, {
      timeframeDays: searchParams.get("timeframeDays"),
    });

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
    console.error("GET /api/customers/scores/[identityId] failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "customer_score_detail_failed",
        error: "Failed to load customer score record.",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
