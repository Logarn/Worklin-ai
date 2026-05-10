import { NextResponse } from "next/server";
import {
  computeCampaignOpportunities,
  parseCampaignOpportunityComputeInput,
} from "@/lib/campaigns/opportunity-engine";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_campaign_opportunity_compute_request",
      error: "Campaign opportunity compute request is invalid.",
      issues,
      activationStatus: "opportunity_only",
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
    const parsed = parseCampaignOpportunityComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeCampaignOpportunities(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/campaigns/opportunities/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "campaign_opportunity_compute_failed",
        error: "Failed to compute campaign opportunities.",
        activationStatus: "opportunity_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
