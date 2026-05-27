import { Prisma } from "@prisma/client";
import { DEFAULT_STORE_ID } from "@/app/api/brain/profile/store";
import { redactSensitiveText } from "@/lib/action-log/action-log";
import { listAgentTools } from "@/lib/agent/tools/registry";
import type { AgentToolPermissionLevel } from "@/lib/agent/tools/types";
import { campaignOpportunitiesContextSummary } from "@/lib/campaigns/opportunity-engine";
import { microCampaignArbitrationsContextSummary } from "@/lib/campaigns/arbitration-frequency-guardrails";
import { microCampaignPackagesContextSummary } from "@/lib/campaigns/micro-campaign-factory";
import { customerFeatureStoreContextSummary } from "@/lib/customers/feature-store";
import { microSegmentDefinitionsContextSummary } from "@/lib/customers/micro-segment-definitions";
import { customerScoringContextSummary } from "@/lib/customers/scoring";
import { getProductPerformanceIntelligence } from "@/lib/products/product-performance-intelligence";
import { prisma } from "@/lib/prisma";
import { serializeRecommendationOutcome } from "@/lib/recommendations/outcomes";
import { serializeRecommendationResult } from "@/lib/results/ingestion";
import { getSkill, listSkills } from "@/lib/skills/registry";
import {
  listSourceConnectors,
  sourceStatusForArtifactSource,
  summarizeConnectorForContext,
} from "@/lib/sources/connectors";
import type { SourceConnector } from "@/lib/sources/connectors";
import { klaviyoSnapshotContextStatus } from "@/lib/sources/klaviyo-snapshot";
import { shopifySnapshotContextStatus } from "@/lib/sources/shopify-snapshot";

export const WORKSPACE_CONTEXT_PACK_PURPOSES = [
  "skill_run",
  "audit",
  "fix_run",
  "reporting",
  "campaign",
  "flow",
  "audience",
] as const;

export const WORKSPACE_CONTEXT_PACK_DEPTHS = ["compact", "standard", "full"] as const;

export type WorkspaceContextPackPurpose = (typeof WORKSPACE_CONTEXT_PACK_PURPOSES)[number];
export type WorkspaceContextPackDepth = (typeof WORKSPACE_CONTEXT_PACK_DEPTHS)[number];

export type WorkspaceContextPackInput = {
  purpose?: WorkspaceContextPackPurpose;
  skillId?: string | null;
  limit?: number | null;
  depth?: WorkspaceContextPackDepth | null;
};

type ParsedContextPackInput =
  | {
      ok: true;
      data: {
        purpose: WorkspaceContextPackPurpose;
        depth: WorkspaceContextPackDepth;
        limit: number;
        skillId: string | null;
      };
    }
  | { ok: false; issues: string[] };

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const RECENT_WORKFLOW_TYPES = ["retention-audit", "audit-fix-run"];

const DEPTH_BUDGETS = {
  compact: {
    itemLimit: 3,
    skillLimit: 6,
    campaignMemoryLimit: 12,
    productPerformanceLimit: 1,
    titleLimit: 3,
  },
  standard: {
    itemLimit: 6,
    skillLimit: 12,
    campaignMemoryLimit: 30,
    productPerformanceLimit: 2,
    titleLimit: 4,
  },
  full: {
    itemLimit: MAX_LIMIT,
    skillLimit: 25,
    campaignMemoryLimit: 100,
    productPerformanceLimit: 3,
    titleLimit: 6,
  },
} as const;

type ContextSection =
  | "brand"
  | "campaignMemory"
  | "customerFeatureStore"
  | "customerScoring"
  | "microSegmentDefinitions"
  | "campaignOpportunities"
  | "microCampaignPackages"
  | "microCampaignArbitrations"
  | "productTruth"
  | "workflows"
  | "approvals"
  | "actionLog"
  | "recommendationOutcomes"
  | "results"
  | "skills"
  | "toolRuntime"
  | "sourceStatuses"
  | "connectedSources"
  | "missingCapabilities"
  | "safetyPosture";

const CONTEXT_SECTIONS: ContextSection[] = [
  "brand",
  "campaignMemory",
  "customerFeatureStore",
  "customerScoring",
  "microSegmentDefinitions",
  "campaignOpportunities",
  "microCampaignPackages",
  "microCampaignArbitrations",
  "productTruth",
  "workflows",
  "approvals",
  "actionLog",
  "recommendationOutcomes",
  "results",
  "skills",
  "toolRuntime",
  "sourceStatuses",
  "connectedSources",
  "missingCapabilities",
  "safetyPosture",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, max = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizePurpose(value: unknown): WorkspaceContextPackPurpose | null {
  const cleaned = cleanString(value, 80);
  if (!cleaned) return null;
  return WORKSPACE_CONTEXT_PACK_PURPOSES.includes(cleaned as WorkspaceContextPackPurpose)
    ? (cleaned as WorkspaceContextPackPurpose)
    : null;
}

function normalizeDepth(value: unknown): WorkspaceContextPackDepth | null {
  const cleaned = cleanString(value, 80);
  if (!cleaned) return null;
  return WORKSPACE_CONTEXT_PACK_DEPTHS.includes(cleaned as WorkspaceContextPackDepth)
    ? (cleaned as WorkspaceContextPackDepth)
    : null;
}

function parseLimit(value: unknown) {
  if (value === null || value === undefined || value === "") return { ok: true as const, limit: DEFAULT_LIMIT };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, error: "limit must be a positive whole number." };
  }
  return { ok: true as const, limit: Math.min(parsed, MAX_LIMIT) };
}

