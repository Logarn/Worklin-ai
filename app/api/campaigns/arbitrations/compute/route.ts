import { NextResponse } from "next/server";
import {
  computeMicroCampaignArbitrations,
  MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
  parseMicroCampaignArbitrationComputeInput,
} from "@/lib/campaigns/arbitration-frequency-guardrails";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_campaign_arbitration_compute_request",
      error: "Micro-campaign arbitration compute request is invalid.",
      issues,
      activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
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
    const parsed = parseMicroCampaignArbitrationComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeMicroCampaignArbitrations(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/campaigns/arbitrations/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_campaign_arbitration_compute_failed",
        error: "Failed to compute micro-campaign arbitrations.",
        activationStatus: MICRO_CAMPAIGN_ARBITRATION_ACTIVATION_STATUS,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
