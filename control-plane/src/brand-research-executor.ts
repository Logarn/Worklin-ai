import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  BRAND_RESEARCH_TRACKS,
  addBrandResearchRunChildTasks,
  type BrandResearchRunRow,
  type BrandResearchTrack,
  type BrandResearchTrackState,
  claimBrandResearchRunForExecution,
  clearBrandResearchRunLease,
  getBrandResearchRunForUser,
  heartbeatBrandResearchRunLease,
  markBrandResearchRunCompleted,
  markBrandResearchRunFailed,
  markBrandResearchRunProgress,
  setBrandResearchRunBrandBrain,
  setBrandResearchRunParentTask,
} from "./brand-research-runs.js";

export interface BrandResearchDispatcherConfig {
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  trackConcurrency?: number;
  runTimeoutMs?: number;
  heartbeatMs?: number;
  maxConcurrentRuns?: number;
  runtimeClient?: BrandResearchRuntimeClient;
}

export interface BrandResearchRuntimeClient {
  dispatch(
    run: BrandResearchRunRow,
  ): Promise<
    | { status: "started"; parentTaskId: string }
    | { status: "waiting"; detail: string }
    | { status: "failed"; detail: string }
  >;
  poll(run: BrandResearchRunRow): Promise<BrandResearchRuntimePollResult>;
  cancel?(run: BrandResearchRunRow): Promise<void>;
}

export interface BrandResearchChildTask {
  id: string;
  label: string;
  track: BrandResearchTrack;
}

export type BrandResearchRuntimePollResult =
  | { status: "running"; childTasks?: BrandResearchChildTask[] }
  | {
      status: "partial";
      detail: string;
      gaps?: string[];
      childTasks?: BrandResearchChildTask[];
    }
  | {
      status: "failed";
      detail: string;
      childTasks?: BrandResearchChildTask[];
    }
  | {
      status: "saved";
      brandBrainId: string;
      report: unknown;
      qualityAccepted?: boolean;
      qualityFailures?: string[];
      childTasks?: BrandResearchChildTask[];
    };

type ResearchEvidence = {
  id: string;
  url: string;
  sourceType: string;
  provider: string;
};

type ResearchReport = {
  version: "brand_research_v1";
  query: { brandName: string; websiteUrl?: string };
  identity: Record<string, unknown>;
  competitorLandscape: Array<Record<string, unknown>>;
  channelFindings: Record<string, unknown>;
  marketSignals: string[];
  customerSignals: string[];
  trendSignals: string[];
  evidence: ResearchEvidence[];
  gaps: string[];
  safety: {
    readOnly: true;
    publicSourcesOnly: true;
    unsupportedClaimsExcluded: true;
  };
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    : [];
}

function parseTracks(run: BrandResearchRunRow): BrandResearchTrack[] {
  try {
    const parsed = JSON.parse(run.tracks_json) as unknown;
    if (!Array.isArray(parsed)) return [...BRAND_RESEARCH_TRACKS];
    const tracks = parsed.filter(
      (track): track is BrandResearchTrack =>
        typeof track === "string" &&
        (BRAND_RESEARCH_TRACKS as readonly string[]).includes(track),
    );
    return tracks.length ? tracks : [...BRAND_RESEARCH_TRACKS];
  } catch {
    return [...BRAND_RESEARCH_TRACKS];
  }
}

