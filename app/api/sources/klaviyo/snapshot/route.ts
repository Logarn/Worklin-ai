import { NextResponse } from "next/server";
import {
  buildKlaviyoSourceSnapshot,
  parseKlaviyoSourceSnapshotInput,
  type KlaviyoSourceSnapshotDepth,
} from "@/lib/sources/klaviyo-snapshot";

export const runtime = "nodejs";

function errorResponse(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_klaviyo_snapshot_request",
      error: "Klaviyo snapshot request is invalid.",
      issues,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        readOnly: true,
        liveExternalActionsBlocked: true,
      },
    },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const parsed = parseKlaviyoSourceSnapshotInput({
    depth: searchParams.get("depth") as KlaviyoSourceSnapshotDepth | null,
  });

  if (!parsed.ok) {
    return errorResponse(parsed.issues);
  }

  try {
    const result = await buildKlaviyoSourceSnapshot(parsed.data);
    if (!result.ok) {
      return errorResponse(result.issues);
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error("GET /api/sources/klaviyo/snapshot failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "klaviyo_snapshot_failed",
        error: "Failed to build Klaviyo source snapshot.",
        platform: "klaviyo",
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          readOnly: true,
          liveExternalActionsBlocked: true,
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = parseKlaviyoSourceSnapshotInput(
    typeof body === "object" && body !== null ? body : {},
  );

  if (!parsed.ok) {
    return errorResponse(parsed.issues);
  }

  try {
    const result = await buildKlaviyoSourceSnapshot(parsed.data);
    if (!result.ok) {
      return errorResponse(result.issues);
    }

    return NextResponse.json({
      ...result.data,
      metadata: {
        ...result.data.metadata,
        route: "POST /api/sources/klaviyo/snapshot",
      },
    });
  } catch (error) {
    console.error("POST /api/sources/klaviyo/snapshot failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "klaviyo_snapshot_failed",
        error: "Failed to build Klaviyo source snapshot.",
        platform: "klaviyo",
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          readOnly: true,
          liveExternalActionsBlocked: true,
        },
      },
      { status: 500 },
    );
  }
}
