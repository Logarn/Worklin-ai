import { NextResponse } from "next/server";
import {
  computeCustomerFeatureStore,
  parseCustomerFeatureComputeInput,
} from "@/lib/customers/feature-store";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_customer_feature_compute_request",
      error: "Customer feature compute request is invalid.",
      issues,
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
    const parsed = parseCustomerFeatureComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeCustomerFeatureStore(parsed.data);
    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          externalActionTaken: false,
          rawContactFieldsReturned: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/customers/features/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "customer_feature_compute_failed",
        error: "Failed to compute customer feature store records.",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
