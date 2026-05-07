import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { toPrismaJson } from "@/app/api/agent/workflows/shared";
import {
  auditRetentionSetup,
  type RetentionAuditInput,
} from "@/lib/audits/retention-audit";
import {
  actionLogWarningCaveat,
  logActionEvent,
  type ActionLogInput,
} from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const WORKFLOW_TYPE = "retention-audit";
const WORKFLOW_GENERATOR = "retention-audit-workflow-v0";

const retentionAuditSchema = z
  .object({
    timeframe: z.enum(["last_90_days", "last_180_days", "last_365_days"]).optional().nullable(),
    includeProduct: z.boolean().optional(),
    includeCampaigns: z.boolean().optional(),
    includeFlows: z.boolean().optional(),
    includeAudiences: z.boolean().optional(),
    includeMetricDiscovery: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional().nullable(),
    productLimit: z.number().int().min(1).max(12).optional().nullable(),
    campaignLimit: z.number().int().min(1).max(50).optional().nullable(),
    flowLimit: z.number().int().min(1).max(10).optional().nullable(),
    audienceLimit: z.number().int().min(1).max(250).optional().nullable(),
    metricLimit: z.number().int().min(1).max(250).optional().nullable(),
  })
  .passthrough();

type RetentionAuditRequest = z.infer<typeof retentionAuditSchema>;

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
}

function enabledSourceCount(input: RetentionAuditRequest) {
  return [
    input.includeProduct !== false,
    input.includeCampaigns !== false,
    input.includeFlows !== false,
    input.includeAudiences !== false,
    input.includeMetricDiscovery !== false,
  ].filter(Boolean).length;
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

function retentionAuditInputSummary(input: RetentionAuditInput) {
  return {
    timeframe: input.timeframe ?? "last_365_days",
    includeProduct: input.includeProduct !== false,
    includeCampaigns: input.includeCampaigns !== false,
    includeFlows: input.includeFlows !== false,
    includeAudiences: input.includeAudiences !== false,
    includeMetricDiscovery: input.includeMetricDiscovery !== false,
    campaignLimit: input.campaignLimit ?? null,
    flowLimit: input.flowLimit ?? null,
    audienceLimit: input.audienceLimit ?? null,
  };
}

function retentionAuditOutputSummary(output: unknown) {
  const audit = isRecord(output) ? output : {};
  const health = isRecord(audit.overallRetentionHealth) ? audit.overallRetentionHealth : {};
  const summary = isRecord(audit.summary) ? audit.summary : {};

  return {
    ok: audit.ok === true,
    readOnly: audit.readOnly === true,
    workflowType: audit.workflowType ?? "retention_audit",
    overallScore: typeof health.score === "number" ? health.score : null,
    overallStatus: typeof health.status === "string" ? health.status : null,
    executiveSummary: typeof summary.executiveSummary === "string" ? summary.executiveSummary : null,
    topIssueCount: countItems(audit.topIssues),
    topOpportunityCount: countItems(audit.topOpportunities),
    prioritizedActionCount: countItems(audit.prioritizedActions),
    caveatCount: countItems(audit.caveats),
    sourceStatusCount: isRecord(audit.sourceStatuses) ? Object.keys(audit.sourceStatuses).length : 0,
  };
}

async function logRetentionAuditEvent(input: ActionLogInput) {
  return logActionEvent({
    actorType: "workflow",
    riskLevel: "low",
    requiresApproval: false,
    externalActionTaken: false,
    canGoLiveNow: false,
    ...input,
    metadata: {
      route: "POST /api/audits/retention",
      ...(isRecord(input.metadata) ? input.metadata : {}),
    },
  });
}

async function persistWorkflowRun(input: RetentionAuditInput, output: unknown) {
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
          completedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return workflow.id;
  } catch (error) {
    console.warn("Retention audit WorkflowRun persistence skipped", error);
    return null;
  }
}

async function safeRetentionAuditError(error: unknown, input?: RetentionAuditInput) {
  console.error("POST /api/audits/retention failed", error);
  const actionLog = await logRetentionAuditEvent({
    eventType: "retention_audit.failed",
    actionType: "run_retention_audit",
    status: "failed",
    targetType: "workflow-run",
    summary: "Retention audit failed before a completed audit response was returned.",
    inputSummary: input ? retentionAuditInputSummary(input) : null,
    outputSummary: {
      ok: false,
      readOnly: true,
      externalActionTaken: false,
    },
    errorMessage: errorMessage(error),
  });

  return NextResponse.json(
    {
      ok: false,
      readOnly: true,
      workflowType: "retention_audit",
      error: "Failed to audit retention setup",
      summary: null,
      overallRetentionHealth: null,
      domainScorecards: null,
      lifecycleCoverage: null,
      topIssues: [],
      topOpportunities: [],
      prioritizedActions: [],
      insights: [],
      chartHints: [],
      caveats: [
        {
          message: "Retention audit failed unexpectedly. No Klaviyo writes, sends, schedules, or syncs were attempted.",
          evidenceType: "caveat",
          severity: "unknown",
        },
        ...actionLogWarningCaveat(actionLog),
      ],
      sourceStatuses: {},
      metadata: {
        generatedAt: new Date().toISOString(),
        readOnly: true,
      },
      actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
    },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = retentionAuditSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        readOnly: true,
        workflowType: "retention_audit",
        error: "Invalid retention audit request",
        issues: issueMessages(parsed.error),
        insights: [],
        chartHints: [],
        caveats: [],
      },
      { status: 400 },
    );
  }

  if (enabledSourceCount(parsed.data) === 0) {
    return NextResponse.json(
      {
        ok: false,
        readOnly: true,
        workflowType: "retention_audit",
        error: "Retention audit needs at least one source",
        issues: ["At least one include flag must be true."],
        insights: [],
        chartHints: [],
        caveats: [],
      },
      { status: 400 },
    );
  }

  try {
    const input: RetentionAuditInput = parsed.data;
    const output = await auditRetentionSetup(input);
    const workflowId = await persistWorkflowRun(input, output);
    const actionLog = await logRetentionAuditEvent({
      eventType: "retention_audit.completed",
      actionType: "run_retention_audit",
      status: "completed",
      targetType: "workflow-run",
      targetId: workflowId,
      workflowRunId: workflowId,
      summary: workflowId
        ? "Retention audit completed and was persisted as a WorkflowRun."
        : "Retention audit completed, but WorkflowRun persistence was skipped.",
      inputSummary: retentionAuditInputSummary(input),
      outputSummary: {
        ...retentionAuditOutputSummary(output),
        workflowId,
      },
      metadata: {
        workflowPersistence: workflowId ? "persisted" : "skipped",
      },
    });
    const persistenceCaveats = workflowId
      ? []
      : [{
          message: "WorkflowRun persistence was skipped for Retention Audit v0; audit output was still returned.",
          evidenceType: "caveat" as const,
          severity: "unknown" as const,
        }];

    return NextResponse.json({
      ...output,
      workflowId,
      workflowPersistence: workflowId ? "persisted" : "skipped",
      caveats: [...output.caveats, ...persistenceCaveats, ...actionLogWarningCaveat(actionLog)],
      actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
    });
  } catch (error) {
    return safeRetentionAuditError(error, parsed.data);
  }
}
