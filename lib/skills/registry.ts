import { Prisma } from "@prisma/client";
import { z } from "zod";
import { logActionEvent, scrubActionLogJson } from "@/lib/action-log/action-log";
import {
  executeAgentToolRuntime,
  type AgentToolRuntimeRequest,
} from "@/lib/agent/tools/runtime";
import { prisma } from "@/lib/prisma";

export const SKILL_STATUSES = [
  "active",
  "draft",
  "shadow",
  "planned",
  "blocked",
  "archived",
] as const;

export const SKILL_ORIGINS = ["system", "human", "agent_created"] as const;
export const SKILL_SCOPES = ["global", "workspace", "hybrid"] as const;
export const SKILL_SAFETY_LEVELS = ["low", "medium", "high", "critical"] as const;
export const SKILL_RUN_MODES = ["shadow", "assist", "execute"] as const;
export const SKILL_ARTIFACT_SOURCES = [
  "klaviyo_snapshot",
  "shopify_snapshot",
  "figma_design",
  "canva_design",
  "google_doc",
  "google_sheet",
  "uploaded_csv",
  "uploaded_image",
  "uploaded_screenshot",
] as const;

export type SkillStatus = (typeof SKILL_STATUSES)[number];
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];
export type SkillScope = (typeof SKILL_SCOPES)[number];
export type SkillSafetyLevel = (typeof SKILL_SAFETY_LEVELS)[number];
export type SkillRunMode = (typeof SKILL_RUN_MODES)[number];
export type SkillArtifactSource = (typeof SKILL_ARTIFACT_SOURCES)[number];

type Jsonish = Prisma.JsonValue | null;

type WorklinSkillRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  origin: string;
  scope: string;
  runMode: string;
  triggerExamples: Jsonish;
  requiredInputs: Jsonish;
  optionalInputs: Jsonish;
  preferredSources: Jsonish;
  fallbackSources: Jsonish;
  requiredArtifacts: Jsonish;
  optionalArtifacts: Jsonish;
  missingSourceBehavior: Jsonish;
  connectorDependencies: Jsonish;
  requiredContext: Jsonish;
  toolsUsed: Jsonish;
  procedureSteps: Jsonish;
  verificationChecklist: Jsonish;
  pitfalls: Jsonish;
  safetyLevel: string;
  approvalRequirements: Jsonish;
  outputShape: Jsonish;
  caveats: Jsonish;
  version: string;
  usageCount: number;
  lastUsedAt: Date | null;
  createdFromWorkflowRunId: string | null;
  createdFromActionLogId: string | null;
  missingCapabilities: Jsonish;
  workspaceContextSuggestions: Jsonish;
  oneOffDetailsNotSavedToSkill: Jsonish;
  metadata: Jsonish;
  createdAt: Date;
  updatedAt: Date;
};

export type SerializedSkill = {
  id: string;
  name: string;
  description: string;
  category: string;
  status: SkillStatus;
  origin: SkillOrigin;
  scope: SkillScope;
  runMode: SkillRunMode;
  triggerExamples: unknown;
  requiredInputs: unknown;
  optionalInputs: unknown;
  preferredSources: unknown;
  fallbackSources: unknown;
  requiredArtifacts: unknown;
  optionalArtifacts: unknown;
  missingSourceBehavior: unknown;
  connectorDependencies: unknown;
  requiredContext: unknown;
  toolsUsed: unknown;
  procedureSteps: unknown;
  verificationChecklist: unknown;
  pitfalls: unknown;
  safetyLevel: SkillSafetyLevel;
  approvalRequirements: unknown;
  outputShape: unknown;
  caveats: unknown;
  version: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdFromWorkflowRunId: string | null;
  createdFromActionLogId: string | null;
  missingCapabilities: unknown;
  workspaceContextSuggestions: unknown;
  oneOffDetailsNotSavedToSkill: unknown;
  safeAlternatives: string[];
  implemented: boolean;
  metadata: unknown;
  createdAt: string | null;
  updatedAt: string | null;
};

type SkillDefinition = Omit<
  SerializedSkill,
  | "usageCount"
  | "lastUsedAt"
  | "createdAt"
  | "updatedAt"
  | "runMode"
  | "workspaceContextSuggestions"
  | "oneOffDetailsNotSavedToSkill"
  | "preferredSources"
  | "fallbackSources"
  | "requiredArtifacts"
  | "optionalArtifacts"
  | "missingSourceBehavior"
  | "connectorDependencies"
