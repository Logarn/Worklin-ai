"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { asRetentionAudit, RetentionAuditReport } from "@/components/audits/retention-audit-canvas";
import { cn } from "@/lib/utils";

type ApiEnvelope = {
  ok: boolean;
  error?: string;
  issues?: string[];
};

type WorkflowSummary = {
  id: string;
  type: string;
  status: string;
  error: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
};

type WorkflowDetail = WorkflowSummary & {
  input: unknown;
  output: unknown;
};

type WorkflowListResponse = ApiEnvelope & {
  workflows: WorkflowSummary[];
};

type WorkflowDetailResponse = ApiEnvelope & {
  workflow: WorkflowDetail;
};

type PlanItem = {
  id: string;
  title: string;
  campaignType: string;
  goal: string;
  segment: string;
  suggestedSendDate: string;
  subjectLineAngle: string | null;
  primaryProduct: string | null;
  why: string;
  confidenceScore: number | null;
};

type WorkflowPlan = {
  id: string;
  name: string;
  summary: string | null;
  strategyNotes: string | null;
  itemCount: number;
  items: PlanItem[];
};

type BriefSection = {
  id: string;
  type: string;
  heading: string | null;
  body: string;
  sortOrder: number;
};

type WorkflowBrief = {
  id: string;
  title: string;
  campaignType: string;
  segment: string;
  goal: string;
  subjectLines: string[];
  previewTexts: string[];
  angle: string;
  primaryProduct: string | null;
  status: string;
  designNotes: string | null;
  cta: string | null;
  sections?: BriefSection[];
};

type QaMessage = {
  code: string;
  message: string;
  field?: string;
};

type WorkflowQaResult = {
  id: string;
  briefId: string;
  status: string;
  score: number;
  issues: QaMessage[];
  warnings: QaMessage[];
  recommendedNextAction: string;
};

type WorkflowOutput = ApiEnvelope & {
  workflowId: string | null;
  plan?: WorkflowPlan;
  briefs?: WorkflowBrief[];
  qaResults?: WorkflowQaResult[];
  summary?: {
    text?: string;
    planItems?: number;
    briefsGenerated?: number;
    qa?: {
      passed?: number;
      warning?: number;
      failed?: number;
      averageScore?: number;
    };
  };
  recommendedNextAction?: string;
};

const defaultPrompt =
  "Plan 3 retention campaigns for next week. No discounts. Include one VIP campaign.";

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

function asWorkflowOutput(value: unknown): WorkflowOutput | null {
  if (!isRecord(value)) return null;
  return value as WorkflowOutput;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asPlan(value: unknown): WorkflowPlan | null {
  if (!isRecord(value)) return null;
  return {
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name : "Untitled plan",
    summary: typeof value.summary === "string" ? value.summary : null,
    strategyNotes: typeof value.strategyNotes === "string" ? value.strategyNotes : null,
    itemCount: typeof value.itemCount === "number" ? value.itemCount : asArray<PlanItem>(value.items).length,
    items: asArray<PlanItem>(value.items),
  };
}

function getWorkflowBriefs(output: WorkflowOutput | null) {
  return asArray<WorkflowBrief>(output?.briefs);
}

function getWorkflowQaResults(output: WorkflowOutput | null) {
  return asArray<WorkflowQaResult>(output?.qaResults);
}

function splitConstraints(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
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

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) return "No score";
  return `${Math.round(value * 100)}%`;
}

function statusVariant(status: string | undefined): "success" | "warning" | "destructive" | "outline" | "secondary" {
  if (status === "completed" || status === "passed") return "success";
  if (status === "running" || status === "warning") return "warning";
  if (status === "failed") return "destructive";
  return "secondary";
}

function qaTone(status: string | undefined) {
  if (status === "passed") return "border-emerald-300/25 bg-emerald-400/10";
  if (status === "warning") return "border-amber-300/25 bg-amber-400/10";
  if (status === "failed") return "border-red-300/25 bg-red-400/10";
  return "border-white/10 bg-white/[0.03]";
}