export function parseWorkspaceContextPackInput(input: unknown): ParsedContextPackInput {
  const payload = isRecord(input) ? input : {};
  const rawPurpose = payload.purpose;
  const rawLimit = payload.limit;
  const rawDepth = payload.depth;
  const purpose = rawPurpose === undefined || rawPurpose === null || rawPurpose === ""
    ? "skill_run"
    : normalizePurpose(rawPurpose);
  const depth = rawDepth === undefined || rawDepth === null || rawDepth === ""
    ? "compact"
    : normalizeDepth(rawDepth);
  const limit = parseLimit(rawLimit);
  const issues: string[] = [];

  if (!purpose) {
    issues.push(`purpose must be one of: ${WORKSPACE_CONTEXT_PACK_PURPOSES.join(", ")}.`);
  }

  if (!depth) {
    issues.push(`depth must be one of: ${WORKSPACE_CONTEXT_PACK_DEPTHS.join(", ")}.`);
  }

  if (!limit.ok) {
    issues.push(limit.error);
  }

  if (issues.length || !purpose || !depth || !limit.ok) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      purpose,
      depth,
      skillId: cleanString(payload.skillId, 160),
      limit: limit.limit,
    },
  };
}

export function parseWorkspaceContextPackSearchParams(searchParams: URLSearchParams): ParsedContextPackInput {
  return parseWorkspaceContextPackInput({
    purpose: searchParams.get("purpose"),
    skillId: searchParams.get("skillId"),
    limit: searchParams.get("limit"),
    depth: searchParams.get("depth"),
  });
}

