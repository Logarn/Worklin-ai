import { NextResponse } from "next/server";
import {
  buildUnifiedCustomerIdentity,
  parseUnifiedCustomerIdentityInput,
} from "@/lib/customers/unified-identity";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_unified_customer_identity_request",
      error: "Unified customer identity request is invalid.",
      issues,
      readOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
      safety: {
        readOnly: true,
        externalActionTaken: false,
        canGoLiveNow: false,
        profileMergePerformed: false,
        profileSyncPerformed: false,
        liveExternalActionsBlocked: true,
      },
    },
    { status: 400 },
  );
}

function serverError() {
  return NextResponse.json(
    {
      ok: false,
      reason: "unified_customer_identity_failed",
      error: "Failed to build unified customer identity snapshot.",
      readOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
      safety: {
        readOnly: true,
        externalActionTaken: false,
        canGoLiveNow: false,
        profileMergePerformed: false,
        profileSyncPerformed: false,
        liveExternalActionsBlocked: true,
      },
    },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const parsed = parseUnifiedCustomerIdentityInput({
      customerId: searchParams.get("customerId"),
      email: searchParams.get("email"),
      externalId: searchParams.get("externalId"),
      depth: searchParams.get("depth"),
      limit: searchParams.get("limit"),
      includeProfiles: searchParams.get("includeProfiles"),
      includeMergeCandidates: searchParams.get("includeMergeCandidates"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await buildUnifiedCustomerIdentity(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/customers/identity failed", error);
    return serverError();
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = parseUnifiedCustomerIdentityInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await buildUnifiedCustomerIdentity(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/customers/identity failed", error);
    return serverError();
  }
}
