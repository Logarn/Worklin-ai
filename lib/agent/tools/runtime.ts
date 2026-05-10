import { z } from "zod";
import { POST as auditFixRunRoute } from "@/app/api/audits/fix-run/route";
import { POST as retentionAuditRoute } from "@/app/api/audits/retention/route";
import {
  serializeWorkflowRun,
  serializeWorkflowRunSummary,
} from "@/app/api/agent/workflows/shared";
import { DEFAULT_STORE_ID } from "@/app/api/brain/profile/store";
import { GET as campaignInsightsRoute } from "@/app/api/memory/insights/route";
import { logActionEvent } from "@/lib/action-log/action-log";
import { getAgentToolByName } from "@/lib/agent/tools/registry";
import type { AgentToolDefinition } from "@/lib/agent/tools/types";
import { listCampaignOpportunities } from "@/lib/campaigns/opportunity-engine";
import { listMicroCampaignPackages } from "@/lib/campaigns/micro-campaign-factory";
import {
  buildUnifiedCustomerIdentity,
  UNIFIED_CUSTOMER_IDENTITY_DEPTHS,
} from "@/lib/customers/unified-identity";
import { listCustomerFeatureStore } from "@/lib/customers/feature-store";
import { listMicroSegmentDefinitions } from "@/lib/customers/micro-segment-definitions";
import { listCustomerScores } from "@/lib/customers/scoring";
import { prisma } from "@/lib/prisma";
import { getPlaybookById, isPlaybookType, listPlaybooks } from "@/lib/playbooks";

const RUNTIME_ORIGIN = "http://worklin.local";
const DEFAULT_WORKFLOW_LIMIT = 50;
const MAX_WORKFLOW_LIMIT = 100;

const TOOL_ALIASES: Record<string, string> = {
  "audit.runRetentionAudit": "workflow.retentionAudit",
  "audit.prepareFixRun": "workflow.auditFixRun",
};

const PURE_READ_NO_ACTION_LOG_TOOLS = new Set([
  "memory.getUnifiedCustomerIdentity",
  "memory.getMicroSegmentDefinitions",
  "memory.getCampaignOpportunities",
  "memory.getMicroCampaignPackages",
]);

const runtimeInputSchema = z.object({
  toolName: z.string().trim().min(1, "toolName is required.").max(160),
  input: z.unknown().optional(),
  approval: z
    .object({
      approvalId: z.string().trim().min(1).max(200).optional(),
    })
    .passthrough()
    .optional(),
});

const optionalLimitSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? Number(value) : value;
}, z.number().int().min(1).max(MAX_WORKFLOW_LIMIT).optional());

const workflowListSchema = z
  .object({
    type: z.string().trim().min(1).max(100).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    limit: optionalLimitSchema,
  })
  .passthrough();

const workflowGetSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    workflowId: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

const playbookListSchema = z
  .object({
    type: z.string().trim().min(1).max(40).optional(),
  })
  .passthrough();

const playbookGetSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
  })
  .passthrough();

const unifiedCustomerIdentitySchema = z
  .object({
    customerId: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().min(3).max(320).optional(),
    externalId: z.string().trim().min(1).max(200).optional(),
    depth: z.enum(UNIFIED_CUSTOMER_IDENTITY_DEPTHS).optional(),
    limit: optionalLimitSchema,
    includeProfiles: z.boolean().optional(),
    includeMergeCandidates: z.boolean().optional(),
  })
  .passthrough();

const customerFeatureStoreSchema = z
  .object({
    identityId: z.string().trim().min(1).max(220).optional(),
    timeframeDays: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(730).optional()),
    status: z.enum(["available", "partial", "unavailable"]).optional(),
    limit: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(200).optional()),
  })
  .passthrough();

const customerScoreStoreSchema = z
  .object({
    identityId: z.string().trim().min(1).max(220).optional(),
    timeframeDays: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(730).optional()),
    status: z.enum(["available", "partial", "unavailable"]).optional(),
    limit: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(200).optional()),
  })
  .passthrough();

const microSegmentDefinitionStoreSchema = z
  .object({
    definitionKey: z.string().trim().min(1).max(180).optional(),
    timeframeDays: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(730).optional()),
    status: z.enum(["available", "partial", "unavailable"]).optional(),
    limit: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(100).optional()),
  })
  .passthrough();

