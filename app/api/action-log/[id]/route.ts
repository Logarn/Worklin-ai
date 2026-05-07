import { NextResponse } from "next/server";
import { serializeActionLog } from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      readOnly: true,
      error,
      issues,
      actionLog: null,
    },
    { status },
  );
}

export async function GET(_: Request, context: RouteContext) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();

  if (!id) {
    return safeError(400, "Invalid action log request", ["action log id is required."]);
  }

  try {
    const actionLog = await prisma.actionLog.findUnique({
      where: { id },
    });

    if (!actionLog) {
      return safeError(404, "Action log entry not found");
    }

    return NextResponse.json({
      ok: true,
      readOnly: true,
      actionLog: serializeActionLog(actionLog),
    });
  } catch (error) {
    console.error("GET /api/action-log/[id] failed", error);
    return safeError(500, "Failed to load action log entry");
  }
}
