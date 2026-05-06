import type { AgentContextResult } from "@/lib/agent/context/types";
import type { LlmProviderAttempt, LlmProviderName } from "@/lib/llm";

export const WORKLIN_INTENTS = [
  "retention_audit",
  "audit_fix_run",
  "plan_brief_qa",
  "approve_workflow",
  "list_workflows",
  "get_workflow",
  "list_playbooks",
  "recommend_flows",
  "clarify",
] as const;

export type WorklinIntent = (typeof WORKLIN_INTENTS)[number];

export type IntentParameters = {
  campaignCount?: number;
  focus?: string;
  constraints?: string[];
  workflowId?: string;
  playbookType?: "flow" | "campaign";
};

export type IntentSafety = {
  sendOrScheduleRequested: boolean;
  externalActionRequested: boolean;
  requiresApproval: boolean;
};

export type ParsedAgentIntent = {
  intent: WorklinIntent;
  confidence: number;
  parameters: IntentParameters;
  safety: IntentSafety;
  clarificationQuestion?: string;
  reasoningSummary: string;
};

export type IntentParserSource = "llm" | "deterministic";

export type IntentParserMetadata = {
  source: IntentParserSource;
  provider?: LlmProviderName;
  model?: string;
  fallbackUsed?: boolean;
  attempts?: LlmProviderAttempt[];
  fallbackReason?: string;
};

export type ParseAgentIntentInput = {
  message: string;
  workflowId?: string | null;
  contextResult?: AgentContextResult;
  provider?: LlmProviderName;
  minConfidence?: number;
};

export type ParseAgentIntentResult = {
  intent: ParsedAgentIntent;
  contextResult: AgentContextResult;
  parser: IntentParserMetadata;
};