const campaignOpportunityStoreSchema = z
  .object({
    opportunityKey: z.string().trim().min(1).max(180).optional(),
    microSegmentDefinitionKey: z.string().trim().min(1).max(180).optional(),
    timeframeDays: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(730).optional()),
    status: z.enum(["available", "partial", "unavailable"]).optional(),
    opportunityType: z.enum(["campaign", "flow", "suppression", "policy", "lifecycle", "review"]).optional(),
    recommendedCampaignType: z.string().trim().min(1).max(120).optional(),
    limit: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(100).optional()),
  })
  .passthrough();

const microCampaignPackageStoreSchema = z
  .object({
    packageKey: z.string().trim().min(1).max(180).optional(),
    opportunityKey: z.string().trim().min(1).max(180).optional(),
    microSegmentDefinitionKey: z.string().trim().min(1).max(180).optional(),
    timeframeDays: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(730).optional()),
    status: z.enum(["prepared", "blocked", "needs_review"]).optional(),
    packageType: z.enum(["campaign", "flow", "suppression", "policy", "lifecycle", "review"]).optional(),
    approvalStatus: z.enum([
      "not_requested",
      "audience_review_required",
      "policy_required",
      "suppression_review_required",
      "review_required",
    ]).optional(),
    limit: z.preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      return typeof value === "string" ? Number(value) : value;
    }, z.number().int().min(1).max(100).optional()),
  })
  .passthrough();

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

const fixRunSchema = z
  .object({
    workflowId: z.string().trim().min(1, "workflowId is required.").max(200),
    mode: z.literal("safe_prepare").optional(),
    scope: z.enum(["all", "fix_first", "campaigns", "flows", "audiences", "performance"]).optional(),
  })
  .passthrough();

export type AgentToolRuntimeRequest = z.infer<typeof runtimeInputSchema>;

type RuntimeFailureReason =
  | "invalid_tool_input"
  | "missing_capability"
  | "tool_unavailable"
  | "external_live_action_blocked"
  | "approval_required"
  | "approval_not_valid"
  | "tool_unimplemented"
  | "tool_execution_failed";

type ToolHandlerResult = {
  ok: boolean;
  status: number;
  result: unknown;
  reason?: string;
  message?: string;
  targetId?: string | null;
  workflowRunId?: string | null;
};

type ToolHandler = (input: unknown) => Promise<ToolHandlerResult>;

class RuntimeInputError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super("Invalid tool input");
    this.name = "RuntimeInputError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asInputRecord(input: unknown) {
  return isRecord(input) ? input : {};
}

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(asInputRecord(input));
  if (!parsed.success) throw new RuntimeInputError(issueMessages(parsed.error));
  return parsed.data;
}

function compactTool(tool: AgentToolDefinition | null) {
  if (!tool) return null;
  return {
    name: tool.name,
    category: tool.category,
    permissionLevel: tool.permissionLevel,
    requiresApproval: tool.requiresApproval,
    riskLevel: tool.riskLevel,
    currentStatus: tool.currentStatus,
    backingRoute: tool.backingRoute,
  };
}

function normalizeRequestedToolName(toolName: string) {
  const trimmed = toolName.trim();
  return {
    requestedToolName: trimmed,
    toolName: TOOL_ALIASES[trimmed] ?? trimmed,
    aliasUsed: Boolean(TOOL_ALIASES[trimmed]),
  };
}

function statusForRuntimeStatus(status: "completed" | "failed" | "refused" | "skipped") {
  return status;
}

function inputSummary(input: unknown) {
  const record = asInputRecord(input);
  return {
    inputType: Array.isArray(input) ? "array" : typeof input,
    inputKeys: Object.keys(record).slice(0, 25),
    workflowId: typeof record.workflowId === "string" ? record.workflowId : null,
    id: typeof record.id === "string" ? record.id : null,
  };
}

