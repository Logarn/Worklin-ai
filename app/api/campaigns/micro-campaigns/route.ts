import { NextResponse } from "next/server";
import {
  listMicroCampaignPackages,
  MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
  parseMicroCampaignPackageListInput,
} from "@/lib/campaigns/micro-campaign-factory";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_package_list_request",
      error: "Micro-campaign package list request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
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
    const parsed = parseMicroCampaignPackageListInput({
      packageKey: searchParams.get("packageKey"),
      opportunityKey: searchParams.get("opportunityKey"),
      microSegmentDefinitionKey: searchParams.get("microSegmentDefinitionKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      packageType: searchParams.get("packageType"),
      approvalStatus: searchParams.get("approvalStatus"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listMicroCampaignPackages(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/micro-campaigns failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_campaign_package_list_failed",
        error: "Failed to list micro-campaign packages.",
        activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