> & {
  runMode?: SkillRunMode;
  workspaceContextSuggestions?: unknown;
  oneOffDetailsNotSavedToSkill?: unknown;
  preferredSources?: unknown;
  fallbackSources?: unknown;
  requiredArtifacts?: unknown;
  optionalArtifacts?: unknown;
  missingSourceBehavior?: unknown;
  connectorDependencies?: unknown;
  usageCount?: number;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type SkillRunRequest = {
  skillId: string;
  input: Record<string, unknown>;
  approval?: AgentToolRuntimeRequest["approval"];
};

type ParsedResult<T> = { ok: true; data: T } | { ok: false; issues: string[] };

type SkillRunHandler = (
  skill: SerializedSkill,
  request: SkillRunRequest,
) => Promise<SkillRunResponse>;

type ToolRuntimeResponse = Awaited<ReturnType<typeof executeAgentToolRuntime>>;

export type SkillRunResponse = {
  ok: boolean;
  reason: string;
  skill: SerializedSkill | null;
  result: unknown;
  toolCalls: Array<{
    toolName: string;
    ok: boolean;
    reason: string;
    status: number;
    actionLogId: string | null;
  }>;
  actionLog: {
    requested: unknown;
    completed: unknown;
  };
  safety: {
    externalActionTaken: false;
    canGoLiveNow: false;
    blocked: boolean;
    approvalBypassed: false;
  };
  caveats: string[];
  status: number;
};

export type SkillProposalInput = {
  id?: string | null;
  name: string;
  reusableName?: string | null;
  description: string;
  category?: string | null;
  status?: SkillStatus | null;
  scope?: SkillScope | null;
  runMode?: SkillRunMode | null;
  triggerExamples?: unknown;
  requiredInputs?: unknown;
  optionalInputs?: unknown;
  preferredSources?: unknown;
  fallbackSources?: unknown;
  requiredArtifacts?: unknown;
  optionalArtifacts?: unknown;
  missingSourceBehavior?: unknown;
  connectorDependencies?: unknown;
  requiredContext?: unknown;
  toolsUsed?: unknown;
  procedureSteps?: unknown;
  verificationChecklist?: unknown;
  pitfalls?: unknown;
  safetyLevel?: SkillSafetyLevel | null;
  approvalRequirements?: unknown;
  outputShape?: unknown;
  caveats?: unknown;
  version?: string | null;
  createdFromWorkflowRunId?: string | null;
  createdFromActionLogId?: string | null;
  missingCapabilities?: unknown;
  workspaceContextSuggestions?: unknown;
  workspaceContext?: unknown;
  brandContext?: unknown;
  oneOffDetailsNotSavedToSkill?: unknown;
  oneOffDetails?: unknown;
  metadata?: unknown;
};

export type SkillTransitionInput = {
  status: SkillStatus;
  decisionNote?: string | null;
  actor?: string | null;
};

export type SkillPatchInput = {
  reason: string;
  patch: {
    procedureStepsAdditions?: unknown;
    verificationChecklistAdditions?: unknown;
    pitfallsAdditions?: unknown;
    triggerExamplesAdditions?: unknown;
    caveatsAdditions?: unknown;
    requiredContextAdditions?: unknown;
    preferredSourcesAdditions?: unknown;
    fallbackSourcesAdditions?: unknown;
    requiredArtifactsAdditions?: unknown;
    optionalArtifactsAdditions?: unknown;
    connectorDependenciesAdditions?: unknown;
    missingSourceBehavior?: unknown;
    workspaceContextSuggestionsAdditions?: unknown;
    missingCapabilitiesAdditions?: unknown;
  };
  actor?: string | null;
};

export type SkillMatchInput = {
  message: string;
  availableFiles?: string[];
  workspaceId?: string | null;
  context?: Record<string, unknown>;
};

const MAX_TEXT_LENGTH = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const skillRunSchema = z.object({
  skillId: z.string().trim().min(1).max(160),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  approval: z
    .object({
      approvalId: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
});

const proposalSchema = z
  .object({
    id: z.string().trim().min(1).max(160).optional().nullable(),
    name: z.string().trim().min(1, "name is required.").max(160),
    reusableName: z.string().trim().min(1).max(160).optional().nullable(),
    description: z.string().trim().min(1, "description is required.").max(MAX_TEXT_LENGTH),
    category: z.string().trim().min(1).max(120).optional().nullable(),
    status: z.enum(SKILL_STATUSES).optional().nullable(),
    scope: z.enum(SKILL_SCOPES).optional().nullable(),
    runMode: z.enum(SKILL_RUN_MODES).optional().nullable(),
    triggerExamples: z.unknown().optional(),
    requiredInputs: z.unknown().optional(),
    optionalInputs: z.unknown().optional(),
    preferredSources: z.unknown().optional(),
    fallbackSources: z.unknown().optional(),
    requiredArtifacts: z.unknown().optional(),
    optionalArtifacts: z.unknown().optional(),
    missingSourceBehavior: z.unknown().optional(),
    connectorDependencies: z.unknown().optional(),
    requiredContext: z.unknown().optional(),
    toolsUsed: z.unknown().optional(),
    procedureSteps: z.unknown().optional(),
    verificationChecklist: z.unknown().optional(),
    pitfalls: z.unknown().optional(),
    safetyLevel: z.enum(SKILL_SAFETY_LEVELS).optional().nullable(),
    approvalRequirements: z.unknown().optional(),
    outputShape: z.unknown().optional(),
    caveats: z.unknown().optional(),
    version: z.string().trim().min(1).max(40).optional().nullable(),
    createdFromWorkflowRunId: z.string().trim().min(1).max(200).optional().nullable(),
    createdFromActionLogId: z.string().trim().min(1).max(200).optional().nullable(),
    missingCapabilities: z.unknown().optional(),
    workspaceContextSuggestions: z.unknown().optional(),
    workspaceContext: z.unknown().optional(),
    brandContext: z.unknown().optional(),
    oneOffDetailsNotSavedToSkill: z.unknown().optional(),
    oneOffDetails: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

const transitionSchema = z.object({
  status: z.enum(SKILL_STATUSES),
  decisionNote: z.string().trim().min(1).max(1000).optional().nullable(),
  actor: z.string().trim().min(1).max(80).optional().nullable(),
});

const patchSchema = z.object({
  reason: z.string().trim().min(1, "reason is required.").max(1000),
  patch: z.object({
    procedureStepsAdditions: z.unknown().optional(),
    verificationChecklistAdditions: z.unknown().optional(),
    pitfallsAdditions: z.unknown().optional(),
    triggerExamplesAdditions: z.unknown().optional(),
    caveatsAdditions: z.unknown().optional(),
    requiredContextAdditions: z.unknown().optional(),
    preferredSourcesAdditions: z.unknown().optional(),
    fallbackSourcesAdditions: z.unknown().optional(),
    requiredArtifactsAdditions: z.unknown().optional(),
    optionalArtifactsAdditions: z.unknown().optional(),
    connectorDependenciesAdditions: z.unknown().optional(),
    missingSourceBehavior: z.unknown().optional(),
    workspaceContextSuggestionsAdditions: z.unknown().optional(),
    missingCapabilitiesAdditions: z.unknown().optional(),
  }),
  actor: z.string().trim().min(1).max(80).optional().nullable(),
});

const matchSchema = z
  .object({
    message: z.string().trim().min(1, "message is required.").max(4000),
    availableFiles: z.array(z.string().trim().min(1).max(500)).optional().default([]),
    workspaceId: z.string().trim().min(1).max(200).optional().nullable(),
    context: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

const STARTER_SKILLS: SkillDefinition[] = [
  {
    id: "retention_audit",
    name: "Retention Audit",
    description:
      "Run a full safe retention audit and return a prioritized canvas-ready account diagnosis.",
    category: "audit",
    status: "active",
    origin: "system",
    scope: "global",
    triggerExamples: [
      "audit my retention setup",
      "what should we fix first in lifecycle",
      "find retention gaps",
    ],
    requiredInputs: [],
    optionalInputs: [
      { name: "focus", description: "Optional area to emphasize, such as flows, campaigns, or audiences." },
      { name: "includeEvidence", description: "Whether the response should include compact evidence summaries." },
    ],
    requiredContext: [
      "brand context",
      "available campaign/flow/audience evidence",
      "existing retention audit workflow",
    ],
    toolsUsed: ["workflow.retentionAudit"],
    procedureSteps: [
      "Read current brand and lifecycle context.",
      "Run the registered retention audit workflow through the Tool Runtime.",
      "Summarize prioritized issues without creating or changing anything live.",
      "Return the workflow id so the audit canvas can open inside the agent experience.",
    ],
    verificationChecklist: [
      "Tool Runtime returned ok.",
      "A workflowRunId exists.",
      "Action Log has a safe audit/tool execution entry.",
      "externalActionTaken is false and canGoLiveNow is false.",
    ],
    pitfalls: [
      "Do not infer write access from a good audit result.",
      "Do not bury blocked evidence behind broad strategy language.",
      "Do not recommend repeated fixes that have known rejected outcomes.",
    ],
    safetyLevel: "low",
    approvalRequirements: {
      requiresApproval: false,
      durableApprovalRequired: false,
      beforeLiveExternalAction: true,
      notes: ["Read-only analytical skill.", "Any future live action must use separate gated tooling."],
    },
    outputShape: {
      ok: "boolean",
      workflowId: "string",
      audit: "compact audit result",
      nextSuggestedSkill: "audit_fix_run",
    },
    caveats: ["Analysis only. No Klaviyo write path is called."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: [],
    safeAlternatives: [],
    implemented: true,
    metadata: {
      runner: "tool_runtime",
      primaryTool: "workflow.retentionAudit",
      stateOnly: true,
    },
  },
  {
    id: "audit_fix_run",
    name: "Audit Fix Run",
    description:
      "Prepare a safe fix package from an existing retention audit workflow without sending, syncing, scheduling, or going live.",
    category: "planning",
    status: "active",
    origin: "system",
    scope: "global",
    triggerExamples: ["fix all this", "prepare the fixes", "make a safe fix package"],
    requiredInputs: [
      { name: "workflowId", description: "Retention audit workflow id to prepare fixes from." },
    ],
    optionalInputs: [
      { name: "scope", description: "Optional subset of audit recommendations to prepare." },
      { name: "mode", description: "Defaults to safe_prepare." },
    ],
    requiredContext: [
      "retention audit workflow output",
      "recommendation outcome tracking",
      "approval state if available",
    ],
    toolsUsed: ["workflow.auditFixRun"],
    procedureSteps: [
      "Validate that a source audit workflow id is present.",
      "Run workflow.auditFixRun through the Tool Runtime in safe_prepare mode.",
      "Return prepared and blocked fixes for the agent-side canvas.",
      "Rely on recommendation outcome tracking to remember what was prepared or blocked.",
    ],
    verificationChecklist: [
      "Tool Runtime accepted safe_prepare without durable approval.",
      "externalActionTaken is false and canGoLiveNow is false.",
      "Prepared fixes have stable recommendation ids.",
      "Blocked fixes stay blocked.",
    ],
    pitfalls: [
      "Do not treat preparation as go-live approval.",
      "Do not create drafts as part of this skill.",
      "Do not overwrite rejected or blocked recommendation outcomes.",
    ],
    safetyLevel: "low",
    approvalRequirements: {
      requiresApproval: false,
      durableApprovalRequired: false,
      userConfirmationExpected: true,
      beforeLiveExternalAction: true,
      notes: ["Safe prepare-only run after clear user intent like 'fix all this'."],
    },
    outputShape: {
      ok: "boolean",
      workflowId: "string",
      preparedFixes: "array",
      blockedFixes: "array",
      nextSuggestedSkill: "approval_review",
    },
    caveats: ["Preparation only. No draft, sync, schedule, send, or live mutation occurs."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: [],
    safeAlternatives: ["retention_audit"],
    implemented: true,
    metadata: {
      runner: "tool_runtime",
      primaryTool: "workflow.auditFixRun",
      mode: "safe_prepare",
      stateOnly: true,
    },
  },
  {
    id: "campaign_copywriting",
    name: "Campaign Copywriting",
    description:
      "Draft retention campaign copy from product truth, audience intent, lifecycle job, offer logic, and brand voice.",
    category: "creative_production",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["write this campaign", "draft retention email copy", "turn this campaign idea into copy"],
    requiredInputs: [{ name: "campaignBrief", description: "Goal, audience, offer, product focus, and constraints." }],
    optionalInputs: [{ name: "copyLength", description: "Short, standard, long-form, SMS-adjacent, or modular." }],
    preferredSources: ["google_doc", "klaviyo_snapshot", "shopify_snapshot"],
    fallbackSources: ["uploaded_csv"],
    requiredArtifacts: [
      {
        name: "campaign_brief_or_prompt",
        description: "Campaign goal, audience, offer, product focus, and desired angle.",
        acceptedSources: ["google_doc", "uploaded_csv"],
      },
    ],
    optionalArtifacts: [
      {
        name: "product_context",
        description: "Product proof, positioning, objections, and customer language.",
        acceptedSources: ["shopify_snapshot", "google_doc", "uploaded_csv"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_structured_context_then_prompt_fallback",
      ifPreferredUnavailable: "Ask for campaign goal, audience, product focus, and offer details before drafting.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "google_doc", status: "not_wired_v0", required: false },
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["brand voice", "product truth", "audience intent", "lifecycle placement"],
    toolsUsed: ["brain.readBrandContext", "memory.getCampaignInsights"],
    procedureSteps: [
      "Read brand and product context.",
      "Clarify the campaign's one job and audience state.",
      "Draft subject lines, preview text, body modules, CTA, and SMS-adjacent hooks when useful.",
      "Return copy as prep-only content, not a platform draft.",
    ],
    verificationChecklist: [
      "Campaign has one clear job.",
      "Claims map to provided product truth.",
      "CTA and offer mechanics are explicit.",
      "No draft, send, or schedule path is touched.",
    ],
    pitfalls: [
      "Do not write generic promo copy when the campaign needs lifecycle specificity.",
      "Do not invent product claims or proof.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { subjectLines: "array", previewText: "array", modules: "array", ctas: "array" },
    caveats: ["Planned assist skill; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["campaign_copywriting.assist_runner"],
    safeAlternatives: ["campaign_copy_qa", "brain.readBrandContext"],
    implemented: false,
    metadata: { plannedRunner: "creative_assist_chain" },
  },
  {
    id: "campaign_copy_qa",
    name: "Campaign Copy QA",
    description:
      "Review campaign copy for brand voice, lifecycle fit, claim risk, CTA clarity, offer hygiene, and buyer anxiety.",
    category: "creative_qa",
    status: "draft",
    origin: "system",
    scope: "global",
    triggerExamples: ["QA this campaign copy", "is this email on-brand", "find copy risks before sending"],
    requiredInputs: [{ name: "copy", description: "Subject, preview, body, CTA, and offer details." }],
    optionalInputs: [{ name: "campaignGoal", description: "Launch, nurture, winback, education, or promo." }],
    requiredContext: ["brand voice", "offer context", "lifecycle stage", "known compliance pitfalls"],
    toolsUsed: ["brain.readBrandContext"],
    procedureSteps: [
      "Read brand context through the Tool Runtime.",
      "Score clarity, specificity, proof, emotional fit, offer mechanics, and objection handling.",
      "Produce a fix list grouped by must-fix, should-fix, and nice-to-have.",
      "Suggest revised snippets without creating a campaign draft.",
    ],
    verificationChecklist: [
      "Brand context was read safely.",
      "No campaign creation tool was called.",
      "Every recommendation maps to a copy span or rationale.",
    ],
    pitfalls: [
      "Do not flatten distinct brand voice into generic ecommerce language.",
      "Do not invent claims or proof.",
      "Do not mark copy as ready for launch.",
    ],
    safetyLevel: "low",
    approvalRequirements: {
      requiresApproval: false,
      beforeLiveExternalAction: true,
      notes: ["Analytical copy review only."],
    },
    outputShape: {
      scorecard: "array",
      issues: "array",
      suggestedRevisions: "array",
      caveats: "array",
    },
    caveats: ["Registered for discovery; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["copy_artifact.read", "claim_guardrails.evaluate"],
    safeAlternatives: ["brain.readBrandContext", "memory.getCampaignInsights"],
    implemented: false,
    metadata: { plannedRunner: "analysis_chain" },
  },
  {
    id: "email_design_review",
    name: "Email Design Review",
    description:
      "Review email design artifacts for hierarchy, readability, CTA visibility, brand fit, accessibility, and approval readiness.",
    category: "creative_qa",
    status: "draft",
    origin: "system",
    scope: "global",
    triggerExamples: ["review this email design", "QA the Figma email", "is this design ready for approval"],
    requiredInputs: [{ name: "designArtifact", description: "Email design file, source link, screenshot, or slices." }],
    optionalInputs: [{ name: "campaignGoal", description: "Goal and audience for the design." }],
    preferredSources: ["figma_design", "canva_design"],
    fallbackSources: ["uploaded_image", "uploaded_screenshot"],
    requiredArtifacts: [
      {
        name: "email_design",
        description: "Current email design artifact or screenshots.",
        acceptedSources: ["figma_design", "canva_design", "uploaded_image", "uploaded_screenshot"],
      },
    ],
    optionalArtifacts: [
      {
        name: "copy_source",
        description: "Copy doc or campaign brief for checking copy/design alignment.",
        acceptedSources: ["google_doc"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_design_source_then_upload_fallback",
      ifPreferredUnavailable: "Ask for design screenshots or slices before reviewing visual hierarchy.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "figma_design", status: "not_wired_v0", required: false },
      { source: "canva_design", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["brand design preferences", "campaign goal", "audience state", "copy intent"],
    toolsUsed: ["brain.readBrandContext"],
    procedureSteps: [
      "Inspect hierarchy, first-screen clarity, CTA visibility, and mobile scan path.",
      "Check copy/design alignment and visual proof placement.",
      "Flag approval blockers, warnings, and polish notes.",
      "Return assistive review only; do not modify the design source.",
    ],
    verificationChecklist: [
      "Primary CTA is visible and not visually buried.",
      "Offer/value proposition is visible early enough for the audience state.",
      "Mobile readability and slice order are coherent.",
      "No design source is edited.",
    ],
    pitfalls: [
      "Do not approve design if the CTA is hidden by visual hierarchy.",
      "Do not assume screenshots are complete if slice order is missing.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { blockers: "array", warnings: "array", polishNotes: "array", approvalReadiness: "string" },
    caveats: ["Draft assist skill; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["email_design.read_artifact"],
    safeAlternatives: ["email_slice_review"],
    implemented: false,
    metadata: { plannedRunner: "design_review_chain" },
  },
  {
    id: "email_slice_review",
    name: "Email Slice Review",
    description:
      "Diagnose one email as a slice of a larger lifecycle: job-to-be-done, audience fit, merchandising, proof, and next action.",
    category: "creative_qa",
    status: "draft",
    origin: "system",
    scope: "global",
    triggerExamples: ["review this one email", "why is this email weak", "make this lifecycle email sharper"],
    requiredInputs: [{ name: "email", description: "Email content or structured email fields." }],
    optionalInputs: [{ name: "sequencePosition", description: "Where the email sits in the flow or campaign." }],
    preferredSources: ["figma_design", "canva_design"],
    fallbackSources: ["uploaded_image", "uploaded_screenshot"],
    requiredArtifacts: [
      {
        name: "email_design_slices",
        description: "Current email design slices or screenshots.",
        acceptedSources: ["figma_design", "canva_design", "uploaded_image", "uploaded_screenshot"],
      },
    ],
    optionalArtifacts: [
      {
        name: "campaign_copy_doc",
        description: "Copy source document if design slices do not include readable copy.",
        acceptedSources: ["google_doc"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_design_source_then_upload_fallback",
      ifPreferredUnavailable: "Ask for uploaded images or screenshots before reviewing visual hierarchy.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "figma_design", status: "not_wired_v0", required: false },
      { source: "canva_design", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["brand voice", "lifecycle placement", "campaign memory"],
    toolsUsed: ["brain.readBrandContext", "memory.getCampaignInsights"],
    procedureSteps: [
      "Identify the email's one job.",
      "Check whether the first screen earns the reader's next click.",
      "Map each section to reassurance, desire, proof, or action.",
      "Return surgical edits rather than a full rewrite by default.",
    ],
    verificationChecklist: [
      "The critique names the email's job.",
      "Suggested edits preserve factual claims.",
      "No send or schedule path is touched.",
    ],
    pitfalls: [
      "Do not review in isolation when lifecycle position is known.",
      "Do not replace strong brand phrasing with generic best practices.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { diagnosis: "object", fixes: "array", revisedSnippets: "array" },
    caveats: ["Registered for discovery; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["email_artifact.read"],
    safeAlternatives: ["brain.readBrandContext"],
    implemented: false,
    metadata: { plannedRunner: "analysis_chain" },
  },
  {
    id: "campaign_calendar_builder",
    name: "Campaign Calendar Builder",
    description:
      "Turn retention priorities, seasonality, product moments, and audience fatigue into a calendar of campaign concepts.",
    category: "planning",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["build next month of campaigns", "make a retention calendar", "plan weekly campaigns"],
    requiredInputs: [{ name: "dateRange", description: "Planning window." }],
    optionalInputs: [
      { name: "launches", description: "Known launches, promos, or content moments." },
      { name: "cadence", description: "Desired send cadence." },
    ],
    requiredContext: ["campaign memory", "brand calendar", "product priorities", "audience fatigue"],
    toolsUsed: ["memory.getCampaignInsights", "brain.readBrandContext"],
    procedureSteps: [
      "Read campaign memory and brand context.",
      "Reserve space for lifecycle gaps before promo ideas.",
      "Balance revenue moments, education, proof, community, and replenishment.",
      "Return briefs that can later become approval-gated campaign work.",
    ],
    verificationChecklist: [
      "Every concept has a goal, audience, timing rationale, and risk note.",
      "No draft creation happens in the calendar step.",
    ],
    pitfalls: [
      "Do not over-pack the calendar just because blank slots exist.",
      "Do not repeat concepts the brand recently ignored or rejected.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { calendar: "array", themes: "array", openQuestions: "array" },
    caveats: ["Needs a clean calendar storage/read model before execution."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["campaign_calendar.read_write_safe"],
    safeAlternatives: ["memory.getCampaignInsights"],
    implemented: false,
    metadata: { plannedRunner: "planning_chain" },
  },
  {
    id: "product_campaign_strategy",
    name: "Product Campaign Strategy",
    description:
      "Turn product truth, purchase behavior, inventory or merchandising goals, and lifecycle context into campaign angles.",
    category: "strategy",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["what campaign should we run for this product", "turn product truth into campaign ideas"],
    requiredInputs: [{ name: "productFocus", description: "Product, category, bundle, or merchandising goal." }],
    optionalInputs: [{ name: "campaignWindow", description: "Date range, season, launch, or promotion context." }],
    preferredSources: ["shopify_snapshot", "klaviyo_snapshot"],
    fallbackSources: ["uploaded_csv", "google_sheet"],
    requiredArtifacts: [
      {
        name: "product_performance_snapshot",
        description: "Product, order, customer, or merchandising data for strategy selection.",
        acceptedSources: ["shopify_snapshot", "uploaded_csv", "google_sheet"],
      },
    ],
    optionalArtifacts: [
      {
        name: "campaign_history",
        description: "Recent campaign or flow performance context.",
        acceptedSources: ["klaviyo_snapshot", "uploaded_csv", "google_sheet"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_shopify_and_klaviyo_snapshots_then_csv_fallback",
      ifPreferredUnavailable: "Ask for product/order and recent campaign exports before ranking campaign angles.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["product truth", "campaign memory", "audience lifecycle state", "offer constraints"],
    toolsUsed: ["memory.getCampaignInsights", "brain.readBrandContext"],
    procedureSteps: [
      "Identify the product's strongest campaign job.",
      "Choose angles from product truth, customer behavior, objections, and lifecycle context.",
      "Map each angle to audience, offer stance, proof, and measurement plan.",
      "Return strategy only; no campaign draft is created.",
    ],
    verificationChecklist: [
      "Each angle has product evidence.",
      "Audience and lifecycle context are explicit.",
      "No campaign draft or send path is touched.",
    ],
    pitfalls: [
      "Do not treat every product as discount-led.",
      "Do not recommend angles unsupported by product or customer evidence.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { angles: "array", audiences: "array", proofNeeds: "array", measurementPlan: "array" },
    caveats: ["Planned assist skill; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["product_campaign_strategy.assist_runner"],
    safeAlternatives: ["memory.getCampaignInsights"],
    implemented: false,
    metadata: { plannedRunner: "strategy_chain" },
  },
  {
    id: "lead_magnet_analysis",
    name: "Lead Magnet Performance Analysis",
    description:
      "Analyze lead magnets, quizzes, freebies, guides, or acquisition cohorts when the workspace actually uses them.",
    category: "optional_growth_analysis",
    status: "planned",
    origin: "system",
    scope: "hybrid",
    triggerExamples: [
      "analyze the lead magnet",
      "why is this freebie not converting",
      "compare lead magnet quality",
    ],
    requiredInputs: [{ name: "leadMagnetName", description: "Lead magnet or funnel to inspect." }],
    optionalInputs: [{ name: "timeframe", description: "Analysis period." }],
    preferredSources: ["klaviyo_snapshot", "shopify_snapshot"],
    fallbackSources: ["uploaded_csv"],
    requiredArtifacts: [
      {
        name: "lead_source_snapshot",
        description: "Lead magnet opt-in, segment, profile, or form source data.",
        acceptedSources: ["klaviyo_snapshot", "uploaded_csv"],
      },
      {
        name: "order_snapshot",
        description: "Order or purchase records for downstream conversion matching.",
        acceptedSources: ["shopify_snapshot", "uploaded_csv"],
      },
    ],
    optionalArtifacts: [
      {
        name: "landing_page_notes",
        description: "Promise, offer, or landing page context for the lead magnet.",
        acceptedSources: ["google_doc", "uploaded_screenshot"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_platform_snapshots_then_csv_fallback",
      ifPreferredUnavailable: "Ask for lead and order CSV exports before calculating performance.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
    ],
    requiredContext: [
      "workspace has lead magnets, quizzes, freebies, guides, or acquisition cohorts",
      "lead source attribution",
      "landing page promise",
      "email follow-up",
      "result history",
    ],
    toolsUsed: ["memory.getCampaignInsights", "brain.readBrandContext"],
    procedureSteps: [
      "Identify the promise made at opt-in.",
      "Compare opt-in volume with revenue, engagement, and unsubscribe pressure.",
      "Read follow-up quality against the promise.",
      "Return whether the issue is traffic quality, promise mismatch, nurture gap, or offer mismatch.",
    ],
    verificationChecklist: [
      "The conclusion separates volume from quality.",
      "Metrics include downstream behavior, not only opt-ins.",
      "Any proposed fixes stay in preparation mode.",
    ],
    pitfalls: [
      "Do not celebrate lead volume without purchase intent.",
      "Do not blame creative before checking audience source and follow-up promise.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: {
      diagnosis: "object",
      metricSummary: "object",
      recommendedExperiments: "array",
      learningSignals: "array",
    },
    caveats: [
      "Optional growth/acquisition analysis, not a core DTC retention starter skill.",
      "Use only when the workspace has lead magnets, quizzes, freebies, guides, or acquisition cohorts.",
      "Needs stable lead magnet attribution before execution.",
    ],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["lead_magnet.attribution.read", "landing_page.performance.read"],
    safeAlternatives: ["memory.getCampaignInsights", "brain.readBrandContext"],
    implemented: false,
    metadata: {
      plannedRunner: "result_learning_chain",
      optionalSkill: true,
      useWhen: "Workspace has lead magnets, quizzes, freebies, guides, or acquisition cohorts.",
    },
  },
  {
    id: "performance_reporting",
    name: "Performance Reporting",
    description:
      "Analyze campaign, flow, product, customer, or uploaded performance data into a clear retention performance read.",
    category: "reporting",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["analyze performance", "report on these campaign results", "summarize this CSV performance data"],
    requiredInputs: [{ name: "performanceScope", description: "Campaign, flow, product, cohort, or reporting window." }],
    optionalInputs: [{ name: "comparisonWindow", description: "Optional prior period or benchmark." }],
    preferredSources: ["klaviyo_snapshot", "shopify_snapshot"],
    fallbackSources: ["uploaded_csv", "google_sheet"],
    requiredArtifacts: [
      {
        name: "performance_snapshot",
        description: "Performance, order, campaign, flow, or cohort result data.",
        acceptedSources: ["klaviyo_snapshot", "shopify_snapshot", "uploaded_csv", "google_sheet"],
      },
    ],
    optionalArtifacts: [
      {
        name: "business_context",
        description: "Goals, known launches, offer context, or decision questions.",
        acceptedSources: ["google_doc", "google_sheet"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_platform_snapshots_then_sheet_or_csv_fallback",
      ifPreferredUnavailable: "Use stored results where available, then ask for CSV or Google Sheet exports for gaps.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
      { source: "google_sheet", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["performance results", "campaign memory", "recommendation outcomes", "business question"],
    toolsUsed: ["memory.getCampaignInsights"],
    procedureSteps: [
      "Normalize metrics and denominators.",
      "Separate strong signals, weak signals, and missing-data caveats.",
      "Connect performance back to recommendations, campaigns, flows, or products.",
      "Return decisions and next questions, not just a table of metrics.",
    ],
    verificationChecklist: [
      "Metrics include denominator context.",
      "Missing data and source limitations are explicit.",
      "No external source is mutated.",
    ],
    pitfalls: [
      "Do not overstate causality from incomplete exports.",
      "Do not bury caveats below the main read.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { mainRead: "string", metrics: "object", caveats: "array", nextDecisions: "array" },
    caveats: ["Planned assist skill; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["performance_reporting.aggregate"],
    safeAlternatives: ["GET /api/results", "GET /api/recommendations/outcomes"],
    implemented: false,
    metadata: { plannedRunner: "reporting_chain" },
  },
  {
    id: "weekly_retention_reporting",
    name: "Weekly Retention Reporting",
    description:
      "Produce a concise weekly operator report that combines outcomes, results, audit changes, and next recommended actions.",
    category: "reporting",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["make this week's retention report", "what changed this week", "weekly retention summary"],
    requiredInputs: [{ name: "weekStart", description: "Start date for reporting." }],
    optionalInputs: [{ name: "audience", description: "Founder, marketer, operator, or agency view." }],
    preferredSources: ["klaviyo_snapshot", "shopify_snapshot"],
    fallbackSources: ["uploaded_csv", "google_sheet"],
    requiredArtifacts: [
      {
        name: "retention_performance_snapshot",
        description: "Campaign, flow, order, and recommendation result data for the report window.",
        acceptedSources: ["klaviyo_snapshot", "shopify_snapshot", "uploaded_csv", "google_sheet"],
      },
    ],
    optionalArtifacts: [
      {
        name: "operator_notes",
        description: "Internal notes, goals, or decision context for the reporting period.",
        acceptedSources: ["google_doc", "google_sheet"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_platform_snapshots_then_sheet_or_csv_fallback",
      ifPreferredUnavailable: "Use stored outcomes/results where available, then ask for CSV or Google Sheet exports for gaps.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
      { source: "google_sheet", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["action log", "recommendation outcomes", "results", "campaign memory"],
    toolsUsed: ["memory.getCampaignInsights"],
    procedureSteps: [
      "Collect what was recommended, prepared, approved, rejected, ignored, and learned.",
      "Separate movement from activity.",
      "Summarize wins, losses, open risks, and next decisions.",
      "Produce a reusable learning note for future audits.",
    ],
    verificationChecklist: [
      "Report cites only stored state.",
      "No external read or write is required.",
      "Open decisions map back to recommendation outcome ids.",
    ],
    pitfalls: [
      "Do not call a week successful because tasks were completed.",
      "Do not hide ignored or rejected recommendations.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { executiveSummary: "string", movements: "array", openDecisions: "array", nextActions: "array" },
    caveats: ["Needs a reporting aggregator over results and outcomes before execution."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["retention_report.aggregate"],
    safeAlternatives: ["GET /api/results", "GET /api/recommendations/outcomes"],
    implemented: false,
    metadata: { plannedRunner: "reporting_chain" },
  },
  {
    id: "flow_audit",
    name: "Flow Audit",
    description:
      "Audit automated lifecycle flows for coverage, sequencing, audience rules, message jobs, and revenue concentration risk.",
    category: "audit",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["audit flows", "find flow gaps", "review welcome and abandon flows"],
    requiredInputs: [],
    optionalInputs: [{ name: "flowType", description: "Welcome, abandon cart, post-purchase, winback, or all." }],
    requiredContext: ["flow inventory", "lifecycle map", "result history"],
    toolsUsed: ["workflow.retentionAudit"],
    procedureSteps: [
      "Inventory lifecycle stages and missing flow coverage.",
      "Inspect each flow's promise, timing, exclusions, and next action.",
      "Prioritize fixes by revenue risk and customer experience impact.",
      "Return a safe plan rather than edits.",
    ],
    verificationChecklist: [
      "Known flows are mapped to lifecycle jobs.",
      "No flow mutation route is called.",
      "Prepared fixes are clearly separated from go-live work.",
    ],
    pitfalls: [
      "Do not optimize one flow while ignoring lifecycle coverage.",
      "Do not assume Klaviyo state can be changed from an audit.",
    ],
    safetyLevel: "low",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { flowMap: "array", gaps: "array", prioritizedFixes: "array" },
    caveats: ["Use retention_audit today for broader safe coverage."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["flow_inventory.read_normalized"],
    safeAlternatives: ["retention_audit"],
    implemented: false,
    metadata: { plannedRunner: "audit_chain" },
  },
  {
    id: "flow_fix_planning",
    name: "Flow Fix Planning",
    description:
      "Turn flow audit findings into a staged implementation plan with dependencies, expected impact, and approval gates.",
    category: "planning",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["plan flow fixes", "what should we change in welcome flow", "sequence these flow fixes"],
    requiredInputs: [{ name: "flowAuditId", description: "Audit or workflow id containing flow findings." }],
    optionalInputs: [{ name: "capacity", description: "How much implementation work is realistic now." }],
    requiredContext: ["flow audit output", "recommendation outcomes", "approval state"],
    toolsUsed: ["workflow.auditFixRun"],
    procedureSteps: [
      "Group flow fixes by dependency and risk.",
      "Separate copy changes, audience changes, trigger changes, and measurement setup.",
      "Prepare only the safe plan and blocked items.",
      "Point risky work at future approval-gated tooling.",
    ],
    verificationChecklist: [
      "Each fix has a dependency and risk level.",
      "No trigger, segment, or flow is created.",
    ],
    pitfalls: [
      "Do not combine measurement setup with go-live changes.",
      "Do not make audience-rule assumptions without evidence.",
    ],
    safetyLevel: "medium",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { phases: "array", blockedItems: "array", approvalNeeds: "array" },
    caveats: ["Prepared planning only; full implementation runner is not available in v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["flow_fix.plan_from_flow_audit"],
    safeAlternatives: ["audit_fix_run"],
    implemented: false,
    metadata: { plannedRunner: "planning_chain" },
  },
  {
    id: "audience_strategy",
    name: "Audience Strategy",
    description:
      "Design audience and segment strategy from lifecycle intent, purchase behavior, engagement risk, and suppression needs.",
    category: "strategy",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["build audience strategy", "who should get this campaign", "find the right segments"],
    requiredInputs: [{ name: "campaignOrGoal", description: "Campaign, flow, or retention goal." }],
    optionalInputs: [{ name: "constraints", description: "Frequency, exclusion, or deliverability constraints." }],
    requiredContext: ["customer lifecycle map", "purchase behavior", "engagement health", "result history"],
    toolsUsed: ["memory.getCampaignInsights", "brain.readBrandContext"],
    procedureSteps: [
      "Translate the business goal into audience intent.",
      "Define include, exclude, suppress, and holdout logic in human-readable form.",
      "Estimate risks like fatigue, low intent, or list quality.",
      "Return strategy only; segment creation is a separate blocked capability.",
    ],
    verificationChecklist: [
      "Audience rules are understandable without platform syntax.",
      "No segment creation is attempted.",
      "Suppression logic is explicit.",
    ],
    pitfalls: [
      "Do not over-segment until there is enough data.",
      "Do not confuse past purchase with current intent.",
    ],
    safetyLevel: "medium",
    approvalRequirements: { requiresApproval: true, beforeLiveExternalAction: true },
    outputShape: { audiences: "array", exclusions: "array", risks: "array", measurementPlan: "array" },
    caveats: ["Segment creation remains blocked."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["audience.profile_query.read", "segment.create.approval_gated"],
    safeAlternatives: ["memory.getCampaignInsights"],
    implemented: false,
    metadata: { plannedRunner: "strategy_chain" },
  },
  {
    id: "deliverability_review",
    name: "Deliverability Review",
    description:
      "Assess sender health, engagement drag, content risk, cadence pressure, and suppression gaps before revenue work scales.",
    category: "deliverability",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: ["review deliverability", "why did opens drop", "is our list quality risky"],
    requiredInputs: [],
    optionalInputs: [{ name: "timeframe", description: "Window to evaluate." }],
    requiredContext: ["engagement trends", "complaint/unsubscribe metrics", "send cadence", "list growth source"],
    toolsUsed: ["memory.getCampaignInsights"],
    procedureSteps: [
      "Normalize engagement, complaint, unsubscribe, and send pressure metrics.",
      "Separate content issues from list quality and cadence issues.",
      "Produce staged repairs before growth or promo pushes.",
      "Flag risky actions that need approval before execution.",
    ],
    verificationChecklist: [
      "Metrics are interpreted with denominator context.",
      "Risky recommendations are blocked from live execution.",
    ],
    pitfalls: [
      "Do not treat open rate alone as proof.",
      "Do not recommend aggressive reactivation without suppression rules.",
    ],
    safetyLevel: "medium",
    approvalRequirements: { requiresApproval: true, beforeLiveExternalAction: true },
    outputShape: { healthSummary: "object", risks: "array", repairPlan: "array" },
    caveats: ["Needs normalized deliverability metrics before execution."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["deliverability.metrics.read"],
    safeAlternatives: ["memory.getCampaignInsights"],
    implemented: false,
    metadata: { plannedRunner: "risk_review_chain" },
  },
  {
    id: "post_purchase_lifecycle_optimization",
    name: "Post-Purchase Lifecycle Optimization",
    description:
      "Optimize the customer experience after purchase across education, cross-sell, replenishment, second purchase, and winback paths.",
    category: "lifecycle_strategy",
    status: "planned",
    origin: "system",
    scope: "global",
    triggerExamples: [
      "improve post-purchase lifecycle",
      "optimize second purchase",
      "what should happen after someone buys",
    ],
    requiredInputs: [{ name: "postPurchaseGoal", description: "Goal such as second purchase, education, replenishment, or winback." }],
    optionalInputs: [{ name: "productCategory", description: "Optional product/category focus." }],
    preferredSources: ["shopify_snapshot", "klaviyo_snapshot"],
    fallbackSources: ["uploaded_csv", "google_sheet"],
    requiredArtifacts: [
      {
        name: "post_purchase_snapshot",
        description: "Orders, customer lifecycle, product, and flow/campaign context after purchase.",
        acceptedSources: ["shopify_snapshot", "klaviyo_snapshot", "uploaded_csv", "google_sheet"],
      },
    ],
    optionalArtifacts: [
      {
        name: "product_usage_context",
        description: "Education, usage, replenishment, or cross-sell notes.",
        acceptedSources: ["google_doc", "google_sheet"],
      },
    ],
    missingSourceBehavior: {
      rule: "prefer_shopify_and_klaviyo_snapshots_then_csv_fallback",
      ifPreferredUnavailable: "Ask for order/customer and flow/campaign exports before prioritizing post-purchase fixes.",
      liveActionAllowed: false,
      connectorBuildRequiredHere: false,
    },
    connectorDependencies: [
      { source: "shopify_snapshot", status: "not_wired_v0", required: false },
      { source: "klaviyo_snapshot", status: "not_wired_v0", required: false },
    ],
    requiredContext: ["order behavior", "product lifecycle", "flow coverage", "campaign memory"],
    toolsUsed: ["workflow.retentionAudit", "memory.getCampaignInsights"],
    procedureSteps: [
      "Map what should happen after purchase by product/category.",
      "Check second-purchase, replenishment, cross-sell, education, and winback coverage.",
      "Prioritize lifecycle gaps by customer value and evidence strength.",
      "Return safe optimization plan only; no flow or segment changes.",
    ],
    verificationChecklist: [
      "Recommendations distinguish education, cross-sell, replenishment, and winback.",
      "Audience exclusions and timing risks are explicit.",
      "No flow or segment mutation is attempted.",
    ],
    pitfalls: [
      "Do not optimize post-purchase messaging without recent-purchase suppression logic.",
      "Do not assume every product has the same replenishment or second-purchase path.",
    ],
    safetyLevel: "medium",
    approvalRequirements: { requiresApproval: false, beforeLiveExternalAction: true },
    outputShape: { lifecycleMap: "array", gaps: "array", priorities: "array", blockedLiveActions: "array" },
    caveats: ["Planned assist skill; not implemented in Skill Runner v0."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["post_purchase_lifecycle.aggregate"],
    safeAlternatives: ["retention_audit", "flow_audit"],
    implemented: false,
    metadata: { plannedRunner: "lifecycle_strategy_chain" },
  },
  {
    id: "klaviyo_build_qa",
    name: "Klaviyo Build QA",
    description:
      "Check a prepared Klaviyo build against strategy, audience, links, content, exclusions, naming, and launch readiness.",
    category: "build_qa",
    status: "blocked",
    origin: "system",
    scope: "global",
    triggerExamples: ["QA this Klaviyo build", "check before launch", "is this flow ready"],
    requiredInputs: [{ name: "buildReference", description: "Draft campaign, flow, or prepared package to inspect." }],
    optionalInputs: [{ name: "checkDepth", description: "Fast, standard, or launch-critical." }],
    requiredContext: ["prepared package", "approval state", "platform build read model", "link inventory"],
    toolsUsed: [],
    procedureSteps: [
      "Read the prepared package and platform build snapshot.",
      "Check links, audiences, exclusions, content, naming, and measurement.",
      "Return launch blockers and approval requirements.",
      "Do not send, schedule, sync, or publish.",
    ],
    verificationChecklist: [
      "Every blocker has a concrete reference.",
      "Live action remains unavailable.",
      "Launch readiness is advisory unless a separate approval-gated path exists.",
    ],
    pitfalls: [
      "Do not mark a build live-ready without platform evidence.",
      "Do not treat approval of QA as approval to launch.",
    ],
    safetyLevel: "high",
    approvalRequirements: {
      requiresApproval: true,
      beforeLiveExternalAction: true,
      notes: ["Blocked until safe platform read snapshots and approval boundaries are present."],
    },
    outputShape: { blockers: "array", warnings: "array", passChecks: "array", launchReadiness: "string" },
    caveats: ["Blocked in v0. No platform write or launch path is available."],
    version: "0.1.0",
    createdFromWorkflowRunId: null,
    createdFromActionLogId: null,
    missingCapabilities: ["klaviyo.build_snapshot.read", "link_check.safe_read"],
    safeAlternatives: ["audit_fix_run"],
    implemented: false,
    metadata: { plannedRunner: "qa_chain" },
  },
];

const STARTER_SKILL_IDS = new Set(STARTER_SKILLS.map((skill) => skill.id));

const STATUS_ORDER: Record<SkillStatus, number> = {
  active: 0,
  shadow: 1,
  draft: 2,
  planned: 3,
  blocked: 4,
  archived: 5,
};

const ALLOWED_SKILL_TRANSITIONS: Record<SkillStatus, SkillStatus[]> = {
  active: ["archived"],
  archived: [],
  blocked: ["draft", "archived"],
  draft: ["shadow", "archived"],
  planned: [],
  shadow: ["active", "archived"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ToJsonOptions = {
  dropRawKeys?: boolean;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
};

function shouldDropSkillMetadataKey(key: string) {
  return /raw|payload|response|full.*audit|audit.*output|klaviyo.*body|headers?/i.test(key);
}

function compactSkillJson(value: unknown, options: ToJsonOptions = {}, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return scrubActionLogJson(value);
  if (value instanceof Date) return value.toISOString();

  const maxDepth = options.maxDepth ?? 4;
  if (depth >= maxDepth) return "[truncated]";

  if (Array.isArray(value)) {
    return value
      .slice(0, options.maxArrayItems ?? 24)
      .map((item) => compactSkillJson(item, options, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, options.maxObjectKeys ?? 36)) {
    if (options.dropRawKeys && shouldDropSkillMetadataKey(key)) continue;
    output[key] = compactSkillJson(child, options, depth + 1);
  }
  return scrubActionLogJson(output);
}

function toJson(value: unknown, options: ToJsonOptions = {}): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(compactSkillJson(value ?? null, options))) as Prisma.InputJsonValue;
}

function cleanString(value: string | null | undefined, max = 240) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeSkillId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_.:]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
}

function generateSkillId(name: string) {
  return normalizeSkillId(name) || `agent_skill_${Date.now()}`;
}

function normalizeStatus(value: string | null | undefined, fallback: SkillStatus): SkillStatus {
  return SKILL_STATUSES.includes(value as SkillStatus) ? (value as SkillStatus) : fallback;
}

function normalizeOrigin(value: string | null | undefined, fallback: SkillOrigin): SkillOrigin {
  return SKILL_ORIGINS.includes(value as SkillOrigin) ? (value as SkillOrigin) : fallback;
}

function normalizeScope(value: string | null | undefined, fallback: SkillScope): SkillScope {
  return SKILL_SCOPES.includes(value as SkillScope) ? (value as SkillScope) : fallback;
}

function normalizeRunMode(value: string | null | undefined, fallback: SkillRunMode): SkillRunMode {
  return SKILL_RUN_MODES.includes(value as SkillRunMode) ? (value as SkillRunMode) : fallback;
}

function normalizeSafetyLevel(
  value: string | null | undefined,
  fallback: SkillSafetyLevel,
): SkillSafetyLevel {
  return SKILL_SAFETY_LEVELS.includes(value as SkillSafetyLevel)
    ? (value as SkillSafetyLevel)
    : fallback;
}

function asArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function asStringArray(value: unknown) {
  return asArray(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeSourceName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSourceList(value: unknown) {
  return uniqueStrings(
    asStringArray(value)
      .map(normalizeSourceName)
      .filter((source) =>
        SKILL_ARTIFACT_SOURCES.includes(source as SkillArtifactSource) ||
        /^[a-z][a-z0-9_.:-]{2,80}$/.test(source),
      ),
  );
}

function defaultMissingSourceBehavior(preferredSources: string[], fallbackSources: string[]) {
  return {
    rule: "prefer_source_snapshot_then_fallback_upload",
    preferredSources,
    fallbackSources,
    ifPreferredUnavailable: fallbackSources.length
      ? "Ask for a fallback artifact before attempting the skill."
      : "Ask for the required source snapshot or artifact before attempting the skill.",
    liveActionAllowed: false,
    connectorBuildRequiredHere: false,
  };
}

function uniqueArray(items: unknown, additions: unknown = []) {
  const existing = asArray(items);
  const seen = new Set(existing.map((item) => (JSON.stringify(item) ?? String(item)).toLowerCase()));
  const output = [...existing];

  for (const item of asArray(additions)) {
    const normalized = (JSON.stringify(item) ?? String(item)).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(item);
  }

  return output.slice(0, 80);
}

function compactContextString(value: unknown, prefix?: string): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return `${prefix ? `${prefix}: ` : ""}${value}`;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => compactContextString(item))
      .filter(Boolean)
      .slice(0, 12)
      .join(", ");
    return items ? `${prefix ? `${prefix}: ` : ""}${items}` : "";
  }
  if (isRecord(value)) {
    const parts = Object.entries(value)
      .slice(0, 8)
      .map(([key, child]) => compactContextString(child, key))
      .filter(Boolean);
    return parts.join("; ");
  }
  return "";
}

function contextStringsFrom(value: unknown) {
  return asArray(value)
    .map((item) => compactContextString(item))
    .filter(Boolean)
    .slice(0, 24);
}

function metadataContextSuggestions(metadata: unknown) {
  if (!isRecord(metadata)) return [];
  const keys = [
    "brandName",
    "clientName",
    "workspaceName",
    "productNames",
    "leadMagnetNames",
    "reportingPreferences",
    "dashboardStyle",
    "platformQuirks",
  ];

  return keys
    .flatMap((key) => metadata[key] === undefined ? [] : contextStringsFrom({ [key]: metadata[key] }))
    .filter(Boolean);
}

function metadataOneOffDetails(metadata: unknown) {
  if (!isRecord(metadata)) return [];
  const keys = [
    "timeframe",
    "dateRange",
    "fileBatch",
    "sourceFiles",
    "uploadedFiles",
    "workflowId",
    "workflowRunId",
  ];

  return keys
    .flatMap((key) => metadata[key] === undefined ? [] : contextStringsFrom({ [key]: metadata[key] }))
    .filter(Boolean);
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, 24);
}

function workspaceContextSuggestionsFor(input: SkillProposalInput) {
  return uniqueStrings([
    ...contextStringsFrom(input.workspaceContextSuggestions),
    ...contextStringsFrom(input.workspaceContext),
    ...contextStringsFrom(input.brandContext),
    ...metadataContextSuggestions(input.metadata),
  ]);
}

function oneOffDetailsFor(input: SkillProposalInput) {
  return uniqueStrings([
    ...contextStringsFrom(input.oneOffDetailsNotSavedToSkill),
    ...contextStringsFrom(input.oneOffDetails),
    ...metadataOneOffDetails(input.metadata),
  ]);
}

function stripGeneralizationMetadata(metadata: unknown) {
  if (!isRecord(metadata)) return {};
  const excluded = new Set([
    "brandName",
    "clientName",
    "workspaceName",
    "productNames",
    "leadMagnetNames",
    "reportingPreferences",
    "dashboardStyle",
    "platformQuirks",
    "timeframe",
    "dateRange",
    "fileBatch",
    "sourceFiles",
    "uploadedFiles",
    "workflowId",
    "workflowRunId",
    "rawPayload",
    "fullAuditOutput",
  ]);

  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !excluded.has(key)));
}

function brandPhrasesFrom(contextSuggestions: string[]) {
  return contextSuggestions
    .flatMap((item) => {
      const match = item.match(/\b([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,2})\s+(uses|prefers|wants|has|reporting|product|lead)/);
      return match?.[1] ? [match[1]] : [];
    })
    .filter((item) => item.length >= 3);
}

function generalizeSkillName(input: SkillProposalInput, workspaceSuggestions: string[], oneOffDetails: string[]) {
  let name = cleanString(input.reusableName, 160) ?? input.name.trim();
  const phrases = [
    ...brandPhrasesFrom(workspaceSuggestions),
    ...oneOffDetails,
  ];

  for (const phrase of phrases) {
    if (phrase.length > 60) continue;
    name = name.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
  }

  name = name
    .replace(/\b(?:jan|feb|mar|apr|april|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/gi, "")
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, "")
    .replace(/\bfile\s+batch\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[-: ]+|[-: ]+$/g, "");

  return name || input.name.trim();
}

function normalizeProposalScope(input: SkillProposalInput, workspaceSuggestions: string[]) {
  if (input.scope === "workspace") return "workspace";
  if (workspaceSuggestions.length > 0) return "hybrid";
  return input.scope ?? "global";
}

function normalizeProposalRunMode(input: SkillProposalInput, status: SkillStatus): SkillRunMode {
  if (status === "blocked") return "shadow";
  if (input.runMode === "shadow") return "shadow";
  return "assist";
}

function withRowUsage(skill: SkillDefinition, row: WorklinSkillRow | null): SerializedSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    status: skill.status,
    origin: skill.origin,
    scope: skill.scope,
    runMode: skill.runMode ?? (skill.implemented ? "execute" : "assist"),
    triggerExamples: skill.triggerExamples,
    requiredInputs: skill.requiredInputs,
    optionalInputs: skill.optionalInputs,
    preferredSources: skill.preferredSources ?? [],
    fallbackSources: skill.fallbackSources ?? [],
    requiredArtifacts: skill.requiredArtifacts ?? [],
    optionalArtifacts: skill.optionalArtifacts ?? [],
    missingSourceBehavior: skill.missingSourceBehavior ?? defaultMissingSourceBehavior(
      normalizeSourceList(skill.preferredSources),
      normalizeSourceList(skill.fallbackSources),
    ),
    connectorDependencies: skill.connectorDependencies ?? [],
    requiredContext: skill.requiredContext,
    toolsUsed: skill.toolsUsed,
    procedureSteps: skill.procedureSteps,
    verificationChecklist: skill.verificationChecklist,
    pitfalls: skill.pitfalls,
    safetyLevel: skill.safetyLevel,
    approvalRequirements: skill.approvalRequirements,
    outputShape: skill.outputShape,
    caveats: skill.caveats,
    version: skill.version,
    usageCount: row?.usageCount ?? skill.usageCount ?? 0,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? skill.lastUsedAt ?? null,
    createdFromWorkflowRunId:
      row?.createdFromWorkflowRunId ?? skill.createdFromWorkflowRunId ?? null,
    createdFromActionLogId: row?.createdFromActionLogId ?? skill.createdFromActionLogId ?? null,
    missingCapabilities: skill.missingCapabilities,
    workspaceContextSuggestions: skill.workspaceContextSuggestions ?? [],
    oneOffDetailsNotSavedToSkill: skill.oneOffDetailsNotSavedToSkill ?? [],
    safeAlternatives: skill.safeAlternatives,
    implemented: skill.implemented,
    metadata: skill.metadata,
    createdAt: row?.createdAt.toISOString() ?? skill.createdAt ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? skill.updatedAt ?? null,
  };
}

function serializeDbSkill(row: WorklinSkillRow): SerializedSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    status: normalizeStatus(row.status, "draft"),
    origin: normalizeOrigin(row.origin, "agent_created"),
    scope: normalizeScope(row.scope, "workspace"),
    runMode: normalizeRunMode(row.runMode, "assist"),
    triggerExamples: row.triggerExamples ?? [],
    requiredInputs: row.requiredInputs ?? [],
    optionalInputs: row.optionalInputs ?? [],
    preferredSources: row.preferredSources ?? [],
    fallbackSources: row.fallbackSources ?? [],
    requiredArtifacts: row.requiredArtifacts ?? [],
    optionalArtifacts: row.optionalArtifacts ?? [],
    missingSourceBehavior: row.missingSourceBehavior ?? defaultMissingSourceBehavior(
      normalizeSourceList(row.preferredSources),
      normalizeSourceList(row.fallbackSources),
    ),
    connectorDependencies: row.connectorDependencies ?? [],
    requiredContext: row.requiredContext ?? [],
    toolsUsed: row.toolsUsed ?? [],
    procedureSteps: row.procedureSteps ?? [],
    verificationChecklist: row.verificationChecklist ?? [],
    pitfalls: row.pitfalls ?? [],
    safetyLevel: normalizeSafetyLevel(row.safetyLevel, "low"),
    approvalRequirements: row.approvalRequirements ?? { requiresApproval: false },
    outputShape: row.outputShape ?? {},
    caveats: row.caveats ?? [],
    version: row.version,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdFromWorkflowRunId: row.createdFromWorkflowRunId,
    createdFromActionLogId: row.createdFromActionLogId,
    missingCapabilities: row.missingCapabilities ?? [],
    workspaceContextSuggestions: row.workspaceContextSuggestions ?? [],
    oneOffDetailsNotSavedToSkill: row.oneOffDetailsNotSavedToSkill ?? [],
    safeAlternatives: [],
    implemented: false,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function matchesFilters(skill: SerializedSkill, filters: SkillListFilters) {
  if (filters.status && skill.status !== filters.status) return false;
  if (filters.category && skill.category !== filters.category) return false;
  if (filters.origin && skill.origin !== filters.origin) return false;
  if (filters.scope && skill.scope !== filters.scope) return false;
  if (filters.runMode && skill.runMode !== filters.runMode) return false;
  if (filters.implemented !== null && filters.implemented !== undefined) {
    if (skill.implemented !== filters.implemented) return false;
  }
  return true;
}

function skillSummary(skill: SerializedSkill) {
  return {
    id: skill.id,
    name: skill.name,
    category: skill.category,
    status: skill.status,
    origin: skill.origin,
    scope: skill.scope,
    runMode: skill.runMode,
    safetyLevel: skill.safetyLevel,
    implemented: skill.implemented,
    toolsUsed: skill.toolsUsed,
    missingCapabilities: skill.missingCapabilities,
    preferredSources: skill.preferredSources,
    fallbackSources: skill.fallbackSources,
    requiredArtifacts: skill.requiredArtifacts,
    optionalArtifacts: skill.optionalArtifacts,
    missingSourceBehavior: skill.missingSourceBehavior,
    connectorDependencies: skill.connectorDependencies,
  };
}

function compactSkillForLog(skill: SerializedSkill) {
  return {
    id: skill.id,
    status: skill.status,
    category: skill.category,
    runMode: skill.runMode,
    implemented: skill.implemented,
    toolsUsed: skill.toolsUsed,
    safetyLevel: skill.safetyLevel,
  };
}

function requiresApproval(skill: SerializedSkill) {
  return isRecord(skill.approvalRequirements)
    ? skill.approvalRequirements.requiresApproval === true
    : false;
}

function statusForToolResult(result: ToolRuntimeResponse) {
  if (result.ok) return "completed";
  if (result.reason === "approval_required") return "refused";
  return "failed";
}

function toolCallSummary(toolName: string, result: ToolRuntimeResponse) {
  return {
    toolName,
    ok: result.ok,
    reason: result.reason ?? (result.ok ? "ok" : "tool_runtime_failed"),
    status: result.status,
    actionLogId: isRecord(result.actionLog) && typeof result.actionLog.id === "string"
      ? result.actionLog.id
      : null,
  };
}

function skillPersistenceData(skill: SerializedSkill, now: Date) {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    status: skill.status,
    origin: skill.origin,
    scope: skill.scope,
    runMode: skill.runMode,
    triggerExamples: toJson(skill.triggerExamples),
    requiredInputs: toJson(skill.requiredInputs),
    optionalInputs: toJson(skill.optionalInputs),
    preferredSources: toJson(skill.preferredSources),
    fallbackSources: toJson(skill.fallbackSources),
    requiredArtifacts: toJson(skill.requiredArtifacts),
    optionalArtifacts: toJson(skill.optionalArtifacts),
    missingSourceBehavior: toJson(skill.missingSourceBehavior),
    connectorDependencies: toJson(skill.connectorDependencies),
    requiredContext: toJson(skill.requiredContext),
    toolsUsed: toJson(skill.toolsUsed),
    procedureSteps: toJson(skill.procedureSteps),
    verificationChecklist: toJson(skill.verificationChecklist),
    pitfalls: toJson(skill.pitfalls),
    safetyLevel: skill.safetyLevel,
    approvalRequirements: toJson(skill.approvalRequirements),
    outputShape: toJson(skill.outputShape),
    caveats: toJson(skill.caveats),
    version: skill.version,
    lastUsedAt: now,
    createdFromWorkflowRunId: skill.createdFromWorkflowRunId,
    createdFromActionLogId: skill.createdFromActionLogId,
    missingCapabilities: toJson(skill.missingCapabilities),
    workspaceContextSuggestions: toJson(skill.workspaceContextSuggestions),
    oneOffDetailsNotSavedToSkill: toJson(skill.oneOffDetailsNotSavedToSkill),
    metadata: toJson(
      {
        ...((isRecord(skill.metadata) ? skill.metadata : {}) as Record<string, unknown>),
        implemented: skill.implemented,
        safeAlternatives: skill.safeAlternatives,
      },
      { dropRawKeys: true, maxArrayItems: 12, maxObjectKeys: 24, maxDepth: 4 },
    ),
  };
}

async function recordSkillUsage(skill: SerializedSkill) {
  const now = new Date();
  const data = skillPersistenceData(skill, now);

  await prisma.worklinSkill.upsert({
    where: { id: skill.id },
    create: {
      id: skill.id,
      ...data,
      usageCount: 1,
    },
    update: {
      ...data,
      usageCount: { increment: 1 },
    },
  });
}

async function logSkillRun(input: {
  eventType: string;
  status: string;
  skillId: string;
  skill: SerializedSkill | null;
  summary: string;
  requestInput?: unknown;
  outputSummary?: unknown;
  errorMessage?: string | null;
}) {
  return logActionEvent({
    eventType: input.eventType,
    actionType: "run_skill",
    status: input.status,
    actorType: "api",
    targetType: "skill",
    targetId: input.skillId,
    riskLevel: input.skill?.safetyLevel ?? "unknown",
    requiresApproval: input.skill ? requiresApproval(input.skill) : false,
    approvalStatus: null,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: input.summary,
    inputSummary: input.requestInput,
    outputSummary: input.outputSummary,
    errorMessage: input.errorMessage ?? null,
    metadata: {
      skill: input.skill ? compactSkillForLog(input.skill) : null,
      stateOnly: true,
      route: "POST /api/skills/run",
    },
  });
}

function buildRunResponse(input: {
  ok: boolean;
  reason: string;
  skill: SerializedSkill | null;
  result?: unknown;
  toolCalls?: SkillRunResponse["toolCalls"];
  requestedLog?: unknown;
  completedLog?: unknown;
  caveats?: string[];
  status: number;
}): SkillRunResponse {
  return {
    ok: input.ok,
    reason: input.reason,
    skill: input.skill,
    result: input.result ?? null,
    toolCalls: input.toolCalls ?? [],
    actionLog: {
      requested: input.requestedLog ?? null,
      completed: input.completedLog ?? null,
    },
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blocked: !input.ok,
      approvalBypassed: false,
    },
    caveats: input.caveats ?? [],
    status: input.status,
  };
}

async function runRetentionAudit(skill: SerializedSkill, request: SkillRunRequest) {
  const requested = await logSkillRun({
    eventType: "skill_run.requested",
    status: "requested",
    skillId: skill.id,
    skill,
    summary: "Retention audit skill run requested.",
    requestInput: request.input,
  });

  const toolName = "workflow.retentionAudit";
  const toolResult = await executeAgentToolRuntime({
    toolName,
    input: request.input,
    approval: request.approval,
  });

  if (toolResult.ok) {
    await recordSkillUsage(skill);
  }

  const completed = await logSkillRun({
    eventType: toolResult.ok ? "skill_run.completed" : "skill_run.failed",
    status: statusForToolResult(toolResult),
    skillId: skill.id,
    skill,
    summary: toolResult.ok
      ? "Retention audit skill run completed."
      : "Retention audit skill run failed safely.",
    requestInput: request.input,
    outputSummary: {
      toolName,
      ok: toolResult.ok,
      reason: toolResult.reason,
      workflowId: isRecord(toolResult.result) ? toolResult.result.workflowId : null,
    },
    errorMessage: toolResult.ok ? null : toolResult.error,
  });

  return buildRunResponse({
    ok: toolResult.ok,
    reason: toolResult.ok ? "skill_completed" : toolResult.reason ?? "tool_runtime_failed",
    skill,
    result: {
      toolResult,
      nextSuggestedSkill: toolResult.ok ? "audit_fix_run" : null,
    },
    toolCalls: [toolCallSummary(toolName, toolResult)],
    requestedLog: requested,
    completedLog: completed,
    caveats: [
      "Skill runner used Tool Runtime safety gates.",
      "No external action was attempted.",
    ],
    status: toolResult.ok ? 200 : toolResult.status,
  });
}

async function runAuditFixRun(skill: SerializedSkill, request: SkillRunRequest) {
  const requested = await logSkillRun({
    eventType: "skill_run.requested",
    status: "requested",
    skillId: skill.id,
    skill,
    summary: "Audit fix-run skill requested in safe prepare mode.",
    requestInput: request.input,
  });

  const toolName = "workflow.auditFixRun";
  const toolResult = await executeAgentToolRuntime({
    toolName,
    input: {
      ...request.input,
      mode: "safe_prepare",
    },
    approval: request.approval,
  });

  if (toolResult.ok) {
    await recordSkillUsage(skill);
  }

  const completed = await logSkillRun({
    eventType: toolResult.ok ? "skill_run.completed" : "skill_run.failed",
    status: statusForToolResult(toolResult),
    skillId: skill.id,
    skill,
    summary: toolResult.ok
      ? "Audit fix-run skill prepared a safe fix package."
      : "Audit fix-run skill failed safely.",
    requestInput: request.input,
    outputSummary: {
      toolName,
      ok: toolResult.ok,
      reason: toolResult.reason,
      workflowId: isRecord(toolResult.result) ? toolResult.result.workflowId : null,
      mode: "safe_prepare",
    },
    errorMessage: toolResult.ok ? null : toolResult.error,
  });

  return buildRunResponse({
    ok: toolResult.ok,
    reason: toolResult.ok ? "skill_completed" : toolResult.reason ?? "tool_runtime_failed",
    skill,
    result: {
      toolResult,
      nextSuggestedSkill: toolResult.ok ? "approval_review" : null,
    },
    toolCalls: [toolCallSummary(toolName, toolResult)],
    requestedLog: requested,
    completedLog: completed,
    caveats: [
      "Safe prepare-only run. Durable approval is not required for preparation.",
      "No draft, sync, schedule, send, or live mutation was attempted.",
    ],
    status: toolResult.ok ? 200 : toolResult.status,
  });
}

const SKILL_RUNNERS: Record<string, SkillRunHandler> = {
  retention_audit: runRetentionAudit,
  audit_fix_run: runAuditFixRun,
};

export type SkillListFilters = {
  status?: SkillStatus | null;
  category?: string | null;
  origin?: SkillOrigin | null;
  scope?: SkillScope | null;
  runMode?: SkillRunMode | null;
  implemented?: boolean | null;
  limit?: number | null;
};

export function parseSkillRunRequest(body: unknown): ParsedResult<SkillRunRequest> {
  const parsed = skillRunSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }

  return {
    ok: true,
    data: {
      skillId: normalizeSkillId(parsed.data.skillId),
      input: parsed.data.input,
      approval: parsed.data.approval,
    },
  };
}

export function parseSkillProposalRequest(body: unknown): ParsedResult<SkillProposalInput> {
  const parsed = proposalSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, data: parsed.data };
}

export function parseSkillTransitionRequest(body: unknown): ParsedResult<SkillTransitionInput> {
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, data: parsed.data };
}

export function parseSkillPatchRequest(body: unknown): ParsedResult<SkillPatchInput> {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, data: parsed.data };
}

export function parseSkillMatchRequest(body: unknown): ParsedResult<SkillMatchInput> {
  const parsed = matchSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, data: parsed.data };
}

export function parseSkillListFilters(url: URL): SkillListFilters {
  const status = url.searchParams.get("status");
  const origin = url.searchParams.get("origin");
  const scope = url.searchParams.get("scope");
  const runMode = url.searchParams.get("runMode");
  const implemented = url.searchParams.get("implemented");
  const limitValue = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);

  return {
    status: SKILL_STATUSES.includes(status as SkillStatus) ? (status as SkillStatus) : null,
    category: cleanString(url.searchParams.get("category"), 120),
    origin: SKILL_ORIGINS.includes(origin as SkillOrigin) ? (origin as SkillOrigin) : null,
    scope: SKILL_SCOPES.includes(scope as SkillScope) ? (scope as SkillScope) : null,
    runMode: SKILL_RUN_MODES.includes(runMode as SkillRunMode) ? (runMode as SkillRunMode) : null,
    implemented:
      implemented === "true" ? true : implemented === "false" ? false : null,
    limit: Number.isFinite(limitValue)
      ? Math.max(1, Math.min(Math.floor(limitValue), MAX_LIMIT))
      : DEFAULT_LIMIT,
  };
}

export async function listSkills(filters: SkillListFilters = {}) {
  const rows = await prisma.worklinSkill.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: Math.max(filters.limit ?? DEFAULT_LIMIT, STARTER_SKILLS.length),
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  const merged = STARTER_SKILLS.map((skill) => withRowUsage(skill, rowsById.get(skill.id) ?? null));
  for (const row of rows) {
    if (!STARTER_SKILL_IDS.has(row.id)) {
      merged.push(serializeDbSkill(row));
    }
  }

  return merged
    .filter((skill) => matchesFilters(skill, filters))
    .sort((a, b) => {
      const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (status !== 0) return status;
      const category = a.category.localeCompare(b.category);
      return category !== 0 ? category : a.name.localeCompare(b.name);
    })
    .slice(0, filters.limit ?? DEFAULT_LIMIT);
}

export async function getSkill(id: string) {
  const normalizedId = normalizeSkillId(id);
  const staticSkill = STARTER_SKILLS.find((skill) => skill.id === normalizedId);
  const row = await prisma.worklinSkill.findUnique({ where: { id: normalizedId } });

  if (staticSkill) {
    return withRowUsage(staticSkill, row);
  }

  return row ? serializeDbSkill(row) : null;
}

export async function runSkill(request: SkillRunRequest): Promise<SkillRunResponse> {
  const skill = await getSkill(request.skillId);

  if (!skill) {
    const completed = await logSkillRun({
      eventType: "skill_run.refused",
      status: "refused",
      skillId: request.skillId,
      skill: null,
      summary: "Unknown skill run was refused.",
      requestInput: request.input,
      outputSummary: {
        reason: "skill_not_found",
        safeAlternatives: ["GET /api/skills"],
      },
    });

    return buildRunResponse({
      ok: false,
      reason: "skill_not_found",
      skill: null,
      requestedLog: null,
      completedLog: completed,
      result: {
        error: "Skill was not found.",
        safeAlternatives: ["GET /api/skills"],
      },
      caveats: ["No tool call was attempted."],
      status: 404,
    });
  }

  const runner = SKILL_RUNNERS[skill.id];
  if (!skill.implemented || skill.status !== "active" || skill.runMode !== "execute" || !runner) {
    const completed = await logSkillRun({
      eventType: "skill_run.refused",
      status: "refused",
      skillId: skill.id,
      skill,
      summary: "Skill is registered but not runnable in Skill Runner v0.",
      requestInput: request.input,
      outputSummary: {
        reason: "skill_not_ready",
        status: skill.status,
        runMode: skill.runMode,
        missingCapabilities: skill.missingCapabilities,
        safeAlternatives: skill.safeAlternatives,
      },
    });

    return buildRunResponse({
      ok: false,
      reason: "skill_not_ready",
      skill,
      result: {
        error: "Skill is registered but not runnable yet.",
        runMode: skill.runMode,
        missingCapabilities: skill.missingCapabilities,
        safeAlternatives: skill.safeAlternatives,
      },
      completedLog: completed,
      caveats: ["No tool call was attempted."],
      status: 409,
    });
  }

  return runner(skill, request);
}

function proposalStatus(input: SkillProposalInput) {
  if (input.status === "blocked") return "blocked";
  if (input.status === "shadow") return "shadow";
  if (input.status === "planned") return "planned";
  if (input.status === "archived") return "draft";
  if (input.status === "active") return "draft";
  return "draft";
}

function normalizeProposal(input: SkillProposalInput) {
  const workspaceContextSuggestions = workspaceContextSuggestionsFor(input);
  const oneOffDetailsNotSavedToSkill = oneOffDetailsFor(input);
  const name = generalizeSkillName(input, workspaceContextSuggestions, oneOffDetailsNotSavedToSkill);
  const rawId = input.id ? normalizeSkillId(input.id) : generateSkillId(name);
  const id = rawId || generateSkillId(input.name);
  const missingCapabilities = asStringArray(input.missingCapabilities);
  const status: SkillStatus =
    missingCapabilities.length > 0 && input.status === "blocked" ? "blocked" : proposalStatus(input);
  const scope = normalizeProposalScope(input, workspaceContextSuggestions);
  const runMode = normalizeProposalRunMode(input, status);
  const preferredSources = normalizeSourceList(input.preferredSources);
  const fallbackSources = normalizeSourceList(input.fallbackSources);

  return {
    id,
    name,
    description: input.description.trim(),
    category: cleanString(input.category, 120) ?? "agent_proposed",
    status,
    origin: "agent_created" as const,
    scope,
    runMode,
    triggerExamples: toJson(input.triggerExamples ?? []),
    requiredInputs: toJson(input.requiredInputs ?? []),
    optionalInputs: toJson(input.optionalInputs ?? []),
    preferredSources: toJson(preferredSources),
    fallbackSources: toJson(fallbackSources),
    requiredArtifacts: toJson(input.requiredArtifacts ?? []),
    optionalArtifacts: toJson(input.optionalArtifacts ?? []),
    missingSourceBehavior: toJson(
      input.missingSourceBehavior ?? defaultMissingSourceBehavior(preferredSources, fallbackSources),
    ),
    connectorDependencies: toJson(input.connectorDependencies ?? []),
    requiredContext: toJson(input.requiredContext ?? []),
    toolsUsed: toJson(input.toolsUsed ?? []),
    procedureSteps: toJson(input.procedureSteps ?? []),
    verificationChecklist: toJson(input.verificationChecklist ?? []),
    pitfalls: toJson(input.pitfalls ?? []),
    safetyLevel: input.safetyLevel ?? "low",
    approvalRequirements: toJson(input.approvalRequirements ?? {
      requiresApproval: false,
      beforeLiveExternalAction: true,
    }),
    outputShape: toJson(input.outputShape ?? {}),
    caveats: toJson(input.caveats ?? []),
    version: cleanString(input.version, 40) ?? "0.1.0",
    createdFromWorkflowRunId: cleanString(input.createdFromWorkflowRunId, 200),
    createdFromActionLogId: cleanString(input.createdFromActionLogId, 200),
    missingCapabilities: toJson(missingCapabilities),
    workspaceContextSuggestions: toJson(workspaceContextSuggestions),
    oneOffDetailsNotSavedToSkill: toJson(oneOffDetailsNotSavedToSkill),
    metadata: toJson(
      {
        ...stripGeneralizationMetadata(input.metadata),
        proposedBy: "agent",
        implemented: false,
        safeAlternatives: [],
        generalization: {
          reusableProcedureStoredInSkill: true,
          workspaceContextSeparated: workspaceContextSuggestions.length > 0,
          oneOffDetailsExcludedFromSkill: oneOffDetailsNotSavedToSkill.length > 0,
          requestedRunMode: input.runMode ?? null,
          storedRunMode: runMode,
          sourcePreferenceRule: "source_snapshots_are_preferred_uploads_are_fallback",
        },
      },
      { dropRawKeys: true, maxArrayItems: 12, maxObjectKeys: 24, maxDepth: 4 },
    ),
  };
}

export async function proposeSkill(input: SkillProposalInput) {
  const data = normalizeProposal(input);

  if (STARTER_SKILL_IDS.has(data.id)) {
    return {
      ok: false as const,
      reason: "system_skill_conflict",
      status: 409,
      skill: null,
      actionLog: null,
      caveats: ["System skill ids cannot be overwritten by proposals."],
    };
  }

  const existing = await prisma.worklinSkill.findUnique({ where: { id: data.id } });
  const row = await prisma.worklinSkill.upsert({
    where: { id: data.id },
    create: {
      ...data,
      usageCount: 0,
    },
    update: data,
  });

  const actionLog = await logActionEvent({
    eventType: existing ? "skill_proposal.updated" : "skill_proposal.created",
    actionType: "propose_skill",
    status: data.status === "blocked" ? "skipped" : "prepared",
    actorType: "agent",
    targetType: "skill",
    targetId: row.id,
    riskLevel: row.safetyLevel,
    requiresApproval: false,
    approvalStatus: null,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: existing ? "Skill proposal updated." : "Skill proposal created.",
    inputSummary: {
      name: input.name,
      storedName: data.name,
      category: data.category,
      status: data.status,
      scope: data.scope,
      runMode: data.runMode,
      sourceWorkflowRunId: data.createdFromWorkflowRunId,
      sourceActionLogId: data.createdFromActionLogId,
    },
    outputSummary: {
      skillId: row.id,
      status: row.status,
      scope: row.scope,
      runMode: row.runMode,
      preferredSources: row.preferredSources,
      fallbackSources: row.fallbackSources,
      missingCapabilities: row.missingCapabilities,
      workspaceContextSuggestions: row.workspaceContextSuggestions,
      oneOffDetailsNotSavedToSkill: row.oneOffDetailsNotSavedToSkill,
    },
    metadata: {
      stateOnly: true,
      route: "POST /api/skills/propose",
    },
  });

  return {
    ok: true as const,
    reason: existing ? "skill_proposal_updated" : "skill_proposal_created",
    status: existing ? 200 : 201,
    skill: serializeDbSkill(row),
    generalization: {
      reusableSkillId: row.id,
      reusableSkillName: row.name,
      scope: row.scope,
      runMode: row.runMode,
      procedure: row.procedureSteps ?? [],
      preferredSources: row.preferredSources ?? [],
      fallbackSources: row.fallbackSources ?? [],
      requiredArtifacts: row.requiredArtifacts ?? [],
      optionalArtifacts: row.optionalArtifacts ?? [],
      missingSourceBehavior: row.missingSourceBehavior ?? null,
      connectorDependencies: row.connectorDependencies ?? [],
      workspaceContextSuggestions: row.workspaceContextSuggestions ?? [],
      missingCapabilities: row.missingCapabilities ?? [],
      oneOffDetailsNotSavedToSkill: row.oneOffDetailsNotSavedToSkill ?? [],
      storageRule: {
        reusableProcedure: "stored_on_skill",
        workspaceContext: "returned_as_suggestions_for_brand_brain_or_workspace_metadata",
        oneOffExecution: "kept_out_of_reusable_skill",
        missingCapability: "stored_separately_from_procedure",
      },
    },
    actionLog,
    caveats: [
      "Proposal is not auto-enabled.",
      "Live external actions remain unavailable.",
    ],
  };
}

export async function transitionSkill(id: string, input: SkillTransitionInput) {
  const skillId = normalizeSkillId(id);

  if (STARTER_SKILL_IDS.has(skillId)) {
    return {
      ok: false as const,
      reason: "system_skill_immutable",
      status: 409,
      skill: await getSkill(skillId),
      transition: null,
      actionLog: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["System skills are defined in code and cannot be transitioned through this route."],
    };
  }

  const row = await prisma.worklinSkill.findUnique({ where: { id: skillId } });
  if (!row) {
    return {
      ok: false as const,
      reason: "skill_not_found",
      status: 404,
      skill: null,
      transition: null,
      actionLog: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["No skill was changed."],
    };
  }

  const fromStatus = normalizeStatus(row.status, "draft");
  const toStatus = input.status;
  const allowed = ALLOWED_SKILL_TRANSITIONS[fromStatus].includes(toStatus);

  if (!allowed) {
    const actionLog = await logActionEvent({
      eventType: "skill_lifecycle.refused",
      actionType: "transition_skill",
      status: "refused",
      actorType: input.actor?.trim() || "api",
      targetType: "skill",
      targetId: row.id,
      riskLevel: row.safetyLevel,
      requiresApproval: false,
      approvalStatus: null,
      externalActionTaken: false,
      canGoLiveNow: false,
      summary: "Skill lifecycle transition was refused.",
      inputSummary: {
        fromStatus,
        toStatus,
        decisionNote: input.decisionNote ?? null,
      },
      outputSummary: {
        reason: "invalid_skill_transition",
        allowedTransitions: ALLOWED_SKILL_TRANSITIONS[fromStatus],
      },
      metadata: {
        stateOnly: true,
        route: "POST /api/skills/[id]/transition",
      },
    });

    return {
      ok: false as const,
      reason: "invalid_skill_transition",
      status: 409,
      skill: serializeDbSkill(row),
      transition: {
        fromStatus,
        toStatus,
        allowedTransitions: ALLOWED_SKILL_TRANSITIONS[fromStatus],
      },
      actionLog,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["No tool call was attempted."],
    };
  }

  const transitionedAt = new Date();
  const previousMetadata = isRecord(row.metadata) ? row.metadata : {};
  const updated = await prisma.worklinSkill.update({
    where: { id: row.id },
    data: {
      status: toStatus,
      metadata: toJson(
        {
          ...previousMetadata,
          lastTransition: {
            fromStatus,
            toStatus,
            decisionNote: input.decisionNote ?? null,
            actor: input.actor ?? "api",
            transitionedAt: transitionedAt.toISOString(),
          },
        },
        { dropRawKeys: true, maxArrayItems: 12, maxObjectKeys: 24, maxDepth: 4 },
      ),
    },
  });

  const actionLog = await logActionEvent({
    eventType: "skill_lifecycle.transitioned",
    actionType: "transition_skill",
    status: "completed",
    actorType: input.actor?.trim() || "api",
    targetType: "skill",
    targetId: updated.id,
    riskLevel: updated.safetyLevel,
    requiresApproval: false,
    approvalStatus: null,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: "Skill lifecycle status changed.",
    inputSummary: {
      fromStatus,
      toStatus,
      decisionNote: input.decisionNote ?? null,
    },
    outputSummary: {
      skillId: updated.id,
      status: updated.status,
      implemented: false,
      runBehavior: toStatus === "active" ? "skill_not_ready_until_runner_wired" : "not_runnable",
    },
    metadata: {
      stateOnly: true,
      route: "POST /api/skills/[id]/transition",
    },
  });

  return {
    ok: true as const,
    reason: "skill_transitioned",
    status: 200,
    skill: serializeDbSkill(updated),
    transition: {
      fromStatus,
      toStatus,
      activationDoesNotWireRunner: toStatus === "active",
    },
    actionLog,
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blocked: false,
    },
    caveats: [
      "Lifecycle transition changed registry state only.",
      "Activation does not bypass Tool Runtime or create a skill runner.",
      "Live external actions remain unavailable.",
    ],
  };
}

function patchAdditions(input: SkillPatchInput) {
  return {
    procedureSteps: asArray(input.patch.procedureStepsAdditions),
    verificationChecklist: asArray(input.patch.verificationChecklistAdditions),
    pitfalls: asArray(input.patch.pitfallsAdditions),
    triggerExamples: asArray(input.patch.triggerExamplesAdditions),
    caveats: asArray(input.patch.caveatsAdditions),
    requiredContext: asArray(input.patch.requiredContextAdditions),
    preferredSources: normalizeSourceList(input.patch.preferredSourcesAdditions),
    fallbackSources: normalizeSourceList(input.patch.fallbackSourcesAdditions),
    requiredArtifacts: asArray(input.patch.requiredArtifactsAdditions),
    optionalArtifacts: asArray(input.patch.optionalArtifactsAdditions),
    connectorDependencies: asArray(input.patch.connectorDependenciesAdditions),
    missingSourceBehavior: input.patch.missingSourceBehavior === undefined
      ? []
      : [input.patch.missingSourceBehavior],
    workspaceContextSuggestions: asArray(input.patch.workspaceContextSuggestionsAdditions),
    missingCapabilities: asArray(input.patch.missingCapabilitiesAdditions),
  };
}

function hasPatchAdditions(additions: ReturnType<typeof patchAdditions>) {
  return Object.values(additions).some((items) => items.length > 0);
}

export async function patchSkill(id: string, input: SkillPatchInput) {
  const skillId = normalizeSkillId(id);

  if (STARTER_SKILL_IDS.has(skillId)) {
    return {
      ok: false as const,
      reason: "system_skill_immutable",
      status: 409,
      skill: await getSkill(skillId),
      actionLog: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["System skills cannot be patched through this route; update code-reviewed registry definitions instead."],
    };
  }

  const row = await prisma.worklinSkill.findUnique({ where: { id: skillId } });
  if (!row) {
    return {
      ok: false as const,
      reason: "skill_not_found",
      status: 404,
      skill: null,
      actionLog: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["No skill was changed."],
    };
  }

  const additions = patchAdditions(input);
  if (!hasPatchAdditions(additions)) {
    return {
      ok: false as const,
      reason: "empty_skill_patch",
      status: 400,
      skill: serializeDbSkill(row),
      actionLog: null,
      safety: {
        externalActionTaken: false,
        canGoLiveNow: false,
        blocked: true,
      },
      caveats: ["Patch did not include any supported additions."],
    };
  }

  const previousMetadata = isRecord(row.metadata) ? row.metadata : {};
  const patchedAt = new Date();
  const updated = await prisma.worklinSkill.update({
    where: { id: row.id },
    data: {
      procedureSteps: toJson(uniqueArray(row.procedureSteps, additions.procedureSteps)),
      verificationChecklist: toJson(uniqueArray(row.verificationChecklist, additions.verificationChecklist)),
      pitfalls: toJson(uniqueArray(row.pitfalls, additions.pitfalls)),
      triggerExamples: toJson(uniqueArray(row.triggerExamples, additions.triggerExamples)),
      caveats: toJson(uniqueArray(row.caveats, additions.caveats)),
      requiredContext: toJson(uniqueArray(row.requiredContext, additions.requiredContext)),
      preferredSources: toJson(uniqueArray(row.preferredSources, additions.preferredSources)),
      fallbackSources: toJson(uniqueArray(row.fallbackSources, additions.fallbackSources)),
      requiredArtifacts: toJson(uniqueArray(row.requiredArtifacts, additions.requiredArtifacts)),
      optionalArtifacts: toJson(uniqueArray(row.optionalArtifacts, additions.optionalArtifacts)),
      connectorDependencies: toJson(uniqueArray(row.connectorDependencies, additions.connectorDependencies)),
      ...(additions.missingSourceBehavior.length
        ? { missingSourceBehavior: toJson(additions.missingSourceBehavior[0]) }
        : {}),
      workspaceContextSuggestions: toJson(
        uniqueArray(row.workspaceContextSuggestions, additions.workspaceContextSuggestions),
      ),
      missingCapabilities: toJson(uniqueArray(row.missingCapabilities, additions.missingCapabilities)),
      metadata: toJson(
        {
          ...previousMetadata,
          lastPatch: {
            reason: input.reason,
            actor: input.actor ?? "api",
            patchedAt: patchedAt.toISOString(),
            changedFields: Object.entries(additions)
              .filter(([, items]) => items.length > 0)
              .map(([field]) => field),
          },
        },
        { dropRawKeys: true, maxArrayItems: 12, maxObjectKeys: 24, maxDepth: 4 },
      ),
    },
  });

  const actionLog = await logActionEvent({
    eventType: "skill_patch.applied",
    actionType: "patch_skill",
    status: "completed",
    actorType: input.actor?.trim() || "api",
    targetType: "skill",
    targetId: updated.id,
    riskLevel: updated.safetyLevel,
    requiresApproval: false,
    approvalStatus: null,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: "Skill patch applied safely.",
    inputSummary: {
      reason: input.reason,
      changedFields: Object.entries(additions)
        .filter(([, items]) => items.length > 0)
        .map(([field]) => field),
    },
    outputSummary: {
      skillId: updated.id,
      status: updated.status,
      runMode: updated.runMode,
      implemented: false,
      runBehavior: "patch_does_not_wire_runner",
    },
    metadata: {
      stateOnly: true,
      route: "POST /api/skills/[id]/patch",
    },
  });

  return {
    ok: true as const,
    reason: "skill_patch_applied",
    status: 200,
    skill: serializeDbSkill(updated),
    patch: {
      changedFields: Object.entries(additions)
        .filter(([, items]) => items.length > 0)
        .map(([field]) => field),
      executionChanged: false,
    },
    actionLog,
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blocked: false,
    },
    caveats: [
      "Patch appended to supported procedure fields only.",
      "Patch did not enable execution or bypass Tool Runtime.",
    ],
  };
}

const DIRECT_MATCH_RULES: Array<{
  skillId: string;
  terms: RegExp[];
  fileTerms?: RegExp[];
  reason: string;
  missingInputs: string[];
}> = [
  {
    skillId: "email_design_review",
    terms: [/\b(email\s+design|figma|canva|design\s+review|design\s+qa|approval\s+readiness)\b/i],
    fileTerms: [/\.(png|jpe?g|webp)$/i],
    reason: "User appears to be asking for email design review from source designs or screenshots.",
    missingInputs: ["campaign goal", "target audience"],
  },
  {
    skillId: "email_slice_review",
    terms: [/\b(email|design|slice|screenshot|mobile|approval|approve|qa|review)\b/i],
    fileTerms: [/\.(png|jpe?g|webp)$/i],
    reason: "User appears to be asking for email design slice review before approval.",
    missingInputs: ["campaign goal", "target audience"],
  },
  {
    skillId: "lead_magnet_analysis",
    terms: [
      /\blead\s*magnet\b/i,
      /\bfreebie\b/i,
      /\bopt[-\s]?in\b/i,
      /\bquiz\b/i,
      /\bguide\b/i,
      /\bacquisition\s+cohort\b/i,
      /\blead\s+source\b/i,
    ],
    reason: "User explicitly appears to be asking for optional lead magnet or acquisition cohort analysis.",
    missingInputs: ["timeframe", "lead magnet names"],
  },
  {
    skillId: "performance_reporting",
    terms: [/\b(performance|results?|csv|orders?|revenue|rpr|buyer\s+rate|matched\s+orders?|cohort|reporting)\b/i],
    fileTerms: [/\.(csv|xlsx?|tsv)$/i],
    reason: "User appears to be asking for performance reporting or export-backed analysis.",
    missingInputs: ["reporting window", "source metrics or export files"],
  },
  {
    skillId: "weekly_retention_reporting",
    terms: [/\b(weekly|week|l7|l30|report|slack|summary|retention\s+read|update)\b/i],
    reason: "User appears to be asking for a weekly retention reporting workflow.",
    missingInputs: ["reporting week", "audience for the report"],
  },
  {
    skillId: "campaign_copy_qa",
    terms: [/\b(copy|subject|preview|cta|campaign|email|claims?|on[-\s]?brand|tone|qa)\b/i],
    reason: "User appears to be asking for campaign copy QA.",
    missingInputs: ["campaign goal", "offer details"],
  },
  {
    skillId: "campaign_copywriting",
    terms: [/\b(write|draft|compose|copywriting|subject\s+lines?|preview\s+text|campaign\s+copy)\b/i],
    reason: "User appears to be asking for retention campaign copywriting.",
    missingInputs: ["campaign brief", "product focus", "offer details"],
  },
  {
    skillId: "campaign_calendar_builder",
    terms: [/\b(calendar|campaign\s+plan|monthly|next\s+month|send\s+dates?|content\s+plan)\b/i],
    reason: "User appears to be asking for campaign calendar planning.",
    missingInputs: ["date range", "send cadence"],
  },
  {
    skillId: "product_campaign_strategy",
    terms: [/\b(product\s+campaign|campaign\s+angle|merchandising|product\s+focus|launch\s+angle)\b/i],
    reason: "User appears to be asking for product-led campaign strategy.",
    missingInputs: ["product focus", "campaign window"],
  },
  {
    skillId: "post_purchase_lifecycle_optimization",
    terms: [/\b(post[-\s]?purchase|second\s+purchase|replenishment|cross[-\s]?sell|after\s+purchase)\b/i],
    reason: "User appears to be asking for post-purchase lifecycle optimization.",
    missingInputs: ["post-purchase goal", "product or category focus"],
  },
];

function skillText(skill: SerializedSkill) {
  return [
    skill.id,
    skill.name,
    skill.description,
    skill.category,
    ...asStringArray(skill.triggerExamples),
    ...asStringArray(skill.requiredContext),
    ...asStringArray(skill.toolsUsed),
  ].join(" ").toLowerCase();
}

function scoreSkill(skill: SerializedSkill, input: SkillMatchInput) {
  const message = input.message.toLowerCase();
  const files = input.availableFiles ?? [];
  const directRule = DIRECT_MATCH_RULES.find((rule) => rule.skillId === skill.id);
  let score = 0;
  const evidence: string[] = [];

  if (directRule) {
    const termHits = directRule.terms.filter((term) => term.test(message)).length;
    const fileHits = (directRule.fileTerms ?? []).filter((term) => files.some((file) => term.test(file))).length;
    score += termHits * 35 + fileHits * 25;
    if (termHits) evidence.push(directRule.reason);
    if (fileHits) evidence.push("Available files match this skill's expected artifact type.");
  }

  const haystack = skillText(skill);
  for (const token of message.split(/[^a-z0-9]+/i).filter((token) => token.length >= 4)) {
    if (haystack.includes(token)) score += 4;
  }

  return { score, evidence };
}

function confidenceFromScore(score: number) {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  if (score > 0) return "low";
  return "none";
}

export async function matchSkill(input: SkillMatchInput) {
  const skills = await listSkills({ limit: MAX_LIMIT });
  const ranked = skills
    .map((skill) => {
      const { score, evidence } = scoreSkill(skill, input);
      const rule = DIRECT_MATCH_RULES.find((item) => item.skillId === skill.id);
      return {
        skill,
        score,
        confidence: confidenceFromScore(score),
        reason: evidence[0] ?? "Matched by skill metadata and trigger examples.",
        missingInputs: rule?.missingInputs ?? [],
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] ?? null;
  const actionLog = await logActionEvent({
    eventType: "skill_match.completed",
    actionType: "match_skill",
    status: "completed",
    actorType: "api",
    targetType: top ? "skill" : "skill-match",
    targetId: top?.skill.id ?? null,
    riskLevel: "low",
    requiresApproval: false,
    approvalStatus: null,
    externalActionTaken: false,
    canGoLiveNow: false,
    summary: top ? "Skill match completed." : "No skill match found.",
    inputSummary: {
      messageLength: input.message.length,
      availableFiles: input.availableFiles ?? [],
      workspaceId: input.workspaceId ?? null,
    },
    outputSummary: {
      matchedSkillId: top?.skill.id ?? null,
      confidence: top?.confidence ?? "none",
      status: top?.skill.status ?? null,
      runMode: top?.skill.runMode ?? null,
      topMatches: ranked.slice(0, 5).map((item) => ({
        skillId: item.skill.id,
        score: item.score,
        confidence: item.confidence,
      })),
    },
    metadata: {
      stateOnly: true,
      route: "POST /api/skills/match",
    },
  });

  return {
    ok: true as const,
    matchedSkillId: top?.skill.id ?? null,
    matchedSkill: top ? skillSummary(top.skill) : null,
    confidence: top?.confidence ?? "none",
    reason: top?.reason ?? "No registered skill matched this request strongly enough.",
    missingInputs: top?.missingInputs ?? [],
    status: top?.skill.status ?? null,
    runMode: top?.skill.runMode ?? null,
    implemented: top?.skill.implemented ?? false,
    matches: ranked.slice(0, 5).map((item) => ({
      skillId: item.skill.id,
      name: item.skill.name,
      status: item.skill.status,
      runMode: item.skill.runMode,
      confidence: item.confidence,
      score: item.score,
      reason: item.reason,
      missingInputs: item.missingInputs,
    })),
    actionLog,
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blocked: false,
    },
    caveats: [
      "Deterministic v0 matcher only; future agent intent can use this as a candidate selector.",
      "Matching a skill does not execute it.",
    ],
  };
}

export function skillNotFoundResponse(id: string) {
  return {
    ok: false,
    reason: "skill_not_found",
    error: "Skill was not found.",
    id: normalizeSkillId(id),
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blocked: true,
    },
    safeAlternatives: ["GET /api/skills"],
  };
}

export function summarizeSkills(skills: SerializedSkill[]) {
  return skills.map(skillSummary);
}