function messageList(items: QaMessage[] | undefined, emptyText: string, tone: "issue" | "warning") {
  if (!items?.length) {
    return <p className="text-sm text-slate-400">{emptyText}</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item.code}-${index}`}
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            tone === "issue"
              ? "border-red-300/20 bg-red-400/10 text-red-100"
              : "border-amber-300/20 bg-amber-400/10 text-amber-100",
          )}
        >
          {item.message}
          {item.field ? <span className="ml-1 text-xs opacity-70">({item.field})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function WorkflowLoadingShell({ error }: { error: string | null }) {
  return (
    <div className="w-full space-y-5 p-4 md:p-6">
      <header className="rounded-2xl border border-white/10 bg-[rgba(10,14,22,0.72)] px-5 py-4 shadow-[0_18px_60px_rgba(2,6,23,0.32)]">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-300/15 text-orange-200">
            <Loader2 className="h-5 w-5 animate-spin" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-slate-50">Opening workflow</h1>
            <p className="text-sm text-slate-400">Loading the selected WorkflowRun.</p>
          </div>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}

      <section className="surface-soft flex min-h-[420px] flex-col items-center justify-center gap-4 p-4 text-center md:p-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-300/25 bg-orange-300/10">
          <Loader2 className="h-6 w-6 animate-spin text-orange-200" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-100">Loading workflow</h2>
          <p className="mt-1 text-sm text-slate-400">Worklin is opening the saved workflow output.</p>
        </div>
      </section>
    </div>
  );
}

function RetentionWorkflowShell({
  workflow,
  audit,
  error,
}: {
  workflow: WorkflowDetail;
  audit: NonNullable<ReturnType<typeof asRetentionAudit>> | null;
  error: string | null;
}) {
  const generatedAt = audit?.metadata.generatedAt ?? workflow.createdAt;

  return (
    <div className="w-full space-y-5 p-4 md:p-6">
      <header className="rounded-2xl border border-white/10 bg-[rgba(10,14,22,0.72)] px-5 py-4 shadow-[0_18px_60px_rgba(2,6,23,0.32)] md:px-6 md:py-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">real connected-account audit</Badge>
              <Badge variant={statusVariant(workflow.status)}>{workflow.status}</Badge>
            </div>
            <h1 className="mt-3 text-2xl font-semibold text-slate-50">Retention Audit</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Worklin prepared this report from the persisted Retention Audit WorkflowRun.
            </p>
          </div>
          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-slate-400 md:text-right">
            <p>Generated {formatDateTime(generatedAt)}</p>
            <p className="mt-1 break-all">Workflow {workflow.id}</p>
          </div>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}

      <section className="surface-soft min-h-[420px] p-4 md:p-6 xl:p-7">
        {audit ? (
          <RetentionAuditReport audit={audit} compact />
        ) : (
          <div className="rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            This WorkflowRun is marked as a retention audit, but the saved output could not be parsed as a Retention Audit response.
          </div>
        )}
      </section>
    </div>
  );
}

export function AgentWorkflowCanvas({
  initialWorkflow = null,
  initialWorkflowId = null,
}: {
  initialWorkflow?: WorkflowDetail | null;
  initialWorkflowId?: string | null;
} = {}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [campaignCount, setCampaignCount] = useState("3");
  const [focus, setFocus] = useState("repeat purchase");
  const [constraints, setConstraints] = useState("no discounts, include one VIP campaign");
  const [recentRuns, setRecentRuns] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDetail | null>(initialWorkflow);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingWorkflowId, setLoadingWorkflowId] = useState<string | null>(
    initialWorkflow ? null : initialWorkflowId,
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const output = useMemo(() => asWorkflowOutput(selectedWorkflow?.output), [selectedWorkflow]);
  const retentionAudit = useMemo(
    () => asRetentionAudit(selectedWorkflow?.output, selectedWorkflow?.id),
    [selectedWorkflow],
  );
  const selectedWorkflowIsRetentionAudit = selectedWorkflow?.type === "retention-audit" || Boolean(retentionAudit);
  const qaByBriefId = useMemo(() => {
    const map = new Map<string, WorkflowQaResult>();
    for (const qa of getWorkflowQaResults(output)) {
      if (qa?.briefId) map.set(qa.briefId, qa);
    }
    return map;
  }, [output]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const [planResponse, retentionResponse] = await Promise.all([
        fetch("/api/agent/workflows?type=plan-brief-qa&limit=8"),
        fetch("/api/agent/workflows?type=retention-audit&limit=4"),
      ]);
      const [planData, retentionData] = await Promise.all([
        parseApiResponse<WorkflowListResponse>(planResponse),
        parseApiResponse<WorkflowListResponse>(retentionResponse),
      ]);
      const workflows = [
        ...asArray<WorkflowSummary>(planData.workflows),
        ...asArray<WorkflowSummary>(retentionData.workflows),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setRecentRuns(workflows.slice(0, 8));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workflows");
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadWorkflow = useCallback(async (id: string) => {
    setLoadingWorkflowId(id);
    setSelectedWorkflow(null);
    setError(null);
    try {
      const response = await fetch(`/api/agent/workflows/${id}`);
      const data = await parseApiResponse<WorkflowDetailResponse>(response);
      setSelectedWorkflow(data.workflow);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workflow");
    } finally {
      setLoadingWorkflowId(null);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const workflowId = initialWorkflowId ?? new URLSearchParams(window.location.search).get("workflowId");
    if (workflowId && initialWorkflow?.id === workflowId) return;
    if (workflowId) void loadWorkflow(workflowId);
  }, [initialWorkflow?.id, initialWorkflowId, loadWorkflow]);

  async function runWorkflow(event?: React.FormEvent | React.MouseEvent) {
    event?.preventDefault();
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      setError("Enter a prompt before running the workflow.");
      return;
    }

    setRunning(true);
    setError(null);

    const payload: Record<string, unknown> = {
      prompt: trimmedPrompt,
    };
    if (startDate.trim()) payload.startDate = startDate.trim();
    if (endDate.trim()) payload.endDate = endDate.trim();
    if (campaignCount.trim()) payload.campaignCount = campaignCount.trim();
    if (focus.trim()) payload.focus = focus.trim();
    const parsedConstraints = splitConstraints(constraints);
    if (parsedConstraints.length) payload.constraints = parsedConstraints;

    try {
      const response = await fetch("/api/agent/workflows/plan-brief-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse<WorkflowOutput>(response);
      if (data.workflowId) {
        await loadWorkflow(data.workflowId);
      }
      await loadRuns();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Workflow failed");
      await loadRuns();
    } finally {
      setRunning(false);
    }
  }

  if (loadingWorkflowId && !selectedWorkflow) {
    return <WorkflowLoadingShell error={error} />;
  }

  if (selectedWorkflow && selectedWorkflowIsRetentionAudit) {
    return <RetentionWorkflowShell workflow={selectedWorkflow} audit={retentionAudit} error={error} />;
  }

  return (
    <div className="w-full space-y-5 p-4 md:p-6">
      <header className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[rgba(10,14,22,0.72)] px-5 py-4 shadow-[0_18px_60px_rgba(2,6,23,0.32)] md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-300/15 text-orange-200">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-semibold text-slate-50">Agent canvas</h1>
              <p className="text-sm text-slate-400">Prompt to plan, brief, and QA.</p>
            </div>
          </div>
        </div>
        {selectedWorkflow ? (
          <Badge variant={statusVariant(selectedWorkflow.status)}>{selectedWorkflow.status}</Badge>
        ) : null}
      </header>

      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="space-y-5">
            <form onSubmit={runWorkflow} className="surface-soft space-y-4 p-4 md:p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <WandSparkles className="h-4 w-4 text-orange-200" />
                  <h2 className="text-sm font-semibold text-slate-100">Request</h2>
                </div>
                <Button type="button" onClick={runWorkflow} disabled={running} className="shrink-0">
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                  Run workflow
                </Button>
              </div>

              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="textarea-base min-h-[108px] resize-y"
                placeholder="Plan retention campaigns for next week..."
                disabled={running}
              />

              <div className="grid gap-3 md:grid-cols-5">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-400">Start</span>
                  <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} disabled={running} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-400">End</span>
                  <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={running} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-400">Count</span>
                  <Input value={campaignCount} onChange={(event) => setCampaignCount(event.target.value)} disabled={running} />
                </label>
                <label className="space-y-1.5 md:col-span-2">
                  <span className="text-xs font-medium text-slate-400">Focus</span>
                  <Input value={focus} onChange={(event) => setFocus(event.target.value)} disabled={running} />
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-400">Constraints</span>
                <Input
                  value={constraints}
                  onChange={(event) => setConstraints(event.target.value)}
                  placeholder="no discounts, include one VIP campaign"
                  disabled={running}
                />
              </label>
            </form>

            <section className="surface-soft min-h-[420px] p-4 md:p-5">
              {running ? (
                <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-300/25 bg-orange-300/10">
                    <Loader2 className="h-6 w-6 animate-spin text-orange-200" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">Running workflow</h2>
                    <p className="mt-1 text-sm text-slate-400">Planning, briefing, and checking QA.</p>
                  </div>
                </div>
              ) : selectedWorkflow ? (
                <WorkflowOutputView workflow={selectedWorkflow} output={output} qaByBriefId={qaByBriefId} />
              ) : (
                <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                    <FileText className="h-6 w-6 text-slate-300" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">No workflow open</h2>
                    <p className="mt-1 text-sm text-slate-400">Run a request or reopen a recent workflow.</p>
                  </div>
                </div>
              )}
            </section>
          </section>

          <aside className="surface-soft h-fit p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-slate-300" />
                <h2 className="text-sm font-semibold text-slate-100">Recent runs</h2>
              </div>
              <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => void loadRuns()} disabled={loadingRuns}>
                <RefreshCw className={cn("h-4 w-4", loadingRuns && "animate-spin")} />
              </Button>
            </div>

            {loadingRuns ? (
              <div className="space-y-2">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-16 animate-pulse rounded-xl bg-white/5" />
                ))}
              </div>
            ) : recentRuns.length ? (
              <div className="space-y-2">
                {recentRuns.map((workflow) => {
                  const active = selectedWorkflow?.id === workflow.id;
                  const loading = loadingWorkflowId === workflow.id;
                  return (
                    <button
                      key={workflow.id}
                      type="button"
                      onClick={() => void loadWorkflow(workflow.id)}
                      className={cn(
                        "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                        active
                          ? "border-orange-300/35 bg-orange-300/10"
                          : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={statusVariant(workflow.status)}>{workflow.status}</Badge>
                        {loading ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : null}
                      </div>
                      <p className="mt-2 truncate text-sm font-medium text-slate-100">{workflow.type}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDateTime(workflow.createdAt)}</p>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-sm text-slate-400">
                No saved workflows yet.
              </p>
            )}
          </aside>
      </div>
    </div>
  );
}

function WorkflowOutputView({
  workflow,
  output,
  qaByBriefId,
}: {
  workflow: WorkflowDetail;
  output: WorkflowOutput | null;
  qaByBriefId: Map<string, WorkflowQaResult>;
}) {
  const retentionAudit = asRetentionAudit(workflow.output, workflow.id);
  if (retentionAudit) {
    return <RetentionAuditReport audit={retentionAudit} compact />;
  }

  if (!output) {
    return (
      <div className="space-y-4">
        <WorkflowHeader workflow={workflow} output={null} />
        <div className="rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          This workflow has no saved output yet. It may still be running, or it was created before output snapshots were stored.
        </div>
      </div>
    );
  }

  const plan = asPlan(output.plan);
  const planItems = plan?.items ?? [];
  const briefs = getWorkflowBriefs(output);

  if (!output.ok) {
    return (
      <div className="space-y-4">
        <WorkflowHeader workflow={workflow} output={output} />
        <div className="rounded-xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {output.error ?? workflow.error ?? "Workflow failed."}
          {output.issues?.length ? <p className="mt-1 text-red-100/80">{output.issues.join(" ")}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <WorkflowHeader workflow={workflow} output={output} />

      {plan ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-orange-200" />
            <h2 className="text-sm font-semibold text-slate-100">Plan</h2>
          </div>
          <div className="grid gap-3">
            {planItems.length ? planItems.map((item, index) => (
              <article key={item.id || `plan-item-${index}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">{item.title || `Plan item ${index + 1}`}</h3>
                    <p className="mt-1 text-sm text-slate-400">{item.goal || "No goal saved."}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{item.campaignType || "Campaign"}</Badge>
                    <Badge variant="outline">{formatDate(item.suggestedSendDate)}</Badge>
                  </div>
                </div>
                <div className="mt-3 grid gap-3 text-sm text-slate-300 md:grid-cols-3">
                  <p>
                    <span className="text-slate-500">Segment</span>
                    <br />
                    {item.segment || "Not set"}
                  </p>
                  <p>
                    <span className="text-slate-500">Angle</span>
                    <br />
                    {item.subjectLineAngle ?? "Not set"}
                  </p>
                  <p>
                    <span className="text-slate-500">Confidence</span>
                    <br />
                    {formatPercent(item.confidenceScore)}
                  </p>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-300">{item.why || "No reasoning saved."}</p>
              </article>
            )) : (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
                No plan items were saved for this workflow.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-orange-200" />
          <h2 className="text-sm font-semibold text-slate-100">Briefs and QA</h2>
        </div>
        <div className="space-y-3">
          {briefs.length ? briefs.map((brief, index) => {
            const qa = qaByBriefId.get(brief.id);
            return <BriefReview key={brief.id || `brief-${index}`} brief={brief} qa={qa} />;
          }) : (
            <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
              No generated briefs were saved for this workflow.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function WorkflowHeader({ workflow, output }: { workflow: WorkflowDetail; output: WorkflowOutput | null }) {
  const qa = output?.summary?.qa;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(workflow.status)}>{workflow.status}</Badge>
            <span className="text-xs text-slate-500">{formatDateTime(workflow.createdAt)}</span>
          </div>
          <h2 className="mt-2 text-lg font-semibold text-slate-50">{output?.summary?.text ?? workflow.type}</h2>
        </div>
        {qa ? (
          <div className="grid grid-cols-4 gap-2 text-center">
            <Metric label="Items" value={String(output?.summary?.planItems ?? 0)} />
            <Metric label="Briefs" value={String(output?.summary?.briefsGenerated ?? 0)} />
            <Metric label="QA" value={String(qa.averageScore ?? 0)} />
            <Metric label="Pass" value={String(qa.passed ?? 0)} />
          </div>
        ) : null}
      </div>

      {output?.recommendedNextAction ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200" />
          <p className="text-sm leading-6 text-emerald-50">{output.recommendedNextAction}</p>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-14 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
      <p className="text-sm font-semibold text-slate-100">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

function BriefReview({ brief, qa }: { brief: WorkflowBrief; qa: WorkflowQaResult | undefined }) {
  const subjectLines = asArray<string>(brief.subjectLines);
  const previewTexts = asArray<string>(brief.previewTexts);
  const sections = asArray<BriefSection>(brief.sections);

  return (
    <article className={cn("rounded-xl border p-4", qaTone(qa?.status))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{brief.title || "Untitled brief"}</h3>
          <p className="mt-1 text-sm text-slate-400">{brief.angle || "No angle saved."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{brief.campaignType || "Campaign"}</Badge>
          {qa ? <Badge variant={statusVariant(qa.status)}>{qa.status} · {qa.score}</Badge> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Subject lines</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {subjectLines.length ? subjectLines.map((subject) => (
              <span key={subject} className="rounded-full border border-white/10 bg-black/15 px-2.5 py-1 text-xs text-slate-200">
                {subject}
              </span>
            )) : <p className="text-sm text-slate-400">No subject lines saved.</p>}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Preview text</p>
          <p className="mt-2 text-sm text-slate-300">{previewTexts[0] ?? "Not set"}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Issues</p>
          <div className="mt-2">{messageList(qa?.issues, "No issues.", "issue")}</div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Warnings</p>
          <div className="mt-2">{messageList(qa?.warnings, "No warnings.", "warning")}</div>
        </div>
      </div>

      {sections.length ? (
        <details className="mt-4 rounded-lg border border-white/10 bg-black/10 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">Sections</summary>
          <div className="mt-3 space-y-3">
            {sections.map((section, index) => (
              <div key={section.id || `section-${index}`} className="border-t border-white/10 pt-3">
                <p className="text-xs font-semibold uppercase text-slate-500">{section.type || `section ${index + 1}`}</p>
                {section.heading ? <p className="mt-1 text-sm font-medium text-slate-100">{section.heading}</p> : null}
                <p className="mt-1 text-sm leading-6 text-slate-300">{section.body || "No body saved."}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}