function validateReport(
  value: unknown,
  run: BrandResearchRunRow,
): {
  report?: ResearchReport;
  error?: string;
} {
  if (!isRecord(value) || value.version !== "brand_research_v1") {
    return { error: "The assistant did not save a brand_research_v1 report." };
  }
  if (!isRecord(value.query) || typeof value.query.brandName !== "string") {
    return { error: "The saved report is missing its brand query." };
  }
  if (
    value.query.brandName.trim().toLocaleLowerCase() !==
    run.brand_name.trim().toLocaleLowerCase()
  ) {
    return {
      error: "The saved report does not match this brand research run.",
    };
  }
  if (!isRecord(value.identity) || !isRecord(value.channelFindings)) {
    return { error: "The saved report is missing required research sections." };
  }
  if (
    !isRecord(value.safety) ||
    value.safety.readOnly !== true ||
    value.safety.publicSourcesOnly !== true ||
    value.safety.unsupportedClaimsExcluded !== true
  ) {
    return {
      error:
        "The saved report is missing its public-source safety declaration.",
    };
  }
  const evidence = Array.isArray(value.evidence) ? value.evidence : null;
  if (!evidence)
    return { error: "The saved report is missing its evidence ledger." };

  const normalizedEvidence: ResearchEvidence[] = [];
  for (const item of evidence) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.url !== "string"
    ) {
      return { error: "Every saved evidence item needs an ID and source URL." };
    }
    try {
      const url = new URL(item.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { error: "Evidence sources must use public HTTP URLs." };
      }
    } catch {
      return { error: "Evidence sources must use valid public URLs." };
    }
    normalizedEvidence.push({
      id: item.id,
      url: item.url,
      sourceType:
        typeof item.sourceType === "string" ? item.sourceType : "other",
      provider:
        typeof item.provider === "string" && item.provider.trim()
          ? item.provider.trim()
          : "public-web",
    });
  }

  const gaps = stringList(value.gaps);
  if (normalizedEvidence.length === 0 && gaps.length === 0) {
    return {
      error:
        "A report without evidence must explicitly record why each missing track was not observable.",
    };
  }

  return {
    report: {
      version: "brand_research_v1",
      query: {
        brandName: value.query.brandName,
        ...(typeof value.query.websiteUrl === "string"
          ? { websiteUrl: value.query.websiteUrl }
          : {}),
      },
      identity: value.identity,
      competitorLandscape: Array.isArray(value.competitorLandscape)
        ? value.competitorLandscape.filter(isRecord)
        : [],
      channelFindings: value.channelFindings,
      marketSignals: stringList(value.marketSignals),
      customerSignals: stringList(value.customerSignals),
      trendSignals: stringList(value.trendSignals),
      evidence: normalizedEvidence,
      gaps,
      safety: {
        readOnly: true,
        publicSourcesOnly: true,
        unsupportedClaimsExcluded: true,
      },
    },
  };
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (isRecord(value)) return Object.values(value).some(hasMeaningfulValue);
  return false;
}

function evidenceIdsFor(
  evidence: ResearchEvidence[],
  sourceTypes: string[],
): string[] {
  return evidence
    .filter((item) => sourceTypes.includes(item.sourceType))
    .map((item) => item.id);
}

function providersForEvidenceIds(
  evidence: ResearchEvidence[],
  evidenceIds: string[],
): string[] {
  const selected = new Set(evidenceIds);
  return Array.from(
    new Set(
      evidence
        .filter((item) => selected.has(item.id))
        .map((item) => item.provider),
    ),
  );
}

