"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Layers3,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ApiEnvelope = {
  ok: boolean;
  error?: string;
  issues?: string[];
};

type AuditCaveat = {
  message: string;
  evidenceType?: string;
  severity?: string;
};

type AuditEvidence = {
  type: string;
  label: string;
  value?: unknown;
  metricKey?: string;
  source?: string;
  entityId?: string;
};

type AuditPriorityItem = {
  id: string;
  title: string;
  domain: string;
  insightType: string;
  severity: string;
  confidence: string;
  priorityScore: number;
};

type AuditInsight = AuditPriorityItem & {
  summary?: string;
  evidence?: AuditEvidence[];
  caveats?: AuditCaveat[];
};

type AuditChartHint = {
  type: string;
  title: string;
  metricKeys: string[];
  entityIds: string[];
  description?: string;
};

type SourceStatus = {
  status: "ok" | "partial" | "skipped" | "unavailable" | "failed";
  readOnly: true;
  summary: Record<string, string | number | boolean | null>;
  caveats: AuditCaveat[];
};

type DomainScorecard = {
  domain: string;
  label: string;
  score: number;
  status: "strong" | "directional" | "weak" | "unknown";
  confidence: string;
  sourceStatus: SourceStatus["status"];
  evidence: string[];
  caveats: AuditCaveat[];
};

type LifecycleCoverage = {
  productPlacements?: Record<string, number>;
  campaignCoverage?: Record<string, number>;
  flowCoverage?: Record<string, number>;
  audienceCoverage?: Record<string, number | string>;
  performanceCoverage?: {
    metricDiscoveryAvailable?: boolean;
    recommendedMetricName?: string | null;
    confidence?: string;
    needsPerformanceData?: boolean;
  };
  gaps?: string[];
};

type PrioritizedAction = {
  id: string;
  label: string;
  priority: "high" | "medium" | "low";
  domain: string;
  whyItMatters: string;
  supportingEvidence: AuditEvidence[];
  suggestedNextWorklinWorkflow: string | null;
  caveats: AuditCaveat[];
  riskLevel: "low" | "medium" | "high";
  approvalRequiredLater: boolean;
};

export type RetentionAudit = ApiEnvelope & {
  readOnly: true;
  workflowType: "retention_audit";
  summary: {
    executiveSummary: string;
    domainsAnalyzed: number;
    domainsSucceeded: number;
    domainsWithCaveats: number;
    needsPerformanceData: boolean;
  };
  overallRetentionHealth: {
    score: number;
    status: "strong" | "directional" | "weak";
    label: string;
    drivers: string[];
  };
  domainScorecards: Record<string, DomainScorecard>;
  topIssues: AuditPriorityItem[];
  topOpportunities: AuditPriorityItem[];
  prioritizedActions: PrioritizedAction[];
  lifecycleCoverage: LifecycleCoverage;
  insights?: AuditInsight[];
  chartHints: AuditChartHint[];
  caveats: AuditCaveat[];
  sourceStatuses: Record<string, SourceStatus>;
  metadata: {
    generatedAt: string;
    readOnly: true;
    input?: Record<string, unknown>;
    sourceFeatures?: string[];
  };
  workflowId?: string | null;
  workflowPersistence?: "persisted" | "skipped";
};

