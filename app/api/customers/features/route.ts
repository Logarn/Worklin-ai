import { NextResponse } from "next/server";
import {
  listCustomerFeatureStore,
  parseCustomerFeatureListInput,
} from "@/lib/customers/feature-store";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_customer_feature_list_request",
      error: "Customer feature list request is invalid.",
      issues,
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
    const parsed = parseCustomerFeatureListInput({
      identityId: searchParams.get("identityId"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listCustomerFeatureStore(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/customers/features failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "customer_feature_list_failed",
        error: "Failed to list customer feature records.",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