function reportTrackUpdates(report: ResearchReport): Array<{
  track: BrandResearchTrack;
  status: BrandResearchTrackState;
  evidenceIds: string[];
  providerUsage: string[];
  gaps: string[];
}> {
  const channel = report.channelFindings;
  const sourceGaps = report.gaps.length
    ? report.gaps
    : ["No source-backed observation was saved for this research track."];
  const tracked = (
    track: BrandResearchTrack,
    found: boolean,
    sourceTypes: string[],
  ) => {
    const evidenceIds = found
      ? evidenceIdsFor(report.evidence, sourceTypes)
      : [];
    return {
      track,
      status: !found
        ? ("not_observable" as const)
        : evidenceIds.length > 0
          ? ("complete" as const)
          : ("partial" as const),
      evidenceIds,
      providerUsage: providersForEvidenceIds(report.evidence, evidenceIds),
      gaps: !found
        ? sourceGaps
        : evidenceIds.length > 0
          ? []
          : [`The ${track} findings do not reference track-specific evidence.`],
    };
  };

  const competitorEvidenceIds = report.competitorLandscape.flatMap(
    (competitor) => stringList(competitor.evidenceIds),
  );
  const knownEvidence = new Set(report.evidence.map((item) => item.id));
  const validCompetitorEvidence = competitorEvidenceIds.filter((id) =>
    knownEvidence.has(id),
  );
  const hasCompetitors = report.competitorLandscape.length > 0;

  return [
    tracked("identity_and_offers", hasMeaningfulValue(report.identity), [
      "official_site",
      "press",
    ]),
    {
      track: "competitors",
      status: !hasCompetitors
        ? "not_observable"
        : validCompetitorEvidence.length > 0
          ? "complete"
          : "partial",
      evidenceIds: validCompetitorEvidence,
      providerUsage: providersForEvidenceIds(
        report.evidence,
        validCompetitorEvidence,
      ),
      gaps: !hasCompetitors
        ? sourceGaps
        : validCompetitorEvidence.length > 0
          ? []
          : ["Competitors were named without valid evidence IDs."],
    },
    tracked("seo_and_content", hasMeaningfulValue(channel.seoAndContent), [
      "official_site",
      "search_result",
    ]),
    tracked("social", hasMeaningfulValue(channel.social), ["social_profile"]),
    tracked(
      "email_and_lifecycle",
      hasMeaningfulValue(channel.emailAndLifecycle),
      ["official_site", "competitor_site"],
    ),
    tracked("sms", hasMeaningfulValue(channel.sms), [
      "official_site",
      "competitor_site",
    ]),
    tracked(
      "products_and_launches",
      hasMeaningfulValue(channel.productAndLaunches),
      ["official_site", "press"],
    ),
    tracked(
      "customer_market_investor_trends",
      report.marketSignals.length > 0 ||
        report.customerSignals.length > 0 ||
        report.trendSignals.length > 0,
      ["market_report", "review", "press"],
    ),
  ];
}

function markSeedMissingRun(
  db: Database,
  run: BrandResearchRunRow,
  nowIsoFn: () => string,
): void {
  for (const track of parseTracks(run)) {
    markBrandResearchRunProgress(
      db,
      run.id,
      {
        track,
        status: "not_observable",
        evidenceCount: 0,
        providerGaps: ["No brand name or public website was supplied."],
      },
      nowIsoFn,
    );
  }
  markBrandResearchRunCompleted(db, run.id, nowIsoFn);
}

function markPartialRun(
  db: Database,
  run: BrandResearchRunRow,
  detail: string,
  gaps: string[],
  nowIsoFn: () => string,
): void {
  const tracks = parseTracks(run);
  for (const [index, track] of tracks.entries()) {
    markBrandResearchRunProgress(
      db,
      run.id,
      {
        track,
        status: index === 0 ? "partial" : "not_observable",
        evidenceCount: 0,
        providerGaps: [detail, ...gaps],
        ...(index === 0 ? { error: detail } : {}),
      },
      nowIsoFn,
    );
  }
}

