import { NextResponse } from "next/server";
import {
  buildShopifySourceSnapshot,
  parseShopifySourceSnapshotInput,
} from "@/lib/sources/shopify-snapshot";

export const runtime = "nodejs";

function errorResponse(issues: string[]) {
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid_shopify_snapshot_request",
      error: "Shopify snapshot request is invalid.",
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
  const parsed = parseShopifySourceSnapshotInput({
    depth: searchParams.get("depth"),
    timeframeDays: searchParams.get("timeframeDays"),
    includeCohorts: searchParams.get("includeCohorts"),
  });

  if (!parsed.ok) {
    return errorResponse(parsed.issues);
  }

  try {
    const result = await buildShopifySourceSnapshot(parsed.data);
    if (!result.ok) {
      return errorResponse(result.issues);
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error("GET /api/sources/shopify/snapshot failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "shopify_snapshot_failed",
        error: "Failed to build Shopify source snapshot.",
        platform: "shopify",
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

  const parsed = parseShopifySourceSnapshotInput(
    typeof body === "object" && body !== null ? body : {},
  );

  if (!parsed.ok) {
    return errorResponse(parsed.issues);
  }

  try {
    const result = await buildShopifySourceSnapshot(parsed.data);
    if (!result.ok) {
      return errorResponse(result.issues);
    }

    return NextResponse.json({
      ...result.data,
      metadata: {
        ...result.data.metadata,
        route: "POST /api/sources/shopify/snapshot",
      },
    });
  } catch (error) {
    console.error("POST /api/sources/shopify/snapshot failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "shopify_snapshot_failed",
        error: "Failed to build Shopify source snapshot.",
        platform: "shopify",
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