function outputSummary(result: unknown, status: number) {
  const record = isRecord(result) ? result : {};
  return {
    statusCode: status,
    ok: isRecord(result) && typeof record.ok === "boolean" ? record.ok : status >= 200 && status < 300,
    resultKeys: Object.keys(record).slice(0, 25),
    count: typeof record.count === "number" ? record.count : null,
    workflowId: typeof record.workflowId === "string" ? record.workflowId : null,
    actionLogId: isRecord(record.actionLog) && typeof record.actionLog.id === "string"
      ? record.actionLog.id
      : null,
    externalActionTaken: false,
    canGoLiveNow: false,
  };
}

function targetFromInput(toolName: string, input: unknown) {
  const record = asInputRecord(input);
  if (toolName === "workflow.get") {
    const id = typeof record.id === "string" ? record.id : record.workflowId;
    return typeof id === "string" ? { targetType: "workflow-run", targetId: id, workflowRunId: id } : {};
  }
  if (toolName === "workflow.auditFixRun") {
    const id = typeof record.workflowId === "string" ? record.workflowId : null;
    return id ? { targetType: "workflow-run", targetId: id, workflowRunId: id } : {};
  }
  return { targetType: "agent-tool", targetId: toolName };
}

function targetFromResult(toolName: string, input: unknown, result: unknown) {
  const record = isRecord(result) ? result : {};
  const workflowId = typeof record.workflowId === "string" ? record.workflowId : null;
  if (workflowId) {
    return { targetType: "workflow-run", targetId: workflowId, workflowRunId: workflowId };
  }
  return targetFromInput(toolName, input);
}

function shouldSkipRuntimeActionLog(tool: AgentToolDefinition | null) {
  return Boolean(tool && PURE_READ_NO_ACTION_LOG_TOOLS.has(tool.name) && tool.permissionLevel === "read");
}

function skippedRuntimeActionLog(toolName: string) {
  return {
    id: null,
    skipped: true,
    reason: "pure_read_memory_summary",
    toolName,
  };
}

async function logRuntimeEvent(input: {
  tool: AgentToolDefinition | null;
  requestedToolName: string;
  toolName: string;
  aliasUsed: boolean;
  runtimeStatus: "completed" | "failed" | "refused" | "skipped";
  reason?: string;
  summary: string;
  toolInput: unknown;
  result?: unknown;
  statusCode: number;
  approvalStatus: string | null;
  target?: {
    targetType?: string;
    targetId?: string;
    workflowRunId?: string;
  };
  errorMessage?: string | null;
}) {
  const target = input.target ?? targetFromInput(input.toolName, input.toolInput);
  return logActionEvent({
    eventType: `agent_tool.${input.runtimeStatus}`,
    actionType: "execute_agent_tool",
    status: statusForRuntimeStatus(input.runtimeStatus),
    actorType: "api",
    targetType: target.targetType ?? "agent-tool",
    targetId: target.targetId ?? input.toolName,
    workflowRunId: target.workflowRunId ?? null,
    riskLevel: input.tool?.riskLevel ?? "unknown",
    requiresApproval: input.tool?.requiresApproval ?? false,
    approvalStatus: input.approvalStatus,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: input.summary,
    inputSummary: {
      requestedToolName: input.requestedToolName,
      toolName: input.toolName,
      aliasUsed: input.aliasUsed,
      reason: input.reason ?? null,
      ...inputSummary(input.toolInput),
    },
    outputSummary: outputSummary(input.result ?? {}, input.statusCode),
    errorMessage: input.errorMessage ?? null,
    metadata: {
      route: "POST /api/agent/tools/execute",
      permissionLevel: input.tool?.permissionLevel ?? null,
      currentStatus: input.tool?.currentStatus ?? null,
      backingRoute: input.tool?.backingRoute ?? null,
    },
  });
}

function safetyBlock(tool: AgentToolDefinition | null, approvalStatus: string | null, blocked: boolean) {
  return {
    permissionLevel: tool?.permissionLevel ?? null,
    riskLevel: tool?.riskLevel ?? "unknown",
    requiresApproval: tool?.requiresApproval ?? false,
    durableApprovalRequired: Boolean(tool?.requiresApproval && approvalStatus !== "safe_prepare_confirmed"),
    approvalStatus,
    externalActionTaken: false,
    canGoLiveNow: false,
    blocked,
  };
}

