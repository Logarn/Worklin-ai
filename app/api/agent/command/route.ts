import { NextResponse } from "next/server";
import { z } from "zod";
import { POST as approveWorkflow } from "@/app/api/agent/commands/approve-workflow/route";
import { POST as auditFixRun } from "@/app/api/audits/fix-run/route";
import { POST as auditRetention } from "@/app/api/audits/retention/route";
import { POST as recommendFlows } from "@/app/api/flows/recommend/route";
import {
  cleanWorkflowId,
  serializeWorkflowRun,
  serializeWorkflowRunSummary,
} from "@/app/api/agent/workflows/shared";
import { POST as planBriefQaWorkflow } from "@/app/api/agent/workflows/plan-brief-qa/route";
import { buildAgentContext } from "@/lib/agent/context/build-context";
import { parseAgentIntent } from "@/lib/agent/intent/parse-intent";
import { getAgentToolByName } from "@/lib/agent/tools/registry";
import { prisma } from "@/lib/prisma";
import { isPlaybookType, listPlaybooks } from "@/lib/playbooks";
import type { AgentContextResult } from "@/lib/agent/context/types";
import type { IntentParameters } from "@/lib/agent/intent/types";
import type { AgentToolDefinition } from "@/lib/agent/tools/types";
import type { PlaybookType, WorklinPlaybook } from "@/lib/playbooks";

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_WORKFLOW_LIMIT = 10;
const COMMAND_ORIGIN = "http://worklin.local";

const commandSchema = z
  .object({
    message: z.string().trim().min(1, "message is required.").max(MAX_MESSAGE_LENGTH),
    workflowId: z.string().trim().min(1).max(200).optional(),
    safeFixPromptContext: z.boolean().optional(),
  })
  .passthrough();

type CommandIntent =
  | "retention_audit"
  | "audit_fix_run"
  | "plan_brief_qa"
  | "approve_workflow"
  | "list_workflows"
  | "get_workflow"
  | "list_playbooks"
  | "recommend_flows"
  | "clarify";

type ToolName =
  | "workflow.retentionAudit"
  | "workflow.auditFixRun"
  | "workflow.planBriefQa"
  | "workflow.approveAndCreateDrafts"
  | "workflow.list"
  | "workflow.get"
  | "playbooks.list"
  | "flows.recommend";

type CommandResponseInput = {
  ok?: boolean;
  intent: CommandIntent;
  tool: ToolName | null;
  result?: unknown;
  message: string;
  status?: number;
  contextSummary?: CommandContextSummary | null;
};

type JsonPostHandler = (request: Request) => Promise<Response>;

type CommandContextSummary = {
  query: string;
  summary: string;
  missing: string[];
  brand: {
    name: string | null;
    rules: number;
    ctas: number;
    phrases: number;
  };
  signals: {
    approval: boolean;
    sendOrSchedule: boolean;
    planning: boolean;
    noDiscount: boolean;
    vip: boolean;
    flow: boolean;
    campaign: boolean;
  };
  playbooks: Array<{
    id: string;
    name: string;
    type: PlaybookType;
    permissionLevel: string;
  }>;
  recentWorkflows: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
  }>;
  recentEligibleWorkflows: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
    summary: unknown;
    recommendedNextAction: unknown;
  }>;
  referencedWorkflow: {
    id: string;
    type: string;
    status: string;
    createdAt: string;
  } | null;
  recentDrafts: number;
  relevantBriefs: number;
  campaignMemory: {
    totalCampaigns: number;
    bestSegmentByRevenue: string | null;
    bestCampaignTypeByRevenue: string | null;
  };
};

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

function commandResponse({
  ok = true,
  intent,
  tool,
  result = {},
  message,
  status = 200,
  contextSummary,
}: CommandResponseInput) {
  const toolDefinition = tool ? getAgentToolByName(tool) : null;

  return NextResponse.json(
    {
      ok,
      intent,
      tool,
      toolMetadata: compactTool(toolDefinition),
      ...(contextSummary ? { contextSummary } : {}),
      result,
      message,
    },
    { status },
  );
}

function normalized(message: string) {
  return message.toLowerCase().replace(/[’']/g, "'").trim();
}

function detectsSendOrScheduleIntent(message: string) {
  return (
    /\b(send|sending|sent|schedule|scheduled|scheduling|launch|launching|go\s+live)\b/i.test(message) ||
    /\b(sync|syncing|push|publish)\b.*\b(segments?|profiles?|flows?|campaigns?|klaviyo)\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify|activate|enable)\b.*\b(live\s+)?(klaviyo\s+)?flows?\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify)\b.*\b(live\s+)?(segments?|profiles?)\b/i.test(message) ||
    /\bdestructive\b.*\bklaviyo\b/i.test(message)
  );
}