type WorkflowSummary = {
  id: string;
  type: string;
  status: string;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type WorkflowDetail = WorkflowSummary & {
  input: Record<string, unknown> | null;
  output: unknown;
};

type WorkflowListResponse = ApiEnvelope & {
  workflows?: WorkflowSummary[];
};

type WorkflowDetailResponse = ApiEnvelope & {
  workflow?: WorkflowDetail;
};

type CaveatGroupKey = "performance" | "klaviyo" | "audience" | "product" | "content" | "other";

const domainOrder = ["product", "campaign", "flow", "audience", "performance", "lifecycle"];
const lifecycleMoments = [
  "Welcome",
  "Browse",
  "Cart",
  "Checkout",
  "Post-purchase",
  "Replenishment",
  "Winback",
  "VIP / Loyalty",
  "Audience Automation",
];

async function parseApiResponse<T extends ApiEnvelope>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !data?.ok) {
    const message =
      data?.issues?.join(" ") ??
      data?.error ??
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRetentionAudit(value: unknown, workflowId?: string): RetentionAudit | null {
  if (!isRecord(value) || value.workflowType !== "retention_audit" || value.ok !== true) return null;
  return {
    ...(value as RetentionAudit),
    workflowId: typeof value.workflowId === "string" ? value.workflowId : workflowId ?? null,
    workflowPersistence: value.workflowPersistence === "skipped" ? "skipped" : "persisted",
  };
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function formatDomain(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreTone(score: number) {
  if (score >= 75) return "border-emerald-300/25 bg-emerald-300/10 text-emerald-100";
  if (score >= 50) return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  return "border-red-300/25 bg-red-300/10 text-red-100";
}

function badgeVariant(status: string): "success" | "warning" | "destructive" | "secondary" | "outline" {
  if (status === "strong" || status === "ok" || status === "completed" || status === "scale") return "success";
  if (status === "directional" || status === "partial" || status === "warning" || status === "monitor") return "warning";
  if (status === "weak" || status === "failed" || status === "critical" || status === "issue" || status === "fix") return "destructive";
  if (status === "skipped" || status === "unavailable" || status === "unknown") return "outline";
  return "secondary";
}

function priorityVariant(priority: string): "warning" | "destructive" | "secondary" {
  if (priority === "high") return "destructive";
  if (priority === "medium") return "warning";
  return "secondary";
}

function scorecard(audit: RetentionAudit, key: string) {
  return audit.domainScorecards[key] ?? null;
}

function allInsights(audit: RetentionAudit) {
  return audit.insights?.length ? audit.insights : [...audit.topIssues, ...audit.topOpportunities];
}

function textMatches(value: string, needles: string[]) {
  const lowered = value.toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
}

function actionText(action: PrioritizedAction) {
  return `${action.label} ${action.whyItMatters} ${action.domain} ${action.suggestedNextWorklinWorkflow ?? ""}`;
}

function insightText(insight: AuditInsight | AuditPriorityItem) {
  return `${insight.title} ${"summary" in insight ? insight.summary ?? "" : ""} ${insight.domain} ${insight.insightType}`;
}

function actionsFor(audit: RetentionAudit, domains: string[], keywords: string[] = []) {
  return audit.prioritizedActions.filter((action) => {
    const domainMatch = domains.includes(action.domain);
    const keywordMatch = keywords.length ? textMatches(actionText(action), keywords) : false;
    return domainMatch || keywordMatch;
  });
}

function insightsFor(audit: RetentionAudit, domains: string[], keywords: string[] = []) {
  return allInsights(audit).filter((insight) => {
    const domainMatch = domains.includes(insight.domain);
    const keywordMatch = keywords.length ? textMatches(insightText(insight), keywords) : false;
    return domainMatch || keywordMatch;
  });
}

function evidenceForAction(action: PrioritizedAction) {
  return action.supportingEvidence
    .map((item) => {
      const value = formatValue(item.value);
      return value ? `${item.label}: ${value}` : item.label;
    })
    .filter(Boolean);
}

function caveatGroup(item: AuditCaveat): CaveatGroupKey {
  const message = item.message.toLowerCase();
  const type = item.evidenceType?.toLowerCase() ?? "";
  if (message.includes("conversion metric") || message.includes("performance") || type.includes("performance")) return "performance";
  if (message.includes("klaviyo") || message.includes("api") || message.includes("scope")) return "klaviyo";
  if (message.includes("audience") || message.includes("segment") || type.includes("segment")) return "audience";
  if (message.includes("shopify") || message.includes("product") || message.includes("sync") || type.includes("product")) return "product";
  if (message.includes("content") || message.includes("image") || message.includes("asset") || type.includes("content")) return "content";
  return "other";
}

function groupedCaveats(audit: RetentionAudit) {
  const groups: Record<CaveatGroupKey, AuditCaveat[]> = {
    performance: [],
    klaviyo: [],
    audience: [],
    product: [],
    content: [],
    other: [],
  };

  for (const item of audit.caveats) {
    groups[caveatGroup(item)].push(item);
  }

  return groups;
}

function statusLabel(status: string) {
  if (status === "ok") return "checked";
  if (status === "partial") return "partially checked";
  if (status === "unavailable") return "unavailable";
  if (status === "skipped") return "skipped";
  if (status === "failed") return "failed";
  return status;
}

function checkedRows(audit: RetentionAudit) {
  const source = audit.sourceStatuses;
  const hasPlaybookEvidence = audit.prioritizedActions.some((action) =>
    action.supportingEvidence.some((item) => item.type === "playbook" || item.source?.includes("playbook")),
  );

  return [
    {
      label: "Product data",
      status: source.product?.status ?? "unknown",
      detail: "Products, orders, order items, customer events, and local commerce truth.",
    },
    {
      label: "Campaign metadata",
      status: source.campaign?.status ?? "unknown",
      detail: "Recent Klaviyo campaign names, channels, themes, and performance availability.",
    },
    {
      label: "Flow structure",
      status: source.flow?.status ?? "unknown",
      detail: "Klaviyo flow details, actions, delays, subjects, and playbook fit.",
    },
    {
      label: "Audience / segment signals",
      status: source.audience?.status ?? "unknown",
      detail: "Klaviyo audience inventory where available plus local lifecycle signals.",
    },
    {
      label: "Metric discovery",
      status: source.performance?.status ?? "unknown",
      detail: "Klaviyo metric inventory and conversion metric readiness.",
    },
    {
      label: "Playbooks / memory",
      status: hasPlaybookEvidence ? "ok" : "unknown",
      detail: hasPlaybookEvidence
        ? "Child audits returned playbook evidence in recommendations."
        : "No explicit playbook evidence was returned in this audit output.",
    },
  ];
}

function scorecardDiagnosis(scorecardValue: DomainScorecard | null) {
  if (!scorecardValue) return "No scorecard returned.";
  return scorecardValue.evidence[0] ?? scorecardValue.caveats[0]?.message ?? "No diagnosis returned.";
}

function lifecycleRows(audit: RetentionAudit) {
  const flowSignals = insightsFor(audit, ["flow", "lifecycle", "creative"]);
  const actions = audit.prioritizedActions;

  return lifecycleMoments.flatMap((moment) => {
    const key = moment.toLowerCase();
    const signals = [
      ...flowSignals.filter((insight) => insightText(insight).toLowerCase().includes(key.split(" ")[0])),
      ...actions.filter((action) => actionText(action).toLowerCase().includes(key.split(" ")[0])),
    ];
    if (!signals.length) return [];

    const issue = signals[0];
    const status = issue
      ? issue instanceof Object && "priority" in issue && issue.priority === "high"
        ? "needs attention"
        : "review"
      : "unknown";

    return {
      moment,
      status,
      issue: issue
        ? "title" in issue
          ? issue.title
          : issue.label
        : "No specific audit signal returned for this lifecycle moment.",
      nextMove: issue && "suggestedNextWorklinWorkflow" in issue
        ? issue.suggestedNextWorklinWorkflow ?? "Review in Retention Audit"
        : issue
          ? "Review source evidence"
          : "Confirm coverage in a deeper lifecycle audit",
    };
  });
}

function classifyAction(action: PrioritizedAction): "fixFirst" | "buildNext" | "scale" | "protect" | "monitor" {
  const text = actionText(action).toLowerCase();
  if (textMatches(text, ["protect", "suppression", "guardrail", "vip", "recent purchaser"])) return "protect";
  if (textMatches(text, ["scale", "revenue anchor", "product spotlight", "add-on", "cross-sell"])) return "scale";
  if (textMatches(text, ["build", "audience coverage", "list/segment", "verify audience", "replenishment audience"])) return "buildNext";
  if (textMatches(text, ["monitor", "review", "subject", "creative", "timing"])) return "monitor";
  if (action.priority === "high" || action.riskLevel === "high" || textMatches(text, ["fix", "confirm", "metric", "performance"])) return "fixFirst";
  return "monitor";
}

function priorityMatrix(audit: RetentionAudit) {
  const matrix = {
    fixFirst: [] as PrioritizedAction[],
    buildNext: [] as PrioritizedAction[],
    scale: [] as PrioritizedAction[],
    protect: [] as PrioritizedAction[],
    monitor: [] as PrioritizedAction[],
  };

  for (const action of audit.prioritizedActions) {
    matrix[classifyAction(action)].push(action);
  }

  return matrix;
}

function EmptyReportState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] px-4 py-5 text-sm leading-6 text-slate-400">
      <p className="font-semibold text-slate-200">{title}</p>
      <p className="mt-1">{body}</p>
    </div>
  );
}

