import { cn } from "@vellumai/design-library";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Globe2,
  Image as ImageIcon,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { PageShell } from "@/components/page-shell";
import { routes } from "@/utils/routes";

import type {
  CompetitorDatasetKey,
  CompetitorIntelligenceReport,
  IntelligenceCompetitor,
  IntelligenceVisual,
} from "./competitor-intelligence-model";

type DashboardTab =
  | "overview"
  | "similar"
  | "meta"
  | "tiktok"
  | "google"
  | "emails";
type DateRange = "7d" | "30d" | "90d" | "12m" | "all";

const DATE_RANGES: Array<{ value: DateRange; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "12m", label: "12 months" },
  { value: "all", label: "All available" },
];

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(date)
    : "Date unavailable";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function measuredNumber(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Not measured"
    : formatNumber(value);
}

function hostname(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function visualDate(item: IntelligenceVisual): number {
  const value = new Date(item.observedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function filterByDate(
  items: IntelligenceVisual[],
  range: DateRange,
  reportDate: string,
): IntelligenceVisual[] {
  if (range === "all") return items;
  const end = new Date(reportDate).getTime();
  const day = 24 * 60 * 60 * 1000;
  const duration =
    range === "7d"
      ? 7 * day
      : range === "30d"
        ? 30 * day
        : range === "90d"
          ? 90 * day
          : 365 * day;
  return items.filter((item) => visualDate(item) >= end - duration);
}

function visualPreview(item: IntelligenceVisual): string | undefined {
  return (
    item.thumbnailUrl ??
    (item.mediaType === "image" ? item.mediaUrl : undefined)
  );
}

function isPlatform(item: IntelligenceVisual, names: string[]): boolean {
  const platform = item.platform?.toLowerCase() ?? "";
  return names.some((name) => platform.includes(name));
}

function platformLabel(item: IntelligenceVisual): string {
  if (isPlatform(item, ["meta", "facebook", "instagram"])) return "Meta";
  if (isPlatform(item, ["tiktok"])) return "TikTok";
  if (isPlatform(item, ["google", "youtube"])) return "Google";
  if (item.kind === "email") return "Email";
  return item.platform || "Website";
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function CountBadge({ children }: { children: number }) {
  return (
    <span className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] font-semibold text-white">
      {children}
    </span>
  );
}

function EmptyPanel({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center border border-zinc-200 bg-white px-6 text-center">
      <ImageIcon className="size-8 text-zinc-300" aria-hidden />
      <h3 className="mt-4 text-base font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">
        {message}
      </p>
    </div>
  );
}

function DateButtons({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (value: DateRange) => void;
}) {
  return (
    <div className="flex w-fit max-w-full overflow-x-auto rounded-md bg-zinc-100 p-1">
      {DATE_RANGES.map((range) => (
        <button
          key={range.value}
          type="button"
          onClick={() => onChange(range.value)}
          className={cn(
            "h-8 shrink-0 rounded px-3 text-xs font-medium",
            value === range.value
              ? "bg-white text-zinc-950 shadow-sm"
              : "text-zinc-500 hover:text-zinc-900",
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

function FilterButton({ children }: { children: string }) {
  return (
    <button
      type="button"
      disabled
      title="More options appear when Worklin has more examples"
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-500"
    >
      {children}
      <ChevronDown className="size-3.5 text-zinc-400" aria-hidden />
    </button>
  );
}

function SourceCard({
  item,
  onOpen,
}: {
  item: IntelligenceVisual;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const preview = visualPreview(item);
  return (
    <article className="min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-600">
        <span className="inline-flex items-center gap-1.5">
          <Globe2 className="size-3.5" aria-hidden />
          {platformLabel(item)}
        </span>
        <span>{formatDate(item.observedAt)}</span>
      </div>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="group block w-full text-left"
      >
        <div
          className={cn(
            "relative flex items-center justify-center overflow-hidden bg-zinc-100",
            item.kind === "email" ? "aspect-[4/5]" : "aspect-[4/3]",
          )}
        >
          {preview ? (
            <img
              src={preview}
              alt={item.title}
              loading="lazy"
              className="size-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
            />
          ) : item.mediaType === "video" && item.mediaUrl ? (
            <video
              src={item.mediaUrl}
              muted
              playsInline
              preload="metadata"
              className="size-full object-contain"
            />
          ) : (
            <span className="text-sm text-zinc-400">Preview not available</span>
          )}
        </div>
        <div className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-zinc-500">
                <span className="mr-1.5 inline-block size-2 rounded-full bg-emerald-500" />
                Found
              </p>
              <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-zinc-950">
                {item.title}
              </h3>
            </div>
            <ArrowUpRight
              className="size-4 shrink-0 text-zinc-400"
              aria-hidden
            />
          </div>
          {item.caption ? (
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-600">
              {item.caption}
            </p>
          ) : null}
          <div className="mt-3 border-t border-zinc-100 pt-3 text-center text-xs font-semibold text-zinc-900">
            See details
          </div>
        </div>
      </button>
    </article>
  );
}

function SourceDetail({
  item,
  onClose,
}: {
  item: IntelligenceVisual | null;
  onClose: () => void;
}) {
  if (!item) return null;
  const preview = item.mediaUrl ?? item.thumbnailUrl;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
    >
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white text-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 md:px-5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-zinc-500">
              {platformLabel(item)} · {formatDate(item.observedAt)}
            </p>
            <h2 className="mt-1 truncate text-base font-semibold">
              {item.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-md hover:bg-zinc-100"
            aria-label="Close"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
          <div className="flex min-h-96 items-center justify-center bg-zinc-100 p-4 md:p-7">
            {item.mediaType === "video" && item.mediaUrl ? (
              <video
                src={item.mediaUrl}
                poster={item.thumbnailUrl}
                controls
                autoPlay
                playsInline
                className="max-h-[72vh] max-w-full object-contain"
              />
            ) : preview ? (
              <img
                src={preview}
                alt={item.title}
                className="max-h-[72vh] max-w-full object-contain"
              />
            ) : (
              <p className="text-sm text-zinc-400">Preview not available</p>
            )}
          </div>
          <aside className="border-l border-zinc-200 p-5">
            <h3 className="text-sm font-semibold">What Worklin found</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              {item.caption || "No written note was saved for this example."}
            </p>
            <dl className="mt-6 divide-y divide-zinc-200 border-y border-zinc-200 text-sm">
              {[
                ["Type", item.mediaType || "Page"],
                ["Where it appeared", platformLabel(item)],
                ["Found", formatDate(item.observedAt)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex justify-between gap-4 py-3"
                >
                  <dt className="text-zinc-500">{label}</dt>
                  <dd className="text-right font-medium text-zinc-900">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {item.caveats.length ? (
              <div className="mt-5 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-zinc-600">
                {item.caveats.join(" ")}
              </div>
            ) : null}
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              Open public source
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ActivityBars({
  items,
  reportDate,
}: {
  items: IntelligenceVisual[];
  reportDate: string;
}) {
  const months = useMemo(() => {
    const end = new Date(reportDate);
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(end.getFullYear(), end.getMonth() - 11 + index, 1);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      return {
        key,
        label: new Intl.DateTimeFormat(undefined, {
          month: "short",
        }).format(date),
        count: items.filter((item) => {
          const observed = new Date(item.observedAt);
          return `${observed.getFullYear()}-${observed.getMonth()}` === key;
        }).length,
      };
    });
  }, [items, reportDate]);
  const max = Math.max(1, ...months.map((month) => month.count));
  return (
    <div className="mt-5 grid h-48 grid-cols-12 items-end gap-1.5">
      {months.map((month) => (
        <div
          key={month.key}
          className="flex h-full min-w-0 flex-col justify-end"
        >
          <div className="flex min-h-0 flex-1 items-end">
            <div
              className={cn(
                "w-full rounded-t-sm",
                month.count ? "bg-emerald-400" : "bg-zinc-100",
              )}
              style={{
                height: month.count
                  ? `${Math.max(12, (month.count / max) * 100)}%`
                  : "4px",
              }}
              title={`${month.label}: ${month.count} examples`}
            />
          </div>
          <span className="mt-2 truncate text-center text-[10px] text-zinc-400">
            {month.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function Overview({
  report,
  onOpen,
  onChangeTab,
}: {
  report: CompetitorIntelligenceReport;
  onOpen: (item: IntelligenceVisual) => void;
  onChangeTab: (tab: DashboardTab) => void;
}) {
  const meta = report.visualEvidence.filter((item) =>
    isPlatform(item, ["meta", "facebook", "instagram"]),
  );
  const tiktok = report.visualEvidence.filter((item) =>
    isPlatform(item, ["tiktok"]),
  );
  const google = report.visualEvidence.filter((item) =>
    isPlatform(item, ["google", "youtube"]),
  );
  const emails = report.visualEvidence.filter((item) => item.kind === "email");
  const brandExamples = report.visualEvidence.filter(
    (item) =>
      item.kind === "brand" ||
      item.kind === "product" ||
      item.kind === "landing_page",
  );
  const modules = report.intelligence?.modules ?? [];
  const finished = modules.filter((item) => item.status === "complete").length;
  const channelRows: Array<{
    label: string;
    count: number;
    tab: DashboardTab;
  }> = [
    { label: "Meta ads", count: meta.length, tab: "meta" },
    { label: "TikTok", count: tiktok.length, tab: "tiktok" },
    { label: "Google ads", count: google.length, tab: "google" },
    { label: "Emails", count: emails.length, tab: "emails" },
  ];

  return (
    <div>
      <div className="grid border-b border-zinc-200 bg-white sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Examples found", report.visualEvidence.length],
          ["Competitors checked", report.competitorLandscape.length],
          ["Research areas finished", `${finished} of ${modules.length}`],
          [
            "Ready for decisions",
            report.quality?.accepted ? "Yes" : "Not yet",
          ],
        ].map(([label, value], index) => (
          <div
            key={String(label)}
            className={cn(
              "px-5 py-4",
              index > 0 && "border-t border-zinc-200 sm:border-t-0",
              index % 2 === 1 && "sm:border-l",
              index > 1 && "xl:border-l",
            )}
          >
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-950">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid border-b border-zinc-200 lg:grid-cols-2">
        <section className="min-w-0 p-5 lg:border-r lg:border-zinc-200">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950">
                Website visits over time
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Past 12 months
              </p>
            </div>
            <span className="text-xs font-medium text-zinc-400">
              Not checked yet
            </span>
          </div>
          <div className="mt-5 flex h-48 items-center justify-center border-y border-dashed border-zinc-200 text-center">
            <p className="max-w-sm text-sm leading-6 text-zinc-500">
              Worklin has not checked website visits for this brand yet.
            </p>
          </div>
        </section>
        <section className="min-w-0 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950">
                Examples found over time
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Past 12 months
              </p>
            </div>
            <strong className="text-xl font-semibold text-zinc-950">
              {report.visualEvidence.length}
            </strong>
          </div>
          <ActivityBars
            items={report.visualEvidence}
            reportDate={report.generatedAt}
          />
        </section>
      </div>

      <section className="border-b border-zinc-200 bg-white p-5">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-zinc-950">
                Brand and products
              </h2>
              <span className="text-xs text-zinc-500">
                {brandExamples.length} found
              </span>
            </div>
            {brandExamples.length ? (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {brandExamples.slice(0, 3).map((item) => (
                  <SourceCard key={item.id} item={item} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <p className="mt-4 border-y border-zinc-200 py-8 text-sm text-zinc-500">
                Products have not been checked yet.
              </p>
            )}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">
              Where the brand appears
            </h2>
            <div className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200">
              {channelRows.map((row) => (
                <button
                  key={row.label}
                  type="button"
                  onClick={() => onChangeTab(row.tab)}
                  className="flex w-full items-center justify-between gap-4 py-3 text-left hover:bg-zinc-50"
                >
                  <span className="text-sm text-zinc-700">{row.label}</span>
                  <span className="text-sm font-semibold text-zinc-950">
                    {row.count || "Not found"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-200 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">
              Competitors
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Close competitors with evidence already checked
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChangeTab("similar")}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-800 hover:underline"
          >
            See all
            <ArrowUpRight className="size-3.5" aria-hidden />
          </button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {report.competitorLandscape.slice(0, 3).map((competitor, index) => {
            const visual = report.visualEvidence.find(
              (item) =>
                item.kind === "competitor" &&
                item.evidenceIds.some((id) =>
                  competitor.evidenceIds.includes(id),
                ),
            );
            return (
              <article
                key={`${competitor.name}-${index}`}
                className="overflow-hidden rounded-md border border-zinc-200 bg-white"
              >
                <div className="aspect-[16/9] bg-zinc-100">
                  {visual && visualPreview(visual) ? (
                    <img
                      src={visualPreview(visual)}
                      alt={competitor.name}
                      className="size-full object-cover object-top"
                    />
                  ) : null}
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-zinc-950">
                      {competitor.name}
                    </h3>
                    <span className="rounded bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">
                      Evidence checked
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-600">
                    {competitor.rationale}
                  </p>
                  {competitor.websiteUrl ? (
                    <a
                      href={competitor.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-zinc-900 hover:underline"
                    >
                      {hostname(competitor.websiteUrl)}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-b border-zinc-200 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-950">Latest ads</h2>
          <button
            type="button"
            onClick={() => onChangeTab("meta")}
            className="text-xs font-semibold text-zinc-800 hover:underline"
          >
            See all
          </button>
        </div>
        {meta.length ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {meta.slice(0, 4).map((item) => (
              <SourceCard key={item.id} item={item} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <p className="mt-4 border-y border-zinc-200 py-8 text-sm text-zinc-500">
            No Meta ads were found.
          </p>
        )}
      </section>

      <section className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-950">
            Latest emails
          </h2>
          <button
            type="button"
            onClick={() => onChangeTab("emails")}
            className="text-xs font-semibold text-zinc-800 hover:underline"
          >
            See all
          </button>
        </div>
        {emails.length ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {emails.slice(0, 4).map((item) => (
              <SourceCard key={item.id} item={item} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <p className="mt-4 border-y border-zinc-200 py-8 text-sm text-zinc-500">
            No emails were found.
          </p>
        )}
      </section>
    </div>
  );
}

type CompetitorTab = CompetitorDatasetKey;

function HistoryBars({
  items,
  emptyMessage,
}: {
  items: Array<{ period: string; value: number }>;
  emptyMessage: string;
}) {
  if (!items.length) {
    return (
      <div className="flex h-44 items-center justify-center border-y border-dashed border-zinc-200 px-5 text-center text-sm text-zinc-500">
        {emptyMessage}
      </div>
    );
  }
  const visible = items.slice(-16);
  const max = Math.max(1, ...visible.map((item) => item.value));
  return (
    <div className="flex h-44 items-end gap-1.5 border-b border-zinc-200 pt-5">
      {visible.map((item) => (
        <div
          key={item.period}
          className="flex h-full min-w-0 flex-1 flex-col justify-end"
          title={`${formatDate(item.period)}: ${item.value}`}
        >
          <div className="flex min-h-0 flex-1 items-end">
            <div
              className={cn(
                "w-full rounded-t-sm",
                item.value ? "bg-emerald-400" : "bg-zinc-100",
              )}
              style={{
                height: item.value
                  ? `${Math.max(8, (item.value / max) * 100)}%`
                  : "3px",
              }}
            />
          </div>
          <span className="mt-2 truncate text-center text-[9px] text-zinc-400">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
            }).format(new Date(item.period))}
          </span>
        </div>
      ))}
    </div>
  );
}

function CompetitorOverview({
  competitor,
  onOpen,
}: {
  competitor: IntelligenceCompetitor;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const details = competitor.details;
  if (!details) {
    return (
      <div className="p-5">
        <EmptyPanel
          title="Profile not available"
          message="Worklin has not collected a full profile for this competitor yet."
        />
      </div>
    );
  }
  return (
    <div>
      <div className="grid border-b border-zinc-200 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Products found", measuredNumber(details.productCount)],
          ["Website visits", measuredNumber(details.monthlyVisits)],
          ["Live Meta ads", measuredNumber(details.activeAds)],
          [
            "Average live ads, 30 days",
            measuredNumber(details.averageActiveAds30d),
          ],
        ].map(([label, value], index) => (
          <div
            key={String(label)}
            className={cn(
              "px-5 py-4",
              index > 0 && "border-t border-zinc-200 sm:border-t-0",
              index % 2 === 1 && "sm:border-l",
              index > 1 && "xl:border-l",
            )}
          >
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="mt-1 text-xl font-semibold text-zinc-950">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid border-b border-zinc-200 lg:grid-cols-2">
        <section className="p-5 lg:border-r lg:border-zinc-200">
          <h3 className="text-sm font-semibold text-zinc-950">
            Website visits
          </h3>
          <p className="mt-1 text-xs text-zinc-500">All available months</p>
          <HistoryBars
            items={details.trafficHistory}
            emptyMessage="Website visits were not measured in this check."
          />
        </section>
        <section className="p-5">
          <h3 className="text-sm font-semibold text-zinc-950">
            Live ads over time
          </h3>
          <p className="mt-1 text-xs text-zinc-500">All available weeks</p>
          <HistoryBars
            items={details.adHistory}
            emptyMessage="No reliable ad history was returned."
          />
        </section>
      </div>

      <section className="border-b border-zinc-200 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-950">
              Products
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Prices and product images found in the store check
            </p>
          </div>
          <span className="text-xs font-medium text-zinc-500">
            {details.products.length} found
          </span>
        </div>
        {details.products.length ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {details.products.map((item) => (
              <SourceCard key={item.id} item={item} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <p className="mt-4 border-y border-zinc-200 py-7 text-sm text-zinc-500">
            {details.coverage.products?.note ||
              "No product or price was returned."}
          </p>
        )}
      </section>

      <section className="grid border-b border-zinc-200 lg:grid-cols-2">
        <div className="p-5 lg:border-r lg:border-zinc-200">
          <h3 className="text-sm font-semibold text-zinc-950">
            Social accounts
          </h3>
          {details.socialAccounts.length ? (
            <div className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200">
              {details.socialAccounts.map((account) => (
                <div
                  key={`${account.platform}-${account.handle ?? ""}`}
                  className="grid grid-cols-[minmax(0,1fr)_repeat(2,auto)] items-center gap-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900">
                      {account.platform}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {account.handle ? `@${account.handle}` : "Account found"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-zinc-900">
                      {account.followers === undefined
                        ? "—"
                        : formatNumber(account.followers)}
                    </p>
                    <p className="text-[11px] text-zinc-500">Followers</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-zinc-900">
                      {account.posts === undefined
                        ? "—"
                        : formatNumber(account.posts)}
                    </p>
                    <p className="text-[11px] text-zinc-500">Posts</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 border-y border-zinc-200 py-7 text-sm text-zinc-500">
              {details.coverage.social?.note ||
                "No reliable social account statistics were returned."}
            </p>
          )}
        </div>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-zinc-950">
            Store tools found
          </h3>
          <div className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200">
            {[...details.tools, ...details.tracking].map((tool) => (
              <div
                key={tool}
                className="flex items-center gap-2 py-3 text-sm text-zinc-700"
              >
                <Check className="size-4 text-emerald-600" aria-hidden />
                {tool}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="p-5">
        <h3 className="text-sm font-semibold text-zinc-950">
          Why this competitor matters
        </h3>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-600">
          {competitor.rationale}
        </p>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">
              What stands out
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-zinc-700">
              {competitor.differentiators.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase text-zinc-500">
              What is still missing
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-zinc-700">
              {competitor.gaps.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function PlainList({
  title,
  items,
  emptyMessage,
}: {
  title: string;
  items: string[];
  emptyMessage: string;
}) {
  return (
    <section className="p-5">
      <h3 className="text-sm font-semibold text-zinc-950">{title}</h3>
      {items.length ? (
        <div className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200">
          {items.map((item) => (
            <div key={item} className="flex items-center gap-2 py-3 text-sm">
              <Check className="size-4 text-emerald-600" aria-hidden />
              {item}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 border-y border-zinc-200 py-7 text-sm text-zinc-500">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}

function CompetitorProfile({
  competitor,
  report,
  onBack,
  onOpen,
}: {
  competitor: IntelligenceCompetitor;
  report: CompetitorIntelligenceReport;
  onBack: () => void;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const [tab, setTab] = useState<CompetitorTab>("overview");
  const details = competitor.details;
  const visual = report.visualEvidence.find(
    (item) =>
      item.kind === "competitor" &&
      item.evidenceIds.some((id) => competitor.evidenceIds.includes(id)),
  );
  const mediaByTab: Partial<Record<CompetitorTab, IntelligenceVisual[]>> = {
    products: details?.products ?? [],
    meta: details?.metaAds ?? [],
    tiktok: details?.tiktok ?? [],
    google: details?.googleAds ?? [],
    emails: details?.emails ?? [],
  };
  const tabs: Array<{ id: CompetitorTab; label: string; count?: number }> = [
    { id: "overview", label: "Shop overview" },
    {
      id: "products",
      label: "Products",
      count: details?.products.length ?? 0,
    },
    { id: "meta", label: "Meta ads", count: details?.metaAds.length ?? 0 },
    { id: "tiktok", label: "TikTok", count: details?.tiktok.length ?? 0 },
    {
      id: "google",
      label: "Google ads",
      count: details?.googleAds.length ?? 0,
    },
    { id: "emails", label: "Emails", count: details?.emails.length ?? 0 },
    {
      id: "social",
      label: "Social accounts",
      count: details?.socialAccounts.length ?? 0,
    },
    {
      id: "tools",
      label: "Store tools",
      count: (details?.tools.length ?? 0) + (details?.tracking.length ?? 0),
    },
  ];

  return (
    <div>
      <header className="border-b border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <button
            type="button"
            onClick={onBack}
            className="flex size-9 items-center justify-center rounded-md border border-zinc-200 hover:bg-zinc-50"
            aria-label="Back to competitors"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <div className="size-14 overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">
            {visual && visualPreview(visual) ? (
              <img
                src={visualPreview(visual)}
                alt=""
                className="size-full object-cover object-top"
              />
            ) : (
              <div className="flex size-full items-center justify-center font-semibold">
                {initials(competitor.name)}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-zinc-950">
              {competitor.name}
            </h2>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>{hostname(competitor.websiteUrl)}</span>
              {details?.countryCode ? <span>{details.countryCode}</span> : null}
              {details?.currency ? <span>{details.currency}</span> : null}
              {details?.category ? <span>{details.category}</span> : null}
              {details?.storeCreatedAt ? (
                <span>Seen since {formatDate(details.storeCreatedAt)}</span>
              ) : null}
            </div>
          </div>
          {competitor.websiteUrl ? (
            <a
              href={competitor.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-4 text-xs font-semibold text-white"
            >
              Open public website
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
        </div>
        <nav
          role="tablist"
          aria-label={`${competitor.name} research`}
          className="flex overflow-x-auto px-4"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex h-12 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium",
                tab === item.id
                  ? "border-zinc-950 text-zinc-950"
                  : "border-transparent text-zinc-500 hover:text-zinc-900",
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <CountBadge>{item.count}</CountBadge>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      {tab === "overview" ? (
        <CompetitorOverview competitor={competitor} onOpen={onOpen} />
      ) : null}
      {tab === "social" ? (
        <section className="p-5">
          <h3 className="text-sm font-semibold text-zinc-950">
            Social accounts
          </h3>
          {details?.socialAccounts.length ? (
            <div className="mt-4 overflow-x-auto border-y border-zinc-200">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Platform</th>
                    <th className="px-4 py-3 font-medium">Account</th>
                    <th className="px-4 py-3 font-medium">Followers</th>
                    <th className="px-4 py-3 font-medium">Posts</th>
                    <th className="px-4 py-3 font-medium">Views</th>
                    <th className="px-4 py-3 font-medium">Likes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200">
                  {details.socialAccounts.map((account) => (
                    <tr key={`${account.platform}-${account.handle ?? ""}`}>
                      <td className="px-4 py-3 font-medium">
                        {account.platform}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {account.handle ? `@${account.handle}` : "Found"}
                      </td>
                      {[account.followers, account.posts, account.views, account.likes].map(
                        (value, index) => (
                          <td
                            key={index}
                            className="px-4 py-3 text-zinc-600"
                          >
                            {value === undefined ? "—" : formatNumber(value)}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 border-y border-zinc-200 py-7 text-sm text-zinc-500">
              {details?.coverage.social?.note ||
                "No reliable social account statistics were returned."}
            </p>
          )}
        </section>
      ) : null}
      {tab === "tools" ? (
        <div className="grid lg:grid-cols-2">
          <PlainList
            title="Store tools"
            items={details?.tools ?? []}
            emptyMessage="No store tools were identified."
          />
          <div className="border-t border-zinc-200 lg:border-l lg:border-t-0">
            <PlainList
              title="Measurement tools"
              items={details?.tracking ?? []}
              emptyMessage="No measurement tools were identified."
            />
          </div>
        </div>
      ) : null}
      {mediaByTab[tab] ? (
        <MediaLibrary
          title={
            tab === "products"
              ? "products"
              : tab === "meta"
                ? "Meta ads"
                : tab === "tiktok"
                  ? "TikTok posts and ads"
                  : tab === "google"
                    ? "Google ads"
                    : "emails"
          }
          items={mediaByTab[tab] ?? []}
          reportDate={report.generatedAt}
          onOpen={onOpen}
        />
      ) : null}
    </div>
  );
}

function SimilarBrands({
  report,
  onOpen,
}: {
  report: CompetitorIntelligenceReport;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<IntelligenceCompetitor | null>(null);
  const competitors = report.competitorLandscape.filter((item) =>
    `${item.name} ${item.positioning} ${item.rationale ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (selected) {
    return (
      <CompetitorProfile
        competitor={selected}
        report={report}
        onBack={() => setSelected(null)}
        onOpen={onOpen}
      />
    );
  }
  return (
    <div>
      <div className="border-b border-zinc-200 bg-zinc-50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-64 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-zinc-400"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search competitors"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-zinc-400"
            />
          </label>
          <FilterButton>Category</FilterButton>
          <FilterButton>Country</FilterButton>
          <FilterButton>Products</FilterButton>
          <FilterButton>Newest first</FilterButton>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse text-left">
          <thead className="bg-zinc-50 text-xs font-medium text-zinc-500">
            <tr>
              <th className="px-5 py-3 font-medium">Brand</th>
              <th className="px-5 py-3 font-medium">Why it competes</th>
              <th className="px-5 py-3 font-medium">Products and prices</th>
              <th className="px-5 py-3 font-medium">Website visits</th>
              <th className="px-5 py-3 font-medium">Ads and emails</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 bg-white">
            {competitors.map((competitor, index) => (
              <SimilarBrandRow
                key={`${competitor.name}-${index}`}
                competitor={competitor}
                report={report}
                onSelect={() => setSelected(competitor)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimilarBrandRow({
  competitor,
  report,
  onSelect,
}: {
  competitor: IntelligenceCompetitor;
  report: CompetitorIntelligenceReport;
  onSelect: () => void;
}) {
  const visual = report.visualEvidence.find(
    (item) =>
      item.kind === "competitor" &&
      item.evidenceIds.some((id) => competitor.evidenceIds.includes(id)),
  );
  const details = competitor.details;
  const paidAndEmailCount =
    (details?.metaAds.length ?? 0) +
    (details?.tiktok.length ?? 0) +
    (details?.googleAds.length ?? 0) +
    (details?.emails.length ?? 0);
  return (
    <tr className="align-top hover:bg-zinc-50">
      <td className="w-72 px-5 py-4">
        <button
          type="button"
          onClick={onSelect}
          className="flex w-full gap-3 text-left"
        >
          <div className="size-20 shrink-0 overflow-hidden rounded border border-zinc-200 bg-zinc-100">
            {visual && visualPreview(visual) ? (
              <img
                src={visualPreview(visual)}
                alt=""
                className="size-full object-cover object-top"
              />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-zinc-950">{competitor.name}</p>
            <p className="mt-1 text-xs text-zinc-500">
              {hostname(competitor.websiteUrl)}
            </p>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
              <Check className="size-3.5" aria-hidden />
              Evidence checked
            </span>
            <span className="mt-2 block text-xs font-semibold text-zinc-900">
              Open full profile
            </span>
          </div>
        </button>
      </td>
      <td className="max-w-xs px-5 py-4 text-sm leading-6 text-zinc-600">
        {competitor.rationale || "Not explained yet"}
      </td>
      <td className="px-5 py-4 text-sm text-zinc-700">
        <p className="font-semibold text-zinc-950">
          {details?.productCount === null ||
          details?.productCount === undefined
            ? "No product row found"
            : `${details.productCount} found`}
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {competitor.offers[0] || "Price not found"}
        </p>
      </td>
      <td className="px-5 py-4 text-sm text-zinc-700">
        <p className="font-semibold text-zinc-950">
          {measuredNumber(details?.monthlyVisits)}
        </p>
        <p className="mt-1 text-xs text-zinc-500">Latest monthly estimate</p>
      </td>
      <td className="px-5 py-4 text-sm text-zinc-700">
        <p className="font-semibold text-zinc-950">
          {paidAndEmailCount} examples
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {[
            details?.metaAds.length ? "Meta" : "",
            details?.tiktok.length ? "TikTok" : "",
            details?.googleAds.length ? "Google" : "",
            details?.emails.length ? "Email" : "",
          ]
            .filter(Boolean)
            .join(", ") || "No examples returned"}
        </p>
      </td>
    </tr>
  );
}

function MediaLibrary({
  title,
  items,
  reportDate,
  onOpen,
}: {
  title: string;
  items: IntelligenceVisual[];
  reportDate: string;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const [range, setRange] = useState<DateRange>("all");
  const [query, setQuery] = useState("");
  const filtered = filterByDate(items, range, reportDate)
    .filter((item) =>
      `${item.title} ${item.caption ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((left, right) => visualDate(right) - visualDate(left));
  return (
    <div>
      <div className="border-b border-zinc-200 bg-zinc-50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterButton>Status</FilterButton>
          <FilterButton>First found</FilterButton>
          <FilterButton>Last found</FilterButton>
          <FilterButton>Type</FilterButton>
          <FilterButton>Country</FilterButton>
          <label className="relative ml-auto min-w-56">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-zinc-400"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${title}`}
              className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-zinc-400"
            />
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white p-4">
        <DateButtons value={range} onChange={setRange} />
        <span className="text-xs text-zinc-500">
          {filtered.length} of {items.length} found
        </span>
      </div>
      {filtered.length ? (
        <div className="grid gap-4 bg-white p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((item) => (
            <SourceCard key={item.id} item={item} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div className="bg-white p-4">
          <EmptyPanel
            title={`No ${title} found`}
            message={
              items.length
                ? "Try a longer date range or a different search."
                : `Worklin has not found any ${title} for this brand yet.`
            }
          />
        </div>
      )}
    </div>
  );
}

export function BrandResearchDashboard({
  report,
  brandId,
}: {
  report: CompetitorIntelligenceReport;
  brandId: string;
}) {
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [selected, setSelected] = useState<IntelligenceVisual | null>(null);
  const meta = report.visualEvidence.filter((item) =>
    isPlatform(item, ["meta", "facebook", "instagram"]),
  );
  const tiktok = report.visualEvidence.filter((item) =>
    isPlatform(item, ["tiktok"]),
  );
  const google = report.visualEvidence.filter((item) =>
    isPlatform(item, ["google", "youtube"]),
  );
  const emails = report.visualEvidence.filter((item) => item.kind === "email");
  const tabs: Array<{
    id: DashboardTab;
    label: string;
    count?: number;
  }> = [
    { id: "overview", label: "Overview" },
    {
      id: "similar",
      label: "Competitors",
      count: report.competitorLandscape.length,
    },
    { id: "meta", label: "Meta ads", count: meta.length },
    { id: "tiktok", label: "TikTok", count: tiktok.length },
    { id: "google", label: "Google ads", count: google.length },
    { id: "emails", label: "Emails", count: emails.length },
  ];

  return (
    <PageShell className="overflow-hidden bg-white p-0 text-zinc-950">
      <header className="shrink-0 border-b border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 md:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to={routes.work.brandArtifacts(brandId)}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              aria-label="Back to Work"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-sm font-bold text-emerald-900">
              {initials(report.query.brandName)}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-zinc-950">
                {report.query.brandName}
              </h1>
              <p className="truncate text-xs text-zinc-500">
                Brand research
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium",
                report.quality?.accepted
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700",
              )}
            >
              {report.quality?.accepted ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <CircleAlert className="size-3.5" aria-hidden />
              )}
              {report.quality?.accepted
                ? "Ready to use"
                : "More research needed"}
            </span>
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-xs font-medium text-zinc-600">
              <CalendarDays className="size-3.5" aria-hidden />
              Updates paused
            </span>
          </div>
        </div>
        <div className="flex gap-x-5 gap-y-2 overflow-x-auto border-t border-zinc-100 bg-zinc-50 px-5 py-2 text-xs text-zinc-600">
          {report.query.websiteUrl ? (
            <a
              href={report.query.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 font-medium text-zinc-800 hover:underline"
            >
              <Globe2 className="size-3.5" aria-hidden />
              {hostname(report.query.websiteUrl)}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
          <span className="shrink-0">Updated {formatDate(report.generatedAt)}</span>
          <span className="shrink-0">{report.identity.category}</span>
          <span className="shrink-0">
            {report.intelligence?.scope.languages.join(", ") ||
              "Language not checked"}
          </span>
        </div>
        <nav
          role="tablist"
          aria-label="Brand research"
          className="flex overflow-x-auto px-3 md:px-4"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex h-12 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium",
                tab === item.id
                  ? "border-zinc-950 text-zinc-950"
                  : "border-transparent text-zinc-500 hover:text-zinc-900",
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <CountBadge>{item.count}</CountBadge>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      <main role="tabpanel" className="min-h-0 flex-1 overflow-y-auto bg-white">
        {tab === "overview" ? (
          <Overview
            report={report}
            onOpen={setSelected}
            onChangeTab={setTab}
          />
        ) : null}
        {tab === "similar" ? (
          <SimilarBrands report={report} onOpen={setSelected} />
        ) : null}
        {tab === "meta" ? (
          <MediaLibrary
            title="Meta ads"
            items={meta}
            reportDate={report.generatedAt}
            onOpen={setSelected}
          />
        ) : null}
        {tab === "tiktok" ? (
          <MediaLibrary
            title="TikTok posts and ads"
            items={tiktok}
            reportDate={report.generatedAt}
            onOpen={setSelected}
          />
        ) : null}
        {tab === "google" ? (
          <MediaLibrary
            title="Google ads"
            items={google}
            reportDate={report.generatedAt}
            onOpen={setSelected}
          />
        ) : null}
        {tab === "emails" ? (
          <MediaLibrary
            title="Emails"
            items={emails}
            reportDate={report.generatedAt}
            onOpen={setSelected}
          />
        ) : null}
      </main>
      <SourceDetail item={selected} onClose={() => setSelected(null)} />
    </PageShell>
  );
}