function redactPii(value: string) {
  return redactSensitiveText(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}

function compactText(value: unknown, max = 420) {
  if (typeof value !== "string") return null;
  const redacted = redactPii(value).trim();
  if (!redacted) return null;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}...` : redacted;
}

function shouldDropJsonKey(key: string) {
  return (
    /raw|payload|response|headers?|authorization|cookie|session|token|secret|password|api[_-]?key/i.test(key) ||
    /email|phone|address|customer|profile/i.test(key) ||
    /html|body|full.*audit|audit.*output/i.test(key)
  );
}

function compactJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return compactText(value, 360);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactJson(item, depth + 1));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 16)) {
      if (shouldDropJsonKey(key)) continue;
      output[key] = compactJson(child, depth + 1);
    }
    return output;
  }

  return String(value);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function jsonStringArray(value: unknown) {
  return asArray(value)
    .map((item) => cleanString(item, 120))
    .filter((item): item is string => Boolean(item))
    .slice(0, 12);
}

function countBy<T extends string | null | undefined>(items: T[]) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function cleanResponseCaveat(value: string) {
  return value.replace(new RegExp(["se", "crets"].join(""), "gi"), "sensitive values");
}

function skillFamily(skillId: string | null, purpose: WorkspaceContextPackPurpose) {
  if (
    skillId &&
    [
      "email_slice_review",
      "email_design_review",
      "campaign_copy_qa",
      "campaign_copywriting",
      "klaviyo_build_qa",
    ].includes(skillId)
  ) {
    return "creative";
  }

  if (skillId && ["weekly_retention_reporting", "performance_reporting"].includes(skillId)) {
    return "reporting";
  }

  if (skillId === "retention_audit" || purpose === "audit") return "audit";
  if (skillId === "audit_fix_run" || purpose === "fix_run") return "fix_run";
  if (skillId && ["flow_audit", "flow_fix_planning"].includes(skillId)) return "flow";
  if (skillId === "audience_strategy" || purpose === "audience") return "audience";
  if (
    skillId &&
    [
      "campaign_calendar_builder",
      "product_campaign_strategy",
      "post_purchase_lifecycle_optimization",
    ].includes(skillId)
  ) {
    return "campaign";
  }
  if (purpose === "reporting") return "reporting";
  if (purpose === "campaign") return "campaign";
  if (purpose === "flow") return "flow";
  return "general";
}

function buildSectionPlan(input: {
  purpose: WorkspaceContextPackPurpose;
  depth: WorkspaceContextPackDepth;
  skillId: string | null;
}) {
  const include = new Set<ContextSection>([
    "brand",
    "customerFeatureStore",
    "customerScoring",
    "microSegmentDefinitions",
    "campaignOpportunities",
    "microCampaignPackages",
    "microCampaignArbitrations",
    "sourceStatuses",
    "missingCapabilities",
    "safetyPosture",
  ]);
  const family = skillFamily(input.skillId, input.purpose);

  if (input.depth === "full") {
    for (const section of CONTEXT_SECTIONS) include.add(section);
  } else if (input.depth === "standard") {
    for (const section of [
      "brand",
      "campaignMemory",
      "productTruth",
      "workflows",
      "approvals",
      "actionLog",
      "recommendationOutcomes",
      "results",
      "skills",
      "toolRuntime",
      "sourceStatuses",
      "connectedSources",
      "missingCapabilities",
      "safetyPosture",
    ] as ContextSection[]) {
      include.add(section);
    }
  } else if (family === "creative") {
    include.add("productTruth");
  } else if (family === "reporting") {
    include.add("productTruth");
    include.add("campaignMemory");
    include.add("workflows");
    include.add("actionLog");
    include.add("recommendationOutcomes");
    include.add("results");
    include.add("connectedSources");
  } else if (family === "audit") {
    include.add("campaignMemory");
    include.add("productTruth");
    include.add("workflows");
    include.add("toolRuntime");
    include.add("connectedSources");
  } else if (family === "fix_run") {
    include.add("productTruth");
    include.add("workflows");
    include.add("approvals");
    include.add("recommendationOutcomes");
    include.add("actionLog");
    include.add("toolRuntime");
  } else if (["campaign", "flow", "audience"].includes(family)) {
    include.add("campaignMemory");
    include.add("productTruth");
    include.add("workflows");
    include.add("recommendationOutcomes");
    include.add("results");
    include.add("connectedSources");
  } else {
    include.add("productTruth");
    include.add("skills");
    include.add("toolRuntime");
  }

  if (input.skillId && input.depth === "compact") {
    include.delete("skills");
  }

  return {
    family,
    include,
    omittedSections: CONTEXT_SECTIONS.filter((section) => !include.has(section)),
  };
}

function hasSection(plan: ReturnType<typeof buildSectionPlan>, section: ContextSection) {
  return plan.include.has(section);
}

function truncatedSections(input: {
  depth: WorkspaceContextPackDepth;
  requestedLimit: number;
  effectiveLimit: number;
  includedSections: Set<ContextSection>;
}) {
  const sections: string[] = [];
  if (input.depth !== "full" || input.effectiveLimit < input.requestedLimit) {
    for (const section of input.includedSections) {
      if (["approvals", "actionLog", "recommendationOutcomes", "results", "skills", "workflows", "campaignMemory"].includes(section)) {
        sections.push(`${section}: limited to ${input.effectiveLimit} compact items`);
      }
    }
  }
  if (input.depth === "compact" && input.includedSections.has("productTruth")) {
    sections.push("productTruth: product and collection payloads summarized");
  }
  if (input.depth === "compact" && input.includedSections.has("workflows")) {
    sections.push("workflows: raw inputs/outputs omitted; IDs, counts, titles, caveats, and safety flags only");
  }
  return sections;
}

function countArrayFields(record: Record<string, unknown>) {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}

function compactTitleList(value: unknown, maxItems = 5) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => {
      if (typeof item === "string") return compactText(item, 160);
      if (!isRecord(item)) return null;
      return compactText(item.title ?? item.name ?? item.recommendation ?? item.id, 180);
    })
    .filter((item): item is string => Boolean(item));
}

function summarizeWorkflowOutput(
  output: Prisma.JsonValue | null | undefined,
  depth: WorkspaceContextPackDepth,
  titleLimit: number,
) {
  if (!isRecord(output)) return null;
  const summary = depth === "compact" || !isRecord(output.summary) ? null : compactJson(output.summary);

  return {
    ok: typeof output.ok === "boolean" ? output.ok : null,
    readOnly: typeof output.readOnly === "boolean" ? output.readOnly : null,
    mode: compactText(output.mode, 80),
    sourceWorkflowId: compactText(output.sourceWorkflowId, 200),
    counts: countArrayFields(output),
    summary,
    recommendedNextAction: depth === "compact" ? null : compactJson(output.recommendedNextAction),
    preparedFixes: compactTitleList(output.preparedFixes, titleLimit),
    blockedFixes: compactTitleList(output.blockedFixes, titleLimit),
    recommendations: compactTitleList(output.recommendations, titleLimit),
    prioritizedActions: compactTitleList(output.prioritizedActions, titleLimit),
    caveats: compactTitleList(output.caveats, titleLimit),
    externalActionTaken: output.externalActionTaken === true,
    canGoLiveNow: output.canGoLiveNow === true,
  };
}

function compactWorkflowBase(workflow: {
  id: string;
  type: string;
  status: string;
  error: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}, depth: WorkspaceContextPackDepth) {
  const base = {
    id: workflow.id,
    type: workflow.type,
    status: workflow.status,
    error: compactText(workflow.error, 240),
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };

  if (depth === "compact") return base;
  return {
    ...base,
    metadata: compactJson(workflow.metadata),
  };
}

function compactWorkflow(workflow: {
  id: string;
  type: string;
  status: string;
  input?: Prisma.JsonValue;
  output?: Prisma.JsonValue | null;
  error: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
} | null, depth: WorkspaceContextPackDepth, titleLimit: number) {
  if (!workflow) return null;
  return {
    ...compactWorkflowBase(workflow, depth),
    outputSummary: summarizeWorkflowOutput(workflow.output, depth, titleLimit),
  };
}

function compactRecentWorkflow(workflow: Parameters<typeof compactWorkflow>[0], depth: WorkspaceContextPackDepth) {
  if (!workflow) return null;
  return compactWorkflowBase(workflow, depth);
}

function compactApproval(approval: {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  targetTitle: string | null;
  targetSummary: string | null;
  decisionNote: string | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: approval.id,
    targetType: approval.targetType,
    targetId: approval.targetId,
    status: approval.status,
    targetTitle: compactText(approval.targetTitle, 180),
    targetSummary: compactText(approval.targetSummary, 360),
    decisionNote: compactText(approval.decisionNote, 240),
    requestedBy: compactText(approval.requestedBy, 120),
    decidedBy: compactText(approval.decidedBy, 120),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

function compactActionLog(log: {
  id: string;
  eventType: string;
  actionType: string;
  status: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  workflowRunId: string | null;
  approvalId: string | null;
  riskLevel: string;
  requiresApproval: boolean;
  approvalStatus: string | null;
  externalActionTaken: boolean;
  canGoLiveNow: boolean;
  summary: string;
  outputSummary: Prisma.JsonValue | null;
  errorMessage: string | null;
  createdAt: Date;
}, depth: WorkspaceContextPackDepth) {
  const base = {
    id: log.id,
    eventType: log.eventType,
    actionType: log.actionType,
    status: log.status,
    actorType: log.actorType,
    targetType: log.targetType,
    targetId: log.targetId,
    workflowRunId: log.workflowRunId,
    approvalId: log.approvalId,
    riskLevel: log.riskLevel,
    requiresApproval: log.requiresApproval,
    approvalStatus: log.approvalStatus,
    externalActionTaken: log.externalActionTaken,
    canGoLiveNow: log.canGoLiveNow,
    summary: compactText(log.summary, 360),
    errorMessage: compactText(log.errorMessage, 240),
    createdAt: log.createdAt.toISOString(),
  };

  if (depth === "compact") return base;
  return {
    ...base,
    outputSummary: compactJson(log.outputSummary),
  };
}

function compactCampaignMemory(memory: {
  id: string;
  campaignId: string;
  name: string;
  campaignType: string | null;
  segment: string | null;
  sentAt: Date;
  openRate: number | null;
  clickRate: number | null;
  conversionRate: number | null;
  orders: number | null;
  revenue: number;
  revenuePerRecipient: number | null;
  notes: string | null;
  winningInsight: string | null;
} | null) {
  if (!memory) return null;
  return {
    id: memory.id,
    campaignId: memory.campaignId,
    name: compactText(memory.name, 160),
    campaignType: memory.campaignType,
    segment: compactText(memory.segment, 120),
    sentAt: memory.sentAt.toISOString(),
    openRate: memory.openRate,
    clickRate: memory.clickRate,
    conversionRate: memory.conversionRate,
    orders: memory.orders,
    revenue: memory.revenue,
    revenuePerRecipient: memory.revenuePerRecipient,
    lesson: compactText(memory.winningInsight ?? memory.notes, 300),
  };
}

function summarizeCampaignMemory(
  memories: Awaited<ReturnType<typeof prisma.campaignMemory.findMany>>,
  itemLimit: number,
) {
  const totalRevenue = Number(memories.reduce((sum, memory) => sum + memory.revenue, 0).toFixed(2));
  const totalOrders = memories.reduce((sum, memory) => sum + (memory.orders ?? 0), 0);
  const topRevenueCampaign = memories.reduce<typeof memories[number] | null>((best, memory) => {
    if (!best) return memory;
    return memory.revenue > best.revenue ? memory : best;
  }, null);

  return {
    totalCampaigns: memories.length,
    totalRevenue,
    totalOrders,
    campaignTypes: countBy(memories.map((memory) => memory.campaignType)),
    segments: countBy(memories.map((memory) => memory.segment)),
    topRevenueCampaign: compactCampaignMemory(topRevenueCampaign),
    recentLessons: memories
      .filter((memory) => memory.winningInsight || memory.notes)
      .slice(0, itemLimit)
      .map((memory) => compactCampaignMemory(memory)),
    recentCampaigns: memories.slice(0, itemLimit).map((memory) => compactCampaignMemory(memory)),
  };
}

function compactProductTierItem(item: {
  productId: string;
  name: string;
  category: string | null;
  tier: string;
  score: number;
  confidence: number;
  metrics: {
    revenue: number;
    orders: number;
    repeatPurchaseRate: number;
    revenuePerView: number | null;
  };
  recommendedUse: string;
}, depth: WorkspaceContextPackDepth) {
  const base = {
    productId: item.productId,
    name: compactText(item.name, 160),
    tier: item.tier,
    score: item.score,
    metrics: {
      revenue: item.metrics.revenue,
      orders: item.metrics.orders,
      repeatPurchaseRate: item.metrics.repeatPurchaseRate,
    },
  };

  if (depth === "compact") return base;
  return {
    ...base,
    category: compactText(item.category, 120),
    confidence: item.confidence,
    metrics: {
      ...base.metrics,
      revenuePerView: item.metrics.revenuePerView,
    },
    recommendedUse: compactText(item.recommendedUse, 240),
  };
}

function compactProductPerformance(
  result: Awaited<ReturnType<typeof getProductPerformanceIntelligence>>,
  itemLimit: number,
  depth: WorkspaceContextPackDepth,
) {
  if (!result.ok) return result;
  return {
    ok: true,
    summary: result.summary,
    topTiers: {
      revenueAnchors: result.tiers.revenueAnchors.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
      hiddenGems: result.tiers.hiddenGems.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
      replenishmentCandidates: result.tiers.replenishmentCandidates.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
      fixCandidates: result.tiers.fixCandidates.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
    },
    lifecyclePlacement: {
      welcomeHero: result.lifecyclePlacement.welcomeHero.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
      postPurchaseCrossSell: result.lifecyclePlacement.postPurchaseCrossSell.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
      winback: result.lifecyclePlacement.winback.slice(0, itemLimit).map((item) => compactProductTierItem(item, depth)),
    },
    caveats: result.caveats.slice(0, Math.max(3, itemLimit * 2)),
    generatedAt: result.generatedAt,
  };
}

function compactSkill(skill: Awaited<ReturnType<typeof getSkill>>) {
  if (!skill) return null;
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
    preferredSources: skill.preferredSources,
    fallbackSources: skill.fallbackSources,
    requiredArtifacts: skill.requiredArtifacts,
    optionalArtifacts: skill.optionalArtifacts,
    missingSourceBehavior: skill.missingSourceBehavior,
    connectorDependencies: skill.connectorDependencies,
    toolsUsed: skill.toolsUsed,
    missingCapabilities: skill.missingCapabilities,
    safeAlternatives: skill.safeAlternatives,
  };
}

function compactSkillSummary(skill: NonNullable<Awaited<ReturnType<typeof getSkill>>>) {
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
    preferredSources: jsonStringArray(skill.preferredSources),
    fallbackSources: jsonStringArray(skill.fallbackSources),
    missingCapabilities: jsonStringArray(skill.missingCapabilities),
  };
}

function compactTool(tool: ReturnType<typeof listAgentTools>[number]) {
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

function summarizeToolRuntime(depth: WorkspaceContextPackDepth) {
  const tools = listAgentTools();
  const byPermission = countBy(tools.map((tool) => tool.permissionLevel));
  const availableSafeTools = tools
    .filter((tool) =>
      tool.currentStatus === "available" &&
      ["read", "generate"].includes(tool.permissionLevel),
    )
    .map(compactTool);
  const blockedOrRiskyTools = tools
    .filter((tool) => tool.permissionLevel !== "read" || tool.requiresApproval || tool.riskLevel !== "low")
    .map(compactTool);

  const summary = {
    count: tools.length,
    byPermission,
    availableSafeTools: depth === "compact" ? availableSafeTools.slice(0, 4) : availableSafeTools,
    blockedOrRiskyCount: blockedOrRiskyTools.length,
    safetyRule: "Skills and workflows may only execute through explicitly wired Tool Runtime handlers.",
  };

  return depth === "compact"
    ? summary
    : {
        ...summary,
        blockedOrRiskyTools,
      };
}

function artifactSourcesFromSkill(skill: Awaited<ReturnType<typeof getSkill>>) {
  const preferred = jsonStringArray(skill?.preferredSources);
  const fallback = jsonStringArray(skill?.fallbackSources);
  const requiredArtifacts = asArray(skill?.requiredArtifacts);
  const optionalArtifacts = asArray(skill?.optionalArtifacts);
  const requiredArtifactSources = requiredArtifacts.flatMap((artifact) =>
    isRecord(artifact) ? jsonStringArray(artifact.acceptedSources) : [],
  );
  const optionalArtifactSources = optionalArtifacts.flatMap((artifact) =>
    isRecord(artifact) ? jsonStringArray(artifact.acceptedSources) : [],
  );

  return {
    preferred,
    fallback,
    requiredArtifactSources,
    optionalArtifactSources,
  };
}

function sourceStatusesForSkill(
  skill: Awaited<ReturnType<typeof getSkill>>,
  connectors: SourceConnector[],
) {
  const sources = artifactSourcesFromSkill(skill);
  const requiredSources = new Set([...sources.preferred, ...sources.requiredArtifactSources]);
  const allSources = Array.from(new Set([
    ...sources.preferred,
    ...sources.fallback,
    ...sources.requiredArtifactSources,
    ...sources.optionalArtifactSources,
  ]));
  const scopedSources = allSources.length ? allSources : ["klaviyo_snapshot", "shopify_snapshot"];

  return scopedSources.map((source) => {
    const status = sourceStatusForArtifactSource(source, connectors, requiredSources.has(source));
    if (source === "klaviyo_snapshot") return klaviyoSnapshotContextStatus({ connectorStatus: status });
    if (source === "shopify_snapshot") return shopifySnapshotContextStatus({ connectorStatus: status });
    return status;
  });
}

function missingCapabilitiesFor(input: {
  skill: Awaited<ReturnType<typeof getSkill>>;
  sourceStatuses: Array<ReturnType<typeof sourceStatusForArtifactSource>>;
  brandProfilePresent: boolean;
  latestRetentionAuditPresent: boolean;
  requireLatestRetentionAudit: boolean;
}) {
  const missing = new Set<string>();
  for (const capability of jsonStringArray(input.skill?.missingCapabilities)) {
    missing.add(capability);
  }
  for (const source of input.sourceStatuses) {
    if (
      source.required &&
      !["connected_snapshot_available", "partial_source_available", "fallback_available"].includes(source.status)
    ) {
      missing.add(`${source.source}.connector_snapshot`);
    }
  }
  if (!input.brandProfilePresent) missing.add("brand_brain.context");
  if (input.requireLatestRetentionAudit && !input.latestRetentionAuditPresent) {
    missing.add("workflow.latest_retention_audit");
  }
  return Array.from(missing).slice(0, 24);
}

function compactBrandProfile(input: {
  profile: Awaited<ReturnType<typeof prisma.brandProfile.findUnique>>;
  ctas: Awaited<ReturnType<typeof prisma.brandCTA.findMany>>;
  phrases: Awaited<ReturnType<typeof prisma.brandPhrase.findMany>>;
  rules: Awaited<ReturnType<typeof prisma.brandRule.findMany>>;
}, itemLimit: number) {
  const profile = input.profile;
  if (!profile) {
    return {
      available: false,
      profile: null,
      ctas: [],
      phrases: [],
      rules: [],
    };
  }

  return {
    available: true,
    profile: {
      storeId: profile.storeId,
      brandName: compactText(profile.brandName, 120),
      tagline: compactText(profile.tagline, 160),
      industry: compactText(profile.industry ?? profile.industryVertical, 120),
      niche: compactText(profile.niche, 120),
      usp: compactText(profile.usp, 240),
      missionStatement: compactText(profile.missionStatement, 240),
      websiteUrl: compactText(profile.websiteUrl, 200),
      shopifyUrl: compactText(profile.shopifyUrl ?? profile.shopifyStoreUrl, 200),
      voiceDescription: compactText(profile.voiceDescription, 360),
      greetingStyle: compactText(profile.greetingStyle, 80),
      signOffStyle: compactText(profile.signOffStyle, 80),
      emojiUsage: compactText(profile.emojiUsage, 80),
      preferredLength: compactText(profile.preferredLength, 80),
      discountPhilosophy: compactText(profile.discountPhilosophy, 160),
      voiceDimensions: {
        formalCasual: profile.voiceFormalCasual,
        seriousPlayful: profile.voiceSeriousPlayful,
        reservedEnthusiastic: profile.voiceReservedEnthusiastic,
        technicalSimple: profile.voiceTechnicalSimple,
        authoritativeApproachable: profile.voiceAuthoritativeApproachable,
        minimalDescriptive: profile.voiceMinimalDescriptive,
        luxuryAccessible: profile.voiceLuxuryAccessible,
        edgySafe: profile.voiceEdgySafe,
        emotionalRational: profile.voiceEmotionalRational,
        trendyTimeless: profile.voiceTrendyTimeless,
      },
    },
    ctas: input.ctas.slice(0, itemLimit).map((cta) => ({
      id: cta.id,
      text: compactText(cta.text, 120),
      isPreferred: cta.isPreferred,
    })),
    phrases: input.phrases.slice(0, itemLimit).map((phrase) => ({
      id: phrase.id,
      phrase: compactText(phrase.phrase, 160),
      type: phrase.type,
    })),
    rules: input.rules.slice(0, itemLimit * 2).map((rule) => ({
      id: rule.id,
      rule: compactText(rule.rule, 240),
      type: rule.type,
      priority: rule.priority,
    })),
  };
}

function summarizeProductJson(value: Prisma.JsonValue | null | undefined, itemLimit: number) {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      count: value.length,
      top: compactTitleList(value, itemLimit),
    };
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    return {
      kind: "object",
      keyCount: keys.length,
      keys: keys.slice(0, itemLimit * 2),
    };
  }

  return {
    kind: value === null || value === undefined ? "empty" : typeof value,
    count: value ? 1 : 0,
  };
}

function compactBrandProductTruth(productIntelligence: {
  descriptionStyle: string | null;
  priceMentionRule: string | null;
  products: Prisma.JsonValue | null;
  collections: Prisma.JsonValue | null;
  heroProducts: string[];
  updatedAt: Date;
} | null, depth: WorkspaceContextPackDepth, itemLimit: number) {
  if (!productIntelligence) {
    return {
      available: false,
      descriptionStyle: null,
      priceMentionRule: null,
      heroProducts: [],
      products: [],
      collections: [],
    };
  }

  return {
    available: true,
    descriptionStyle: compactText(productIntelligence.descriptionStyle, 240),
    priceMentionRule: compactText(productIntelligence.priceMentionRule, 240),
    heroProducts: productIntelligence.heroProducts.slice(0, itemLimit * 2).map((item) => compactText(item, 120)),
    products: depth === "full"
      ? compactJson(productIntelligence.products)
      : summarizeProductJson(productIntelligence.products, itemLimit),
    collections: depth === "full"
      ? compactJson(productIntelligence.collections)
      : summarizeProductJson(productIntelligence.collections, itemLimit),
    updatedAt: productIntelligence.updatedAt.toISOString(),
  };
}

export async function buildWorkspaceContextPack(input: WorkspaceContextPackInput = {}) {
  const parsed = parseWorkspaceContextPackInput(input);
  if (!parsed.ok) return parsed;

  const { purpose, depth, skillId, limit } = parsed.data;
  const budget = DEPTH_BUDGETS[depth];
  const effectiveLimit = Math.min(limit, budget.itemLimit);
  const skillLimit = Math.min(Math.max(effectiveLimit, budget.skillLimit), budget.skillLimit);
  const sectionPlan = buildSectionPlan({ purpose, depth, skillId });
  const requiresLatestRetentionAudit = ["audit", "fix_run", "reporting"].includes(sectionPlan.family);
  const generatedAt = new Date().toISOString();
  const caveats: string[] = [
    "Context pack is read-only and assembled from local stored state.",
    `Depth is ${depth}; summaries omit raw payloads, secrets, env values, and large outputs.`,
  ];

  const [
    profile,
    ctas,
    phrases,
    rules,
    productIntelligence,
    campaignMemories,
    latestRetentionAudit,
    latestAuditFixRun,
    recentWorkflows,
    approvals,
    actionLogs,
    outcomes,
    results,
    sourceConnectors,
    skills,
    selectedSkill,
    productPerformanceResult,
    customerFeatureStore,
    customerScoring,
    microSegmentDefinitions,
    campaignOpportunities,
    microCampaignPackages,
    microCampaignArbitrations,
  ] = await Promise.all([
    prisma.brandProfile.findUnique({ where: { storeId: DEFAULT_STORE_ID } }),
    prisma.brandCTA.findMany({
      where: { storeId: DEFAULT_STORE_ID },
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.brandPhrase.findMany({
      where: { storeId: DEFAULT_STORE_ID },
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.brandRule.findMany({
      where: { storeId: DEFAULT_STORE_ID },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: effectiveLimit * 2,
    }),
    prisma.productIntelligence.findFirst({ orderBy: { updatedAt: "desc" } }),
    prisma.campaignMemory.findMany({
      orderBy: { sentAt: "desc" },
      take: Math.min(budget.campaignMemoryLimit, 100),
    }),
    prisma.workflowRun.findFirst({
      where: { type: "retention-audit" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.workflowRun.findFirst({
      where: { type: "audit-fix-run" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.workflowRun.findMany({
      where: { type: { in: RECENT_WORKFLOW_TYPES } },
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.approval.findMany({
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.actionLog.findMany({
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.recommendationOutcome.findMany({
      orderBy: { updatedAt: "desc" },
      take: effectiveLimit,
    }),
    prisma.recommendationResult.findMany({
      orderBy: { createdAt: "desc" },
      take: effectiveLimit,
    }),
    listSourceConnectors(),
    hasSection(sectionPlan, "skills") ? listSkills({ limit: skillLimit }) : Promise.resolve([]),
    skillId ? getSkill(skillId) : Promise.resolve(null),
    hasSection(sectionPlan, "productTruth")
      ? getProductPerformanceIntelligence({ limit: budget.productPerformanceLimit }).catch((error) => {
      caveats.push("Product performance intelligence could not be assembled; product context uses stored Brand Brain product truth only.");
      console.warn("Workspace context product intelligence read failed", error);
      return null;
      })
      : Promise.resolve(null),
    hasSection(sectionPlan, "customerFeatureStore")
      ? customerFeatureStoreContextSummary().catch((error) => {
          caveats.push("Customer Feature Store summary could not be assembled; context pack omits feature-store status.");
          console.warn("Workspace context customer feature store read failed", error);
          return null;
        })
      : Promise.resolve(null),
    hasSection(sectionPlan, "customerScoring")
      ? customerScoringContextSummary().catch((error) => {
          caveats.push("Customer Scoring summary could not be assembled; context pack omits scoring status.");
          console.warn("Workspace context customer scoring read failed", error);
          return null;
        })
      : Promise.resolve(null),
    hasSection(sectionPlan, "microSegmentDefinitions")
      ? microSegmentDefinitionsContextSummary().catch((error) => {
          caveats.push("Micro-segment definition summary could not be assembled; context pack omits segment-definition status.");
          console.warn("Workspace context micro-segment definition read failed", error);
          return null;
        })
      : Promise.resolve(null),
    hasSection(sectionPlan, "campaignOpportunities")
      ? campaignOpportunitiesContextSummary().catch((error) => {
          caveats.push("Campaign opportunity summary could not be assembled; context pack omits opportunity status.");
          console.warn("Workspace context campaign opportunity read failed", error);
          return null;
        })
      : Promise.resolve(null),
    hasSection(sectionPlan, "microCampaignPackages")
      ? microCampaignPackagesContextSummary().catch((error) => {
          caveats.push("Micro-campaign package summary could not be assembled; context pack omits package status.");
          console.warn("Workspace context micro-campaign package read failed", error);
          return null;
        })
      : Promise.resolve(null),
    hasSection(sectionPlan, "microCampaignArbitrations")
      ? microCampaignArbitrationsContextSummary().catch((error) => {
          caveats.push("Micro-campaign arbitration summary could not be assembled; context pack omits arbitration status.");
          console.warn("Workspace context micro-campaign arbitration read failed", error);
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (skillId && !selectedSkill) {
    caveats.push(`Skill ${skillId} was not found; context pack includes general workspace context only.`);
  }

  const connectorSummaries = sourceConnectors.map(summarizeConnectorForContext);
  const sourceStatuses = sourceStatusesForSkill(selectedSkill, sourceConnectors);
  const toolRuntime = summarizeToolRuntime(depth);
  const safeToolPermissions = new Set<AgentToolPermissionLevel>(["read", "generate"]);
  const missingCapabilities = missingCapabilitiesFor({
    skill: selectedSkill,
    sourceStatuses,
    brandProfilePresent: Boolean(profile),
    latestRetentionAuditPresent: Boolean(latestRetentionAudit),
    requireLatestRetentionAudit: requiresLatestRetentionAudit,
  });
  const skillSummary = selectedSkill ? compactSkill(selectedSkill) : null;
  const outcomeRows = outcomes.map(serializeRecommendationOutcome);
  const resultRows = results.map(serializeRecommendationResult);
  const contextPack: Record<string, unknown> = {
    purpose,
    depth,
    skillId,
    skill: skillSummary,
  };

  if (hasSection(sectionPlan, "brand")) {
    contextPack.brand = compactBrandProfile({ profile, ctas, phrases, rules }, effectiveLimit);
  }

  if (hasSection(sectionPlan, "campaignMemory")) {
    contextPack.campaignMemory = summarizeCampaignMemory(campaignMemories, effectiveLimit);
  }

  if (hasSection(sectionPlan, "customerFeatureStore")) {
    contextPack.customerFeatureStore = customerFeatureStore;
  }

  if (hasSection(sectionPlan, "customerScoring")) {
    contextPack.customerScoring = customerScoring;
  }

  if (hasSection(sectionPlan, "microSegmentDefinitions")) {
    contextPack.microSegmentDefinitions = microSegmentDefinitions;
  }

  if (hasSection(sectionPlan, "campaignOpportunities")) {
    contextPack.campaignOpportunities = campaignOpportunities;
  }

  if (hasSection(sectionPlan, "microCampaignPackages")) {
    contextPack.microCampaignPackages = microCampaignPackages;
  }

  if (hasSection(sectionPlan, "microCampaignArbitrations")) {
    contextPack.microCampaignArbitrations = microCampaignArbitrations;
  }

  if (hasSection(sectionPlan, "productTruth")) {
    contextPack.productTruth = {
      brandBrain: compactBrandProductTruth(productIntelligence, depth, budget.productPerformanceLimit),
      performance: productPerformanceResult
        ? compactProductPerformance(productPerformanceResult, budget.productPerformanceLimit, depth)
        : null,
    };
  }

  if (hasSection(sectionPlan, "workflows")) {
    contextPack.workflows = {
      latestRetentionAudit: compactWorkflow(latestRetentionAudit, depth, budget.titleLimit),
      latestAuditFixRun: compactWorkflow(latestAuditFixRun, depth, budget.titleLimit),
      recent: recentWorkflows.map((workflow) => compactRecentWorkflow(workflow, depth)),
    };
  }

  if (hasSection(sectionPlan, "approvals")) {
    contextPack.approvals = {
      countsByStatus: countBy(approvals.map((approval) => approval.status)),
      recent: approvals.map(compactApproval),
    };
  }

  if (hasSection(sectionPlan, "actionLog")) {
    contextPack.actionLog = {
      recent: actionLogs.map((log) => compactActionLog(log, depth)),
    };
  }

  if (hasSection(sectionPlan, "recommendationOutcomes")) {
    contextPack.recommendationOutcomes = {
      countsByStatus: countBy(outcomeRows.map((outcome) => outcome.status)),
      recent: outcomeRows.map((outcome) => ({
        id: outcome.id,
        sourceType: outcome.sourceType,
        sourceWorkflowRunId: outcome.sourceWorkflowRunId,
        recommendationId: outcome.recommendationId,
        title: compactText(outcome.title, 140),
        domain: outcome.domain,
        actionType: outcome.actionType,
        status: outcome.status,
        priority: outcome.priority,
        confidence: outcome.confidence,
        approvalId: outcome.approvalId,
        updatedAt: outcome.updatedAt,
      })),
    };
  }

  if (hasSection(sectionPlan, "results")) {
    contextPack.results = {
      countsByLearningSignal: countBy(resultRows.map((result) => result.learningSignal)),
      recent: resultRows.map((result) => ({
        id: result.id,
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        recommendationOutcomeId: result.recommendationOutcomeId,
        workflowRunId: result.workflowRunId,
        resultType: result.resultType,
        status: result.status,
        learningSignal: result.learningSignal,
        learningStatus: result.learningStatus,
        metrics: depth === "compact" ? null : compactJson(result.metrics),
        summary: compactText(result.summary, 240),
        createdAt: result.createdAt,
      })),
    };
  }

  if (hasSection(sectionPlan, "skills")) {
    contextPack.skills = {
      count: skills.length,
      selectedSkillId: skillSummary?.id ?? null,
      summary: skills.map(compactSkillSummary),
    };
  }

  if (hasSection(sectionPlan, "toolRuntime")) {
    contextPack.toolRuntime = {
      ...toolRuntime,
      safeExecutableTools: toolRuntime.availableSafeTools.filter((tool) =>
        safeToolPermissions.has(tool.permissionLevel as AgentToolPermissionLevel),
      ),
    };
  }

  if (hasSection(sectionPlan, "sourceStatuses")) {
    contextPack.sourceStatuses = sourceStatuses;
  }

  if (hasSection(sectionPlan, "connectedSources")) {
    contextPack.connectedSources = connectorSummaries;
  }

  if (hasSection(sectionPlan, "missingCapabilities")) {
    contextPack.missingCapabilities = missingCapabilities;
  }

  if (hasSection(sectionPlan, "safetyPosture")) {
    contextPack.safetyPosture = {
      readOnly: true,
      stateOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
      klaviyoWritesAllowed: false,
      draftCreationAllowed: false,
      sendsAllowed: false,
      schedulingAllowed: false,
      profileSyncAllowed: false,
      flowOrSegmentCreationAllowed: false,
      liveExternalActionsBlocked: true,
    };
  }

  const omittedSections = sectionPlan.omittedSections;
  const response = {
    ok: true as const,
    purpose,
    depth,
    generatedAt,
    contextPack,
    sourceStatuses,
    caveats: caveats.map(cleanResponseCaveat),
    metadata: {
      generatedAt,
      depth,
      limit,
      effectiveLimit,
      skillId,
      purpose,
      sectionFamily: sectionPlan.family,
      omittedSections,
      truncatedSections: truncatedSections({
        depth,
        requestedLimit: limit,
        effectiveLimit,
        includedSections: sectionPlan.include,
      }),
      sizeBytes: 0,
      storeId: DEFAULT_STORE_ID,
      schemaChanged: false,
      routesUsed: ["GET /api/workspace/context-pack", "POST /api/workspace/context-pack"],
    },
  };

  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  return response;
}