function persistSavedReport(
  db: Database,
  run: BrandResearchRunRow,
  brandBrainId: string,
  value: unknown,
  qualityAccepted: boolean | undefined,
  qualityFailures: string[],
  nowIsoFn: () => string,
): void {
  const validation = validateReport(value, run);
  if (!validation.report) {
    markPartialRun(
      db,
      run,
      validation.error ?? "The saved research report could not be validated.",
      [],
      nowIsoFn,
    );
    return;
  }

  if (!brandBrainId.trim()) {
    markPartialRun(
      db,
      run,
      "The assistant reported success without a persisted Brand Brain identifier.",
      [],
      nowIsoFn,
    );
    return;
  }

  setBrandResearchRunBrandBrain(db, run.id, brandBrainId, nowIsoFn);
  for (const update of reportTrackUpdates(validation.report)) {
    markBrandResearchRunProgress(
      db,
      run.id,
      {
        track: update.track,
        status: update.status,
        evidenceCount: update.evidenceIds.length,
        evidenceIds: update.evidenceIds,
        providerUsage: update.providerUsage,
        providerGaps: update.gaps,
      },
      nowIsoFn,
    );
  }

  const isDeepReport =
    isRecord(value) &&
    isRecord(value.intelligence) &&
    value.intelligence.contractVersion === "brand_intelligence_v1";
  if (isDeepReport && qualityAccepted !== true) {
    const detail =
      qualityFailures.length > 0
        ? `More research is needed: ${qualityFailures.join(" ")}`
        : "More research is needed before this report can be called complete.";
    markBrandResearchRunProgress(
      db,
      run.id,
      {
        track: "identity_and_offers",
        status: "partial",
        providerGaps: [detail],
        error: detail,
      },
      nowIsoFn,
    );
  }
}

function currentRun(
  db: Database,
  run: BrandResearchRunRow,
): BrandResearchRunRow | null {
  return getBrandResearchRunForUser(db, run.id, run.user_id);
}

function persistObservedChildTasks(
  db: Database,
  runId: string,
  childTasks: BrandResearchChildTask[] | undefined,
  nowIsoFn: () => string,
): void {
  if (!childTasks?.length) return;
  const addedIds = new Set(
    addBrandResearchRunChildTasks(
      db,
      runId,
      childTasks.map((task) => task.id),
      nowIsoFn,
    ),
  );
  for (const task of childTasks) {
    if (!addedIds.has(task.id)) continue;
    markBrandResearchRunProgress(
      db,
      runId,
      {
        track: task.track,
        status: "running",
      },
      nowIsoFn,
    );
  }
}

