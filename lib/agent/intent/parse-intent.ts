import "server-only";

import { buildAgentContext } from "@/lib/agent/context/build-context";
import type { AgentContextResult } from "@/lib/agent/context/types";
import { agentToolRegistry } from "@/lib/agent/tools/registry";
import { generateStructured, LlmRouterError } from "@/lib/llm";
import type { LlmProviderName } from "@/lib/llm";
import type {
  IntentParameters,
  IntentSafety,
  ParsedAgentIntent,
  ParseAgentIntentInput,
  ParseAgentIntentResult,
  WorklinIntent,
} from "@/lib/agent/intent/types";
import { WORKLIN_INTENTS } from "@/lib/agent/intent/types";

const DEFAULT_MIN_CONFIDENCE = 0.68;

function normalized(message: string) {
  return message.toLowerCase().replace(/[’']/g, "'").trim();
}

function clampConfidence(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIntent(value: unknown): value is WorklinIntent {
  return typeof value === "string" && WORKLIN_INTENTS.includes(value as WorklinIntent);
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  return items.length ? Array.from(new Set(items)) : undefined;
}

function asCampaignCount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) return undefined;
  return parsed;
}

function asPlaybookType(value: unknown): "flow" | "campaign" | undefined {
  return value === "flow" || value === "campaign" ? value : undefined;
}

function detectSendOrSchedule(message: string) {
  return (
    /\b(send|sending|sent|schedule|scheduled|scheduling|launch|launching|go\s+live)\b/i.test(message) ||
    /\b(sync|syncing|push|publish)\b.*\b(segments?|profiles?|flows?|campaigns?|klaviyo)\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify|activate|enable)\b.*\b(live\s+)?(klaviyo\s+)?flows?\b/i.test(message) ||
    /\b(create|update|delete|remove|change|modify)\b.*\b(live\s+)?(segments?|profiles?)\b/i.test(message) ||
    /\bdestructive\b.*\bklaviyo\b/i.test(message)
  );
}

function detectApproval(message: string) {
  return (
    /\bapproved?\b/i.test(message) ||
    /\blooks?\s+good\b/i.test(message) ||
    /\bgo\s+ahead\b/i.test(message) ||
    /\bapprove\s+(these|them|the\s+ready\s+ones|ready\s+ones)\b/i.test(message) ||
    /\bship\s+the\s+drafts?\b/i.test(message)
  );
}

function detectListWorkflows(message: string) {
  return (
    /\b(show|list|open|view|what)\b.*\b(recent|previous|past|workflow|workflows|runs?|made|created|earlier|yesterday)\b/i.test(
      message,
    ) || /\bwhat\s+did\s+you\s+(make|create)\b/i.test(message)
  );
}

function detectGetWorkflow(message: string) {
  return /\b(open|show|view|get)\b.*\b(this\s+)?(workflow|run)\b/i.test(message);
}

function detectListPlaybooks(message: string) {
  return /\b(playbook|playbooks)\b/i.test(message);
}

function detectRecommendFlows(message: string) {
  return (
    /\b(audit|diagnose|review|fix|improve|optimi[sz]e)\b.*\b(klaviyo\s+)?flows?\b/i.test(message) ||
    /\b(what|which)\b.*\b(lifecycle\s+)?flows?\b.*\b(missing|build|next|need|have|recommend)\b/i.test(message) ||
    /\b(lifecycle|automation|automations)\b.*\b(missing|build|next|need|have|recommend|audit|fix)\b/i.test(message) ||
    /\b(recover|recovery)\b.*\b(abandoned?\s+checkouts?|checkout\s+abandon|abandoned?\s+carts?|cart\s+abandon)\b/i.test(message) ||
    /\b(increase|grow|improve)\b.*\b(repeat\s+purchases?|reorders?|restock|replenishment)\b.*\b(flows?|automations?)\b/i.test(message) ||
    /\bwhat\s+automations?\s+should\s+this\s+brand\s+have\b/i.test(message)
  );
}