async function refusal(input: {
  tool: AgentToolDefinition | null;
  requestedToolName: string;
  toolName: string;
  aliasUsed: boolean;
  reason: RuntimeFailureReason;
  error: string;
  status: number;
  toolInput: unknown;
  approvalStatus: string | null;
  runtimeStatus?: "failed" | "refused" | "skipped";
  issues?: string[];
  safeAlternative?: string;
  roadmapHint?: string;
}) {
  const actionLog = await logRuntimeEvent({
    tool: input.tool,
    requestedToolName: input.requestedToolName,
    toolName: input.toolName,
    aliasUsed: input.aliasUsed,
    runtimeStatus: input.runtimeStatus ?? "refused",
    reason: input.reason,
    summary: input.error,
    toolInput: input.toolInput,
    result: { ok: false, reason: input.reason, issues: input.issues ?? [] },
    statusCode: input.status,
    approvalStatus: input.approvalStatus,
    errorMessage: input.error,
  });

  return {
    ok: false,
    reason: input.reason,
    error: input.error,
    issues: input.issues ?? [],
    ...(input.safeAlternative ? { safeAlternative: input.safeAlternative } : {}),
    ...(input.roadmapHint ? { roadmapHint: input.roadmapHint } : {}),
    requestedToolName: input.requestedToolName,
    toolName: input.tool ? input.tool.name : input.toolName,
    toolMetadata: compactTool(input.tool),
    result: null,
    safety: safetyBlock(input.tool, input.approvalStatus, true),
    actionLog: actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning },
    status: input.status,
  };
}

async function verifyApproval(approval: AgentToolRuntimeRequest["approval"]) {
  const approvalId = approval?.approvalId?.trim();
  if (!approvalId) return { ok: false as const, status: "missing" as const };

  const row = await prisma.approval.findUnique({
    where: { id: approvalId },
    select: { id: true, status: true, targetType: true, targetId: true },
  });
  if (!row) return { ok: false as const, status: "not_found" as const, approvalId };
  if (row.status !== "approved") {
    return { ok: false as const, status: row.status, approvalId, approval: row };
  }
  return { ok: true as const, status: "approved" as const, approvalId, approval: row };
}

function isSafePrepareOnlyAuditFixRun(toolName: string, input: unknown) {
  if (toolName !== "workflow.auditFixRun") return false;
  const record = asInputRecord(input);
  const mode = typeof record.mode === "string" ? record.mode.trim() : null;
  return !mode || mode === "safe_prepare";
}

