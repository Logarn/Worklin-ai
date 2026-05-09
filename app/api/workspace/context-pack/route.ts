import { NextResponse } from "next/server";
import {
  buildWorkspaceContextPack,
  parseWorkspaceContextPackInput,
  parseWorkspaceContextPackSearchParams,
} from "@/lib/workspace/context-pack";

export const runtime = "nodejs";

function invalidRequest(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_context_pack_request",
      error: "Invalid workspace context pack request.",
      issues,
      contextPack: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
    },
    { status: 400 },
  );
}

function serverError() {
  return NextResponse.json(
    {
      ok: false,
      reason: "context_pack_failed",
      error: "Failed to assemble workspace context pack.",
      contextPack: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
    },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = parseWorkspaceContextPackSearchParams(searchParams);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await buildWorkspaceContextPack(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/workspace/context-pack failed", error);
    return serverError();
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = parseWorkspaceContextPackInput(body);

    if (!parsed.ok) {
      return invalidRequest(parsed.issues);
    }

    const result = await buildWorkspaceContextPack(parsed.data);
    if (!result.ok) {
      return invalidRequest(result.issues);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/workspace/context-pack failed", error);
    return serverError();
  }
}
