import { NextResponse } from "next/server";
import { getMicroSegmentDefinition } from "@/lib/customers/micro-segment-definitions";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_segment_definition_get_request",
      error: "Micro-segment definition get request is invalid.",
      issues,
      activationStatus: "definition_only",
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
    const result = await getMicroSegmentDefinition(id, {
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      limit: 1,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ...result,
          activationStatus: "definition_only",
          externalActionTaken: false,
          rawContactFieldsReturned: false,
          canGoLiveNow: false,
        },
        { status: "status" in result && typeof result.status === "number" ? result.status : 400 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/customers/segment-definitions/[id] failed", error);
    return invalidRequest(["Failed to read micro-segment definition."]);
  }
}
