import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { toPrismaJson } from "@/app/api/agent/workflows/shared";
import {
  auditRetentionSetup,
  type RetentionAuditInput,
} from "@/lib/audits/retention-audit";
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

function safeRetentionAuditError(error: unknown) {
  console.error("POST /api/audits/retention failed", error);
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
      ],
      sourceStatuses: {},
      metadata: {
        generatedAt: new Date().toISOString(),
        readOnly: true,
      },
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
      caveats: [...output.caveats, ...persistenceCaveats],
    });
  } catch (error) {
    return safeRetentionAuditError(error);
  }
}