function detectRetentionAudit(message: string) {
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

function detectFixConfirmation(message: string) {
  return (
    /\bfix\s+all\b/i.test(message) ||
    /\bfix\s+(all\s+)?(this|it|these|what\s+you\s+can)\b/i.test(message) ||
    /\bprepare\s+(the\s+)?(safe\s+)?fixes\b/i.test(message) ||
    /\bhandle\s+(the\s+)?safe\s+fixes\b/i.test(message) ||
    /\bprepare\s+everything\s+safe\b/i.test(message) ||
    /\bfix\s+what\s+you\s+can\b/i.test(message)
  );
}

function detectPlan(message: string) {
  return (
    /\b(plan|prep|prepare|create|generate|build|make|put\s+together)\b.*\b(campaign|campaigns|retention|email|emails|flow|flows|lifecycle|something)\b/i.test(
      message,
    ) ||
    /\b(campaign|campaigns|retention\s+campaigns?|emails?)\b.*\b(next\s+week|tomorrow|this\s+week|no\s+discounts?)\b/i.test(
      message,
    ) ||
    /\b(sales|revenue|orders?)\b.*\b(slow|down|soft|stalled|flat|dropped|declining)\b/i.test(message)
  );
}

function inferCampaignCount(message: string) {
  const digitMatch = message.match(/\b(\d{1,2})\s+(?:retention\s+)?(?:campaigns?|emails?|ideas?)\b/i);
  if (digitMatch) return asCampaignCount(Number(digitMatch[1]));
  if (/\b(one|a)\s+(?:campaign|email|idea)\b/i.test(message)) return 1;
  if (/\b(two|couple)\s+(?:campaigns?|emails?|ideas?)\b/i.test(message)) return 2;
  if (/\b(three|few)\s+(?:campaigns?|emails?|ideas?)\b/i.test(message)) return 3;
  return undefined;
}

function inferFocus(message: string) {
  if (/\b(sales|revenue|orders?)\b.*\b(slow|down|soft|stalled|flat|dropped|declining)\b/i.test(message)) {
    return "revenue recovery";
  }
  if (/\brepeat purchase|second purchase|buy again\b/i.test(message)) return "repeat purchase";
  if (/\bwinback|win\s+back|at[-\s]?risk|lapsed|churn\b/i.test(message)) return "winback";
  if (/\bvip|loyal|loyalty|champions?\b/i.test(message)) return "loyalty";
  if (/\breplenish|restock\b/i.test(message)) return "replenishment";
  return undefined;
}

function inferConstraints(message: string) {
  const constraints: string[] = [];
  if (/\b(no|without|avoid)\b.*\b(discounts?|discounting|coupons?|markdowns?|promos?|promotions?)\b/i.test(message)) {
    constraints.push("no discounts");
  } else if (/\b(discounting|discounts?)\b.*\b(not\s+too\s+hard|light|lighter|soft|minimal|sparingly)\b/i.test(message)) {
    constraints.push("avoid heavy discounts");
  }
  if (/\bwithout\s+discounting\s+too\s+hard\b/i.test(message)) constraints.push("avoid heavy discounts");
  if (/\b(vip|early access|loyalty|loyal|champions?)\b/i.test(message)) constraints.push("include one VIP campaign");
  if (/\b(no|without|avoid)\b.*\b(sms|text messages?)\b/i.test(message)) constraints.push("email only");
  return constraints.length ? Array.from(new Set(constraints)) : undefined;
}

function inferPlaybookType(message: string) {
  const text = normalized(message);
  if (/\bflows?\b/.test(text)) return "flow" as const;
  if (/\bcampaigns?\b/.test(text)) return "campaign" as const;
  return undefined;
}

function extractWorkflowId(message: string, workflowId?: string | null) {
  if (workflowId?.trim()) return workflowId.trim();
  const match = message.match(/\bworkflow(?:Id)?[:#\s]+([A-Za-z0-9_-]{8,})\b/i);
  return match?.[1];
}

function buildSafety(message: string, intent: WorklinIntent): IntentSafety {
  const sendOrScheduleRequested = detectSendOrSchedule(message);
  const approvalRequested = detectApproval(message) || intent === "approve_workflow";
  return {
    sendOrScheduleRequested,
    externalActionRequested: sendOrScheduleRequested || approvalRequested,
    requiresApproval: sendOrScheduleRequested || approvalRequested,
  };
}

export function deterministicParseIntent(message: string, workflowId?: string | null): ParsedAgentIntent {
  const parameters: IntentParameters = {};
  const extractedWorkflowId = extractWorkflowId(message, workflowId);
  if (extractedWorkflowId) parameters.workflowId = extractedWorkflowId;

  let intent: WorklinIntent = "clarify";
  let confidence = 0.55;
  let reasoningSummary = "The request is ambiguous and needs clarification.";
  let clarificationQuestion: string | undefined = "What would you like Worklin to do?";

  if (detectSendOrSchedule(message)) {
    confidence = 0.99;
    reasoningSummary = "The user asked for a live external action, which must stay refusal-safe.";
    clarificationQuestion =
      "I cannot send, schedule, sync, create live flows or segments, or make destructive Klaviyo changes from chat. I can prepare the safe package for review instead.";
  } else if (detectRetentionAudit(message)) {
    intent = "retention_audit";
    confidence = 0.94;
    reasoningSummary = "The user asked Worklin to audit the retention setup.";
    clarificationQuestion = undefined;
  } else if (detectFixConfirmation(message)) {
    intent = "audit_fix_run";
    confidence = 0.9;
    reasoningSummary = "The user asked Worklin to prepare safe fixes from a retention audit.";
    clarificationQuestion = extractedWorkflowId
      ? undefined
      : "Which retention audit should I prepare fixes for?";
  } else if (detectApproval(message)) {
    intent = "approve_workflow";
    confidence = 0.9;
    reasoningSummary = "The message is an approval phrase for ready workflow output.";
    clarificationQuestion = extractedWorkflowId
      ? undefined
      : "Which completed workflow should I approve? Pass a workflowId.";
  } else if (detectListPlaybooks(message)) {
    intent = "list_playbooks";
    confidence = 0.92;
    parameters.playbookType = inferPlaybookType(message);
    reasoningSummary = "The user asked to see Worklin playbooks.";
    clarificationQuestion = undefined;
  } else if (detectRecommendFlows(message)) {
    intent = "recommend_flows";
    confidence = 0.9;
    parameters.focus = inferFocus(message);
    parameters.constraints = inferConstraints(message);
    reasoningSummary = "The user is asking Worklin to recommend lifecycle flow work.";
    clarificationQuestion = undefined;
  } else if (detectGetWorkflow(message)) {
    if (extractedWorkflowId) {
      intent = "get_workflow";
      confidence = 0.86;
      reasoningSummary = "The user asked to open a specific workflow.";
      clarificationQuestion = undefined;
    } else {
      confidence = 0.82;
      reasoningSummary = "The user asked to open a workflow but did not provide a workflow id.";
      clarificationQuestion = "Which workflow should I open? Pass a workflowId.";
    }
  } else if (detectListWorkflows(message)) {
    intent = "list_workflows";
    confidence = 0.88;
    reasoningSummary = "The user asked about earlier or recent workflow output.";
    clarificationQuestion = undefined;
  } else if (detectPlan(message)) {
    intent = "plan_brief_qa";
    confidence = 0.82;
    parameters.campaignCount = inferCampaignCount(message);
    parameters.focus = inferFocus(message);
    parameters.constraints = inferConstraints(message);
    reasoningSummary = "The user is asking Worklin to prepare retention campaign work.";
    clarificationQuestion = undefined;
  } else if (/\b(help|what can you do|options|commands)\b/i.test(message)) {
    confidence = 0.82;
    reasoningSummary = "The user asked for help rather than a specific Worklin action.";
    clarificationQuestion = "Do you want to plan campaigns, approve a workflow, list workflows, open a workflow, or view playbooks?";
  }

  return {
    intent,
    confidence,
    parameters,
    safety: buildSafety(message, intent),
    ...(clarificationQuestion ? { clarificationQuestion } : {}),
    reasoningSummary,
  };
}

function summarizeContext(contextResult: AgentContextResult) {
  const context = contextResult.context;
  return {
    summary: contextResult.summary,
    missing: contextResult.missing,
    brandName: context.brand.profile?.brandName ?? null,
    playbooks: context.playbooks.slice(0, 6).map((playbook) => ({
      id: playbook.id,
      name: playbook.name,
      type: playbook.type,
      permissionLevel: playbook.permissionLevel,
    })),
    recentWorkflows: context.recentWorkflows.slice(0, 5).map((workflow) => ({
      id: workflow.id,
      type: workflow.type,
      status: workflow.status,
      createdAt: workflow.createdAt,
    })),
    referencedWorkflow: context.referencedWorkflow
      ? {
          id: context.referencedWorkflow.id,
          type: context.referencedWorkflow.type,
          status: context.referencedWorkflow.status,
          createdAt: context.referencedWorkflow.createdAt,
        }
      : null,
    recentDraftCount: context.recentDrafts.length,
    relevantBriefCount: context.relevantBriefs.length,
    campaignMemory: {
      totalCampaigns: context.campaignMemory.summary.totalCampaigns,
      bestSegmentByRevenue: context.campaignMemory.bestSegmentByRevenue?.key ?? null,
      bestCampaignTypeByRevenue: context.campaignMemory.bestCampaignTypeByRevenue?.key ?? null,
    },
  };
}

function buildLlmPrompt(message: string, workflowId: string | null | undefined, contextResult: AgentContextResult) {
  const tools = agentToolRegistry
    .filter((tool) =>
      [
        "workflow.retentionAudit",
        "workflow.auditFixRun",
        "workflow.planBriefQa",
        "workflow.approveAndCreateDrafts",
        "workflow.list",
        "workflow.get",
        "playbooks.list",
        "flows.recommend",
      ].includes(tool.name),
    )
    .map((tool) => ({
      name: tool.name,
      permissionLevel: tool.permissionLevel,
      requiresApproval: tool.requiresApproval,
      riskLevel: tool.riskLevel,
      status: tool.currentStatus,
    }));

  return `Classify this Worklin chat message into one safe structured intent.

Rules:
- You classify and structure only. Never execute tools.
- Only use these intents: retention_audit, audit_fix_run, plan_brief_qa, approve_workflow, list_workflows, get_workflow, list_playbooks, recommend_flows, clarify.
- If the user asks to send, schedule, launch, go live, sync segments/profiles, create or update live Klaviyo flows, or make destructive Klaviyo changes, use intent "clarify".
- Use "retention_audit" when the user asks to audit, check, review, diagnose, refresh, re-audit, or inspect the retention setup/account/system. Examples include "audit my retention setup", "run an audit", "run another audit", "refresh the audit", "check my retention again", and "what's broken in retention?".
- Use "audit_fix_run" when the user asks in natural language to prepare safe fixes from a retention audit. Examples include "fix all this", "handle what you can safely", "turn that audit into fixes", "prepare the safe fixes", and "go prepare the safe package".
- For bare vague confirmations such as "yes", "ok", or "sure", use "clarify" unless the provided context clearly indicates the user is answering a safe-fixes confirmation. Deterministic routing will validate that context before executing.
- If no retention-audit workflowId/context is available for a fix request, still classify clear fix-preparation language as audit_fix_run and let deterministic routing clarify.
- Approval may only mean draft creation after deterministic validation. Do not assume a workflow if none is provided.
- Use "recommend_flows" for Klaviyo flow audits, missing lifecycle flows, automation recommendations, abandoned checkout/cart recovery flows, replenishment/repeat purchase flows, and questions about which automations the brand should have.
- Do not use "recommend_flows" for saved Worklin workflow history requests like "show recent workflows" or "open this workflow".
- Do not use "recommend_flows" for campaign planning requests like "plan 3 campaigns"; use "plan_brief_qa" for campaign/email planning.
- External actions and approvals must set safety.requiresApproval true.
- Keep reasoningSummary under 140 characters.
- Return valid JSON only in the exact shape requested.

User message:
${message}

Provided workflowId:
${workflowId ?? "none"}

Context:
${JSON.stringify(summarizeContext(contextResult))}

Allowed tools:
${JSON.stringify(tools)}

Return JSON:
{
  "intent": "retention_audit | audit_fix_run | plan_brief_qa | approve_workflow | list_workflows | get_workflow | list_playbooks | recommend_flows | clarify",
  "confidence": 0,
  "parameters": {
    "campaignCount": 0,
    "focus": "",
    "constraints": [],
    "workflowId": "",
    "playbookType": "flow | campaign"
  },
  "safety": {
    "sendOrScheduleRequested": false,
    "externalActionRequested": false,
    "requiresApproval": false
  },
  "clarificationQuestion": "",
  "reasoningSummary": ""
}`;
}

function sanitizeLlmIntent(output: unknown, message: string, workflowId?: string | null): ParsedAgentIntent | null {
  if (!isRecord(output) || !isIntent(output.intent)) return null;
  const rawParameters = isRecord(output.parameters) ? output.parameters : {};
  const rawSafety = isRecord(output.safety) ? output.safety : {};
  const parameters: IntentParameters = {};
  const campaignCount = asCampaignCount(rawParameters.campaignCount);
  if (campaignCount) parameters.campaignCount = campaignCount;
  const focus = asString(rawParameters.focus);
  if (focus) parameters.focus = focus.slice(0, 160);
  const constraints = asStringArray(rawParameters.constraints);
  if (constraints) parameters.constraints = constraints.slice(0, 8);
  const parsedWorkflowId = asString(rawParameters.workflowId) ?? extractWorkflowId(message, workflowId);
  if (parsedWorkflowId) parameters.workflowId = parsedWorkflowId.slice(0, 200);
  const playbookType = asPlaybookType(rawParameters.playbookType);
  if (playbookType) parameters.playbookType = playbookType;

  const detectedSendOrSchedule = detectSendOrSchedule(message);
  const sendOrScheduleRequested =
    typeof rawSafety.sendOrScheduleRequested === "boolean"
      ? rawSafety.sendOrScheduleRequested || detectedSendOrSchedule
      : detectedSendOrSchedule;
  const approvalRequested = detectApproval(message) || output.intent === "approve_workflow";
  const externalActionRequested =
    typeof rawSafety.externalActionRequested === "boolean"
      ? rawSafety.externalActionRequested || sendOrScheduleRequested || approvalRequested
      : sendOrScheduleRequested || approvalRequested;
  const requiresApproval =
    typeof rawSafety.requiresApproval === "boolean"
      ? rawSafety.requiresApproval || sendOrScheduleRequested || approvalRequested || externalActionRequested
      : sendOrScheduleRequested || approvalRequested || externalActionRequested;

  const forcedClarify = sendOrScheduleRequested;
  return {
    intent: forcedClarify ? "clarify" : output.intent,
    confidence: clampConfidence(output.confidence),
    parameters,
    safety: {
      sendOrScheduleRequested,
      externalActionRequested,
      requiresApproval,
    },
    ...(asString(output.clarificationQuestion)
      ? { clarificationQuestion: asString(output.clarificationQuestion)?.slice(0, 240) }
      : {}),
    reasoningSummary:
      asString(output.reasoningSummary)?.slice(0, 180) ??
      "The LLM classified the message into a Worklin intent.",
  };
}

export async function parseAgentIntent(input: ParseAgentIntentInput): Promise<ParseAgentIntentResult> {
  const contextResult =
    input.contextResult ??
    (await buildAgentContext({
      message: input.message,
      workflowId: input.workflowId ?? undefined,
      limit: 10,
    }));
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  try {
    const llmResult = await generateStructured({
      provider: input.provider,
      temperature: 0.1,
      maxTokens: 650,
      prompt: buildLlmPrompt(input.message, input.workflowId, contextResult),
    });
    const parsed = sanitizeLlmIntent(llmResult.output, input.message, input.workflowId);

    if (!parsed) {
      return {
        intent: deterministicParseIntent(input.message, input.workflowId),
        contextResult,
        parser: {
          source: "deterministic",
          provider: llmResult.provider,
          model: llmResult.model,
          fallbackUsed: llmResult.fallbackUsed,
          attempts: llmResult.attempts,
          fallbackReason: "invalid_llm_output",
        },
      };
    }

    if (parsed.confidence < minConfidence) {
      return {
        intent: deterministicParseIntent(input.message, input.workflowId),
        contextResult,
        parser: {
          source: "deterministic",
          provider: llmResult.provider,
          model: llmResult.model,
          fallbackUsed: llmResult.fallbackUsed,
          attempts: llmResult.attempts,
          fallbackReason: "low_confidence",
        },
      };
    }

    return {
      intent: parsed,
      contextResult,
      parser: {
        source: "llm",
        provider: llmResult.provider,
        model: llmResult.model,
        fallbackUsed: llmResult.fallbackUsed,
        attempts: llmResult.attempts,
      },
    };
  } catch (error) {
    return {
      intent: deterministicParseIntent(input.message, input.workflowId),
      contextResult,
      parser: {
        source: "deterministic",
        ...(error instanceof LlmRouterError ? { attempts: error.attempts } : {}),
        fallbackReason: error instanceof LlmRouterError ? "llm_provider_unavailable" : "llm_parse_failed",
      },
    };
  }
}
