import { NextResponse } from "next/server";
import {
  computeMicroCampaignPackages,
  MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
  parseMicroCampaignPackageComputeInput,
} from "@/lib/campaigns/micro-campaign-factory";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_package_compute_request",
      error: "Micro-campaign package compute request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
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
    const parsed = parseMicroCampaignPackageComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeMicroCampaignPackages(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/campaigns/micro-campaigns/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_campaign_package_compute_failed",
        error: "Failed to compute micro-campaign packages.",
        activationStatus: MICRO_CAMPAIGN_PACKAGE_ACTIVATION_STATUS,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
