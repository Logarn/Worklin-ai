import { lazy } from "react";
import {
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import type { Surface } from "@/domains/chat/types/types";
import { isTaskProgressSurface } from "@/domains/chat/transcript/message-content";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";

// Weather card has its own data-shape parsing and forecast UI that is only
// rendered when a card surface advertises a weather template. Defer loading
// to keep it out of the chat-critical bundle.
const WeatherForecastDisplay = lazy(() =>
  import("@/domains/chat/components/surfaces/weather-forecast-display").then(
    (m) => ({ default: m.WeatherForecastDisplay }),
  ),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CardMetadataItem {
  label: string;
  value: string;
}

interface TaskStepItem {
  id?: string;
  label: string;
  status?: string;
  detail?: string;
}

interface AuditReasoningItem {
  cardId?: string;
  title: string;
  status?: string;
  analysisWindow?: string;
  dataRead: string[];
  ruleApplied?: string;
  rationale?: string;
  evidence: string[];
  caveats: string[];
  recommendation?: string;
}

interface CardSurfaceData {
  title: string;
  subtitle?: string;
  body: string;
  metadata?: CardMetadataItem[];
  template?: string;
  templateData?: Record<string, unknown>;
}

interface CardSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Task progress helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { label: string; colorClass: string }> = {
  complete: {
    label: "Complete",
    colorClass: "text-[var(--system-positive-strong)]",
  },
  completed: {
    label: "Completed",
    colorClass: "text-[var(--system-positive-strong)]",
  },
  partial: {
    label: "Partial",
    colorClass: "text-[var(--system-mid-strong)]",
  },
  in_progress: {
    label: "In Progress",
    colorClass: "text-[var(--system-mid-strong)]",
  },
  waiting: { label: "Waiting", colorClass: "text-[var(--system-mid-strong)]" },
  blocked: {
    label: "Blocked",
    colorClass: "text-[var(--system-negative-strong)]",
  },
  failed: {
    label: "Failed",
    colorClass: "text-[var(--system-negative-strong)]",
  },
};

const DEFAULT_STATUS = {
  label: "Pending",
  colorClass: "text-[var(--content-disabled)]",
};

function getStatusConfig(status: string | undefined) {
  return STATUS_CONFIG[status ?? ""] ?? DEFAULT_STATUS;
}

// Once the overall task is `completed`, treat any lingering `failed` step as
// recovered: a recoverable step (e.g. a Gmail reconnect) can be left `failed`
// with no corrective per-step update, which would otherwise show a permanent red
// glyph on a successful flow.
function effectiveStepStatus(
  stepStatus: string | undefined,
  taskCompleted: boolean,
): string | undefined {
  if (taskCompleted && stepStatus === "failed") {
    return "completed";
  }
  return stepStatus;
}

function normalizedTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function StatusBadge({ status }: { status: string | undefined }) {
  const { label, colorClass } = getStatusConfig(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-body-small-default ${colorClass}`}
      style={{
        backgroundColor: "color-mix(in srgb, currentColor 15%, transparent)",
      }}
    >
      {label}
    </span>
  );
}

function StepIcon({ status }: { status: string | undefined }) {
  const { colorClass } = getStatusConfig(status);
  const iconClass = `h-4 w-4 shrink-0 ${colorClass}`;

  switch (status) {
    case "completed":
      return <CircleCheck className={iconClass} />;
    case "in_progress":
      return <Loader2 className={`${iconClass} animate-spin`} />;
    case "waiting":
      return <Clock className={iconClass} />;
    case "failed":
      return <CircleX className={iconClass} />;
    default:
      return <Circle className={iconClass} />;
  }
}

// ---------------------------------------------------------------------------
// Task progress template
// ---------------------------------------------------------------------------

/**
 * The counter-style task_progress fallback only makes sense when the template
 * data actually carries usable `{ completed, total }` counters. Malformed
 * template data — e.g. a model emitting `steps` as an object instead of an
 * array, which fails `isTaskProgressSurface` — must not fall through to a
 * meaningless "0 / 0 tasks · 0%" bar; the card degrades to its plain body
 * instead. `completed` may be absent (treated as 0 by the bar), `total` must
 * coerce to a finite positive number.
 */
function hasUsableProgressCounters(
  templateData: Record<string, unknown>,
): boolean {
  const completed = Number(templateData.completed ?? 0);
  const total = Number(templateData.total ?? NaN);
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0;
}

function TaskProgressBar({
  templateData,
}: {
  templateData: Record<string, unknown>;
}) {
  const completed = Number(templateData.completed ?? 0);
  const total = Number(templateData.total ?? 0);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-body-small-default text-[var(--content-quiet)]">
        <span>
          {completed} / {total} tasks
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
        <div
          className="h-full rounded-full bg-[var(--primary-base)] transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function TaskStepList({
  steps,
  taskCompleted,
}: {
  steps: TaskStepItem[];
  taskCompleted: boolean;
}) {
  return (
    <div className="mt-5 divide-y divide-[var(--border-base)]">
      {steps.map((step, index) => {
        const status = effectiveStepStatus(step.status, taskCompleted);
        return (
          <div
            key={step.id || index}
            className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-[var(--tag-bg-neutral)] px-1.5 text-label-medium-default tabular-nums text-[var(--content-tertiary)]">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block min-w-0 whitespace-normal break-words text-body-medium-default text-[var(--content-strong)]">
                {step.label}
              </span>
              {step.detail && (
                <p className="mt-1 whitespace-pre-wrap break-words text-body-small-default leading-[18px] text-[var(--content-tertiary)]">
                  {step.detail}
                </p>
              )}
            </div>
            <div className="mt-0.5 shrink-0">
              <StepIcon status={status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit reasoning template
// ---------------------------------------------------------------------------

function parseAuditReasoningItems(
  templateData: Record<string, unknown> | undefined,
): AuditReasoningItem[] {
  const modules = templateData?.modules ?? templateData?.auditTrace;
  if (!Array.isArray(modules)) return [];

  return modules
    .map((raw): AuditReasoningItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;
      const title = normalizedTitle(item.title);
      if (!title) return null;
      return {
        cardId: normalizedTitle(item.cardId) || normalizedTitle(item.moduleId),
        title,
        status: normalizedTitle(item.status),
        analysisWindow: normalizedTitle(item.analysisWindow),
        dataRead: stringList(item.dataRead),
        ruleApplied: normalizedTitle(item.ruleApplied),
        rationale: normalizedTitle(item.rationale),
        evidence: stringList(item.evidence),
        caveats: stringList(item.caveats),
        recommendation: normalizedTitle(item.recommendation),
      };
    })
    .filter((item): item is AuditReasoningItem => item !== null);
}

function BulletList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-label-medium-default text-[var(--content-quiet)]">
        {title}
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((item, index) => (
          <li
            key={`${title}-${index}`}
            className="flex gap-2 text-body-small-default leading-[18px] text-[var(--content-tertiary)]"
          >
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current" />
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {item}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuditReasoningCard({
  title,
  status,
  modules,
}: {
  title: string;
  status: string | undefined;
  modules: AuditReasoningItem[];
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--content-secondary)]" />
            <h3 className="min-w-0 whitespace-normal break-words text-title-small text-[var(--content-strong)]">
              {title}
            </h3>
          </div>
          <p className="mt-1 whitespace-normal break-words text-body-small-default text-[var(--content-quiet)]">
            Visible audit reasoning: what Worklin read, which rule it applied,
            what evidence it found, and what it recommends. This is not private
            model scratchpad.
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="mt-4 divide-y divide-[var(--border-base)]">
        {modules.map((module, index) => (
          <section
            key={module.cardId || `${module.title}-${index}`}
            className="py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="whitespace-normal break-words text-body-medium-default text-[var(--content-strong)]">
                  {module.title}
                </h4>
                {module.analysisWindow && (
                  <p className="mt-0.5 whitespace-normal break-words text-body-small-default text-[var(--content-quiet)]">
                    {module.analysisWindow}
                  </p>
                )}
              </div>
              {module.status && <StatusBadge status={module.status} />}
            </div>

            <div className="mt-3 grid gap-3">
              <BulletList title="Data read" items={module.dataRead} />
              {module.ruleApplied && (
                <div>
                  <p className="text-label-medium-default text-[var(--content-quiet)]">
                    Rule applied
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-body-small-default leading-[18px] text-[var(--content-tertiary)]">
                    {module.ruleApplied}
                  </p>
                </div>
              )}
              {module.rationale && (
                <div>
                  <p className="text-label-medium-default text-[var(--content-quiet)]">
                    Why it matters
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-body-small-default leading-[18px] text-[var(--content-tertiary)]">
                    {module.rationale}
                  </p>
                </div>
              )}
              <BulletList title="Evidence" items={module.evidence} />
              {module.recommendation && (
                <div>
                  <p className="text-label-medium-default text-[var(--content-quiet)]">
                    Recommendation
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-body-small-default leading-[18px] text-[var(--content-tertiary)]">
                    {module.recommendation}
                  </p>
                </div>
              )}
              <BulletList title="Caveats" items={module.caveats} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CardSurface({ surface, onAction }: CardSurfaceProps) {
  const data = surface.data as unknown as CardSurfaceData;
  const isWeather = data.template === "weather_forecast" && data.templateData;
  const isTaskProgress =
    data.template === "task_progress" &&
    !!data.templateData &&
    hasUsableProgressCounters(data.templateData);
  const auditReasoningItems =
    data.template === "audit_reasoning"
      ? parseAuditReasoningItems(data.templateData)
      : [];
  // Shared predicate so this render-detection and the activity-summary
  // hoist-detection in transcript-message-body cannot drift.
  const hasSteps = isTaskProgressSurface(surface);
  const cardTitle =
    normalizedTitle(data.title) || normalizedTitle(surface.title);

  if (hasSteps) {
    const templateData = data.templateData!;
    const title = normalizedTitle(templateData.title) || cardTitle || "Task";
    const status =
      typeof templateData.status === "string" ? templateData.status : undefined;
    const steps = templateData.steps as TaskStepItem[];

    return (
      <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-title-small text-[var(--content-strong)]">
              {title}
            </span>
            <StatusBadge status={status} />
          </div>
          <TaskStepList steps={steps} taskCompleted={status === "completed"} />
        </div>
      </SurfaceContainer>
    );
  }

  if (data.template === "audit_reasoning" && auditReasoningItems.length > 0) {
    const templateData = data.templateData!;
    const title =
      normalizedTitle(templateData.title) || cardTitle || "Audit Reasoning";
    const status =
      typeof templateData.status === "string" ? templateData.status : undefined;

    return (
      <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
        <AuditReasoningCard
          title={title}
          status={status}
          modules={auditReasoningItems}
        />
      </SurfaceContainer>
    );
  }

  const bodyMarkdown = (
    <ChatMarkdownMessage
      content={data.body}
      className="mt-2 text-body-medium-lighter text-[var(--content-tertiary)]"
    />
  );

  return (
    <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
      <div>
        {cardTitle && (
          <h3 className="text-title-small text-[var(--content-strong)]">
            {cardTitle}
          </h3>
        )}

        {data.subtitle && (
          <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
            {data.subtitle}
          </p>
        )}

        {isWeather ? (
          <LazyBoundary fallback={bodyMarkdown} errorFallback={bodyMarkdown}>
            <WeatherForecastDisplay
              templateData={data.templateData!}
              fallback={bodyMarkdown}
            />
          </LazyBoundary>
        ) : (
          <>
            {bodyMarkdown}

            {data.metadata && data.metadata.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {data.metadata.map((item) => (
                  <div key={item.label}>
                    <dt className="text-body-small-default text-[var(--content-quiet)]">
                      {item.label}
                    </dt>
                    <dd className="text-body-medium-lighter text-[var(--content-strong)]">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </div>
            )}

            {isTaskProgress && (
              <TaskProgressBar templateData={data.templateData!} />
            )}
          </>
        )}
      </div>
    </SurfaceContainer>
  );
}