function detectsApprovalIntent(message: string) {
  return (
    /\bapproved?\b/i.test(message) ||
    /\blooks?\s+good\b/i.test(message) ||
    /\bgo\s+ahead\b/i.test(message) ||
    /\bapprove\s+(these|them|the\s+ready\s+ones|ready\s+ones)\b/i.test(message) ||
    /\bship\s+the\s+drafts?\b/i.test(message)
  );
}

function detectsPlanBriefQaIntent(message: string) {
  return (
    /\b(plan|prep|prepare|create|generate|build)\b.*\b(campaign|campaigns|retention|email|emails|flow|flows|lifecycle)\b/i.test(message) ||
    /\b(campaign|campaigns|retention\s+campaigns?)\b.*\b(next\s+week|tomorrow|this\s+week|no\s+discounts?)\b/i.test(message)
  );
}

function detectsListWorkflowIntent(message: string) {
  return (
    /\b(show|list|open|view|what)\b.*\b(recent|previous|past|workflow|workflows|runs?|made|created|yesterday)\b/i.test(message) ||
    /\bwhat\s+did\s+you\s+(make|create)\b/i.test(message)
  );
}

function detectsGetWorkflowIntent(message: string) {
  return /\b(open|show|view|get)\b.*\b(this\s+)?(workflow|run)\b/i.test(message);
}

function detectsListPlaybooksIntent(message: string) {
  return /\b(playbook|playbooks)\b/i.test(message);
}

function detectsRecommendFlowsIntent(message: string) {
  return (
    /\b(audit|diagnose|review|fix|improve|optimi[sz]e)\b.*\b(klaviyo\s+)?flows?\b/i.test(message) ||
    /\b(what|which)\b.*\b(lifecycle\s+)?flows?\b.*\b(missing|build|next|need|have|recommend)\b/i.test(message) ||
    /\b(lifecycle|automation|automations)\b.*\b(missing|build|next|need|have|recommend|audit|fix)\b/i.test(message) ||
    /\b(recover|recovery)\b.*\b(abandoned?\s+checkouts?|checkout\s+abandon|abandoned?\s+carts?|cart\s+abandon)\b/i.test(message) ||
    /\b(increase|grow|improve)\b.*\b(repeat\s+purchases?|reorders?|restock|replenishment)\b.*\b(flows?|automations?)\b/i.test(message) ||
    /\bwhat\s+automations?\s+should\s+this\s+brand\s+have\b/i.test(message)
  );
}

function detectsRetentionAuditIntent(message: string) {
  const text = normalized(message);
  const narrowAuditDomain =
    /\b(flows?|campaigns?|segments?|audiences?|products?|metrics?)\b/.test(text) &&
    !/\b(retention|account|setup|lifecycle)\b/.test(text);

  if (narrowAuditDomain && /\baudit\b/.test(text)) return false;

  return (
    /\b(audit|check|review|diagnose|inspect)\b.*\b(retention\s+setup|retention\s+system|retention|account)\b/i.test(text) ||
    /\brun\s+(?:a|an|another|a\s+fresh|fresh)\s+(?:retention\s+)?audit\b/i.test(text) ||
    /\brefresh\s+(?:the\s+)?(?:retention\s+)?audit\b/i.test(text) ||
    /\bre[-\s]?audit\s+(?:this\s+|the\s+|my\s+)?(?:account|retention|setup)\b/i.test(text) ||
    /\bcheck\s+(?:my|the|this)?\s*retention\s+again\b/i.test(text) ||
    /\bwhat'?s\s+broken\s+in\s+retention\b/i.test(text) ||
    /\bhow\s+healthy\s+is\s+(my|the)\s+retention\b/i.test(text)
  );
}

function detectsExplicitFixConfirmationIntent(message: string) {
  return (
    /\bfix\s+all\b/i.test(message) ||
    /\bfix\s+(all\s+)?(this|it|these|what\s+you\s+can)\b/i.test(message) ||
    /\bprepare\s+(the\s+)?(safe\s+)?fixes\b/i.test(message) ||
    /\bhandle\s+(the\s+)?safe\s+fixes\b/i.test(message) ||
    /\bprepare\s+everything\s+safe\b/i.test(message) ||
    /\bfix\s+what\s+you\s+can\b/i.test(message)
  );
}

function detectsVagueFixConfirmationIntent(message: string) {
  return /^\s*(yes|yeah|yep|sure|ok|okay|do it|go ahead|please do)\s*[.!]?\s*$/i.test(message);
}

