import { NextResponse } from "next/server";
import {
  getMicroCampaignPackage,
  MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
} from "@/lib/campaigns/micro-campaign-factory";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_package_get_request",
      error: "Micro-campaign package get request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
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
    const result = await getMicroCampaignPackage(id, {
      opportunityKey: searchParams.get("opportunityKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      packageType: searchParams.get("packageType"),
      approvalStatus: searchParams.get("approvalStatus"),
      limit: 1,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
          externalActionTaken: false,
          rawContactFieldsReturned: false,
          canGoLiveNow: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/micro-campaigns/[id] failed", error);
    return invalidRequest(["Failed to read micro-campaign package."]);
  }
}
