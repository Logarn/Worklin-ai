import { NextResponse } from "next/server";
import { legacyExecutionDisabledPayload } from "@/lib/legacy-execution-gate";

export async function POST() {
  return NextResponse.json(legacyExecutionDisabledPayload("Klaviyo segment sync"), { status: 403 });
}