function inferPlaybookType(message: string): PlaybookType | undefined {
  const text = normalized(message);
  if (/\bflows?\b/.test(text)) return "flow";
  if (/\bcampaigns?\b/.test(text)) return "campaign";
  return undefined;
}

function inferIntent(message: string, workflowId?: string): CommandIntent {
  if (detectsSendOrScheduleIntent(message)) return "clarify";
  if (detectsRetentionAuditIntent(message)) return "retention_audit";
  if (detectsExplicitFixConfirmationIntent(message)) return "audit_fix_run";
  if (detectsApprovalIntent(message)) return workflowId ? "approve_workflow" : "clarify";
  if (detectsListPlaybooksIntent(message)) return "list_playbooks";
  if (detectsGetWorkflowIntent(message)) return workflowId ? "get_workflow" : "clarify";
  if (detectsListWorkflowIntent(message)) return "list_workflows";
  if (detectsRecommendFlowsIntent(message)) return "recommend_flows";
  if (detectsPlanBriefQaIntent(message)) return "plan_brief_qa";
  return "clarify";
}

function detectsNoDiscountSignal(message: string, playbooks: WorklinPlaybook[] = []) {
  return (
    /\b(no|without|avoid)\b.*\b(discounts?|coupons?|sales?|markdowns?|promos?|promotions?|offers?)\b/i.test(message) ||
    playbooks.some((playbook) => playbook.id === "no_discount_education")
  );
}

function detectsVipSignal(message: string, playbooks: WorklinPlaybook[] = []) {
  return /\b(vip|early\s+access|loyalty|loyal|champions?)\b/i.test(message) ||
    playbooks.some((playbook) => playbook.id === "vip_early_access");
}

function detectsFlowSignal(message: string, playbooks: WorklinPlaybook[] = []) {
  return /\b(flows?|lifecycle|automations?|welcome|abandon|carts?|checkouts?|replenish|replenishment|winback|win\s+back)\b/i.test(message) ||
    playbooks.some((playbook) => playbook.type === "flow");
}

function detectsCampaignSignal(message: string, playbooks: WorklinPlaybook[] = []) {
  return /\b(campaigns?|emails?|retention)\b/i.test(message) ||
    playbooks.some((playbook) => playbook.type === "campaign");
}

function compactPlaybook(playbook: WorklinPlaybook) {
  return {
    id: playbook.id,
    name: playbook.name,
    type: playbook.type,
    permissionLevel: playbook.permissionLevel,
  };
}

function isRecentEligibleWorkflow(workflow: AgentContextResult["context"]["recentWorkflows"][number]) {
  return workflow.type === "plan-brief-qa" && workflow.status === "completed";
}

function compactContextSummary(result: AgentContextResult): CommandContextSummary {
  const context = result.context;
  const playbooks = context.playbooks.map(compactPlaybook);
  const recentWorkflows = context.recentWorkflows.slice(0, DEFAULT_WORKFLOW_LIMIT).map((workflow) => ({
    id: workflow.id,
    type: workflow.type,
    status: workflow.status,
    createdAt: workflow.createdAt,
  }));
  const recentEligibleWorkflows = context.recentWorkflows
    .filter(isRecentEligibleWorkflow)
    .map((workflow) => ({
      id: workflow.id,
      type: workflow.type,
      status: workflow.status,
      createdAt: workflow.createdAt,
      summary: workflow.summary ?? null,
      recommendedNextAction: workflow.recommendedNextAction ?? null,
    }));

  return {
    query: result.query,
    summary: result.summary,
    missing: result.missing,
    brand: {
      name: context.brand.profile?.brandName ?? null,
      rules: context.brand.rules.length,
      ctas: context.brand.ctas.length,
      phrases: context.brand.phrases.length,
    },
    signals: {
      approval: detectsApprovalIntent(result.query),
      sendOrSchedule: detectsSendOrScheduleIntent(result.query),
      planning: detectsPlanBriefQaIntent(result.query),
      noDiscount: detectsNoDiscountSignal(result.query, context.playbooks),
      vip: detectsVipSignal(result.query, context.playbooks),
      flow: detectsFlowSignal(result.query, context.playbooks),
      campaign: detectsCampaignSignal(result.query, context.playbooks),
    },
    playbooks,
    recentWorkflows,
    recentEligibleWorkflows,
    referencedWorkflow: context.referencedWorkflow
      ? {
          id: context.referencedWorkflow.id,
          type: context.referencedWorkflow.type,
          status: context.referencedWorkflow.status,
          createdAt: context.referencedWorkflow.createdAt,
        }
      : null,
    recentDrafts: context.recentDrafts.length,
    relevantBriefs: context.relevantBriefs.length,
    campaignMemory: {
      totalCampaigns: context.campaignMemory.summary.totalCampaigns,
      bestSegmentByRevenue: context.campaignMemory.bestSegmentByRevenue?.key ?? null,
      bestCampaignTypeByRevenue: context.campaignMemory.bestCampaignTypeByRevenue?.key ?? null,
    },
  };
}

