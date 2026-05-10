import { NextResponse } from "next/server";
import {
  listCampaignOpportunities,
  parseCampaignOpportunityListInput,
} from "@/lib/campaigns/opportunity-engine";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_campaign_opportunity_list_request",
      error: "Campaign opportunity list request is invalid.",
      issues,
      activationStatus: "opportunity_only",
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
    const parsed = parseCampaignOpportunityListInput({
      opportunityKey: searchParams.get("opportunityKey"),
      microSegmentDefinitionKey: searchParams.get("microSegmentDefinitionKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      opportunityType: searchParams.get("opportunityType"),
      recommendedCampaignType: searchParams.get("recommendedCampaignType"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listCampaignOpportunities(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/opportunities failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "campaign_opportunity_list_failed",
        error: "Failed to list campaign opportunities.",
        activationStatus: "opportunity_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
