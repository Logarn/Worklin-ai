import { NextResponse } from "next/server";
import { buildKlaviyoEnrichmentPlan } from "@/lib/enrichment/klaviyo-plan";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_enrichment_plan_request",
      error: "Klaviyo enrichment plan request is invalid.",
      issues,
      readOnly: true,
      syncPerformed: false,
      externalActionTaken: false,
      canGoLiveNow: false,
      safety: {
        klaviyoWritesAllowed: false,
        shopifyWritesAllowed: false,
        profileSyncAllowed: false,
        segmentCreationAllowed: false,
        liveExternalActionsBlocked: true,
      },
    },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await buildKlaviyoEnrichmentPlan(body);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error("POST /api/enrichment/klaviyo/plan failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "enrichment_plan_failed",
        error: "Failed to prepare Klaviyo enrichment plan.",
        readOnly: true,
        syncPerformed: false,
        externalActionTaken: false,
        canGoLiveNow: false,
        safety: {
          klaviyoWritesAllowed: false,
          shopifyWritesAllowed: false,
          profileSyncAllowed: false,
          segmentCreationAllowed: false,
          liveExternalActionsBlocked: true,
        },
      },
      { status: 500 },
    );
  }
}
