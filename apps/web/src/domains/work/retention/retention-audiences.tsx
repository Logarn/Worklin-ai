import {
  AlertCircle,
  Check,
  Clock3,
  Download,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/utils/conversation-selection";
import { routes } from "@/utils/routes";
import { Button, ProgressBar } from "@vellumai/design-library";

import {
  RetentionApiError,
  type RetentionSegment,
  type RetentionSegmentRun,
} from "./retention-api";
import {
  useRetentionAudiences,
  useRetentionSegmentRun,
  useStartRetentionSegmentRun,
} from "./use-retention-audiences";

const DEFAULT_SEGMENT_LIMIT = 10;
const SAMPLE_LIMIT = 2;

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function retentionAudienceSummaryCsv(
  segments: RetentionSegment[],
): string {
  const rows = segments.map((segment) => [
    segment.name,
    segment.description,
    segment.totalCount,
    segment.eligibleCount,
    Math.round(segment.confidence * 100),
    changeLabel(segment.changeSincePriorRun),
    segment.evidence
      .map((item) => `${item.signal}: ${item.explanation}`)
      .join(" | "),
    segment.campaignConcept?.objective ?? "",
    segment.campaignConcept?.angle ?? "",
    segment.campaignConcept?.timing ?? "",
    segment.campaignConcept?.callToAction ?? "",
    segment.campaignConcept?.offer ?? "",
  ]);
  return [
    [
      "Audience",
      "Definition",
      "People",
      "Can receive email",
      "Confidence percent",
      "Change since prior review",
      "Supporting evidence",
      "Campaign objective",
      "Campaign angle",
      "Timing",
      "Call to action",
      "Offer",
    ],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

function downloadRetentionAudienceSummary(segments: RetentionSegment[]): void {
  const blob = new Blob([retentionAudienceSummaryCsv(segments)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "worklin-audience-summary.csv";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function retentionCampaignReviewPrompt(
  _brandId: string,
  _runId: string,
): string {
  return "Create this week's email campaigns for this brand.";
}

function storedRunKey(assistantId: string, brandId: string | null): string {
  return `worklin:retention:segment-run:${assistantId}:${brandId ?? "none"}`;
}

function readStoredRunId(assistantId: string, brandId: string | null): string | null {
  try {
    return sessionStorage.getItem(storedRunKey(assistantId, brandId));
  } catch {
    return null;
  }
}

function storeRunId(
  assistantId: string,
  brandId: string | null,
  runId: string | null,
): void {
  try {
    if (runId) {
      sessionStorage.setItem(storedRunKey(assistantId, brandId), runId);
    } else {
      sessionStorage.removeItem(storedRunKey(assistantId, brandId));
    }
  } catch {
    // Session storage is only a reload convenience. The server remains truth.
  }
}

function runLabel(status: RetentionSegmentRun["status"]): string {
  const labels: Record<RetentionSegmentRun["status"], string> = {
    queued: "Waiting to start",
    claimed: "Building audiences",
    paused: "Paused safely",
    completed: "Review ready",
    failed: "Needs another try",
  };
  return labels[status];
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High confidence";
  if (confidence >= 0.6) return "Medium confidence";
  return "Early signal";
}

function changeLabel(change: number | null): string {
  if (change === null) return "Not measured yet";
  if (change === 0) return "No change since the last review";
  const direction = change > 0 ? "more" : "fewer";
  return `${Math.abs(change).toLocaleString()} ${direction} since the last review`;
}

function audienceErrorMessage(error: unknown): string {
  if (error instanceof RetentionApiError) {
    if (error.status === 403) {
      return "You do not have access to this brand's audience review.";
    }
    if (error.status === 404 || error.status === 503) {
      return "Audience review is not ready for this workspace yet.";
    }
    if (error.status === 429 || error.code === "model_usage_limited") {
      return "ChatGPT usage is temporarily limited. Your progress is saved and can be resumed later.";
    }
  }
  return "Worklin could not load this audience review right now.";
}

function RunProgress({ run }: { run: RetentionSegmentRun }) {
  const progress =
    run.totalSegments > 0
      ? run.completedSegments / run.totalSegments
      : run.status === "completed"
        ? 1
        : 0;
  const isWorking = run.status === "queued" || run.status === "claimed";

  return (
    <section
      className="border-y border-[var(--border-base)] py-4"
      aria-labelledby="audience-progress-heading"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          {isWorking ? (
            <Loader2
              className="mt-0.5 size-5 shrink-0 animate-spin text-[var(--content-secondary)]"
              aria-hidden="true"
            />
          ) : run.status === "completed" ? (
            <Check
              className="mt-0.5 size-5 shrink-0 text-[var(--content-success)]"
              aria-hidden="true"
            />
          ) : (
            <Clock3
              className="mt-0.5 size-5 shrink-0 text-[var(--content-secondary)]"
              aria-hidden="true"
            />
          )}
          <div>
            <h2
              id="audience-progress-heading"
              className="text-body-medium-default text-[var(--content-emphasised)]"
            >
              {runLabel(run.status)}
            </h2>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              {run.completedSegments.toLocaleString()} of{" "}
              {run.totalSegments.toLocaleString()} audiences prepared
              {run.cohortCount
                ? ` from ${run.cohortCount.toLocaleString()} frozen profiles`
                : ""}
            </p>
          </div>
        </div>
        <span className="text-body-small-default text-[var(--content-tertiary)]">
          Up to {run.maxSegments} audiences · 2 samples each
        </span>
      </div>
      <ProgressBar
        className="mt-4"
        value={progress}
        aria-label="Audience review progress"
      />
    </section>
  );
}

function SampleMessage({
  sample,
  index,
}: {
  sample: RetentionSegment["sampleMessages"][number];
  index: number;
}) {
  const blocked = sample.qualityStatus === "blocked";
  return (
    <div className="min-w-0 border-l-2 border-[var(--border-base)] pl-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label-small text-[var(--content-tertiary)]">
          SAMPLE {index + 1}
        </p>
        {sample.qualityStatus === "needs_review" ? (
          <span className="text-body-small-default text-[var(--system-warning-strong)]">
            Needs review
          </span>
        ) : null}
      </div>
      {blocked ? (
        <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
          This sample was withheld because it did not pass the quality check.
        </p>
      ) : (
        <>
          <p className="mt-3 break-words text-body-medium-default text-[var(--content-emphasised)]">
            {sample.subject}
          </p>
          {sample.preheader ? (
            <p className="mt-1 break-words text-body-small-default text-[var(--content-tertiary)]">
              {sample.preheader}
            </p>
          ) : null}
          <p className="mt-3 whitespace-pre-wrap break-words text-body-small-default text-[var(--content-secondary)]">
            {sample.body}
          </p>
          <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
            Why this version: {sample.explanation}
          </p>
        </>
      )}
    </div>
  );
}

function AudienceRow({ segment }: { segment: RetentionSegment }) {
  return (
    <article className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h2 className="break-words text-title-small text-[var(--content-emphasised)]">
            {segment.name}
          </h2>
          <p className="mt-2 max-w-3xl text-body-small-default text-[var(--content-secondary)]">
            {segment.description}
          </p>
        </div>
        <span className="shrink-0 text-body-small-default text-[var(--content-success)]">
          {confidenceLabel(segment.confidence)} ·{" "}
          {Math.round(segment.confidence * 100)}%
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-[var(--border-base)] py-4 sm:grid-cols-3">
        <div>
          <dt className="text-label-small text-[var(--content-tertiary)]">
            PEOPLE
          </dt>
          <dd className="mt-1 text-title-medium tabular-nums text-[var(--content-emphasised)]">
            {segment.totalCount.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-label-small text-[var(--content-tertiary)]">
            CAN RECEIVE EMAIL
          </dt>
          <dd className="mt-1 text-title-medium tabular-nums text-[var(--content-emphasised)]">
            {segment.eligibleCount.toLocaleString()}
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-label-small text-[var(--content-tertiary)]">
            CHANGE
          </dt>
          <dd className="mt-1 text-body-small-default text-[var(--content-default)]">
            {changeLabel(segment.changeSincePriorRun)}
          </dd>
        </div>
      </dl>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section aria-label={`Evidence for ${segment.name}`}>
          <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
            Why Worklin found this audience
          </h3>
          {segment.evidence.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {segment.evidence.map((item, index) => (
                <li
                  key={`${item.signal}-${index}`}
                  className="flex items-start gap-2 text-body-small-default text-[var(--content-secondary)]"
                >
                  <span
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--content-success)]"
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="font-medium text-[var(--content-default)]">
                      {item.signal}
                    </strong>
                    {`. ${item.explanation}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              Evidence is still being prepared.
            </p>
          )}
        </section>

        <section aria-label={`Campaign concept for ${segment.name}`}>
          <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
            Campaign idea
          </h3>
          {segment.campaignConcept ? (
            <div className="mt-3 border-l-2 border-[var(--content-success)] pl-4">
              <p className="text-body-medium-default text-[var(--content-default)]">
                {segment.campaignConcept.objective}
              </p>
              <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
                {segment.campaignConcept.angle}
              </p>
              <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                {segment.campaignConcept.timing} ·{" "}
                {segment.campaignConcept.callToAction}
              </p>
              {segment.campaignConcept.offer ? (
                <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                  Offer: {segment.campaignConcept.offer}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              The campaign idea is still being prepared.
            </p>
          )}
        </section>
      </div>

      <section
        className="mt-6 border-t border-[var(--border-base)] pt-5"
        aria-label={`Message samples for ${segment.name}`}
      >
        <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
          Representative emails
        </h3>
        {segment.sampleMessages.length > 0 ? (
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            {segment.sampleMessages
              .slice(0, SAMPLE_LIMIT)
              .map((sample, index) => (
                <SampleMessage
                  key={`${sample.subject}-${index}`}
                  sample={sample}
                  index={index}
                />
              ))}
          </div>
        ) : (
          <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
            Message samples are still being prepared.
          </p>
        )}
      </section>
    </article>
  );
}

export function RetentionAudiences({
  assistantId,
  selectedBrandId,
}: {
  assistantId: string;
  selectedBrandId: string | null;
}) {
  const navigate = useNavigate();
  const audiences = useRetentionAudiences(assistantId, selectedBrandId);
  const [runId, setRunId] = useState<string | null>(() =>
    readStoredRunId(assistantId, selectedBrandId),
  );
  const [segmentLimit, setSegmentLimit] = useState(DEFAULT_SEGMENT_LIMIT);
  const run = useRetentionSegmentRun(assistantId, runId);
  const startRun = useStartRetentionSegmentRun(assistantId);

  useEffect(() => {
    const stored = readStoredRunId(assistantId, selectedBrandId);
    setRunId(stored);
  }, [assistantId, selectedBrandId]);

  const refetchSegments = audiences.segments.refetch;

  useEffect(() => {
    if (run.data?.status === "completed") {
      void refetchSegments();
    }
  }, [refetchSegments, run.data?.status]);

  useEffect(() => {
    if (
      run.error instanceof RetentionApiError &&
      (run.error.status === 403 || run.error.status === 404)
    ) {
      storeRunId(assistantId, selectedBrandId, null);
      setRunId(null);
    }
  }, [assistantId, run.error, selectedBrandId]);

  const brandId = audiences.brandId;
  const segments = audiences.segments.data ?? [];
  const activeRun = run.data ?? startRun.data;
  const working =
    activeRun?.status === "queued" || activeRun?.status === "claimed";
  const resumable =
    activeRun?.status === "paused" || activeRun?.status === "failed";

  function beginReview() {
    if (!brandId) return;
    startRun.mutate(
      {
        brandId,
        maxSegments: segmentLimit,
        sampleLimitPerSegment: SAMPLE_LIMIT,
      },
      {
        onSuccess: (nextRun) => {
          storeRunId(assistantId, selectedBrandId, nextRun.id);
          setRunId(nextRun.id);
          const draftConversationId = createDraftConversationId();
          useConversationStore
            .getState()
            .setActiveConversationId(draftConversationId);
          useViewerStore.getState().setMainView("chat");
          const prompt = retentionCampaignReviewPrompt(
            nextRun.brandId,
            nextRun.id,
          );
          void navigate(
            `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
          );
        },
      },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex items-start gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3">
        <LockKeyhole
          className="mt-0.5 size-5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden="true"
        />
        <div>
          <p className="text-body-medium-default text-[var(--content-emphasised)]">
            Review only
          </p>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Worklin can prepare audiences and examples. Nothing here creates a
            Klaviyo campaign or sends a message.
          </p>
        </div>
      </div>

      {audiences.imports.isPending ? (
        <div className="flex items-center justify-center gap-2 py-20 text-body-small-default text-[var(--content-tertiary)]">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Finding the connected brand
        </div>
      ) : audiences.imports.isError ? (
        <div
          className="flex flex-col items-center py-20 text-center"
          role="alert"
        >
          <AlertCircle className="size-7 text-[var(--system-warning-strong)]" />
          <p className="mt-3 text-body-medium-default text-[var(--content-default)]">
            Audience setup is unavailable
          </p>
          <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
            {audienceErrorMessage(audiences.imports.error)}
          </p>
          <Button
            className="mt-4"
            size="compact"
            variant="outlined"
            leftIcon={<RefreshCw />}
            onClick={() => void audiences.imports.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : !brandId ? (
        <div className="border-y border-[var(--border-base)] py-10 text-center">
          <h2 className="text-title-small text-[var(--content-emphasised)]">
            Select a brand first
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-body-small-default text-[var(--content-tertiary)]">
            Choose a brand in Customer decisions, then open Setup and approve
            that brand's history import.
            Worklin will then be able to find useful audiences.
          </p>
        </div>
      ) : (
        <>
          <section
            className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
            aria-labelledby="build-audiences-heading"
          >
            <div>
              <h2
                id="build-audiences-heading"
                className="text-title-small text-[var(--content-emphasised)]"
              >
                Find useful audiences
              </h2>
              <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
                Start with 10. Worklin will stop early rather than invent weak
                groups just to meet a number.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-col gap-1 text-body-small-default text-[var(--content-tertiary)]">
                Audience limit
                <select
                  className="h-10 min-w-32 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 text-body-small-default text-[var(--content-default)]"
                  value={segmentLimit}
                  onChange={(event) =>
                    setSegmentLimit(Number(event.target.value))
                  }
                  disabled={working || startRun.isPending}
                >
                  <option value={10}>10 audiences</option>
                  <option value={25}>25 audiences</option>
                  <option value={50}>50 audiences</option>
                </select>
              </label>
              <Button
                className="bg-[var(--content-emphasised)] text-[var(--surface-base)]"
                variant="primary"
                leftIcon={
                  working || startRun.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )
                }
                disabled={working || startRun.isPending}
                onClick={beginReview}
              >
                {working || startRun.isPending
                  ? "Preparing review"
                  : resumable
                    ? "Resume review"
                    : segments.length > 0
                      ? "Refresh audiences"
                      : "Find audiences"}
              </Button>
              {segments.length > 0 ? (
                <Button
                  variant="outlined"
                  leftIcon={<Download />}
                  onClick={() => downloadRetentionAudienceSummary(segments)}
                >
                  Download summary
                </Button>
              ) : null}
            </div>
          </section>

          {activeRun ? <RunProgress run={activeRun} /> : null}

          {startRun.isError || run.isError ? (
            <div
              className="flex items-start gap-3 border-y border-[var(--border-base)] py-4"
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-[var(--system-warning-strong)]" />
              <div>
                <p className="text-body-medium-default text-[var(--content-emphasised)]">
                  Audience review paused
                </p>
                <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                  {audienceErrorMessage(startRun.error ?? run.error)}
                </p>
              </div>
            </div>
          ) : null}

          {audiences.segments.isPending ? (
            <div className="flex items-center justify-center gap-2 py-20 text-body-small-default text-[var(--content-tertiary)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading audiences
            </div>
          ) : audiences.segments.isError ? (
            <div
              className="flex flex-col items-center py-16 text-center"
              role="alert"
            >
              <AlertCircle className="size-7 text-[var(--system-warning-strong)]" />
              <p className="mt-3 text-body-medium-default text-[var(--content-default)]">
                Audiences could not be loaded
              </p>
              <Button
                className="mt-4"
                size="compact"
                variant="outlined"
                leftIcon={<RefreshCw />}
                onClick={() => void audiences.segments.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : segments.length > 0 ? (
            <div className="grid gap-5" aria-label="Prepared audiences">
              {segments.map((segment) => (
                <AudienceRow key={segment.id} segment={segment} />
              ))}
            </div>
          ) : !working ? (
            <div className="border-y border-[var(--border-base)] py-10 text-center">
              <h2 className="text-title-small text-[var(--content-emphasised)]">
                No audiences prepared yet
              </h2>
              <p className="mx-auto mt-2 max-w-lg text-body-small-default text-[var(--content-tertiary)]">
                Start a review after the Klaviyo history import has completed.
                Worklin will show only audiences supported by useful evidence.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
