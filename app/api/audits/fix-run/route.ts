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
import { prisma } from "@/lib/prisma";

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

function safeFixRunError(error: unknown) {
  console.error("POST /api/audits/fix-run failed", error);
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
      ],
      metadata: {
        generatedAt: new Date().toISOString(),
        safePrepareOnly: true,
        externalActionsTaken: false,
        writesPerformed: false,
      },
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
        ],
      },
      { status: 400 },
    );
  }

  try {
    const workflow = await prisma.workflowRun.findUnique({
      where: { id: parsed.data.workflowId },
    });

    if (!workflow) {
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
          ],
        },
        { status: 404 },
      );
    }

    const validation = validateRetentionAuditWorkflow(workflow);
    if (!validation.ok) {
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
          ],
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
    const persistenceCaveats = workflowId
      ? []
      : [{
          message: "WorkflowRun persistence was skipped for Audit Fix Run v0; the prepared fix package was still returned.",
          evidenceType: "caveat" as const,
          severity: "unknown" as const,
        }];

    return NextResponse.json({
      ...result,
      workflowId,
      workflowPersistence: workflowId ? "persisted" : "skipped",
      caveats: [...result.caveats, ...persistenceCaveats],
    });
  } catch (error) {
    return safeFixRunError(error);
  }
}
