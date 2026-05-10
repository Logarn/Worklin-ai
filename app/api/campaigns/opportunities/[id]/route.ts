import { NextResponse } from "next/server";
import { getCampaignOpportunity } from "@/lib/campaigns/opportunity-engine";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_campaign_opportunity_get_request",
      error: "Campaign opportunity get request is invalid.",
      issues,
      activationStatus: "opportunity_only",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      canGoLiveNow: false,
    },
    { status: 400 },
  );
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const result = await getCampaignOpportunity(id, {
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      opportunityType: searchParams.get("opportunityType"),
      recommendedCampaignType: searchParams.get("recommendedCampaignType"),
      limit: 1,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          activationStatus: "opportunity_only",
          externalActionTaken: false,
          rawContactFieldsReturned: false,
          canGoLiveNow: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/opportunities/[id] failed", error);
    return invalidRequest(["Failed to read campaign opportunity."]);
  }
}