async function callJsonPostRoute(
  handler: (request: Request) => Promise<Response>,
  path: string,
  payload: unknown,
): Promise<ToolHandlerResult> {
  const response = await handler(
    new Request(`${RUNTIME_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    }),
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && (!isRecord(data) || data.ok !== false),
    status: response.status,
    result: data,
    reason: response.ok ? undefined : "tool_route_failed",
    workflowRunId: isRecord(data) && typeof data.workflowId === "string" ? data.workflowId : null,
    targetId: isRecord(data) && typeof data.workflowId === "string" ? data.workflowId : null,
  };
}

async function workflowList(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(workflowListSchema, input);
  const workflows = await prisma.workflowRun.findMany({
    where: {
      ...(parsed.type ? { type: parsed.type } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: parsed.limit ?? DEFAULT_WORKFLOW_LIMIT,
  });

  return {
    ok: true,
    status: 200,
    result: {
      ok: true,
      readOnly: true,
      workflows: workflows.map(serializeWorkflowRunSummary),
      count: workflows.length,
      filters: {
        type: parsed.type ?? null,
        status: parsed.status ?? null,
        limit: parsed.limit ?? DEFAULT_WORKFLOW_LIMIT,
      },
    },
  };
}

async function workflowGet(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(workflowGetSchema, input);
  const id = parsed.id ?? parsed.workflowId;
  if (!id) {
    throw new RuntimeInputError(["id or workflowId is required."]);
  }

  const workflow = await prisma.workflowRun.findUnique({
    where: { id },
  });

  if (!workflow) {
    return {
      ok: false,
      status: 404,
      reason: "workflow_not_found",
      result: {
        ok: false,
        readOnly: true,
        error: "Workflow run not found",
        workflowId: id,
      },
      targetId: id,
      workflowRunId: id,
    };
  }

  return {
    ok: true,
    status: 200,
    result: {
      ok: true,
      readOnly: true,
      workflow: serializeWorkflowRun(workflow),
    },
    targetId: workflow.id,
    workflowRunId: workflow.id,
  };
}

async function playbooksList(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(playbookListSchema, input);
  if (parsed.type && !isPlaybookType(parsed.type)) {
    throw new RuntimeInputError(["type must be either flow or campaign."]);
  }

  const type = parsed.type && isPlaybookType(parsed.type) ? parsed.type : undefined;
  const playbooks = listPlaybooks(type);

  return {
    ok: true,
    status: 200,
    result: {
      ok: true,
      readOnly: true,
      playbooks,
      count: playbooks.length,
      filters: type ? { type } : {},
    },
  };
}

async function playbooksGet(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(playbookGetSchema, input);
  const playbook = getPlaybookById(parsed.id);

  if (!playbook) {
    return {
      ok: false,
      status: 404,
      reason: "playbook_not_found",
      result: {
        ok: false,
        readOnly: true,
        error: "Playbook not found",
        id: parsed.id,
      },
      targetId: parsed.id,
    };
  }

  return {
    ok: true,
    status: 200,
    result: {
      ok: true,
      readOnly: true,
      playbook,
    },
    targetId: playbook.id,
  };
}

async function campaignInsights(): Promise<ToolHandlerResult> {
  const response = await campaignInsightsRoute();
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    result: {
      ok: response.ok,
      readOnly: true,
      ...data,
    },
    reason: response.ok ? undefined : "campaign_memory_insights_failed",
  };
}

async function unifiedCustomerIdentity(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(unifiedCustomerIdentitySchema, input);
  const result = await buildUnifiedCustomerIdentity(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_unified_customer_identity_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        externalActionTaken: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function customerFeatureStore(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(customerFeatureStoreSchema, input);
  const result = await listCustomerFeatureStore(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_customer_feature_store_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function customerScoreStore(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(customerScoreStoreSchema, input);
  const result = await listCustomerScores(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_customer_score_store_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function microSegmentDefinitionStore(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(microSegmentDefinitionStoreSchema, input);
  const result = await listMicroSegmentDefinitions(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_micro_segment_definition_store_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        activationStatus: "definition_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function campaignOpportunityStore(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(campaignOpportunityStoreSchema, input);
  const result = await listCampaignOpportunities(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_campaign_opportunity_store_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        activationStatus: "opportunity_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function microCampaignPackageStore(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(microCampaignPackageStoreSchema, input);
  const result = await listMicroCampaignPackages(parsed);

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      reason: "invalid_micro_campaign_package_store_request",
      result: {
        ok: false,
        readOnly: true,
        issues: result.issues,
        activationStatus: "package_only",
        externalActionTaken: false,
        rawContactFieldsReturned: false,
        canGoLiveNow: false,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    result,
  };
}

async function brandContext(): Promise<ToolHandlerResult> {
  const storeId = DEFAULT_STORE_ID;
  const [profile, rules, ctas, phrases, customVoiceDimensions] = await Promise.all([
    prisma.brandProfile.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        brandName: true,
        tagline: true,
        industry: true,
        niche: true,
        brandStory: true,
        usp: true,
        missionStatement: true,
        websiteUrl: true,
        shopifyUrl: true,
        targetDemographics: true,
        targetPsychographics: true,
        audiencePainPoints: true,
        audienceDesires: true,
        voiceFormalCasual: true,
        voiceSeriousPlayful: true,
        voiceReservedEnthusiastic: true,
        voiceTechnicalSimple: true,
        voiceAuthoritativeApproachable: true,
        voiceMinimalDescriptive: true,
        voiceLuxuryAccessible: true,
        voiceEdgySafe: true,
        voiceEmotionalRational: true,
        voiceTrendyTimeless: true,
        voiceDescription: true,
        greetingStyle: true,
        signOffStyle: true,
        emojiUsage: true,
        preferredLength: true,
        discountPhilosophy: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.brandRule.findMany({
      where: { storeId },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 80,
    }),
    prisma.brandCTA.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.brandPhrase.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.customVoiceDimension.findMany({
      where: { storeId },
      orderBy: { createdAt: "asc" },
      take: 20,
    }),
  ]);

  return {
    ok: true,
    status: 200,
    result: {
      ok: true,
      readOnly: true,
      storeId,
      profile,
      rules,
      ctas,
      phrases,
      customVoiceDimensions,
      missing: profile ? [] : ["brand.profile"],
    },
  };
}

async function retentionAudit(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(retentionAuditSchema, input);
  return callJsonPostRoute(retentionAuditRoute, "/api/audits/retention", parsed);
}

async function auditFixRun(input: unknown): Promise<ToolHandlerResult> {
  const parsed = parseToolInput(fixRunSchema, input);
  return callJsonPostRoute(auditFixRunRoute, "/api/audits/fix-run", {
    mode: "safe_prepare",
    scope: "all",
    ...parsed,
  });
}

const SAFE_TOOL_HANDLERS: Record<string, ToolHandler> = {
  "workflow.list": workflowList,
  "workflow.get": workflowGet,
  "playbooks.list": playbooksList,
  "playbooks.get": playbooksGet,
  "memory.getCampaignInsights": campaignInsights,
  "memory.getUnifiedCustomerIdentity": unifiedCustomerIdentity,
  "memory.getCustomerFeatureStore": customerFeatureStore,
  "memory.getCustomerScores": customerScoreStore,
  "memory.getMicroSegmentDefinitions": microSegmentDefinitionStore,
  "memory.getCampaignOpportunities": campaignOpportunityStore,
  "memory.getMicroCampaignPackages": microCampaignPackageStore,
  "brain.readBrandContext": brandContext,
  "workflow.retentionAudit": retentionAudit,
  "workflow.auditFixRun": auditFixRun,
};

export async function executeAgentToolRuntime(input: AgentToolRuntimeRequest) {
  const parsed = runtimeInputSchema.parse(input);
  const { requestedToolName, toolName, aliasUsed } = normalizeRequestedToolName(parsed.toolName);
  const tool = getAgentToolByName(toolName);
  const toolInput = parsed.input ?? {};

  if (!tool) {
    return refusal({
      tool,
      requestedToolName,
      toolName,
      aliasUsed,
      reason: "missing_capability",
      error: "Agent tool is not registered.",
      status: 404,
      toolInput,
      approvalStatus: null,
      safeAlternative: "Use a registered safe tool such as workflow.list, workflow.get, playbooks.list, playbooks.get, memory.getCampaignInsights, memory.getUnifiedCustomerIdentity, memory.getCustomerFeatureStore, memory.getCustomerScores, memory.getMicroSegmentDefinitions, memory.getCampaignOpportunities, memory.getMicroCampaignPackages, brain.readBrandContext, or audit.runRetentionAudit.",
      roadmapHint: "Add new capabilities to the Tool Registry and SAFE_TOOL_HANDLERS only after a safety review.",
    });
  }

  if (tool.permissionLevel === "external_live_action") {
    return refusal({
      tool,
      requestedToolName,
      toolName,
      aliasUsed,
      reason: "external_live_action_blocked",
      error: "External live action tools are blocked by Tool Execution Runtime v0.",
      status: 403,
      toolInput,
      approvalStatus: "blocked_external_live_action",
    });
  }

  if (tool.currentStatus !== "available") {
    return refusal({
      tool,
      requestedToolName,
      toolName,
      aliasUsed,
      reason: "tool_unavailable",
      error: `Agent tool is ${tool.currentStatus}.`,
      status: 409,
      toolInput,
      approvalStatus: tool.requiresApproval ? "not_checked" : "not_required",
      runtimeStatus: "skipped",
    });
  }

  const safePrepareOnly = isSafePrepareOnlyAuditFixRun(tool.name, toolInput);
  const approval = tool.requiresApproval && !safePrepareOnly
    ? await verifyApproval(parsed.approval)
    : {
        ok: true as const,
        status: tool.requiresApproval ? "safe_prepare_confirmed" as const : "not_required" as const,
      };
  const approvalStatus = tool.requiresApproval ? approval.status : "not_required";

  if (tool.requiresApproval && !safePrepareOnly && !approval.ok) {
    return refusal({
      tool,
      requestedToolName,
      toolName,
      aliasUsed,
      reason: approval.status === "missing" ? "approval_required" : "approval_not_valid",
      error: approval.status === "missing"
        ? "This agent tool requires an approved Approval id before execution."
        : "The provided Approval id is missing, not found, or not approved.",
      status: 403,
      toolInput,
      approvalStatus: approval.status,
      safeAlternative: tool.name === "workflow.auditFixRun"
        ? "Run audit.prepareFixRun only in safe_prepare mode, or provide an approved Approval id for approval-gated tools."
        : "Request or approve the durable Approval record before executing this tool.",
    });
  }

  const handler = SAFE_TOOL_HANDLERS[tool.name];
  if (!handler) {
    return refusal({
      tool,
      requestedToolName,
      toolName,
      aliasUsed,
      reason: "tool_unimplemented",
      error: "Agent tool is registered but not wired in Tool Execution Runtime v0.",
      status: 501,
      toolInput,
      approvalStatus,
      runtimeStatus: "skipped",
      safeAlternative: "Use one of the explicitly wired safe v0 tools.",
      roadmapHint: "Wire this registered tool in SAFE_TOOL_HANDLERS only after confirming its side effects and safety posture.",
    });
  }

  try {
    const execution = await handler(toolInput);
    const ok = execution.ok && execution.status >= 200 && execution.status < 300;
    const target = ok
      ? targetFromResult(tool.name, toolInput, execution.result)
      : targetFromInput(tool.name, toolInput);
    const actionLog = shouldSkipRuntimeActionLog(tool)
      ? null
      : await logRuntimeEvent({
          tool,
          requestedToolName,
          toolName,
          aliasUsed,
          runtimeStatus: ok ? "completed" : "failed",
          reason: execution.reason,
          summary: ok
            ? "Agent tool executed through Tool Execution Runtime v0."
            : "Agent tool execution returned a safe failure response.",
          toolInput,
          result: execution.result,
          statusCode: execution.status,
          approvalStatus,
          target,
          errorMessage: ok ? null : execution.reason ?? "Tool execution failed",
        });

    return {
      ok,
      reason: ok ? null : execution.reason ?? "tool_execution_failed",
      error: ok ? null : execution.message ?? "Agent tool execution failed.",
      requestedToolName,
      toolName: tool.name,
      toolMetadata: compactTool(tool),
      result: execution.result,
      safety: safetyBlock(tool, approvalStatus, false),
      actionLog: actionLog
        ? actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning }
        : skippedRuntimeActionLog(tool.name),
      status: execution.status,
    };
  } catch (error) {
    const status = error instanceof RuntimeInputError ? 400 : 500;
    const reason: RuntimeFailureReason =
      error instanceof RuntimeInputError ? "invalid_tool_input" : "tool_execution_failed";
    const message = error instanceof RuntimeInputError
      ? "Invalid tool input."
      : "Agent tool execution failed.";
    const issues = error instanceof RuntimeInputError ? error.issues : [];
    const actionLog = shouldSkipRuntimeActionLog(tool)
      ? null
      : await logRuntimeEvent({
          tool,
          requestedToolName,
          toolName,
          aliasUsed,
          runtimeStatus: "failed",
          reason,
          summary: message,
          toolInput,
          result: { ok: false, reason, issues },
          statusCode: status,
          approvalStatus,
          errorMessage: error instanceof Error ? error.message : String(error),
        });

    return {
      ok: false,
      reason,
      error: message,
      issues,
      requestedToolName,
      toolName: tool.name,
      toolMetadata: compactTool(tool),
      result: null,
      safety: safetyBlock(tool, approvalStatus, true),
      actionLog: actionLog
        ? actionLog.ok ? { id: actionLog.actionLog.id } : { warning: actionLog.warning }
        : skippedRuntimeActionLog(tool.name),
      status,
    };
  }
}

export function parseAgentToolRuntimeRequest(body: unknown):
  | { ok: true; data: AgentToolRuntimeRequest }
  | { ok: false; issues: string[] } {
  const parsed = runtimeInputSchema.safeParse(body);
  if (!parsed.success) return { ok: false, issues: issueMessages(parsed.error) };
  return { ok: true, data: parsed.data };
}
