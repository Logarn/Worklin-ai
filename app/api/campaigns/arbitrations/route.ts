import { NextResponse } from "next/server";
import {
  listMicroCampaignArbitrations,
  MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
  parseMicroCampaignArbitrationListInput,
} from "@/lib/campaigns/arbitration-frequency-guardrails";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_arbitration_list_request",
      error: "Micro-campaign arbitration list request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
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
    const parsed = parseMicroCampaignArbitrationListInput({
      arbitrationKey: searchParams.get("arbitrationKey"),
      packageKey: searchParams.get("packageKey"),
      opportunityKey: searchParams.get("opportunityKey"),
      microSegmentDefinitionKey: searchParams.get("microSegmentDefinitionKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      decision: searchParams.get("decision"),
      packageStatus: searchParams.get("packageStatus"),
      packageType: searchParams.get("packageType"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listMicroCampaignArbitrations(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/campaigns/arbitrations failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_campaign_arbitration_list_failed",
        error: "Failed to list micro-campaign arbitrations.",
        activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
