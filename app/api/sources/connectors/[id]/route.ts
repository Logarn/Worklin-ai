import { NextResponse } from "next/server";
import {
  connectorsSafetySummary,
  listSourceConnectors,
} from "@/lib/sources/connectors";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const connectorId = id?.trim();

  if (!connectorId) {
    return NextResponse.json(
      {
        ok: false,
        reason: "invalid_source_connector_id",
        error: "Source connector id is required.",
        connector: null,
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          registryOnly: true,
          liveExternalActionsBlocked: true,
        },
      },
      { status: 400 },
    );
  }

  try {
    const connectors = await listSourceConnectors();
    const normalizedId = connectorId.toLowerCase().replace(/[-\s]+/g, "_");
    const connector = connectors.find((item) => item.id === normalizedId || item.platform === normalizedId);

    if (!connector) {
      return NextResponse.json(
        {
          ok: false,
          reason: "source_connector_not_found",
          error: "Source connector was not found.",
          connector: null,
          safeAlternatives: connectors.map((item) => item.id),
          safety: connectorsSafetySummary(connectors),
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      connector,
      safety: connectorsSafetySummary(connectors),
      metadata: {
        route: "GET /api/sources/connectors/[id]",
        registryOnly: true,
        noExternalCalls: true,
        schemaChanged: false,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("GET /api/sources/connectors/[id] failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "source_connector_lookup_failed",
        error: "Failed to load source connector.",
        connector: null,
        safety: {
          externalActionTaken: false,
          canGoLiveNow: false,
          registryOnly: true,
          liveExternalActionsBlocked: true,
        },
      },
      { status: 500 },
    );
  }
}
