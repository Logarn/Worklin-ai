import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { serializeActionLog } from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      readOnly: true,
      error,
      issues,
      actionLogs: [],
    },
    { status },
  );
}

function clean(value: string | null) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function parseLimit(value: string | null) {
  if (!value) return { ok: true as const, limit: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, error: "limit must be a positive whole number." };
  }
  return { ok: true as const, limit: Math.min(parsed, MAX_LIMIT) };
}

function parseBoolean(value: string | null, field: string) {
  if (!value) return { ok: true as const, value: null };
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return { ok: true as const, value: true };
  if (normalized === "false") return { ok: true as const, value: false };
  return { ok: false as const, error: `${field} must be true or false.` };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedLimit = parseLimit(searchParams.get("limit"));
    if (!parsedLimit.ok) {
      return safeError(400, "Invalid action log request", [parsedLimit.error]);
    }

    const parsedExternal = parseBoolean(searchParams.get("externalActionTaken"), "externalActionTaken");
    if (!parsedExternal.ok) {
      return safeError(400, "Invalid action log request", [parsedExternal.error]);
    }

    const parsedGoLive = parseBoolean(searchParams.get("canGoLiveNow"), "canGoLiveNow");
    if (!parsedGoLive.ok) {
      return safeError(400, "Invalid action log request", [parsedGoLive.error]);
    }

    const eventType = clean(searchParams.get("eventType"));
    const actionType = clean(searchParams.get("actionType"));
    const status = clean(searchParams.get("status"));
    const actorType = clean(searchParams.get("actorType"));
    const targetType = clean(searchParams.get("targetType"));
    const targetId = clean(searchParams.get("targetId"));
    const workflowRunId = clean(searchParams.get("workflowRunId"));
    const approvalId = clean(searchParams.get("approvalId"));

    const where: Prisma.ActionLogWhereInput = {
      ...(eventType ? { eventType } : {}),
      ...(actionType ? { actionType } : {}),
      ...(status ? { status } : {}),
      ...(actorType ? { actorType } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(parsedExternal.value !== null ? { externalActionTaken: parsedExternal.value } : {}),
      ...(parsedGoLive.value !== null ? { canGoLiveNow: parsedGoLive.value } : {}),
    };

    const actionLogs = await prisma.actionLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parsedLimit.limit,
    });

    return NextResponse.json({
      ok: true,
      readOnly: true,
      count: actionLogs.length,
      actionLogs: actionLogs.map(serializeActionLog),
      filters: {
        eventType,
        actionType,
        status,
        actorType,
        targetType,
        targetId,
        workflowRunId,
        approvalId,
        externalActionTaken: parsedExternal.value,
        canGoLiveNow: parsedGoLive.value,
        limit: parsedLimit.limit,
      },
    });
  } catch (error) {
    console.error("GET /api/action-log failed", error);
    return safeError(500, "Failed to load action log");
  }
}