async function runOnceWorker(
  db: Database,
  run: BrandResearchRunRow,
  leaseToken: string,
  leaseTtlMs: number,
  heartbeatMs: number,
  runTimeoutMs: number,
  pollIntervalMs: number,
  runtimeClient: BrandResearchRuntimeClient | undefined,
  nowIsoFn: () => string,
): Promise<void> {
  let cancelled: BrandResearchRunRow | null = null;
  const startedAt = run.started_at ? Date.parse(run.started_at) : Date.now();
  const deadline = Number.isFinite(startedAt)
    ? startedAt + runTimeoutMs
    : Date.now() + runTimeoutMs;
  const heartbeatTimer = setInterval(() => {
    heartbeatBrandResearchRunLease(
      db,
      run.id,
      leaseToken,
      new Date(Date.now() + leaseTtlMs).toISOString(),
      nowIsoFn,
    );
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  try {
    if (run.seed_missing_reason === "seedMissing") {
      markSeedMissingRun(db, run, nowIsoFn);
      return;
    }
    if (!runtimeClient) {
      markBrandResearchRunFailed(
        db,
        run.id,
        nowIsoFn,
        "No durable assistant research dispatcher is configured.",
      );
      return;
    }

    while (true) {
      const current = currentRun(db, run);
      if (!current) return;
      if (current.status === "cancelled") {
        cancelled = current;
        return;
      }
      if (current.status !== "running") return;
      if (Date.now() > deadline) {
        markBrandResearchRunFailed(
          db,
          run.id,
          nowIsoFn,
          "Brand research run exceeded the 15-minute execution limit.",
        );
        return;
      }

      if (!current.parent_task_id) {
        const dispatch = await runtimeClient.dispatch(current);
        if (dispatch.status === "failed") {
          markBrandResearchRunFailed(db, run.id, nowIsoFn, dispatch.detail);
          return;
        }
        if (dispatch.status === "waiting") {
          await sleep(pollIntervalMs);
          continue;
        }
        setBrandResearchRunParentTask(
          db,
          current.id,
          dispatch.parentTaskId,
          nowIsoFn,
        );
        await sleep(pollIntervalMs);
        continue;
      }

      const result = await runtimeClient.poll(current);
      persistObservedChildTasks(db, run.id, result.childTasks, nowIsoFn);
      if (result.status === "running") {
        await sleep(pollIntervalMs);
        continue;
      }
      if (result.status === "failed") {
        markBrandResearchRunFailed(db, run.id, nowIsoFn, result.detail);
        return;
      }
      if (result.status === "partial") {
        markPartialRun(db, run, result.detail, result.gaps ?? [], nowIsoFn);
        return;
      }
      persistSavedReport(
        db,
        currentRun(db, run) ?? current,
        result.brandBrainId,
        result.report,
        result.qualityAccepted,
        result.qualityFailures ?? [],
        nowIsoFn,
      );
      return;
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearBrandResearchRunLease(db, run.id, leaseToken);
    if (cancelled && runtimeClient?.cancel) {
      try {
        await runtimeClient.cancel(cancelled);
      } catch {
        // The durable cancellation state is already authoritative. The next
        // runtime wake observes it even when a transport cancellation fails.
      }
    }
  }
}

function nestedValue(
  value: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 5 || !isRecord(value)) return null;
  if (value.version === "brand_research_v1" && Array.isArray(value.evidence)) {
    return value;
  }
  for (const key of ["report", "input", "arguments", "params", "data"]) {
    const found = nestedValue(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

type SavedBrandBrainResult = {
  brandBrainId: string;
  qualityAccepted?: boolean;
  qualityFailures: string[];
};

function savedBrandBrainResult(result: unknown): SavedBrandBrainResult | null {
  if (typeof result === "string") {
    try {
      return savedBrandBrainResult(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (!isRecord(result)) return null;
  if (result.saved === true) {
    const brandBrainId =
      result.artifactSaved === true &&
      typeof result.brandId === "string" &&
      result.brandId.trim()
        ? result.brandId.trim()
        : "";
    if (!brandBrainId) return null;
    return {
      brandBrainId,
      ...(typeof result.qualityAccepted === "boolean"
        ? { qualityAccepted: result.qualityAccepted }
        : {}),
      qualityFailures: stringList(result.qualityFailures),
    };
  }
  for (const key of ["content", "result", "data"]) {
    const found = savedBrandBrainResult(result[key]);
    if (found) return found;
  }
  return null;
}

function subagentSpawnResult(
  value: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return subagentSpawnResult(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (typeof value.subagentId === "string") return value;
  for (const key of ["content", "result", "data", "output"]) {
    const found = subagentSpawnResult(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function researchTrackForLabel(label: string): BrandResearchTrack | null {
  const prefix = "brand-research:";
  if (!label.startsWith(prefix)) return null;
  const [track] = label.slice(prefix.length).split(":");
  if (!track) return null;
  return (BRAND_RESEARCH_TRACKS as readonly string[]).includes(track)
    ? (track as BrandResearchTrack)
    : null;
}

function observedChildTasks(messages: unknown[]): BrandResearchChildTask[] {
  const tasks = new Map<string, BrandResearchChildTask>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const name = typeof toolCall.name === "string" ? toolCall.name : "";
      const input = isRecord(toolCall.input) ? toolCall.input : {};
      const innerTool = typeof input.tool === "string" ? input.tool : "";
      if (name !== "subagent_spawn" && innerTool !== "subagent_spawn") {
        continue;
      }
      const payload = isRecord(input.input) ? input.input : input;
      const label = typeof payload.label === "string" ? payload.label : "";
      const track = researchTrackForLabel(label);
      const result = subagentSpawnResult(toolCall.result);
      const id =
        result && typeof result.subagentId === "string"
          ? result.subagentId.trim()
          : "";
      if (!id || !track) continue;
      tasks.set(id, { id, label, track });
    }
  }
  return [...tasks.values()];
}

/**
 * Interpret the assistant transcript without trusting prose. Completion is
 * recognized only when the Brand Brain save tool returned a persisted ID.
 */
export function readBrandResearchRuntimeResult(
  messages: unknown,
): BrandResearchRuntimePollResult {
  if (!Array.isArray(messages)) return { status: "running" };
  const childTasks = observedChildTasks(messages);
  const observedTasks = childTasks.length > 0 ? { childTasks } : {};

  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const name = typeof toolCall.name === "string" ? toolCall.name : "";
      const input = isRecord(toolCall.input) ? toolCall.input : {};
      const innerTool = typeof input.tool === "string" ? input.tool : "";
      if (
        name !== "brand_research_save" &&
        innerTool !== "brand_research_save"
      ) {
        continue;
      }
      const report = nestedValue(input);
      const saved = savedBrandBrainResult(toolCall.result);
      if (report && saved) {
        return {
          status: "saved",
          brandBrainId: saved.brandBrainId,
          report,
          ...(typeof saved.qualityAccepted === "boolean"
            ? { qualityAccepted: saved.qualityAccepted }
            : {}),
          ...(saved.qualityFailures.length > 0
            ? { qualityFailures: saved.qualityFailures }
            : {}),
          ...observedTasks,
        };
      }
      return {
        status: "partial",
        detail:
          "The research assistant finished without a confirmed Brand Brain save.",
        ...observedTasks,
      };
    }

    const content = typeof message.content === "string" ? message.content : "";
    const marker =
      /WORKLIN_RESEARCH_RUN_STATUS:\s*(saved|partial|failed)/i.exec(content);
    if (!marker) continue;
    if (marker[1]!.toLowerCase() === "failed") {
      return {
        status: "failed",
        detail: "The research assistant reported a failed run.",
        ...observedTasks,
      };
    }
    return {
      status: "partial",
      detail:
        "The research assistant ended without a confirmed Brand Brain save.",
      ...observedTasks,
    };
  }
  return { status: "running", ...observedTasks };
}

export function createBrandResearchExecutor(
  db: Database,
  nowIsoFn: () => string = nowIso,
  config: BrandResearchDispatcherConfig = {},
) {
  const leaseTtlMs = Math.max(config.leaseTtlMs ?? 20_000, 2_000);
  const heartbeatMs = Math.max(config.heartbeatMs ?? 5_000, 1_000);
  const pollIntervalMs = Math.max(config.pollIntervalMs ?? 2_000, 100);
  const runTimeoutMs = config.runTimeoutMs ?? 15 * 60 * 1000;
  const maxConcurrentRuns = Math.max(config.maxConcurrentRuns ?? 2, 1);
  const activeRuns = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOneTick = async (): Promise<void> => {
    const started: Promise<void>[] = [];
    while (activeRuns.size < maxConcurrentRuns) {
      const leaseToken = randomUUID();
      const run = claimBrandResearchRunForExecution(
        db,
        leaseToken,
        new Date(Date.now() + leaseTtlMs).toISOString(),
        nowIsoFn,
      );
      if (!run) break;

      const task = runOnceWorker(
        db,
        run,
        leaseToken,
        leaseTtlMs,
        heartbeatMs,
        runTimeoutMs,
        pollIntervalMs,
        config.runtimeClient,
        nowIsoFn,
      ).catch((error) => {
        markBrandResearchRunFailed(
          db,
          run.id,
          nowIsoFn,
          error instanceof Error ? error.message : String(error),
        );
      });
      const tracked = task.finally(() => activeRuns.delete(run.id));
      activeRuns.set(run.id, tracked);
      started.push(tracked);
    }
    await Promise.all(started);
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = setInterval(
      () => {
        void runOneTick();
      },
      Math.max(config.pollIntervalMs ?? 4_000, 1_000),
    );
    timer.unref?.();
    void runOneTick();
  };

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return { start, stop, runOnce: runOneTick };
}
