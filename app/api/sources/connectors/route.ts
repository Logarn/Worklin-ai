import { NextResponse } from "next/server";
import {
  connectorsSafetySummary,
  listSourceConnectors,
} from "@/lib/sources/connectors";

export const runtime = "nodejs";

export async function GET() {
  try {
    const connectors = await listSourceConnectors();

    return NextResponse.json({
      ok: true,
      connectors,
      count: connectors.length,
      safety: connectorsSafetySummary(connectors),
      metadata: {
        route: "GET /api/sources/connectors",
        registryOnly: true,
        noExternalCalls: true,
        schemaChanged: false,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("GET /api/sources/connectors failed", error);
    return NextResponse.json(
      {
        ok: false,
        reason: "source_connector_registry_failed",
        error: "Failed to load source connector registry.",
        connectors: [],
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
