import { NextResponse } from "next/server";
import {
  computeMicroSegmentDefinitions,
  parseMicroSegmentDefinitionComputeInput,
} from "@/lib/customers/micro-segment-definitions";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_micro_segment_definition_compute_request",
      error: "Micro-segment definition compute request is invalid.",
      issues,
      activationStatus: "definition_only",
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
    const parsed = parseMicroSegmentDefinitionComputeInput(
      typeof body === "object" && body !== null ? body : {},
    );

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await computeMicroSegmentDefinitions(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/customers/segment-definitions/compute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "micro_segment_definition_compute_failed",
        error: "Failed to compute micro-segment definitions.",
        activationStatus: "definition_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
      { status: 500 },
    );
  }
}