function contextPlanningConstraints(contextSummary: CommandContextSummary) {
  const constraints = [];
  if (contextSummary.signals.noDiscount) constraints.push("no discounts");
  if (contextSummary.signals.vip) constraints.push("include one VIP campaign");

  for (const playbook of contextSummary.playbooks) {
    if (playbook.type === "flow") constraints.push(`consider ${playbook.name} flow playbook`);
    if (playbook.type === "campaign") constraints.push(`consider ${playbook.name} campaign playbook`);
  }

  return Array.from(new Set(constraints));
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

async function callJsonRoute(handler: JsonPostHandler, path: string, payload: unknown) {
  const response = await handler(
    new Request(`${COMMAND_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function routePlanBriefQa(
  message: string,
  contextSummary: CommandContextSummary,
  parameters: IntentParameters = {},
) {
  const constraints = uniqueStrings([
    ...contextPlanningConstraints(contextSummary),
    ...(parameters.constraints ?? []),
  ]);
  const { response, data } = await callJsonRoute(
    planBriefQaWorkflow,
    "/api/agent/workflows/plan-brief-qa",
    {
      prompt: message,
      constraints,
      ...(parameters.campaignCount ? { campaignCount: parameters.campaignCount } : {}),
      ...(parameters.focus ? { focus: parameters.focus } : {}),
    },
  );

  return commandResponse({
    ok: response.ok && data?.ok !== false,
    intent: "plan_brief_qa",
    tool: "workflow.planBriefQa",
    result: data,
    message: response.ok
      ? "I created a Plan -> Brief -> QA workflow from your request."
      : "I could not create the Plan -> Brief -> QA workflow.",
    status: response.status,
    contextSummary,
  });
}

async function routeApproveWorkflow(message: string, workflowId: string, contextSummary: CommandContextSummary) {
  const { response, data } = await callJsonRoute(
    approveWorkflow,
    "/api/agent/commands/approve-workflow",
    { message, workflowId },
  );

  return commandResponse({
    ok: response.ok && data?.ok !== false,
    intent: "approve_workflow",
    tool: "workflow.approveAndCreateDrafts",
    result: data,
    message: response.ok
      ? "I routed your approval to draft creation for the eligible briefs. Nothing was scheduled or sent."
      : "I could not approve this workflow for draft creation.",
    status: response.status,
    contextSummary,
  });
}

async function routeRecommendFlows(
  message: string,
  contextSummary: CommandContextSummary,
  parameters: IntentParameters = {},
) {
  const constraints = uniqueStrings(parameters.constraints ?? []);
  const { response, data } = await callJsonRoute(
    recommendFlows,
    "/api/flows/recommend",
    {
      message,
      goal: parameters.focus ?? message,
      ...(constraints.length ? { constraints } : {}),
    },
  );

  return commandResponse({
    ok: response.ok && data?.ok !== false,
    intent: "recommend_flows",
    tool: "flows.recommend",
    result: data,
    message: response.ok
      ? "I ran the read-only Flow Planner against the connected Klaviyo flows."
      : "I could not run the read-only Flow Planner.",
    status: response.status,
    contextSummary,
  });
}

function workflowUrl(workflowId: string) {
  return `/agent/workflows?workflowId=${encodeURIComponent(workflowId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function issueTitles(items: unknown, limit: number) {
  return asArray<Record<string, unknown>>(items)
    .map((item) => asString(item.title))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function uniquePriorityTitles(...groups: string[][]) {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const title of groups.flat()) {
    const clean = cleanPriorityTitle(title);
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(clean);
  }
  return titles;
}

function cleanPriorityTitle(title: string) {
  const trimmed = title.trim().replace(/[.!?]+$/, "");
  if (/revenue performance setup needs a verified conversion metric/i.test(trimmed)) {
    return "Confirm Klaviyo conversion metric before trusting performance-backed recommendations";
  }
  if (/retention foundation needs sequencing before action plans/i.test(trimmed)) {
    return "Define sequencing and suppression guardrails before preparing campaigns or flows";
  }
  if (/suppression guardrails/i.test(trimmed)) {
    return "Define suppression guardrails before preparing campaigns or flows";
  }
  return trimmed.replace(/\baction plans?\b/gi, "safe fix prep");
}

function numberedLines(items: string[], limit = 3) {
  return items.slice(0, limit).map((item, index) => `${index + 1}. ${item}.`);
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compactRetentionAuditResult(data: unknown) {
  const audit = isRecord(data) ? data : {};
  const health = isRecord(audit.overallRetentionHealth) ? audit.overallRetentionHealth : {};
  const summary = isRecord(audit.summary) ? audit.summary : {};
  const workflowId = asString(audit.workflowId);

  return {
    workflowId,
    workflowUrl: workflowId ? workflowUrl(workflowId) : null,
    workflowType: "retention_audit",
    workflowPersistence: asString(audit.workflowPersistence),
    overallRetentionHealth: {
      score: typeof health.score === "number" ? health.score : null,
      status: asString(health.status),
      label: asString(health.label),
    },
    executiveSummary: asString(summary.executiveSummary),
    topIssues: issueTitles(audit.topIssues, 5),
    topOpportunities: issueTitles(audit.topOpportunities, 5),
    prioritizedActions: issueTitles(audit.prioritizedActions, 5),
    caveatCount: asArray(audit.caveats).length,
    asksForFixConfirmation: true,
  };
}

function retentionAuditChatMessage(result: ReturnType<typeof compactRetentionAuditResult>) {
  const priorities = uniquePriorityTitles(
    result.topIssues,
    result.prioritizedActions,
    result.topOpportunities,
  );
  const priorityLines = priorities.length
    ? numberedLines(priorities)
    : ["1. Review the audit caveats before preparing fixes."];

  return [
    "I audited your retention setup.",
    "",
    "Top priorities:",
    ...priorityLines,
    "",
    "Open the full audit canvas:",
    result.workflowId
      ? `[Open Retention Audit](${workflowUrl(result.workflowId)})`
      : "The audit ran, but the WorkflowRun id was not returned.",
    "",
    "Want me to prepare the safe fixes?",
    "",
    "Nothing will be sent, scheduled, synced, created live, or changed externally.",
  ].join("\n");
}

async function routeRetentionAudit(contextSummary: CommandContextSummary) {
  const { response, data } = await callJsonRoute(
    auditRetention,
    "/api/audits/retention",
    {},
  );
  const result = compactRetentionAuditResult(data);

  return commandResponse({
    ok: response.ok && isRecord(data) && data.ok !== false,
    intent: "retention_audit",
    tool: "workflow.retentionAudit",
    result,
    message: response.ok
      ? retentionAuditChatMessage(result)
      : "I could not complete the retention audit. No sends, schedules, syncs, drafts, or live changes were attempted.",
    status: response.status,
    contextSummary,
  });
}

function completedRetentionAuditCandidates(contextSummary: CommandContextSummary) {
  return contextSummary.recentWorkflows.filter((workflow) =>
    workflow.type === "retention-audit" && workflow.status === "completed",
  );
}

async function resolveRetentionAuditWorkflowId(
  workflowId: string | undefined,
  contextSummary: CommandContextSummary,
  options: { allowLatestFallback?: boolean } = {},
) {
  const id = cleanWorkflowId(workflowId);

  if (id) {
    const workflow = await prisma.workflowRun.findUnique({
      where: { id },
      select: { id: true, type: true, status: true, createdAt: true },
    });
    if (!workflow) {
      return {
        ok: false as const,
        status: 404,
        reason: "workflow_not_found",
        message: "I could not find that workflow. Send the retention audit workflowId you want me to prepare fixes for.",
        candidates: [],
      };
    }
    if (workflow.type !== "retention-audit") {
      return {
        ok: false as const,
        status: 400,
        reason: "not_retention_audit",
        message: "That workflow is not a retention audit. I can only prepare safe fixes from a retention-audit WorkflowRun.",
        candidates: completedRetentionAuditCandidates(contextSummary),
      };
    }
    if (workflow.status !== "completed") {
      return {
        ok: false as const,
        status: 400,
        reason: "retention_audit_not_completed",
        message: "That retention audit is not completed yet. I can prepare safe fixes after the audit finishes.",
        candidates: completedRetentionAuditCandidates(contextSummary),
      };
    }
    return { ok: true as const, workflowId: workflow.id, source: "explicit" as const };
  }

  const candidates = completedRetentionAuditCandidates(contextSummary);
  if (options.allowLatestFallback && candidates.length === 1) {
    return { ok: true as const, workflowId: candidates[0].id, source: "latest_recent" as const };
  }

  return {
    ok: false as const,
    status: 200,
    reason: candidates.length ? "multiple_retention_audits" : "missing_retention_audit_context",
    message: candidates.length
      ? "I found more than one recent retention audit. Which one should I prepare safe fixes for?"
      : "Do you mean you want me to prepare the safe fixes for the latest retention audit? Send the retention audit workflowId so I do not guess.",
    candidates,
  };
}

function compactFixRunResult(data: unknown) {
  const fixRun = isRecord(data) ? data : {};
  const summary = isRecord(fixRun.summary) ? fixRun.summary : {};
  const workflowId = asString(fixRun.workflowId);
  const fixGroups = isRecord(fixRun.fixGroups) ? fixRun.fixGroups : {};

  return {
    workflowId,
    workflowUrl: workflowId ? workflowUrl(workflowId) : null,
    sourceWorkflowId: asString(fixRun.sourceWorkflowId),
    workflowType: "audit_fix_run",
    workflowPersistence: asString(fixRun.workflowPersistence),
    summary: {
      prepared: typeof summary.prepared === "number" ? summary.prepared : 0,
      blocked: typeof summary.blocked === "number" ? summary.blocked : 0,
      needsApproval: typeof summary.needsApproval === "number" ? summary.needsApproval : 0,
      chatSummary: asString(summary.chatSummary),
    },
    fixGroups: {
      campaigns: asArray(fixGroups.campaigns).length,
      flows: asArray(fixGroups.flows).length,
      audiences: asArray(fixGroups.audiences).length,
      performance: asArray(fixGroups.performance).length,
      suppression: asArray(fixGroups.suppression).length,
    },
    blockedFixes: asArray<Record<string, unknown>>(fixRun.blockedFixes)
      .map((item) => ({
        title: asString(item.title),
        missingCapability: asString(item.missingCapability),
      }))
      .slice(0, 5),
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      sent: false,
      scheduled: false,
      synced: false,
      createdLive: false,
      changedExternally: false,
    },
  };
}

function fixRunChatMessage(result: ReturnType<typeof compactFixRunResult>) {
  const blocked = result.summary.blocked;
  const groupParts = [
    result.fixGroups.campaigns ? countLabel(result.fixGroups.campaigns, "campaign fix", "campaign fixes") : null,
    result.fixGroups.flows ? countLabel(result.fixGroups.flows, "flow fix", "flow fixes") : null,
    result.fixGroups.audiences ? countLabel(result.fixGroups.audiences, "audience fix", "audience fixes") : null,
    result.fixGroups.performance ? countLabel(result.fixGroups.performance, "performance setup fix", "performance setup fixes") : null,
    result.fixGroups.suppression ? countLabel(result.fixGroups.suppression, "suppression guardrail") : null,
  ].filter((item): item is string => Boolean(item));

  return [
    "I prepared the safe fix package.",
    "",
    "Prepared fixes:",
    ...(groupParts.length ? groupParts.map((item) => `- ${item}`) : [`- ${result.summary.prepared} fixes prepared for review`]),
    "",
    blocked
      ? `${blocked} live execution steps are blocked because the required live capabilities are not enabled yet.`
      : "No live execution step was attempted.",
    "",
    result.workflowId
      ? `[Open Prepared Fix Package](${workflowUrl(result.workflowId)})`
      : "The fix package ran, but no WorkflowRun id was returned.",
    "",
    "Nothing was sent, scheduled, synced, drafted, created live, or changed externally.",
  ].join("\n");
}

async function routeAuditFixRun(
  workflowId: string | undefined,
  contextSummary: CommandContextSummary,
  options: { allowLatestFallback?: boolean } = {},
) {
  const resolved = await resolveRetentionAuditWorkflowId(workflowId, contextSummary, options);

  if (!resolved.ok) {
    return commandResponse({
      ok: false,
      intent: "audit_fix_run",
      tool: "workflow.auditFixRun",
      result: {
        reason: resolved.reason,
        workflowId: workflowId ?? null,
        retentionAuditCandidates: resolved.candidates,
      },
      message: resolved.message,
      status: resolved.status,
      contextSummary,
    });
  }

  const { response, data } = await callJsonRoute(
    auditFixRun,
    "/api/audits/fix-run",
    {
      workflowId: resolved.workflowId,
      mode: "safe_prepare",
      scope: "all",
    },
  );
  const result = compactFixRunResult(data);

  return commandResponse({
    ok: response.ok && isRecord(data) && data.ok !== false,
    intent: "audit_fix_run",
    tool: "workflow.auditFixRun",
    result: {
      ...result,
      contextResolution: resolved.source,
    },
    message: response.ok
      ? fixRunChatMessage(result)
      : "I could not prepare the safe fix package. Nothing was sent, scheduled, synced, drafted, created live, or changed externally.",
    status: response.status,
    contextSummary,
  });
}

async function routeListWorkflows(contextSummary: CommandContextSummary) {
  const workflows = await prisma.workflowRun.findMany({
    orderBy: { createdAt: "desc" },
    take: DEFAULT_WORKFLOW_LIMIT,
  });

  return commandResponse({
    intent: "list_workflows",
    tool: "workflow.list",
    result: {
      workflows: workflows.map(serializeWorkflowRunSummary),
      count: workflows.length,
    },
    message: workflows.length
      ? `Here are the ${workflows.length} most recent workflow runs.`
      : "There are no saved workflow runs yet.",
    contextSummary,
  });
}

async function routeGetWorkflow(workflowId: string, contextSummary: CommandContextSummary) {
  const id = cleanWorkflowId(workflowId);
  if (!id) {
    return commandResponse({
      intent: "clarify",
      tool: "workflow.get",
      result: { workflowId: null },
      message: "Which workflow should I open? Pass a workflowId.",
      contextSummary,
    });
  }

  const workflow = await prisma.workflowRun.findUnique({
    where: { id },
  });

  if (!workflow) {
    return commandResponse({
      ok: false,
      intent: "get_workflow",
      tool: "workflow.get",
      result: { workflowId: id },
      message: "Workflow run not found.",
      status: 404,
      contextSummary,
    });
  }

  return commandResponse({
    intent: "get_workflow",
    tool: "workflow.get",
    result: {
      workflow: serializeWorkflowRun(workflow),
    },
    message: "Here is the saved workflow run.",
    contextSummary,
  });
}

function routeListPlaybooks(
  message: string,
  contextSummary: CommandContextSummary,
  contextResult: AgentContextResult,
  playbookType?: PlaybookType,
) {
  const requestedType = playbookType ?? inferPlaybookType(message);
  const type = requestedType && isPlaybookType(requestedType) ? requestedType : undefined;
  const contextPlaybooks = contextResult.context.playbooks;
  const playbooks = contextPlaybooks.length ? contextPlaybooks : listPlaybooks(type);

  return commandResponse({
    intent: "list_playbooks",
    tool: "playbooks.list",
    result: {
      playbooks,
      count: playbooks.length,
      filters: type ? { type } : {},
      source: contextPlaybooks.length ? "agent_context" : "registry",
    },
    message: type
      ? `Here are the registered ${type} playbooks.`
      : "Here are the registered Worklin playbooks.",
    contextSummary,
  });
}

function routeClarify(message: string, contextSummary: CommandContextSummary, workflowId?: string) {
  if (detectsSendOrScheduleIntent(message)) {
    return commandResponse({
      intent: "clarify",
      tool: null,
      result: {
        reason: "draft_only_refusal",
        workflowId: workflowId ?? null,
      },
      message:
        "I cannot send, schedule, sync, create live flows or segments, or make destructive Klaviyo changes from chat. I can prepare the safe fix package for review; nothing live will be changed.",
      contextSummary,
    });
  }

  if (detectsApprovalIntent(message) && !workflowId) {
    return commandResponse({
      intent: "clarify",
      tool: "workflow.approveAndCreateDrafts",
      result: {
        reason: "missing_workflow_context",
        workflowId: null,
        recentEligibleWorkflows: contextSummary.recentEligibleWorkflows,
      },
      message:
        "Which completed workflow should I approve? Pass a workflowId so I create drafts for the right briefs.",
      contextSummary,
    });
  }

  if (detectsGetWorkflowIntent(message) && !workflowId) {
    return commandResponse({
      intent: "clarify",
      tool: "workflow.get",
      result: {
        reason: "missing_workflow_id",
        workflowId: null,
      },
      message: "Which workflow should I open? Pass a workflowId.",
      contextSummary,
    });
  }

  return commandResponse({
    intent: "clarify",
    tool: null,
    result: {
      supportedIntents: [
        "plan_brief_qa",
        "retention_audit",
        "audit_fix_run",
        "approve_workflow",
        "list_workflows",
        "get_workflow",
        "list_playbooks",
        "recommend_flows",
      ],
    },
    message:
      "I am not sure which Worklin action you want. Try asking me to audit retention, prepare safe fixes for a retention audit, plan campaigns, audit flows, approve a workflow, show recent workflows, open a workflow, or list playbooks.",
    contextSummary,
  });
}

export async function POST(request: Request) {
  let parsedMessage: string | null = null;
  let parsedWorkflowId: string | undefined;

  try {
    const body = await request.json().catch(() => null);
    const parsed = commandSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          intent: "invalid_command",
          tool: null,
          result: {
            issues: parsed.error.issues.map((issue) => issue.message),
          },
          message: "message is required.",
        },
        { status: 400 },
      );
    }

    const { message, workflowId, safeFixPromptContext } = parsed.data;
    parsedMessage = message;
    parsedWorkflowId = workflowId;

    const contextResult = await buildAgentContext({
      message,
      workflowId,
      limit: DEFAULT_WORKFLOW_LIMIT,
    });
    const contextSummary = compactContextSummary(contextResult);
    const parsedIntentResult = await parseAgentIntent({
      message,
      workflowId,
      contextResult,
    });
    const parsedIntent = parsedIntentResult.intent;
    const resolvedWorkflowId = parsedIntent.parameters.workflowId ?? contextSummary.referencedWorkflow?.id ?? workflowId;
    const deterministicIntent = inferIntent(message, resolvedWorkflowId);
    const intent =
      parsedIntent.intent === "clarify" && deterministicIntent !== "clarify"
        ? deterministicIntent
        : parsedIntent.intent;
    const hasRetentionAuditContext =
      contextSummary.referencedWorkflow?.type === "retention-audit" ||
      (resolvedWorkflowId && contextSummary.recentWorkflows.some((workflow) =>
        workflow.id === resolvedWorkflowId && workflow.type === "retention-audit",
      ));
  const shouldPrepareFixes =
      detectsExplicitFixConfirmationIntent(message) ||
      (intent === "audit_fix_run" &&
        (!detectsVagueFixConfirmationIntent(message) || Boolean(safeFixPromptContext))) ||
      (detectsVagueFixConfirmationIntent(message) &&
        Boolean(hasRetentionAuditContext) &&
        Boolean(safeFixPromptContext));

    if (parsedIntent.safety.sendOrScheduleRequested || detectsSendOrScheduleIntent(message)) {
      return routeClarify(message, contextSummary, resolvedWorkflowId);
    }

    if (detectsGetWorkflowIntent(message) && !resolvedWorkflowId) {
      return routeClarify(message, contextSummary, resolvedWorkflowId);
    }

    if (intent === "retention_audit" || detectsRetentionAuditIntent(message)) return routeRetentionAudit(contextSummary);
    if (
      detectsVagueFixConfirmationIntent(message) &&
      Boolean(hasRetentionAuditContext) &&
      !safeFixPromptContext
    ) {
      return commandResponse({
        intent: "clarify",
        tool: "workflow.auditFixRun",
        result: {
          reason: "needs_safe_fix_confirmation_context",
          workflowId: resolvedWorkflowId ?? null,
        },
        message:
          "Do you mean you want me to prepare the safe fixes for the latest retention audit?",
        contextSummary,
      });
    }
    if (shouldPrepareFixes) {
      return routeAuditFixRun(resolvedWorkflowId, contextSummary, {
        allowLatestFallback: Boolean(safeFixPromptContext),
      });
    }
    if (intent === "plan_brief_qa") return routePlanBriefQa(message, contextSummary, parsedIntent.parameters);
    if (intent === "recommend_flows") return routeRecommendFlows(message, contextSummary, parsedIntent.parameters);
    if (intent === "approve_workflow" && resolvedWorkflowId) {
      return routeApproveWorkflow(message, resolvedWorkflowId, contextSummary);
    }
    if (intent === "list_workflows") return routeListWorkflows(contextSummary);
    if (intent === "get_workflow" && resolvedWorkflowId) return routeGetWorkflow(resolvedWorkflowId, contextSummary);
    if (intent === "list_playbooks") {
      return routeListPlaybooks(message, contextSummary, contextResult, parsedIntent.parameters.playbookType);
    }

    return routeClarify(message, contextSummary, resolvedWorkflowId);
  } catch (error) {
    if (error instanceof Error && error.message === "WORKFLOW_NOT_FOUND") {
      const intent = parsedMessage ? inferIntent(parsedMessage, parsedWorkflowId) : "get_workflow";

      return commandResponse({
        ok: false,
        intent: intent === "approve_workflow" ? "approve_workflow" : "get_workflow",
        tool: intent === "approve_workflow" ? "workflow.approveAndCreateDrafts" : "workflow.get",
        result: {
          workflowId: parsedWorkflowId ?? null,
        },
        message: "Workflow run not found.",
        status: 404,
      });
    }

    console.error("POST /api/agent/command failed", error);
    return NextResponse.json(
      {
        ok: false,
        intent: "command_failed",
        tool: null,
        result: {},
        message: "Failed to route agent command",
      },
      { status: 500 },
    );
  }
}
