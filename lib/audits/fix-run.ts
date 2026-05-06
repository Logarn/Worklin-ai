import type { Prisma } from "@prisma/client";
import type {
  AuditCaveat,
  AuditDomain,
  AuditEvidence,
  AuditInsight,
  AuditInsightType,
  AuditRecommendedAction,
  AuditSeverity,
} from "@/lib/audits/types";
import type {
  RetentionAuditOutput,
  RetentionPrioritizedAction,
  RetentionPriorityItem,
} from "@/lib/audits/retention-audit";

export type AuditFixRunMode = "safe_prepare";

export type AuditFixRunScope =
  | "all"
  | "fix_first"
  | "campaigns"
  | "flows"
  | "audiences"
  | "performance";

export type AuditFixType =
  | "campaign"
  | "flow"
  | "audience"
  | "performance"
  | "suppression";

export type AuditFixPriority = "high" | "medium" | "low";
export type AuditFixRiskLevel = "low" | "medium" | "high";

export type AuditFixSourceWorkflow = {
  id: string;
  type: string;
  status: string;
  output: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PreparedAuditFix = {
  id: string;
  title: string;
  fixType: AuditFixType;
  sourceIssueId: string | null;
  priority: AuditFixPriority;
  status: "prepared";
  whatWorklinPrepared: Record<string, unknown>;
  whyItMatters: string;
  evidence: AuditEvidence[];
  caveats: AuditCaveat[];
  dependencies: string[];
  whatRemainsBlocked: string[];
  riskLevel: AuditFixRiskLevel;
  approvalRequired: true;
  canGoLiveNow: false;
  externalActionTaken: false;
  suggestedNextStep: string;
  futureToolNeeded: string | null;
};

export type BlockedAuditFix = {
  id: string;
  title: string;
  fixType: AuditFixType;
  sourceIssueId: string | null;
  priority: AuditFixPriority;
  status: "blocked";
  reason: string;
  missingCapability: string;
  safeAlternative: string;
  futureRoadmapLink: string | null;
  evidence: AuditEvidence[];
  caveats: AuditCaveat[];
  riskLevel: AuditFixRiskLevel;
  canGoLiveNow: false;
  externalActionTaken: false;
};

export type AuditFixRunOutput = {
  ok: true;
  readOnly: true;
  mode: AuditFixRunMode;
  sourceWorkflowId: string;
  summary: {
    prepared: number;
    blocked: number;
    needsApproval: number;
    chatSummary: string;
  };
  preparedFixes: PreparedAuditFix[];
  blockedFixes: BlockedAuditFix[];
  approvalPackage: {
    readyForApproval: boolean;
    approvalSummary: string;
    items: Array<{
      id: string;
      title: string;
      fixType: AuditFixType;
      priority: AuditFixPriority;
      approvalRequired: true;
      canGoLiveNow: false;
      externalActionTaken: false;
    }>;
  };
  fixGroups: {
    campaigns: PreparedAuditFix[];
    flows: PreparedAuditFix[];
    audiences: PreparedAuditFix[];
    performance: PreparedAuditFix[];
    suppression: PreparedAuditFix[];
  };
  nextUserMessage: string;
  caveats: AuditCaveat[];
  metadata: {
    generatedAt: string;
    sourceWorkflow: {
      id: string;
      type: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      auditGeneratedAt: string | null;
    };
    scope: AuditFixRunScope;
    safePrepareOnly: true;
    externalActionsTaken: false;
    writesPerformed: false;
    liveCapabilitiesBlocked: string[];
    sourceSummary: {
      overallRetentionHealth: number | null;
      topIssues: number;
      topOpportunities: number;
      prioritizedActions: number;
      insights: number;
      caveats: number;
    };
  };
  workflowId?: string | null;
  workflowPersistence?: "persisted" | "skipped";
};

type FixSource = {
  id: string;
  title: string;
  summary: string;
  sourceIssueId: string | null;
  domain: AuditDomain;
  insightType: AuditInsightType;
  severity: AuditSeverity;
  priorityScore: number;
  priority: AuditFixPriority;
  riskLevel: AuditFixRiskLevel;
  evidence: AuditEvidence[];
  caveats: AuditCaveat[];
  recommendedAction?: AuditRecommendedAction;
  action?: RetentionPrioritizedAction;
  insight?: AuditInsight;
};

type ActionPackage = {
  type: AuditFixType;
  title: string;
  whatWorklinPrepared: Record<string, unknown>;
  suggestedNextStep: string;
  futureToolNeeded: string | null;
  dependencies: string[];
  blocked?: {
    title: string;
    reason: string;
    missingCapability: string;
    safeAlternative: string;
    futureRoadmapLink: string | null;
  };
};

const SOURCE_WORKFLOW_TYPE = "retention-audit";
const MAX_PREPARED_FIXES = 12;
const MAX_BLOCKED_FIXES = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value: string) {
  return normalizeText(value).replace(/\s+/g, "_").slice(0, 80) || "fix";
}