function hasRecordSignal(value: Record<string, unknown> | undefined) {
  return Object.values(value ?? {}).some((item) => {
    if (typeof item === "number") return item > 0;
    if (typeof item === "string") return item.trim() !== "" && item !== "unknown";
    return Boolean(item);
  });
}

function hasScorecardSignal(value: DomainScorecard | null) {
  if (!value) return false;
  return (
    value.status !== "unknown" ||
    value.evidence.length > 0 ||
    value.caveats.length > 0 ||
    Number.isFinite(value.score)
  );
}

function MetricTile({ label, value, icon }: { label: string; value: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-h-24 rounded-xl border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
        {icon ? <div className="text-slate-500">{icon}</div> : null}
      </div>
      <div className="mt-3 text-2xl font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const clamped = clampScore(score);
  const color = clamped >= 75 ? "bg-emerald-300" : clamped >= 50 ? "bg-amber-300" : "bg-red-300";
  return (
    <div className="h-2 rounded-full bg-white/10">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function SectionHeader({ title, question }: { title: string; question?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      {question ? <p className="mt-1 text-sm leading-6 text-slate-400">{question}</p> : null}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const normalized =
    status.includes("partial") ? "partial" :
    status.includes("attention") ? "warning" :
    status.includes("checked") ? "ok" :
    status;
  return <Badge variant={badgeVariant(normalized)}>{status}</Badge>;
}

function OperatorBriefing({ audit }: { audit: RetentionAudit }) {
  const score = clampScore(audit.overallRetentionHealth.score);
  const topPriorities = audit.prioritizedActions.slice(0, 3);

  return (
    <section className="rounded-2xl border border-white/10 bg-[linear-gradient(135deg,rgba(20,28,42,0.96),rgba(11,16,25,0.96))] p-5 shadow-[0_16px_50px_rgba(2,6,23,0.35)] md:p-7 xl:p-8">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_230px] xl:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Retention Audit</Badge>
            <Badge variant={badgeVariant(audit.overallRetentionHealth.status)}>{audit.overallRetentionHealth.status}</Badge>
            {audit.workflowPersistence ? <Badge variant="secondary">{audit.workflowPersistence}</Badge> : null}
          </div>
          <h1 className="mt-5 text-3xl font-semibold text-slate-50 md:text-4xl">Retention Audit</h1>
          <p className="mt-4 max-w-5xl text-base leading-7 text-slate-200">{audit.summary.executiveSummary}</p>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-400">{audit.overallRetentionHealth.label}</p>
          <div className="mt-5 flex flex-wrap gap-3 text-xs text-slate-500">
            <span>Generated {formatDateTime(audit.metadata.generatedAt)}</span>
            {audit.workflowId ? <span className="break-all">Workflow {audit.workflowId}</span> : null}
          </div>
        </div>
        <div className={cn("rounded-2xl border p-5", scoreTone(score))}>
          <p className="text-xs font-medium uppercase opacity-80">Overall health</p>
          <p className="mt-2 text-4xl font-semibold text-slate-50">{score}</p>
          <p className="mt-1 text-xs text-slate-300/80">out of 100</p>
          <ScoreBar score={score} />
        </div>
      </div>

      <div className="mt-7 grid gap-4 lg:grid-cols-3">
        {topPriorities.length ? topPriorities.map((action, index) => (
          <div key={action.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-4 md:p-5">
            <p className="text-xs font-medium uppercase text-slate-500">Priority {index + 1}</p>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-100 md:text-base md:leading-7">{action.label}</p>
            <p className="mt-3 text-xs text-slate-500">{formatDomain(action.domain)} · {action.priority}</p>
          </div>
        )) : (
          <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4 text-sm text-slate-400">
            No prioritized actions returned.
          </div>
        )}
      </div>
    </section>
  );
}

function WhatChecked({ audit }: { audit: RetentionAudit }) {
  const caveatGroups = groupedCaveats(audit);
  const limitations = [
    ...caveatGroups.performance.slice(0, 2),
    ...caveatGroups.klaviyo.slice(0, 2),
    ...caveatGroups.audience.slice(0, 1),
    ...caveatGroups.product.slice(0, 1),
    ...caveatGroups.content.slice(0, 1),
  ];

  return (
    <section>
      <SectionHeader
        title="What Worklin Checked"
        question="The report stays honest about which sources were available, partial, or missing."
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {checkedRows(audit).map((row) => (
          <div key={row.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">{row.label}</p>
                <p className="mt-1 text-sm leading-6 text-slate-400">{row.detail}</p>
              </div>
              <StatusPill status={statusLabel(row.status)} />
            </div>
          </div>
        ))}
      </div>

      {limitations.length ? (
        <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4">
          <p className="text-sm font-semibold text-amber-100">Limitations to keep in view</p>
          <div className="mt-3 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
            {limitations.map((item, index) => (
              <p key={`${item.message}-${index}`} className="rounded-lg border border-amber-200/10 bg-black/10 px-3 py-2 text-xs leading-5 text-amber-50/85">
                {item.message}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HealthSnapshot({ audit }: { audit: RetentionAudit }) {
  const entries = domainOrder
    .map((key) => [key, audit.domainScorecards[key]] as const)
    .filter((entry): entry is readonly [string, DomainScorecard] => Boolean(entry[1]));

  return (
    <section>
      <SectionHeader title="Retention Health Snapshot" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {entries.map(([key, item]) => (
          <div key={key} className="flex min-h-52 flex-col rounded-xl border border-white/10 bg-white/[0.035] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">{item.label || formatDomain(key)}</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">{scorecardDiagnosis(item)}</p>
              </div>
              <StatusPill status={item.status} />
            </div>
            <div className="mt-auto flex items-end justify-between gap-4 pt-5">
              <p className="text-3xl font-semibold text-slate-100">{clampScore(item.score)}</p>
              <p className="text-xs text-slate-500">
                {(item.evidence?.length ?? 0) + (item.caveats?.length ?? 0)} signal(s)
              </p>
            </div>
            <ScoreBar score={item.score} />
          </div>
        ))}
      </div>
    </section>
  );
}

function TruthPanel({
  title,
  question,
  scorecardValue,
  actions,
  insights,
  caveats,
  metrics,
}: {
  title: string;
  question: string;
  scorecardValue: DomainScorecard | null;
  actions: PrioritizedAction[];
  insights: Array<AuditInsight | AuditPriorityItem>;
  caveats: AuditCaveat[];
  metrics?: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 md:p-6">
      <SectionHeader title={title} question={question} />
      <div className="grid gap-4 2xl:grid-cols-[320px_1fr]">
        <div className="rounded-xl border border-white/10 bg-black/15 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase text-slate-500">Domain health</p>
              <p className="mt-2 text-3xl font-semibold text-slate-100">{scorecardValue ? clampScore(scorecardValue.score) : "—"}</p>
            </div>
            {scorecardValue ? <StatusPill status={scorecardValue.status} /> : null}
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-400">{scorecardDiagnosis(scorecardValue)}</p>
          {metrics?.length ? (
            <div className="mt-4 grid grid-cols-2 gap-2">
              {metrics.map((metric) => (
                <div key={metric.label} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                  <p className="text-xs text-slate-500">{metric.label}</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{metric.value}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <p className="text-sm font-semibold text-slate-100">Signals</p>
            <div className="mt-3 space-y-2">
              {insights.length ? insights.slice(0, 4).map((item) => (
                <p key={item.id} className="text-sm leading-6 text-slate-400">
                  {item.title}
                </p>
              )) : (
                <p className="text-sm text-slate-500">No specific insight returned for this domain.</p>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <p className="text-sm font-semibold text-slate-100">Operator moves</p>
            <div className="mt-3 space-y-2">
              {actions.length ? actions.slice(0, 4).map((action) => (
                <p key={action.id} className="text-sm leading-6 text-slate-400">
                  {action.label}
                </p>
              )) : (
                <p className="text-sm text-slate-500">No action returned for this domain.</p>
              )}
            </div>
          </div>
          {caveats.length ? (
            <div className="rounded-xl border border-amber-300/15 bg-amber-300/8 p-4 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-amber-100">Caveats</p>
                {caveats.length > 3 ? <Badge variant="warning">+{caveats.length - 3}</Badge> : null}
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {caveats.slice(0, 3).map((item, index) => (
                  <p key={`${item.message}-${index}`} className="rounded-lg border border-amber-200/10 bg-black/10 px-3 py-2 text-xs leading-5 text-amber-50/85">
                    {item.message}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ProductTruth({ audit }: { audit: RetentionAudit }) {
  const coverage = audit.lifecycleCoverage.productPlacements ?? {};
  return (
    <TruthPanel
      title="Product Truth"
      question="Which products should retention use as the spine of campaigns and flows?"
      scorecardValue={scorecard(audit, "product")}
      actions={actionsFor(audit, ["product"], ["product", "revenue anchor", "replenishment", "add-on", "cross-sell"])}
      insights={insightsFor(audit, ["product"], ["product", "revenue anchor", "replenishment"])}
      caveats={groupedCaveats(audit).product}
      metrics={[
        { label: "Welcome", value: coverage.welcomeHero ?? 0 },
        { label: "Add-ons", value: coverage.cartCheckoutAddOns ?? 0 },
        { label: "Post-purchase", value: coverage.postPurchaseCrossSell ?? 0 },
        { label: "Winback", value: coverage.winback ?? 0 },
      ]}
    />
  );
}

function CampaignTruth({ audit }: { audit: RetentionAudit }) {
  const campaignCoverage = audit.lifecycleCoverage.campaignCoverage ?? {};
  return (
    <TruthPanel
      title="Campaign Truth"
      question="Are campaigns strategically useful, or are they random and broad?"
      scorecardValue={scorecard(audit, "campaign")}
      actions={actionsFor(audit, ["campaign", "creative", "offer"], ["campaign", "subject", "product spotlight", "broad", "theme"])}
      insights={insightsFor(audit, ["campaign", "creative", "offer"], ["campaign", "subject", "broad", "theme"])}
      caveats={[...groupedCaveats(audit).performance, ...groupedCaveats(audit).product].slice(0, 5)}
      metrics={[
        { label: "Analyzed", value: campaignCoverage.campaignsAnalyzed ?? 0 },
        { label: "Issues", value: campaignCoverage.topIssues ?? 0 },
        { label: "Opportunities", value: campaignCoverage.topOpportunities ?? 0 },
        { label: "Protected", value: campaignCoverage.protectedPatterns ?? 0 },
      ]}
    />
  );
}

function FlowTruth({ audit }: { audit: RetentionAudit }) {
  const coverage = audit.lifecycleCoverage.flowCoverage ?? {};
  const rows = lifecycleRows(audit);
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 md:p-6">
      <SectionHeader title="Flow Truth" question="Lifecycle automation health, based only on returned flow evidence." />
      <div className="grid gap-4 2xl:grid-cols-[300px_1fr]">
        <div className="rounded-xl border border-white/10 bg-black/15 p-4">
          <p className="text-xs font-medium uppercase text-slate-500">Flow health</p>
          <p className="mt-2 text-3xl font-semibold text-slate-100">{scorecard(audit, "flow")?.score ?? "—"}</p>
          <p className="mt-3 text-sm leading-6 text-slate-400">{scorecardDiagnosis(scorecard(audit, "flow"))}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <MetricTile label="Audited" value={coverage.flowsAudited ?? 0} />
            <MetricTile label="Issues" value={coverage.topIssues ?? 0} />
          </div>
        </div>
        {rows.length ? (
          <div className="overflow-hidden rounded-xl border border-white/10">
            <div className="hidden grid-cols-[170px_130px_minmax(0,1fr)_minmax(220px,0.8fr)] bg-white/[0.04] px-4 py-3 text-xs font-medium uppercase text-slate-500 xl:grid">
              <span>Moment</span>
              <span>Status</span>
              <span>Evidence / issue</span>
              <span>Next move</span>
            </div>
            {rows.map((row) => (
              <div key={row.moment} className="grid gap-3 border-t border-white/10 bg-black/15 px-4 py-3 xl:grid-cols-[170px_130px_minmax(0,1fr)_minmax(220px,0.8fr)] xl:first:border-t-0">
                <p className="text-sm font-medium text-slate-100">{row.moment}</p>
                <div>
                  <StatusPill status={row.status === "needs attention" ? "warning" : row.status} />
                </div>
                <p className="text-sm leading-6 text-slate-400">{row.issue}</p>
                <p className="text-sm leading-6 text-slate-500">{row.nextMove}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyReportState
            title="No lifecycle-specific flow findings returned"
            body="Worklin still scored the flow domain above, but this audit output did not include specific Welcome, Browse, Cart, Checkout, or Winback flow findings."
          />
        )}
      </div>
    </section>
  );
}

function AudienceTruth({ audit }: { audit: RetentionAudit }) {
  const coverage = audit.lifecycleCoverage.audienceCoverage ?? {};
  return (
    <TruthPanel
      title="Audience / Segment Truth"
      question="Do audiences give Worklin enough lifecycle truth to avoid broad-blast execution?"
      scorecardValue={scorecard(audit, "audience")}
      actions={actionsFor(audit, ["segment", "lifecycle"], ["audience", "segment", "suppression", "vip", "winback", "replenishment"])}
      insights={insightsFor(audit, ["segment", "lifecycle"], ["audience", "segment", "suppression", "vip", "winback"])}
      caveats={[...groupedCaveats(audit).audience, ...groupedCaveats(audit).klaviyo].slice(0, 5)}
      metrics={[
        { label: "Covered", value: coverage.covered ?? 0 },
        { label: "Partial", value: coverage.partial ?? 0 },
        { label: "Missing", value: coverage.missing ?? 0 },
        { label: "Broad risk", value: coverage.broadAudienceRisk ?? "unknown" },
      ]}
    />
  );
}

function LifecycleCoverageMap({ audit }: { audit: RetentionAudit }) {
  const rows = [
    {
      moment: "Product spine",
      status: scorecard(audit, "product")?.status ?? "unknown",
      evidence: scorecardDiagnosis(scorecard(audit, "product")),
      next: actionsFor(audit, ["product"], ["product", "revenue anchor"])[0]?.label ?? "Use product intelligence when choosing campaign and flow themes.",
    },
    {
      moment: "Campaign strategy",
      status: scorecard(audit, "campaign")?.status ?? "unknown",
      evidence: scorecardDiagnosis(scorecard(audit, "campaign")),
      next: actionsFor(audit, ["campaign", "creative"], ["campaign", "subject"])[0]?.label ?? "Review campaign themes and performance readiness.",
    },
    {
      moment: "Flow coverage",
      status: scorecard(audit, "flow")?.status ?? "unknown",
      evidence: scorecardDiagnosis(scorecard(audit, "flow")),
      next: actionsFor(audit, ["flow"], ["browse", "welcome", "timing"])[0]?.label ?? "Audit lifecycle automations by playbook depth.",
    },
    {
      moment: "Audience coverage",
      status: scorecard(audit, "audience")?.status ?? "unknown",
      evidence: scorecardDiagnosis(scorecard(audit, "audience")),
      next: actionsFor(audit, ["segment"], ["audience", "suppression"])[0]?.label ?? "Confirm lifecycle audiences and suppression coverage.",
    },
    {
      moment: "Performance readiness",
      status: scorecard(audit, "performance")?.status ?? "unknown",
      evidence: scorecardDiagnosis(scorecard(audit, "performance")),
      next: actionsFor(audit, ["revenue"], ["metric", "performance"])[0]?.label ?? "Confirm conversion metric before trusting revenue-backed prioritization.",
    },
  ];

  return (
    <section>
      <SectionHeader title="Lifecycle Coverage Map" question="A compact map of the operating system Worklin checked." />
      <div className="overflow-hidden rounded-xl border border-white/10">
        <div className="hidden grid-cols-[190px_130px_minmax(0,1fr)_minmax(240px,0.9fr)] bg-white/[0.04] px-4 py-3 text-xs font-medium uppercase text-slate-500 lg:grid">
          <span>Lifecycle moment</span>
          <span>Status</span>
          <span>Evidence / issue</span>
          <span>Next move</span>
        </div>
        {rows.map((row) => (
          <div key={row.moment} className="grid gap-3 border-t border-white/10 bg-black/10 px-4 py-4 lg:grid-cols-[190px_130px_minmax(0,1fr)_minmax(240px,0.9fr)] lg:first:border-t-0">
            <p className="text-sm font-medium text-slate-100">{row.moment}</p>
            <div>
              <StatusPill status={row.status} />
            </div>
            <p className="text-sm leading-6 text-slate-400">{row.evidence}</p>
            <p className="text-sm leading-6 text-slate-400">{row.next}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PriorityMatrix({ audit }: { audit: RetentionAudit }) {
  const matrix = priorityMatrix(audit);
  const columns = [
    ["Fix First", matrix.fixFirst],
    ["Build Next", matrix.buildNext],
    ["Scale", matrix.scale],
    ["Protect", matrix.protect],
    ["Monitor", matrix.monitor],
  ].filter(([, actions]) => actions.length) as Array<[string, PrioritizedAction[]]>;

  return (
    <section>
      <SectionHeader title="Priority Matrix" question="Actions grouped by operator intent, not as one long list." />
      {columns.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {columns.map(([title, actions]) => (
            <div key={title} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">{title}</p>
                <Badge variant="secondary">{actions.length}</Badge>
              </div>
              <div className="mt-3 space-y-2">
                {actions.slice(0, 3).map((action) => (
                <div key={action.id} className="rounded-lg border border-white/10 bg-black/15 p-3.5">
                  <p className="text-sm font-medium leading-6 text-slate-200">{action.label}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant={priorityVariant(action.priority)}>{action.priority}</Badge>
                    <Badge variant="outline">{formatDomain(action.domain)}</Badge>
                  </div>
                </div>
                ))}
                {actions.length > 3 ? (
                  <p className="text-xs leading-5 text-slate-500">+{actions.length - 3} more action(s) in the full action plan.</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyReportState
          title="No account-level actions returned"
          body="The audit response did not include prioritized actions. Worklin is preserving the report without inventing action items."
        />
      )}
    </section>
  );
}

function ActionPlanPreview({ audit }: { audit: RetentionAudit }) {
  const [expanded, setExpanded] = useState(false);
  const actions = expanded ? audit.prioritizedActions : audit.prioritizedActions.slice(0, 4);

  if (!audit.prioritizedActions.length) return null;

  return (
    <section>
      <SectionHeader title="Action Plan Preview" question="Not execution yet. These are the top operator moves Worklin would turn into a plan next." />
      <div className="grid gap-3 xl:grid-cols-2">
        {actions.map((action, index) => (
          <div key={action.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-4xl">
                <p className="text-xs font-medium uppercase text-slate-500">Action {index + 1}</p>
                <p className="mt-1 text-sm font-semibold leading-6 text-slate-100">{action.label}</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">{action.whyItMatters}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Badge variant={priorityVariant(action.priority)}>{action.priority}</Badge>
                <Badge variant="secondary">{formatDomain(action.domain)}</Badge>
                {action.approvalRequiredLater ? <Badge variant="outline">approval later</Badge> : null}
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_260px]">
              <div className="space-y-2">
                {evidenceForAction(action).slice(0, 3).map((item, evidenceIndex) => (
                  <p key={`${action.id}-${evidenceIndex}`} className="text-xs leading-5 text-slate-500">
                    {item}
                  </p>
                ))}
              </div>
              <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs leading-5 text-slate-400">
                {action.suggestedNextWorklinWorkflow ?? "No workflow suggested"}
              </div>
            </div>
            {action.caveats.length ? (
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {action.caveats.slice(0, 2).map((item, caveatIndex) => (
                  <p key={`${action.id}-caveat-${caveatIndex}`} className="rounded-lg border border-amber-300/15 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-50/85">
                    {item.message}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {audit.prioritizedActions.length > 4 ? (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer actions" : `Show all ${audit.prioritizedActions.length} actions`}
        </Button>
      ) : null}
    </section>
  );
}

function CaveatGroupCard({ title, caveats }: { title: string; caveats: AuditCaveat[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleCaveats = expanded ? caveats : caveats.slice(0, 2);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <Badge variant="warning">{caveats.length}</Badge>
      </div>
      <div className="mt-3 space-y-2">
        {visibleCaveats.map((item, index) => (
          <p key={`${title}-${index}`} className="rounded-lg border border-white/10 bg-black/10 px-3 py-2 text-xs leading-5 text-slate-400">
            {item.message}
          </p>
        ))}
        {caveats.length > 2 ? (
          <button
            type="button"
            className="text-xs font-medium text-orange-200 hover:text-orange-100"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer caveats" : `Show ${caveats.length - 2} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DataConfidence({ audit }: { audit: RetentionAudit }) {
  const groups = groupedCaveats(audit);
  const rows = ([
    ["Performance caveats", groups.performance],
    ["Klaviyo access caveats", groups.klaviyo],
    ["Audience caveats", groups.audience],
    ["Product / Shopify sync caveats", groups.product],
    ["Content / image-heavy caveats", groups.content],
    ["Other caveats", groups.other],
  ] as Array<[string, AuditCaveat[]]>).filter(([, caveats]) => caveats.length);

  return (
    <section>
      <SectionHeader title="Data Confidence / Caveats" question="Visible enough to guide decisions, grouped so the report does not become a wall of caveats." />
      {rows.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(([title, caveats]) => (
            <CaveatGroupCard key={title} title={title} caveats={caveats} />
          ))}
        </div>
      ) : (
        <EmptyReportState
          title="No caveats returned"
          body="This audit response did not include data-confidence caveats. Worklin is not adding limitations that were not present in the source output."
        />
      )}
    </section>
  );
}

function ChartHints({ audit }: { audit: RetentionAudit }) {
  if (!audit.chartHints.length) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.018] p-4 md:p-5">
      <SectionHeader title="Future Visualization Hints" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {audit.chartHints.slice(0, 4).map((hint, index) => (
          <div key={`${hint.title}-${index}`} className="rounded-xl border border-white/10 bg-black/10 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-semibold text-slate-200">{hint.title}</p>
              <Badge variant="outline">{hint.type}</Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {hint.metricKeys.length} metric key(s), {hint.entityIds.length} entity id(s)
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RetentionAuditReport({ audit, compact = false }: { audit: RetentionAudit; compact?: boolean }) {
  const caveatGroups = groupedCaveats(audit);
  const showProductTruth =
    hasScorecardSignal(scorecard(audit, "product")) ||
    hasRecordSignal(audit.lifecycleCoverage.productPlacements) ||
    actionsFor(audit, ["product"], ["product", "revenue anchor", "replenishment", "add-on", "cross-sell"]).length > 0 ||
    insightsFor(audit, ["product"], ["product", "revenue anchor", "replenishment"]).length > 0 ||
    caveatGroups.product.length > 0;
  const showCampaignTruth =
    hasScorecardSignal(scorecard(audit, "campaign")) ||
    hasRecordSignal(audit.lifecycleCoverage.campaignCoverage) ||
    actionsFor(audit, ["campaign", "creative", "offer"], ["campaign", "subject", "product spotlight", "broad", "theme"]).length > 0 ||
    insightsFor(audit, ["campaign", "creative", "offer"], ["campaign", "subject", "broad", "theme"]).length > 0;
  const showFlowTruth =
    hasScorecardSignal(scorecard(audit, "flow")) ||
    hasRecordSignal(audit.lifecycleCoverage.flowCoverage) ||
    actionsFor(audit, ["flow"], ["browse", "welcome", "cart", "checkout", "winback"]).length > 0 ||
    insightsFor(audit, ["flow", "lifecycle", "creative"], ["browse", "welcome", "cart", "checkout", "winback"]).length > 0;
  const showAudienceTruth =
    hasScorecardSignal(scorecard(audit, "audience")) ||
    hasRecordSignal(audit.lifecycleCoverage.audienceCoverage) ||
    actionsFor(audit, ["segment", "lifecycle"], ["audience", "segment", "suppression", "vip", "winback", "replenishment"]).length > 0 ||
    insightsFor(audit, ["segment", "lifecycle"], ["audience", "segment", "suppression", "vip", "winback"]).length > 0 ||
    caveatGroups.audience.length > 0 ||
    caveatGroups.klaviyo.length > 0;
  const hasTruthSection = showProductTruth || showCampaignTruth || showFlowTruth || showAudienceTruth;
  const showLifecycleMap = domainOrder.some((domain) => hasScorecardSignal(scorecard(audit, domain))) || Boolean(audit.lifecycleCoverage.gaps?.length);

  return (
    <div className={cn("mx-auto w-full max-w-[1600px] space-y-6", compact ? "p-0" : "p-0")}>
      <OperatorBriefing audit={audit} />
      <WhatChecked audit={audit} />
      <HealthSnapshot audit={audit} />
      {showProductTruth ? <ProductTruth audit={audit} /> : null}
      {showCampaignTruth ? <CampaignTruth audit={audit} /> : null}
      {showFlowTruth ? <FlowTruth audit={audit} /> : null}
      {showAudienceTruth ? <AudienceTruth audit={audit} /> : null}
      {!hasTruthSection ? (
        <EmptyReportState
          title="No domain truth sections returned"
          body="The retention audit response did not include product, campaign, flow, or audience detail sections. Worklin is showing the summary and source statuses only."
        />
      ) : null}
      {showLifecycleMap ? <LifecycleCoverageMap audit={audit} /> : null}
      <PriorityMatrix audit={audit} />
      <ActionPlanPreview audit={audit} />
      <DataConfidence audit={audit} />
      <ChartHints audit={audit} />
    </div>
  );
}

function EmptyState({ onRun, running }: { onRun: () => void; running: boolean }) {
  return (
    <Card className="border-dashed border-white/15 bg-white/[0.025]">
      <CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
        <div className="mb-5 rounded-full border border-orange-300/25 bg-orange-300/10 p-4 text-orange-200">
          <Sparkles size={28} />
        </div>
        <h2 className="text-2xl font-semibold text-slate-100">No retention audit loaded</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
          Run a live audit or open a persisted Retention Audit WorkflowRun.
        </p>
        <Button onClick={onRun} disabled={running} className="mt-6">
          {running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Run retention audit
        </Button>
      </CardContent>
    </Card>
  );
}

function RecentRuns({
  runs,
  activeId,
  loading,
  loadingWorkflowId,
  onLoad,
}: {
  runs: WorkflowSummary[];
  activeId: string | null;
  loading: boolean;
  loadingWorkflowId: string | null;
  onLoad: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock3 size={18} className="text-slate-400" />
          Recent Retention Audit Runs
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-400">
            Loading runs
          </div>
        ) : runs.length ? (
          runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onLoad(run.id)}
              className={cn(
                "w-full rounded-xl border p-3 text-left transition-colors",
                activeId === run.id
                  ? "border-orange-300/35 bg-orange-300/10"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.055]",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-100">{formatDateTime(run.createdAt)}</p>
                {loadingWorkflowId === run.id ? <Loader2 size={14} className="animate-spin text-orange-300" /> : null}
              </div>
              <p className="mt-1 text-xs text-slate-500">{run.id}</p>
            </button>
          ))
        ) : (
          <p className="text-sm text-slate-500">No persisted retention audits found.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function RetentionAuditCanvas({ entry = "secondary" }: { entry?: "secondary" | "workflow" }) {
  const [audit, setAudit] = useState<RetentionAudit | null>(null);
  const [recentRuns, setRecentRuns] = useState<WorkflowSummary[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingRuns, setIsLoadingRuns] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [loadingWorkflowId, setLoadingWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWorkflow = useCallback(async (id: string) => {
    setLoadingWorkflowId(id);
    setError(null);
    try {
      const data = await parseApiResponse<WorkflowDetailResponse>(await fetch(`/api/agent/workflows/${id}`));
      const parsed = asRetentionAudit(data.workflow?.output, data.workflow?.id);
      if (!parsed) throw new Error("Workflow output is not a retention audit.");
      setAudit(parsed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workflow.");
    } finally {
      setLoadingWorkflowId(null);
      setIsInitialLoad(false);
    }
  }, []);

  const loadRecentRuns = useCallback(async ({ openLatest = false }: { openLatest?: boolean } = {}) => {
    setIsLoadingRuns(true);
    try {
      const data = await parseApiResponse<WorkflowListResponse>(
        await fetch("/api/agent/workflows?type=retention-audit&limit=6"),
      );
      const runs = data.workflows ?? [];
      setRecentRuns(runs);
      if (openLatest && runs[0]?.id) {
        await loadWorkflow(runs[0].id);
      } else {
        setIsInitialLoad(false);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load recent runs.");
      setIsInitialLoad(false);
    } finally {
      setIsLoadingRuns(false);
    }
  }, [loadWorkflow]);

  useEffect(() => {
    const workflowId = new URLSearchParams(window.location.search).get("workflowId");
    if (workflowId) {
      void loadWorkflow(workflowId);
      void loadRecentRuns();
      return;
    }
    void loadRecentRuns({ openLatest: true });
  }, [loadRecentRuns, loadWorkflow]);

  const runAudit = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    try {
      const data = await parseApiResponse<RetentionAudit>(
        await fetch("/api/audits/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      setAudit(data);
      await loadRecentRuns();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run retention audit.");
    } finally {
      setIsRunning(false);
      setIsInitialLoad(false);
    }
  }, [loadRecentRuns]);

  const activeWorkflowId = audit?.workflowId ?? null;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[rgba(10,14,22,0.72)] p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Secondary test surface</Badge>
            <Badge variant="secondary">{entry === "workflow" ? "workflow canvas" : "dev runner"}</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-slate-100">Retention Audit Canvas</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            Primary product path: open a retention audit WorkflowRun in `/agent/workflows?workflowId=...`.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void loadRecentRuns({ openLatest: Boolean(!audit) })} disabled={isLoadingRuns || isRunning}>
            {isLoadingRuns ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </Button>
          <Button onClick={runAudit} disabled={isRunning || loadingWorkflowId !== null}>
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            Run audit
          </Button>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-300/25 bg-red-300/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      {isInitialLoad || isRunning ? (
        <Card>
          <CardContent className="flex min-h-72 items-center justify-center p-8 text-center">
            <div>
              <Loader2 className="mx-auto animate-spin text-orange-300" size={28} />
              <p className="mt-4 text-sm font-medium text-slate-200">
                {isRunning ? "Running retention audit" : "Loading retention audit"}
              </p>
              <p className="mt-1 text-xs text-slate-500">Klaviyo reads can take a little while.</p>
            </div>
          </CardContent>
        </Card>
      ) : audit ? (
        <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            <RetentionAuditReport audit={audit} />
          </div>
          <RecentRuns
            runs={recentRuns}
            activeId={activeWorkflowId}
            loading={isLoadingRuns}
            loadingWorkflowId={loadingWorkflowId}
            onLoad={(id) => void loadWorkflow(id)}
          />
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
          <EmptyState onRun={runAudit} running={isRunning} />
          <RecentRuns
            runs={recentRuns}
            activeId={null}
            loading={isLoadingRuns}
            loadingWorkflowId={loadingWorkflowId}
            onLoad={(id) => void loadWorkflow(id)}
          />
        </section>
      )}
    </div>
  );
}
