import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { toPrismaJson } from "@/app/api/agent/workflows/shared";
import { logActionEvent } from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const APPROVAL_STATUSES = ["pending", "approved", "rejected", "revision_requested"] as const;
const TERMINAL_APPROVAL_STATUSES = ["approved", "rejected", "revision_requested"] as const;
const TARGET_TYPES = [
  "audit-fix-run",
  "campaign-brief",
  "flow-package",
  "audience-package",
  "klaviyo-draft",
  "workflow-run",
] as const;

type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
type TerminalApprovalStatus = (typeof TERMINAL_APPROVAL_STATUSES)[number];
type ApprovalTargetType = (typeof TARGET_TYPES)[number];

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ApprovalRow = {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  targetTitle: string | null;
  targetSummary: string | null;
  requestNote: string | null;
  decisionNote: string | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type JsonRecord = Record<string, unknown>;

const requestApprovalSchema = z.object({
  targetType: z.string().trim().min(1, "targetType is required.").max(80),
  targetId: z.string().trim().min(1, "targetId is required.").max(200),
  targetTitle: z.string().trim().min(1).max(240).optional(),
  targetSummary: z.string().trim().min(1).max(4000).optional(),
  requestNote: z.string().trim().min(1).max(4000).optional(),
  requestedBy: z.string().trim().min(1).max(120).optional(),
  metadata: z.unknown().optional(),
});

const transitionSchema = z.object({
  decidedBy: z.string().trim().min(1).max(120).optional(),
  decisionNote: z.string().trim().min(1).max(4000).optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
  metadata: z.unknown().optional(),
});

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactId(id: string) {
  return id.length > 10 ? `${id.slice(0, 10)}...` : id;
}

function normalizeSlug(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizeTargetType(value: string): ApprovalTargetType | null {
  const normalized = normalizeSlug(value);
  const aliases: Record<string, ApprovalTargetType> = {
    "audit-fix-run": "audit-fix-run",
    auditfixrun: "audit-fix-run",
    "campaign-brief": "campaign-brief",
    campaignbrief: "campaign-brief",
    "flow-package": "flow-package",
    flowpackage: "flow-package",
    "audience-package": "audience-package",
    audiencepackage: "audience-package",
    "klaviyo-draft": "klaviyo-draft",
    klaviyodraft: "klaviyo-draft",
    "workflow-run": "workflow-run",
    workflowrun: "workflow-run",
    workflowruns: "workflow-run",
  };
  return aliases[normalized] ?? null;
}

function normalizeStatus(value: string): ApprovalStatus | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return APPROVAL_STATUSES.includes(normalized as ApprovalStatus)
    ? (normalized as ApprovalStatus)
    : null;
}

function serializeDate(value: Date | null) {
  return value ? value.toISOString() : null;
}

function serializeApproval(approval: ApprovalRow) {
  return {
    id: approval.id,
    targetType: approval.targetType,
    targetId: approval.targetId,
    status: approval.status,
    targetTitle: approval.targetTitle,
    targetSummary: approval.targetSummary,
    requestNote: approval.requestNote,
    decisionNote: approval.decisionNote,
    requestedBy: approval.requestedBy,
    decidedBy: approval.decidedBy,
    decidedAt: serializeDate(approval.decidedAt),
    metadata: approval.metadata,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

function safeError(status: number, error: string, issues: string[] = []) {
  return NextResponse.json(
    {
      ok: false,
      error,
      issues,
      stateOnly: true,
      externalActionsTaken: false,
    },
    { status },
  );
}

function actionLogResponse(
  result: Awaited<ReturnType<typeof logActionEvent>>,
) {
  return result.ok
    ? { actionLog: { id: result.actionLog.id } }
    : {
        actionLog: { warning: result.warning },
        warnings: ["Action logging failed, but the approval state response was preserved."],
      };
}

function workflowRunIdForApprovalTarget(targetType: string, targetId: string) {
  return ["audit-fix-run", "workflow-run", "flow-package", "audience-package"].includes(targetType)
    ? targetId
    : null;
}

async function logApprovalRequested(approval: ApprovalRow) {
  return logActionEvent({
    eventType: "approval.requested",
    actionType: "request_approval",
    status: "requested",
    actorType: approval.requestedBy ? "user" : "system",
    targetType: approval.targetType,
    targetId: approval.targetId,
    workflowRunId: workflowRunIdForApprovalTarget(approval.targetType, approval.targetId),
    approvalId: approval.id,
    riskLevel: "medium",
    requiresApproval: true,
    approvalStatus: approval.status,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: `Approval requested for ${approval.targetType}.`,
    inputSummary: {
      targetType: approval.targetType,
      targetId: approval.targetId,
      hasTargetTitle: Boolean(approval.targetTitle),
      requestedBy: approval.requestedBy,
      hasRequestNote: Boolean(approval.requestNote),
    },
    outputSummary: {
      approvalId: approval.id,
      status: approval.status,
      stateOnly: true,
      externalActionsTaken: false,
    },
    metadata: {
      route: "POST /api/approvals/request",
    },
  });
}

async function logApprovalTransition(approval: ApprovalRow, nextStatus: TerminalApprovalStatus) {
  return logActionEvent({
    eventType: `approval.${nextStatus}`,
    actionType: "transition_approval",
    status: nextStatus,
    actorType: approval.decidedBy ? "user" : "system",
    targetType: approval.targetType,
    targetId: approval.targetId,
    workflowRunId: workflowRunIdForApprovalTarget(approval.targetType, approval.targetId),
    approvalId: approval.id,
    riskLevel: "medium",
    requiresApproval: true,
    approvalStatus: approval.status,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: `Approval state changed to ${nextStatus}.`,
    inputSummary: {
      approvalId: approval.id,
      targetType: approval.targetType,
      targetId: approval.targetId,
      decidedBy: approval.decidedBy,
      hasDecisionNote: Boolean(approval.decisionNote),
    },
    outputSummary: {
      approvalId: approval.id,
      status: approval.status,
      stateOnly: true,
      externalActionsTaken: false,
    },
    metadata: {
      route: `POST /api/approvals/[id]/${nextStatus}`,
    },
  });
}

async function findPendingApproval(targetType: ApprovalTargetType, targetId: string) {
  return prisma.approval.findFirst({
    where: {
      targetType,
      targetId,
      status: "pending",
    },
    orderBy: { createdAt: "desc" },
  });
}

function existingPendingApprovalResponse(approval: ApprovalRow) {
  return NextResponse.json({
    ok: true,
    created: false,
    stateOnly: true,
    externalActionsTaken: false,
    message: "Approval is already pending for this target.",
    approval: serializeApproval(approval),
  });
}

function approvalMetadata(requestMetadata: unknown, target: JsonRecord) {
  return toPrismaJson({
    ...(isRecord(requestMetadata) ? requestMetadata : {}),
    ...(requestMetadata !== undefined && !isRecord(requestMetadata) ? { requestMetadata } : {}),
    target,
    safety: {
      stateOnly: true,
      externalActionsTaken: false,
      klaviyoWrites: false,
      draftsCreated: false,
      sendsOrSchedules: false,
      profileSync: false,
    },
  });
}

function mergeTransitionMetadata(
  existingMetadata: Prisma.JsonValue | null,
  transition: {
    status: TerminalApprovalStatus;
    decidedAt: string;
    metadata: unknown;
  },
) {
  const base = isRecord(existingMetadata)
    ? existingMetadata
    : existingMetadata
      ? { previousMetadata: existingMetadata }
      : {};

  return toPrismaJson({
    ...base,
    lastTransition: {
      status: transition.status,
      decidedAt: transition.decidedAt,
      stateOnly: true,
      externalActionsTaken: false,
      ...(transition.metadata !== undefined ? { metadata: transition.metadata } : {}),
    },
  });
}

function workflowTargetSnapshot(workflow: {
  id: string;
  type: string;
  status: string;
  output?: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    sourceModel: "WorkflowRun",
    id: workflow.id,
    type: workflow.type,
    status: workflow.status,
    metadata: workflow.metadata,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function auditFixRunSummary(output: Prisma.JsonValue | null) {
  if (!isRecord(output)) return null;

  const approvalPackage = isRecord(output.approvalPackage) ? output.approvalPackage : {};
  const summary = isRecord(output.summary) ? output.summary : {};
  return (
    asString(approvalPackage.approvalSummary) ??
    asString(summary.chatSummary) ??
    null
  );
}

async function validateWorkflowTarget(targetId: string, expectedType?: string) {
  const workflow = await prisma.workflowRun.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      type: true,
      status: true,
      output: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!workflow) {
    return {
      ok: false as const,
      status: 404,
      error: "Approval target not found",
      issues: ["No WorkflowRun was found for the provided targetId. No external action was attempted."],
    };
  }

  if (expectedType && workflow.type !== expectedType) {
    return {
      ok: false as const,
      status: 400,
      error: "Invalid approval target",
      issues: [`Expected a ${expectedType} WorkflowRun, but found ${workflow.type}. No external action was attempted.`],
    };
  }

  if (expectedType === "audit-fix-run" && workflow.status !== "completed") {
    return {
      ok: false as const,
      status: 400,
      error: "Invalid approval target",
      issues: ["Only completed audit-fix-run WorkflowRuns can be submitted for approval. No external action was attempted."],
    };
  }

  return {
    ok: true as const,
    target: workflowTargetSnapshot(workflow),
    title: expectedType === "audit-fix-run"
      ? `Audit Fix Run ${compactId(workflow.id)}`
      : `WorkflowRun ${compactId(workflow.id)}`,
    summary: expectedType === "audit-fix-run" ? auditFixRunSummary(workflow.output) : null,
  };
}

async function validateApprovalTarget(targetType: ApprovalTargetType, targetId: string) {
  if (targetType === "audit-fix-run") {
    return validateWorkflowTarget(targetId, "audit-fix-run");
  }

  if (targetType === "workflow-run" || targetType === "flow-package" || targetType === "audience-package") {
    return validateWorkflowTarget(targetId);
  }

  if (targetType === "campaign-brief") {
    const brief = await prisma.campaignBrief.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        title: true,
        status: true,
        campaignType: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!brief) {
      return {
        ok: false as const,
        status: 404,
        error: "Approval target not found",
        issues: ["No CampaignBrief was found for the provided targetId. No external action was attempted."],
      };
    }

    return {
      ok: true as const,
      target: {
        sourceModel: "CampaignBrief",
        id: brief.id,
        status: brief.status,
        campaignType: brief.campaignType,
        createdAt: brief.createdAt.toISOString(),
        updatedAt: brief.updatedAt.toISOString(),
      },
      title: brief.title,
      summary: null,
    };
  }

  const draft = await prisma.klaviyoDraft.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      briefId: true,
      campaignName: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!draft) {
    return {
      ok: false as const,
      status: 404,
      error: "Approval target not found",
      issues: ["No KlaviyoDraft was found for the provided targetId. No external action was attempted."],
    };
  }

  return {
    ok: true as const,
    target: {
      sourceModel: "KlaviyoDraft",
      id: draft.id,
      briefId: draft.briefId,
      status: draft.status,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    },
    title: draft.campaignName,
    summary: null,
  };
}

export async function requestApproval(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = requestApprovalSchema.safeParse(body);

  if (!parsed.success) {
    return safeError(400, "Invalid approval request", issueMessages(parsed.error));
  }

  const targetType = normalizeTargetType(parsed.data.targetType);
  if (!targetType) {
    return safeError(400, "Unsupported approval target type", [
      `targetType must be one of: ${TARGET_TYPES.join(", ")}.`,
    ]);
  }

  try {
    const targetResult = await validateApprovalTarget(targetType, parsed.data.targetId);
    if (!targetResult.ok) {
      return safeError(targetResult.status, targetResult.error, targetResult.issues);
    }

    const existingPendingApproval = await findPendingApproval(targetType, parsed.data.targetId);

    if (existingPendingApproval) {
      return existingPendingApprovalResponse(existingPendingApproval);
    }

    let approval: ApprovalRow;
    try {
      approval = await prisma.approval.create({
        data: {
          targetType,
          targetId: parsed.data.targetId,
          status: "pending",
          targetTitle: parsed.data.targetTitle ?? targetResult.title,
          targetSummary: parsed.data.targetSummary ?? targetResult.summary,
          requestNote: parsed.data.requestNote,
          requestedBy: parsed.data.requestedBy,
          metadata: approvalMetadata(parsed.data.metadata, targetResult.target),
        },
      });
    } catch (error) {
      const raceExistingApproval = await findPendingApproval(targetType, parsed.data.targetId);
      if (raceExistingApproval) {
        return existingPendingApprovalResponse(raceExistingApproval);
      }
      throw error;
    }

    const actionLog = await logApprovalRequested(approval);

    return NextResponse.json(
      {
        ok: true,
        created: true,
        stateOnly: true,
        externalActionsTaken: false,
        message: "Approval was requested. No external work was executed.",
        approval: serializeApproval(approval),
        ...actionLogResponse(actionLog),
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/approvals/request failed", error);
    return safeError(500, "Failed to request approval", [
      "The approval state could not be saved. No external action was attempted.",
    ]);
  }
}

export async function listApprovals(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawLimit = searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : 50;
    if (!Number.isInteger(limit) || limit < 1) {
      return safeError(400, "Invalid approval list request", ["limit must be a positive whole number."]);
    }

    const rawStatus = searchParams.get("status");
    const status = rawStatus ? normalizeStatus(rawStatus) : null;
    if (rawStatus && !status) {
      return safeError(400, "Invalid approval list request", [
        `status must be one of: ${APPROVAL_STATUSES.join(", ")}.`,
      ]);
    }

    const rawTargetType = searchParams.get("targetType");
    const targetType = rawTargetType ? normalizeTargetType(rawTargetType) : null;
    if (rawTargetType && !targetType) {
      return safeError(400, "Invalid approval list request", [
        `targetType must be one of: ${TARGET_TYPES.join(", ")}.`,
      ]);
    }

    const targetId = searchParams.get("targetId")?.trim() || null;
    const where: Prisma.ApprovalWhereInput = {
      ...(status ? { status } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
    };

    const approvals = await prisma.approval.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
    });

    return NextResponse.json({
      ok: true,
      approvals: approvals.map(serializeApproval),
    });
  } catch (error) {
    console.error("GET /api/approvals failed", error);
    return safeError(500, "Failed to load approvals");
  }
}

export async function getApproval(_: Request, context: RouteContext) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();
  if (!id) {
    return safeError(400, "Invalid approval request", ["approval id is required."]);
  }

  try {
    const approval = await prisma.approval.findUnique({
      where: { id },
    });

    if (!approval) {
      return safeError(404, "Approval not found");
    }

    return NextResponse.json({
      ok: true,
      approval: serializeApproval(approval),
    });
  } catch (error) {
    console.error("GET /api/approvals/[id] failed", error);
    return safeError(500, "Failed to load approval");
  }
}

export async function transitionApproval(
  request: Request,
  context: RouteContext,
  nextStatus: TerminalApprovalStatus,
) {
  const { id: rawId } = await context.params;
  const id = rawId?.trim();
  if (!id) {
    return safeError(400, "Invalid approval transition", ["approval id is required."]);
  }

  const body = await request.json().catch(() => ({}));
  const parsed = transitionSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return safeError(400, "Invalid approval transition", issueMessages(parsed.error));
  }

  try {
    const approval = await prisma.approval.findUnique({
      where: { id },
    });

    if (!approval) {
      return safeError(404, "Approval not found");
    }

    if (approval.status !== "pending") {
      return safeError(409, "Invalid approval transition", [
        `Only pending approvals can move to ${nextStatus}. Current status is ${approval.status}. No external action was attempted.`,
      ]);
    }

    const decidedAt = new Date();
    const updateResult = await prisma.approval.updateMany({
      where: {
        id,
        status: "pending",
      },
      data: {
        status: nextStatus,
        decisionNote: parsed.data.decisionNote ?? parsed.data.reason,
        decidedBy: parsed.data.decidedBy,
        decidedAt,
        metadata: mergeTransitionMetadata(approval.metadata, {
          status: nextStatus,
          decidedAt: decidedAt.toISOString(),
          metadata: parsed.data.metadata,
        }),
      },
    });

    if (updateResult.count !== 1) {
      const currentApproval = await prisma.approval.findUnique({ where: { id } });
      return safeError(409, "Invalid approval transition", [
        `Only pending approvals can move to ${nextStatus}. Current status is ${currentApproval?.status ?? "unknown"}. No external action was attempted.`,
      ]);
    }

    const updated = await prisma.approval.findUnique({
      where: { id },
    });

    if (!updated) {
      return safeError(404, "Approval not found");
    }

    const actionLog = await logApprovalTransition(updated, nextStatus);

    return NextResponse.json({
      ok: true,
      stateOnly: true,
      externalActionsTaken: false,
      message: `Approval state changed to ${nextStatus}. No external work was executed.`,
      approval: serializeApproval(updated),
      ...actionLogResponse(actionLog),
    });
  } catch (error) {
    console.error(`POST /api/approvals/[id]/${nextStatus} failed`, error);
    return safeError(500, "Failed to update approval state", [
      "The approval state could not be updated. No external action was attempted.",
    ]);
  }
}
