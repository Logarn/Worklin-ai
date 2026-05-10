import { NextResponse } from "next/server";
import {
  listMicroSegmentDefinitions,
  parseMicroSegmentDefinitionListInput,
} from "@/lib/customers/micro-segment-definitions";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_segment_definition_list_request",
      error: "Micro-segment definition list request is invalid.",
      issues,
      activationStatus: "definition_only",
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
    const parsed = parseMicroSegmentDefinitionListInput({
      definitionKey: searchParams.get("definitionKey"),
      timeframeDays: searchParams.get("timeframeDays"),
      status: searchParams.get("status"),
      limit: searchParams.get("limit"),
    });

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await listMicroSegmentDefinitions(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/customers/segment-definitions failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_segment_definition_list_failed",
        error: "Failed to list micro-segment definitions.",
        activationStatus: "definition_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
