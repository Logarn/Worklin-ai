import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { toPrismaJson } from "@/app/api/agent/workflows/shared";
import {
  prepareAuditFixRun,
  validateRetentionAuditWorkflow,
  type AuditFixRunOutput,
  type AuditFixRunScope,
} from "@/lib/audits/fix-run";
import {
  actionLogWarningCaveat,
  logActionEvent,
  type ActionLogInput,
} from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";
import { trackAuditFixRunOutcomes } from "@/lib/recommendations/outcomes";

export const runtime = "nodejs";

const WORKFLOW_TYPE = "audit-fix-run";
const WORKFLOW_GENERATOR = "audit-fix-run-v0";

const fixRunSchema = z.object({
  workflowId: z.string().trim().min(1, "workflowId is required."),
  mode: z.literal("safe_prepare").optional().default("safe_prepare"),
  scope: z.enum(["all", "fix_first", "campaigns", "flows", "audiences", "performance"]).optional().default("all"),
});

type AuditFixRunRequest = z.infer<typeof fixRunSchema>;

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function countItems(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function fixRunInputSummary(input: Partial<AuditFixRunRequest> | null) {
  return {
    workflowId: input?.workflowId ?? null,
    mode: input?.mode ?? "safe_prepare",
    scope: input?.scope ?? "all",
  };
}

function fixRunOutputSummary(output: unknown) {
  const fixRun = isRecord(output) ? output : {};
  const summary = isRecord(fixRun.summary) ? fixRun.summary : {};

  return {
    ok: fixRun.ok === true,
    readOnly: fixRun.readOnly === true,
    mode: fixRun.mode ?? "safe_prepare",
    sourceWorkflowId: fixRun.sourceWorkflowId ?? null,
    prepared: typeof summary.prepared === "number" ? summary.prepared : countItems(fixRun.preparedFixes),
    blocked: typeof summary.blocked === "number" ? summary.blocked : countItems(fixRun.blockedFixes),
    needsApproval: typeof summary.needsApproval === "number" ? summary.needsApproval : null,
    preparedFixCount: countItems(fixRun.preparedFixes),
    blockedFixCount: countItems(fixRun.blockedFixes),
    caveatCount: countItems(fixRun.caveats),
    externalActionTaken: false,
    canGoLiveNow: false,
  };
}

async function logFixRunEvent(input: ActionLogInput) {
  return logActionEvent({
    actorType: "workflow",
    riskLevel: "medium",
    requiresApproval: true,
    approvalStatus: "not_requested",
    externalActionTaken: false,
    canGoLiveNow: false,
    ...input,
    metadata: {
      route: "POST /api/audits/fix-run",
      ...(isRecord(input.metadata) ? input.metadata : {}),
    },
  });
}

async function safeFixRunError(error: unknown, input?: Partial<AuditFixRunRequest> | null) {
  console.error("POST /api/audits/fix-run failed", error);
  const actionLog = await logFixRunEvent({
    eventType: "audit_fix_run.failed",
    actionType: "prepare_safe_audit_fixes",
    status: "failed",
    targetType: "workflow-run",
    targetId: input?.workflowId ?? null,
    summary: "Audit Fix Run failed before a prepared fix package was returned.",
    inputSummary: fixRunInputSummary(input ?? null),
    outputSummary: {
      ok: false,
      readOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    errorMessage: errorMessage(error),
  });

  return NextResponse.json(
    {
      ok: false,
      readOnly: true,
      mode: "safe_prepare",
      error: "Failed to prepare audit fixes",
      preparedFixes: [],
      blockedFixes: [],
      approvalPackage: {
        readyForApproval: false,
        approvalSummary: "Audit Fix Run failed before preparing an approval package.",
        items: [],
      },
      fixGroups: {
        campaigns: [],
        flows: [],
        audiences: [],
        performance: [],
        suppression: [],
      },
      caveats: [
        {
          message: "Audit Fix Run failed unexpectedly. No Klaviyo writes, sends, schedules, syncs, drafts, creates, or updates were attempted.",
          evidenceType: "caveat",
          severity: "unknown",
        },
        ...actionLogWarningCaveat(actionLog),
      ],
      metadata: {
        generatedAt: new Date().toISOString(),
        safePrepareOnly: true,
        externalActionsTaken: false,
        writesPerformed: false,
      },
      actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
    },
    { status: 500 },
  );
}

async function persistWorkflowRun(input: AuditFixRunRequest, output: AuditFixRunOutput) {
  try {
    const workflow = await prisma.workflowRun.create({
      data: {
        type: WORKFLOW_TYPE,
        status: "completed",
        input: toPrismaJson(input),
        output: toPrismaJson(output),
        error: null,
        metadata: {
          generatedBy: WORKFLOW_GENERATOR,
          readOnly: true,
          mode: input.mode,
          scope: input.scope,
          sourceWorkflowId: input.workflowId,
          completedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return workflow.id;
  } catch (error) {
    console.warn("Audit Fix Run WorkflowRun persistence skipped", error);
    return null;
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = fixRunSchema.safeParse(body ?? {});

  if (!parsed.success) {
    const actionLog = await logFixRunEvent({
      eventType: "audit_fix_run.failed",
      actionType: "prepare_safe_audit_fixes",
      status: "failed",
      targetType: "workflow-run",
      targetId: null,
      summary: "Audit Fix Run request validation failed before any workflow read.",
      inputSummary: {
        receivedWorkflowId: isRecord(body) && typeof body.workflowId === "string" ? body.workflowId : null,
        issues: issueMessages(parsed.error),
      },
      outputSummary: {
        ok: false,
        statusCode: 400,
        externalActionTaken: false,
        canGoLiveNow: false,
      },
    });

    return NextResponse.json(
      {
        ok: false,
        readOnly: true,
        mode: "safe_prepare",
        error: "Invalid audit fix-run request",
        issues: issueMessages(parsed.error),
        preparedFixes: [],
        blockedFixes: [],
        caveats: [
          {
            message: "Request validation failed before any workflow read or external action was attempted.",
            evidenceType: "caveat",
            severity: "unknown",
          },
          ...actionLogWarningCaveat(actionLog),
        ],
        actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
      },
      { status: 400 },
    );
  }

  try {
    const workflow = await prisma.workflowRun.findUnique({
      where: { id: parsed.data.workflowId },
    });

    if (!workflow) {
      const actionLog = await logFixRunEvent({
        eventType: "audit_fix_run.failed",
        actionType: "prepare_safe_audit_fixes",
        status: "failed",
        targetType: "workflow-run",
        targetId: parsed.data.workflowId,
        summary: "Audit Fix Run could not find the requested retention audit WorkflowRun.",
        inputSummary: fixRunInputSummary(parsed.data),
        outputSummary: {
          ok: false,
          statusCode: 404,
          externalActionTaken: false,
          canGoLiveNow: false,
        },
      });

      return NextResponse.json(
        {
          ok: false,
          readOnly: true,
          mode: parsed.data.mode,
          sourceWorkflowId: parsed.data.workflowId,
          error: "Retention audit workflow not found",
          preparedFixes: [],
          blockedFixes: [],
          caveats: [
            {
              message: "No WorkflowRun was found for the provided workflowId. No external action was attempted.",
              evidenceType: "caveat",
              severity: "unknown",
            },
            ...actionLogWarningCaveat(actionLog),
          ],
          actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
        },
        { status: 404 },
      );
    }

    const validation = validateRetentionAuditWorkflow(workflow);
    if (!validation.ok) {
      const actionLog = await logFixRunEvent({
        eventType: "audit_fix_run.failed",
        actionType: "prepare_safe_audit_fixes",
        status: "failed",
        targetType: "workflow-run",
        targetId: workflow.id,
        workflowRunId: workflow.id,
        summary: "Audit Fix Run received a WorkflowRun that cannot be used as a completed retention audit.",
        inputSummary: fixRunInputSummary(parsed.data),
        outputSummary: {
          ok: false,
          statusCode: validation.status,
          error: validation.error,
          issueCount: validation.issues.length,
          externalActionTaken: false,
          canGoLiveNow: false,
        },
      });

      return NextResponse.json(
        {
          ok: false,
          readOnly: true,
          mode: parsed.data.mode,
          sourceWorkflowId: workflow.id,
          error: validation.error,
          issues: validation.issues,
          preparedFixes: [],
          blockedFixes: [],
          caveats: [
            {
              message: "Audit Fix Run can only prepare fixes from a completed retention audit output. No external action was attempted.",
              evidenceType: "caveat",
              severity: "unknown",
            },
            ...actionLogWarningCaveat(actionLog),
          ],
          actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
        },
        { status: validation.status },
      );
    }

    const result = prepareAuditFixRun({
      workflow,
      audit: validation.audit,
      mode: parsed.data.mode,
      scope: parsed.data.scope as AuditFixRunScope,
    });
    const workflowId = await persistWorkflowRun(parsed.data, result);
    const actionLog = await logFixRunEvent({
      eventType: "audit_fix_run.prepared",
      actionType: "prepare_safe_audit_fixes",
      status: "prepared",
      targetType: "workflow-run",
      targetId: workflowId ?? parsed.data.workflowId,
      workflowRunId: workflowId,
      summary: workflowId
        ? "Audit Fix Run prepared a safe fix package and persisted it as a WorkflowRun."
        : "Audit Fix Run prepared a safe fix package, but WorkflowRun persistence was skipped.",
      inputSummary: fixRunInputSummary(parsed.data),
      outputSummary: {
        ...fixRunOutputSummary(result),
        workflowId,
      },
      metadata: {
        sourceWorkflowId: parsed.data.workflowId,
        workflowPersistence: workflowId ? "persisted" : "skipped",
      },
    });
    const recommendationOutcomes = await trackAuditFixRunOutcomes({
      workflowRunId: workflowId,
      output: result,
      actionLogId: actionLog.ok ? actionLog.actionLog.id : null,
    });
    const persistenceCaveats = workflowId
      ? []
      : [{
          message: "WorkflowRun persistence was skipped for Audit Fix Run v0; the prepared fix package was still returned.",
          evidenceType: "caveat" as const,
          severity: "unknown" as const,
        }];
    const outcomeCaveats = recommendationOutcomes.ok
      ? []
      : [{
          message: recommendationOutcomes.warning,
          evidenceType: "caveat" as const,
          severity: "unknown" as const,
        }];

    return NextResponse.json({
      ...result,
      workflowId,
      workflowPersistence: workflowId ? "persisted" : "skipped",
      caveats: [...result.caveats, ...persistenceCaveats, ...outcomeCaveats, ...actionLogWarningCaveat(actionLog)],
      actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
      recommendationOutcomes: recommendationOutcomes.ok
        ? {
            tracked: recommendationOutcomes.count,
            created: recommendationOutcomes.created,
            updated: recommendationOutcomes.updated,
            ids: recommendationOutcomes.outcomes.map((outcome) => outcome.id),
          }
        : { warning: recommendationOutcomes.warning },
    });
  } catch (error) {
    return safeFixRunError(error, parsed.data);
  }
}
