import { NextResponse } from "next/server";
import {
  getMicroCampaignArbitration,
  MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
} from "@/lib/campaigns/arbitration-frequency-guardrails";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_arbitration_get_request",
      error: "Micro-campaign arbitration get request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
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
    const result = await getMicroCampaignArbitration(id, {
      opportunityKey: searchParams.get("opportunityKey"),
      microSegmentDefinitionKey: searchParams.get("microSegmentDefinitionKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      decision: searchParams.get("decision"),
      packageStatus: searchParams.get("packageStatus"),
      packageType: searchParams.get("packageType"),
      limit: 1,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
          externalActionTaken: false,
          rawContactFieldsReturned: false,
          canGoLiveNow: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/arbitrations/[id] failed", error);
    return invalidRequest(["Failed to read micro-campaign arbitration."]);
  }
}