function asRetentionAuditOutput(value: unknown): RetentionAuditOutput | null {
  if (!isRecord(value)) return null;
  if (value.ok !== true || value.workflowType !== "retention_audit") return null;
  if (!isRecord(value.summary) || !isRecord(value.overallRetentionHealth)) return null;
  if (!Array.isArray(value.prioritizedActions) || !Array.isArray(value.insights)) return null;
  return value as RetentionAuditOutput;
}

export function validateRetentionAuditWorkflow(workflow: AuditFixSourceWorkflow):
  | { ok: true; audit: RetentionAuditOutput }
  | { ok: false; status: 400 | 404; error: string; issues: string[] } {
  const audit = asRetentionAuditOutput(workflow.output);

  if (workflow.type !== SOURCE_WORKFLOW_TYPE && !audit) {
    return {
      ok: false,
      status: 400,
      error: "Workflow run is not a retention audit",
      issues: ["Audit Fix Run v0 can only prepare fixes from a persisted retention-audit WorkflowRun."],
    };
  }

  if (!audit) {
    return {
      ok: false,
      status: 404,
      error: "Retention audit output is unavailable",
      issues: ["The WorkflowRun exists, but its retention audit output is missing or incomplete."],
    };
  }

  return { ok: true, audit };
}

function priorityFromScore(score: number): AuditFixPriority {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function priorityRank(priority: AuditFixPriority) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function riskFromSeverity(severity: AuditSeverity): AuditFixRiskLevel {
  if (severity === "critical" || severity === "issue") return "high";
  if (severity === "warning" || severity === "unknown") return "medium";
  return "low";
}

function riskRank(risk: AuditFixRiskLevel) {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function fixTypeForText(input: {
  domain: AuditDomain;
  title: string;
  summary: string;
  actionLabel?: string;
}) {
  const text = normalizeText([input.domain, input.title, input.summary, input.actionLabel ?? ""].join(" "));
  const campaignDomain = input.domain === "campaign" ||
    input.domain === "creative" ||
    input.domain === "offer" ||
    input.domain === "product";

  if (
    text.includes("suppression") ||
    text.includes("suppress") ||
    text.includes("guardrail") ||
    text.includes("protect vip") ||
    text.includes("recent purchaser")
  ) {
    return "suppression" as const;
  }

  if (
    text.includes("metric") ||
    text.includes("conversion") ||
    text.includes("performance setup") ||
    text.includes("performance reporting") ||
    text.includes("revenue backed") ||
    text.includes("revenue based")
  ) {
    return "performance" as const;
  }

  if (campaignDomain && !text.includes("flow") && !text.includes("sequence")) {
    return "campaign" as const;
  }

  if (
    input.domain === "flow" ||
    text.includes("flow") ||
    text.includes("browse abandon") ||
    text.includes("cart abandon") ||
    text.includes("checkout abandon") ||
    text.includes("welcome") ||
    text.includes("post purchase") ||
    text.includes("winback") ||
    text.includes("replenishment")
  ) {
    return "flow" as const;
  }

  if (
    input.domain === "segment" ||
    text.includes("audience") ||
    text.includes("segment") ||
    text.includes("vip") ||
    text.includes("buyer") ||
    text.includes("product interest")
  ) {
    return "audience" as const;
  }

  if (
    input.domain === "campaign" ||
    input.domain === "creative" ||
    input.domain === "offer" ||
    input.domain === "product" ||
    text.includes("campaign") ||
    text.includes("subject") ||
    text.includes("theme") ||
    text.includes("angle")
  ) {
    return "campaign" as const;
  }

  if (input.domain === "revenue") return "performance" as const;
  if (input.domain === "lifecycle") return "audience" as const;
  return "campaign" as const;
}

function scopeAllows(scope: AuditFixRunScope, fixType: AuditFixType, source: FixSource) {
  if (scope === "all") return true;
  if (scope === "campaigns") return fixType === "campaign";
  if (scope === "flows") return fixType === "flow";
  if (scope === "audiences") return fixType === "audience" || fixType === "suppression";
  if (scope === "performance") return fixType === "performance";
  return source.priority === "high" || source.riskLevel === "high" || source.priorityScore >= 70;
}

function sourceIntentKey(source: FixSource) {
  const fixType = fixTypeForText({
    domain: source.domain,
    title: source.title,
    summary: source.summary,
    actionLabel: source.recommendedAction?.label ?? source.action?.label,
  });
  const text = normalizeText([
    source.id,
    source.title,
    source.summary,
    source.recommendedAction?.label ?? "",
    source.action?.label ?? "",
  ].join(" "));

  if (fixType === "performance") return "performance_metric_setup";
  if (fixType === "suppression") return "suppression_guardrails";
  if (
    text.includes("retention foundation") ||
    text.includes("lowest scoring retention domains") ||
    text.includes("lowest scoring domains") ||
    text.includes("source truth and lifecycle gaps")
  ) {
    return "lifecycle_foundation_sequence";
  }
  if (fixType === "flow") {
    if (text.includes("browse")) return "flow_browse_abandon";
    if (text.includes("checkout")) return "flow_checkout_abandon";
    if (text.includes("cart")) return "flow_cart_abandon";
    if (text.includes("welcome")) return "flow_welcome";
    if (text.includes("post purchase")) return "flow_post_purchase";
    if (text.includes("winback")) return "flow_winback";
    if (text.includes("replenishment")) return "flow_replenishment";
  }
  if (fixType === "audience") {
    if (text.includes("vip")) return "audience_vip";
    if (text.includes("replenishment")) return "audience_replenishment";
    if (text.includes("winback")) return "audience_winback";
    if (text.includes("product interest")) return "audience_product_interest";
    if (text.includes("one time") || text.includes("new customer")) return "audience_lifecycle_separation";
  }
  if (fixType === "campaign") {
    if (text.includes("product")) return "campaign_product_truth";
    if (text.includes("subject")) return "campaign_subject_line";
    if (text.includes("generic") || text.includes("broad")) return "campaign_generic_blast";
    if (text.includes("faq") || text.includes("objection")) return "campaign_objection_handling";
  }

  return `${fixType}_${slugify(source.title)}`;
}

function mergeEvidence(existing: AuditEvidence[], incoming: AuditEvidence[]) {
  const seen = new Set(existing.map((item) => `${item.type}:${item.label}:${item.metricKey ?? ""}:${item.entityId ?? ""}`));
  const merged = [...existing];

  for (const item of incoming) {
    const key = `${item.type}:${item.label}:${item.metricKey ?? ""}:${item.entityId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 8);
}

function mergeCaveats(existing: AuditCaveat[], incoming: AuditCaveat[]) {
  const seen = new Set(existing.map((item) => item.message.toLowerCase()));
  const merged = [...existing];

  for (const item of incoming) {
    const key = item.message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged.slice(0, 8);
}

function sourceFromAction(action: RetentionPrioritizedAction): FixSource {
  return {
    id: action.id,
    title: action.label,
    summary: action.whyItMatters,
    sourceIssueId: action.id,
    domain: action.domain,
    insightType: "fix",
    severity: action.riskLevel === "high" ? "issue" : action.riskLevel === "medium" ? "warning" : "opportunity",
    priorityScore: action.priority === "high" ? 82 : action.priority === "medium" ? 62 : 42,
    priority: action.priority,
    riskLevel: action.riskLevel,
    evidence: action.supportingEvidence,
    caveats: action.caveats,
    action,
  };
}

function sourceFromInsight(insight: AuditInsight, action?: AuditRecommendedAction): FixSource {
  return {
    id: action?.id ?? insight.id,
    title: action?.label ?? insight.title,
    summary: action?.description ?? insight.summary,
    sourceIssueId: insight.id,
    domain: insight.domain,
    insightType: action?.actionType ?? insight.insightType,
    severity: insight.severity,
    priorityScore: insight.priorityScore,
    priority: action?.priority ?? priorityFromScore(insight.priorityScore),
    riskLevel: riskFromSeverity(insight.severity),
    evidence: insight.evidence,
    caveats: insight.caveats,
    recommendedAction: action,
    insight,
  };
}

function sourceFromPriorityItem(item: RetentionPriorityItem, kind: "issue" | "opportunity"): FixSource {
  return {
    id: item.id,
    title: item.title,
    summary: kind === "issue"
      ? "Retention audit surfaced this as a top issue to prepare before execution."
      : "Retention audit surfaced this as a top opportunity to prepare for scale.",
    sourceIssueId: item.id,
    domain: item.domain,
    insightType: item.insightType,
    severity: item.severity,
    priorityScore: item.priorityScore,
    priority: priorityFromScore(item.priorityScore),
    riskLevel: riskFromSeverity(item.severity),
    evidence: [],
    caveats: [],
  };
}

function collectFixSources(audit: RetentionAuditOutput) {
  const sources: FixSource[] = [];

  sources.push(...audit.prioritizedActions.map(sourceFromAction));

  for (const insight of audit.insights) {
    if (insight.recommendedActions.length) {
      sources.push(...insight.recommendedActions.map((action) => sourceFromInsight(insight, action)));
    } else {
      sources.push(sourceFromInsight(insight));
    }
  }

  sources.push(...audit.topIssues.map((item) => sourceFromPriorityItem(item, "issue")));
  sources.push(...audit.topOpportunities.map((item) => sourceFromPriorityItem(item, "opportunity")));

  return sources.sort((a, b) =>
    priorityRank(b.priority) - priorityRank(a.priority) ||
    b.priorityScore - a.priorityScore ||
    a.title.localeCompare(b.title),
  );
}

function dedupeFixSources(sources: FixSource[]) {
  const byIntent = new Map<string, FixSource>();

  for (const source of sources) {
    const key = sourceIntentKey(source);
    const existing = byIntent.get(key);
    if (!existing) {
      byIntent.set(key, source);
      continue;
    }

    existing.priority = priorityRank(source.priority) > priorityRank(existing.priority) ? source.priority : existing.priority;
    existing.riskLevel = riskRank(source.riskLevel) > riskRank(existing.riskLevel) ? source.riskLevel : existing.riskLevel;
    existing.priorityScore = Math.max(existing.priorityScore, source.priorityScore);
    existing.evidence = mergeEvidence(existing.evidence, source.evidence);
    existing.caveats = mergeCaveats(existing.caveats, source.caveats);
    if (source.summary.length > existing.summary.length && source.summary.length < 240) {
      existing.summary = source.summary;
    }
  }

  return Array.from(byIntent.values()).sort((a, b) =>
    priorityRank(b.priority) - priorityRank(a.priority) ||
    b.priorityScore - a.priorityScore ||
    a.title.localeCompare(b.title),
  );
}

function isGenericFoundationSource(source: FixSource) {
  return sourceIntentKey(source) === "lifecycle_foundation_sequence";
}

function productSpine(audit: RetentionAuditOutput) {
  const productEvidence = audit.domainScorecards.product?.evidence ?? [];
  const lifecycle = audit.lifecycleCoverage.productPlacements;
  return {
    evidence: productEvidence.slice(0, 4),
    placementCounts: lifecycle,
    caveat: audit.domainScorecards.product?.caveats[0]?.message ?? null,
  };
}

function metricCandidates(audit: RetentionAuditOutput) {
  const performance = audit.lifecycleCoverage.performanceCoverage;
  const evidence = audit.domainScorecards.performance?.evidence ?? [];
  return {
    recommendedMetricName: performance.recommendedMetricName,
    confidence: performance.confidence,
    needsPerformanceData: performance.needsPerformanceData,
    evidence: evidence.slice(0, 4),
  };
}

function audienceDefinitionHints(audit: RetentionAuditOutput, source: FixSource) {
  const coverage = audit.lifecycleCoverage.audienceCoverage;
  return {
    focus: source.title,
    coverageSnapshot: coverage,
    inclusionLogic: [
      "Use local customer/order/event signals first.",
      "Prefer lifecycle-specific membership over one broad list.",
      "Keep rules inspectable before any Klaviyo sync exists.",
    ],
    exclusionLogic: [
      "Exclude recent purchasers from winback pressure.",
      "Exclude VIPs from blanket discounting unless the campaign is explicitly VIP-safe.",
    ],
  };
}

function packageForSource(source: FixSource, audit: RetentionAuditOutput): ActionPackage {
  const fixType = fixTypeForText({
    domain: source.domain,
    title: source.title,
    summary: source.summary,
    actionLabel: source.recommendedAction?.label ?? source.action?.label,
  });

  if (fixType === "performance") {
    return {
      type: "performance",
      title: "Confirm Klaviyo conversion metric and performance reporting",
      whatWorklinPrepared: {
        packageType: "metric_setup_package",
        recommendedMetric: metricCandidates(audit).recommendedMetricName,
        confidence: metricCandidates(audit).confidence,
        needsPerformanceData: metricCandidates(audit).needsPerformanceData,
        reviewChecklist: [
          "Verify the account's primary purchase metric in Klaviyo.",
          "Use Placed Order when available and confirmed.",
          "Keep revenue-backed campaign and flow rankings caveated until confirmation.",
        ],
      },
      suggestedNextStep: "Ask Worklin to confirm the conversion metric candidate before using revenue-backed prioritization.",
      futureToolNeeded: "Durable metric selection / performance setup",
      dependencies: ["Klaviyo metric read access", "User confirmation of the conversion metric"],
    };
  }

  if (fixType === "suppression") {
    return {
      type: "suppression",
      title: "Prepare lifecycle suppression guardrails",
      whatWorklinPrepared: {
        packageType: "suppression_guardrail_package",
        rules: [
          "Protect VIPs and recent purchasers from broad discount or winback pressure.",
          "Keep active abandoners out of conflicting campaign pushes while recovery flows are active.",
          "Separate recent buyers, repeat buyers, VIPs, at-risk customers, and winback candidates before campaign execution.",
        ],
        governanceUse: "Apply these guardrails to future campaign briefs, flow plans, and audience definitions.",
      },
      suggestedNextStep: "Review the suppression guardrails as the default audience safety layer for future fixes.",
      futureToolNeeded: "Segment/profile sync and campaign suppression execution",
      dependencies: ["Audience definitions", "User approval before any live segment or campaign use"],
      blocked: {
        title: "Live suppression sync is not available in safe_prepare mode",
        reason: "Audit Fix Run v0 prepares suppression rules but does not create Klaviyo segments or attach suppressions to campaigns.",
        missingCapability: "Segment/Profile Sync",
        safeAlternative: "Keep the suppression guardrail package in the approval bundle for inspection.",
        futureRoadmapLink: "Segment/Profile Sync",
      },
    };
  }

  if (fixType === "flow") {
    return {
      type: "flow",
      title: source.title,
      whatWorklinPrepared: {
        packageType: "flow_build_package",
        targetLifecycleMoment: source.title,
        triggerAudienceTiming: [
          "Map the flow to its Worklin lifecycle playbook.",
          "Use the audit issue as the sequence/timing requirement.",
          "Keep message content recommendations metadata-first when Klaviyo content is image-heavy or unavailable.",
        ],
        recommendedMessageSequence: [
          "Message 1: match lifecycle intent and remove friction.",
          "Message 2: product proof, objection handling, or category guidance.",
          "Message 3: urgency, replenishment, cross-sell, or winback logic only when audience-safe.",
        ],
        productContext: productSpine(audit),
      },
      suggestedNextStep: "Use the Flow Planner / Flow Definition Builder path to turn this package into a reviewable flow definition later.",
      futureToolNeeded: "Flow Definition Builder",
      dependencies: ["Flow playbook mapping", "Klaviyo flow creation/update capability", "User approval before live changes"],
      blocked: {
        title: "Live flow creation or updates are not available in safe_prepare mode",
        reason: "This fix run can prepare the flow plan, but it cannot create, update, or activate Klaviyo flows.",
        missingCapability: "Flow Definition Builder / Klaviyo Flow Execution",
        safeAlternative: "Review the prepared flow package without making external changes.",
        futureRoadmapLink: "Flow Definition Builder",
      },
    };
  }

  if (fixType === "audience") {
    return {
      type: "audience",
      title: source.title,
      whatWorklinPrepared: {
        packageType: "audience_definition_package",
        audienceDefinition: audienceDefinitionHints(audit, source),
        suppressionDefaults: [
          "Protect VIP and recent-purchase cohorts unless the message is lifecycle-appropriate.",
          "Do not reuse broad list targeting as a substitute for lifecycle membership.",
        ],
        klaviyoSyncStatus: "not_executed",
      },
      suggestedNextStep: "Review the audience definition package before any future Klaviyo segment sync.",
      futureToolNeeded: "Segment/Profile Sync",
      dependencies: ["Local customer/order/event data", "Klaviyo audience read access where available", "User approval before sync"],
      blocked: {
        title: "Live audience or profile sync is not available in safe_prepare mode",
        reason: "Audit Fix Run v0 prepares audience definitions but does not create Klaviyo segments or sync profiles.",
        missingCapability: "Segment/Profile Sync",
        safeAlternative: "Keep the audience definition package as a reviewable artifact.",
        futureRoadmapLink: "Segment/Profile Sync",
      },
    };
  }

  return {
    type: "campaign",
    title: source.title,
    whatWorklinPrepared: {
      packageType: "campaign_fix_package",
      recommendedAngles: [
        source.title,
        "Anchor the campaign to product truth and a specific lifecycle audience.",
        "Use FAQ, objection handling, product story, VIP, winback, or replenishment angles instead of broad generic blasts when supported.",
      ],
      targetAudienceGuidance: [
        "Start from the lifecycle audience implied by the audit issue.",
        "Apply suppression guardrails before moving toward draft or send workflows.",
      ],
      productSpine: productSpine(audit),
      draftabilityStatus: "artifact_only_not_drafted",
    },
    suggestedNextStep: "Use a future campaign preparation workflow to turn this package into an approval-ready draft.",
    futureToolNeeded: "Campaign draft execution path",
    dependencies: ["Campaign playbook", "Product truth", "Audience/suppression review", "User approval before drafting or sending"],
  };
}

function evidenceForFixType(fixType: AuditFixType, evidence: AuditEvidence[]) {
  const allowedByType: Record<AuditFixType, AuditEvidence["type"][]> = {
    campaign: ["content", "performance", "product", "metric", "sample_size", "caveat"],
    flow: ["structure", "playbook", "product", "content", "performance", "metric", "caveat"],
    audience: ["segment", "metric", "sample_size", "product", "caveat"],
    performance: ["metric", "performance", "sample_size", "caveat"],
    suppression: ["segment", "caveat", "metric", "sample_size"],
  };
  const allowed = new Set(allowedByType[fixType]);
  const filtered = evidence.filter((item) => allowed.has(item.type));
  return (filtered.length ? filtered : evidence).slice(0, 6);
}

function preparedFixFromSource(source: FixSource, audit: RetentionAuditOutput, index: number): PreparedAuditFix {
  const actionPackage = packageForSource(source, audit);
  const evidence = evidenceForFixType(actionPackage.type, source.evidence);

  return {
    id: `fix_${String(index + 1).padStart(2, "0")}_${slugify(actionPackage.title)}`,
    title: actionPackage.title,
    fixType: actionPackage.type,
    sourceIssueId: source.sourceIssueId,
    priority: source.priority,
    status: "prepared",
    whatWorklinPrepared: actionPackage.whatWorklinPrepared,
    whyItMatters: source.summary,
    evidence,
    caveats: source.caveats.slice(0, 6),
    dependencies: actionPackage.dependencies,
    whatRemainsBlocked: [
      actionPackage.blocked?.reason ?? null,
      actionPackage.futureToolNeeded
        ? `Live execution requires ${actionPackage.futureToolNeeded} and explicit approval.`
        : null,
      "This route cannot send, schedule, sync, draft, create, update, activate, or go live.",
    ].filter((item): item is string => Boolean(item)),
    riskLevel: source.riskLevel,
    approvalRequired: true,
    canGoLiveNow: false,
    externalActionTaken: false,
    suggestedNextStep: actionPackage.suggestedNextStep,
    futureToolNeeded: actionPackage.futureToolNeeded,
  };
}

function blockedFixesFromPrepared(prepared: PreparedAuditFix[], audit: RetentionAuditOutput): BlockedAuditFix[] {
  const blockedByCapability = new Map<string, BlockedAuditFix>();

  for (const fix of prepared) {
    const actionPackage = packageForSource({
      id: fix.id,
      title: fix.title,
      summary: fix.whyItMatters,
      sourceIssueId: fix.sourceIssueId,
      domain: fix.fixType === "flow" ? "flow" : fix.fixType === "performance" ? "revenue" : fix.fixType === "campaign" ? "campaign" : "segment",
      insightType: "fix",
      severity: fix.riskLevel === "high" ? "issue" : "warning",
      priorityScore: fix.priority === "high" ? 80 : 60,
      priority: fix.priority,
      riskLevel: fix.riskLevel,
      evidence: fix.evidence,
      caveats: fix.caveats,
    }, audit);

    if (!actionPackage.blocked) continue;
    const key = actionPackage.blocked.missingCapability;
    if (blockedByCapability.has(key)) continue;

    blockedByCapability.set(key, {
      id: `blocked_${slugify(key)}`,
      title: actionPackage.blocked.title,
      fixType: fix.fixType,
      sourceIssueId: fix.sourceIssueId,
      priority: fix.priority,
      status: "blocked",
      reason: actionPackage.blocked.reason,
      missingCapability: actionPackage.blocked.missingCapability,
      safeAlternative: actionPackage.blocked.safeAlternative,
      futureRoadmapLink: actionPackage.blocked.futureRoadmapLink,
      evidence: fix.evidence.slice(0, 4),
      caveats: fix.caveats.slice(0, 4),
      riskLevel: fix.riskLevel,
      canGoLiveNow: false,
      externalActionTaken: false,
    });
  }

  if (prepared.some((fix) => fix.fixType === "performance")) {
    blockedByCapability.set("Durable metric selection / env configuration", {
      id: "blocked_durable_metric_selection",
      title: "Metric selection is not written to environment configuration",
      fixType: "performance",
      sourceIssueId: prepared.find((fix) => fix.fixType === "performance")?.sourceIssueId ?? null,
      priority: "high",
      status: "blocked",
      reason: "This route prepares the metric setup package but does not write KLAVIYO_CONVERSION_METRIC_ID or any environment variable.",
      missingCapability: "Durable metric selection / performance setup",
      safeAlternative: "Return the recommended metric candidate for user confirmation.",
      futureRoadmapLink: "Klaviyo Metric Discovery / Performance Setup",
      evidence: [],
      caveats: [{ message: "No environment variables were written or suggested as written by Worklin.", evidenceType: "caveat", severity: "unknown" }],
      riskLevel: "medium",
      canGoLiveNow: false,
      externalActionTaken: false,
    });
  }

  return Array.from(blockedByCapability.values())
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.title.localeCompare(b.title))
    .slice(0, MAX_BLOCKED_FIXES);
}

function groupedFixes(prepared: PreparedAuditFix[]): AuditFixRunOutput["fixGroups"] {
  return {
    campaigns: prepared.filter((fix) => fix.fixType === "campaign"),
    flows: prepared.filter((fix) => fix.fixType === "flow"),
    audiences: prepared.filter((fix) => fix.fixType === "audience"),
    performance: prepared.filter((fix) => fix.fixType === "performance"),
    suppression: prepared.filter((fix) => fix.fixType === "suppression"),
  };
}

function packageSummary(prepared: PreparedAuditFix[], blocked: BlockedAuditFix[]) {
  if (!prepared.length) {
    return "I did not find any safe fixes to prepare from this audit scope. Nothing was changed.";
  }

  const groupCounts = groupedFixes(prepared);
  const parts = [
    groupCounts.campaigns.length ? `${groupCounts.campaigns.length} campaign package${groupCounts.campaigns.length === 1 ? "" : "s"}` : null,
    groupCounts.flows.length ? `${groupCounts.flows.length} flow package${groupCounts.flows.length === 1 ? "" : "s"}` : null,
    groupCounts.audiences.length ? `${groupCounts.audiences.length} audience package${groupCounts.audiences.length === 1 ? "" : "s"}` : null,
    groupCounts.performance.length ? `${groupCounts.performance.length} performance setup package${groupCounts.performance.length === 1 ? "" : "s"}` : null,
    groupCounts.suppression.length ? `${groupCounts.suppression.length} suppression guardrail package${groupCounts.suppression.length === 1 ? "" : "s"}` : null,
  ].filter((item): item is string => Boolean(item));

  return `I prepared ${prepared.length} safe fix package${prepared.length === 1 ? "" : "s"}: ${parts.join(", ")}. ${blocked.length} live execution step${blocked.length === 1 ? " is" : "s are"} blocked until a future tool or explicit approval path exists.`;
}

function caveatsForOutput(audit: RetentionAuditOutput, prepared: PreparedAuditFix[], blocked: BlockedAuditFix[]) {
  const caveats: AuditCaveat[] = [
    {
      message: "Audit Fix Run v0 is prepare-only: no Klaviyo writes, sends, schedules, drafts, segment syncs, profile syncs, or flow updates were attempted.",
      evidenceType: "caveat",
      severity: "unknown",
    },
    ...audit.caveats,
    ...prepared.flatMap((fix) => fix.caveats),
    ...blocked.flatMap((fix) => fix.caveats),
  ];
  const seen = new Set<string>();

  return caveats.filter((item) => {
    const key = item.message.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function sourceSummary(audit: RetentionAuditOutput) {
  return {
    overallRetentionHealth: audit.overallRetentionHealth?.score ?? null,
    topIssues: audit.topIssues.length,
    topOpportunities: audit.topOpportunities.length,
    prioritizedActions: audit.prioritizedActions.length,
    insights: audit.insights.length,
    caveats: audit.caveats.length,
  };
}

export function prepareAuditFixRun(input: {
  workflow: AuditFixSourceWorkflow;
  audit: RetentionAuditOutput;
  mode?: AuditFixRunMode;
  scope?: AuditFixRunScope;
}): AuditFixRunOutput {
  const mode = input.mode ?? "safe_prepare";
  const scope = input.scope ?? "all";
  const allSources = dedupeFixSources(collectFixSources(input.audit));
  const scopedSources = allSources
    .filter((source) => !isGenericFoundationSource(source))
    .filter((source) => scopeAllows(scope, fixTypeForText({
      domain: source.domain,
      title: source.title,
      summary: source.summary,
      actionLabel: source.recommendedAction?.label ?? source.action?.label,
    }), source))
    .slice(0, MAX_PREPARED_FIXES);
  const prepared = scopedSources.map((source, index) => preparedFixFromSource(source, input.audit, index));
  const blocked = blockedFixesFromPrepared(prepared, input.audit);
  const chatSummary = packageSummary(prepared, blocked);
  const approvalItems = prepared.map((fix) => ({
    id: fix.id,
    title: fix.title,
    fixType: fix.fixType,
    priority: fix.priority,
    approvalRequired: fix.approvalRequired,
    canGoLiveNow: fix.canGoLiveNow,
    externalActionTaken: fix.externalActionTaken,
  }));

  return {
    ok: true,
    readOnly: true,
    mode,
    sourceWorkflowId: input.workflow.id,
    summary: {
      prepared: prepared.length,
      blocked: blocked.length,
      needsApproval: prepared.length,
      chatSummary,
    },
    preparedFixes: prepared,
    blockedFixes: blocked,
    approvalPackage: {
      readyForApproval: prepared.length > 0,
      approvalSummary: prepared.length
        ? `Prepared ${prepared.length} safe fix package${prepared.length === 1 ? "" : "s"} for one review. Nothing can go live from this route.`
        : "No approval package was prepared for this scope.",
      items: approvalItems,
    },
    fixGroups: groupedFixes(prepared),
    nextUserMessage: prepared.length
      ? "I prepared the safe fix package. Review the approval bundle; I did not send, schedule, sync, draft, create, or update anything externally."
      : "I did not find safe fixes to prepare for this scope. Try a broader scope or rerun the retention audit with more source data.",
    caveats: caveatsForOutput(input.audit, prepared, blocked),
    metadata: {
      generatedAt: new Date().toISOString(),
      sourceWorkflow: {
        id: input.workflow.id,
        type: input.workflow.type,
        status: input.workflow.status,
        createdAt: input.workflow.createdAt.toISOString(),
        updatedAt: input.workflow.updatedAt.toISOString(),
        auditGeneratedAt: input.audit.metadata?.generatedAt ?? null,
      },
      scope,
      safePrepareOnly: true,
      externalActionsTaken: false,
      writesPerformed: false,
      liveCapabilitiesBlocked: Array.from(new Set(blocked.map((fix) => fix.missingCapability))),
      sourceSummary: sourceSummary(input.audit),
    },
  };
}
