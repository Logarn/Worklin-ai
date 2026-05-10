import { NextResponse } from "next/server";
import { legacyExecutionDisabledPayload } from "@/lib/legacy-execution-gate";

export async function POST() {
  return NextResponse.json(legacyExecutionDisabledPayload("Klaviyo profile sync"), { status: 403 });
}
