import { NextResponse } from "next/server";
import {
  executeAgentToolRuntime,
  parseAgentToolRuntimeRequest,
} from "@/lib/agent/tools/runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = parseAgentToolRuntimeRequest(body);

    if (!parsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          reason: "invalid_request",
          error: "Invalid agent tool execution request.",
          issues: parsed.issues,
          result: null,
          safety: {
            externalActionTaken: false,
            canGoLiveNow: false,
            blocked: true,
          },
        },
        { status: 400 },
      );
    }

    const result = await executeAgentToolRuntime(parsed.data);
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/agent/tools/execute failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "tool_execution_failed",
        error: "Failed to execute agent tool.",
        result: null,
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          blocked: true,
        },
      },
      { status: 500 },
    );
  }
}
