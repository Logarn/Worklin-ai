import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Download,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { PageShell } from "@/components/page-shell";
import { formatFriendlyDate, formatFullLocalDate } from "@/utils/format-date";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

import {
  FARM_RECORD_CATEGORIES,
  type FarmRecord,
  type FarmRecordAttentionLevel,
  type FarmRecordCategory,
} from "./farm-record-model";

type FarmRecordFilter = "all" | FarmRecordCategory;

interface FarmOperationsPageProps {
  brandName: string;
  records: FarmRecord[];
  hasPartialError: boolean;
  filesHref: string;
  onAskWorklin: (prompt: string) => void;
}

const ATTENTION_LABELS: Record<FarmRecordAttentionLevel, string> = {
  normal: "Recorded",
  watch: "Watching",
  action: "Action needed",
  urgent: "Urgent",
};

export function FarmOperationsPage({
  brandName,
  records,
  hasPartialError,
  filesHref,
  onAskWorklin,
}: FarmOperationsPageProps) {
  const [filter, setFilter] = useState<FarmRecordFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const selectedRecord =
    records.find((record) => record.recordId === selectedRecordId) ?? null;
  const categories = useMemo(
    () =>
      FARM_RECORD_CATEGORIES.filter((category) =>
        records.some((record) => record.category === category),
      ),
    [records],
  );
  const attentionRecords = useMemo(
    () =>
      records.filter(
        (record) =>
          record.attentionLevel === "action" ||
          record.attentionLevel === "urgent",
      ),
    [records],
  );
  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        if (filter !== "all" && record.category !== filter) return false;
        if (!normalizedSearch) return true;
        return [
          record.title,
          record.reference,
          record.category,
          record.recordType,
          record.status,
          record.summary,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch);
      }),
    [filter, normalizedSearch, records],
  );
  const lastUpdated = records.reduce(
    (latest, record) => Math.max(latest, record.updatedAt),
    0,
  );

  return (
    <PageShell className="overflow-hidden p-0">
      <div className="flex h-full min-w-0 flex-col bg-[var(--surface-base)]">
        <header className="shrink-0 border-b border-[var(--border-base)] px-5 py-5 md:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Link
                to={routes.work.root}
                className="inline-flex min-h-9 items-center gap-1 text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
              >
                <ChevronLeft className="size-4" />
                All farms
              </Link>
              <p className="mt-3 text-label-small text-[var(--content-tertiary)]">
                FARM OPERATIONS
              </p>
              <h1 className="mt-1 text-title-large text-[var(--content-emphasised)]">
                {brandName}
              </h1>
              <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
                Records, documents, decisions, and operating history.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={filesHref}
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--border-base)] px-3 text-body-small-default text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <FolderOpen className="size-4" />
                Files & documents
              </Link>
              <Button
                variant="primary"
                leftIcon={<MessageSquarePlus className="size-4" />}
                onClick={() =>
                  onAskWorklin(
                    `Review the current records for ${brandName}. Tell me what needs my attention, what is still uncertain, and what is progressing normally.`,
                  )
                }
              >
                Ask Worklin
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-6 md:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {hasPartialError ? (
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 text-body-small-default text-[var(--content-secondary)]"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                Some records may be temporarily unavailable.
              </div>
            ) : null}

            <section
              aria-label="Farm record summary"
              className="grid border-y border-[var(--border-base)] sm:grid-cols-3"
            >
              <SummaryMetric
                label="Saved records"
                value={String(records.length)}
              />
              <SummaryMetric
                label="Need attention"
                value={String(attentionRecords.length)}
              />
              <SummaryMetric
                label="Last updated"
                value={
                  lastUpdated
                    ? formatFriendlyDate(new Date(lastUpdated))
                    : "No updates"
                }
              />
            </section>

            <section aria-labelledby="attention-heading">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-label-small text-[var(--content-tertiary)]">
                    OWNER ATTENTION
                  </p>
                  <h2
                    id="attention-heading"
                    className="mt-1 text-title-small text-[var(--content-emphasised)]"
                  >
                    {attentionRecords.length
                      ? `${attentionRecords.length} ${attentionRecords.length === 1 ? "item needs" : "items need"} a decision or follow-up`
                      : "No saved record needs action"}
                  </h2>
                </div>
                {attentionRecords.length ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onAskWorklin(
                        `Walk me through the ${attentionRecords.length} records that need attention for ${brandName}, starting with the most urgent.`,
                      )
                    }
                  >
                    Review
                  </Button>
                ) : null}
              </div>
              {attentionRecords.length ? (
                <div className="mt-3 divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
                  {attentionRecords.slice(0, 3).map((record) => (
                    <button
                      key={record.recordId}
                      type="button"
                      onClick={() => setSelectedRecordId(record.recordId)}
                      className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-1 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      <AttentionMark level={record.attentionLevel} />
                      <span className="min-w-0">
                        <strong className="block truncate text-body-small-strong text-[var(--content-emphasised)]">
                          {record.title}
                        </strong>
                        <span className="block truncate text-body-small-default text-[var(--content-tertiary)]">
                          {record.status} · {record.reference}
                        </span>
                      </span>
                      <ArrowRight className="size-4 text-[var(--content-tertiary)]" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex min-h-16 items-center gap-3 border-y border-[var(--border-base)] text-body-small-default text-[var(--content-secondary)]">
                  <CheckCircle2 className="size-4 text-[var(--system-positive-strong)]" />
                  No saved record is currently marked for owner action.
                </div>
              )}
            </section>

            <section aria-labelledby="records-heading">
              <div className="flex flex-col gap-4">
                <div>
                  <p className="text-label-small text-[var(--content-tertiary)]">
                    WORK
                  </p>
                  <h2
                    id="records-heading"
                    className="mt-1 text-title-small text-[var(--content-emphasised)]"
                  >
                    Farm records
                  </h2>
                </div>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div
                    role="tablist"
                    aria-label="Farm record category"
                    className="flex gap-1 overflow-x-auto pb-1"
                  >
                    <FilterButton
                      label="All"
                      count={records.length}
                      active={filter === "all"}
                      onClick={() => setFilter("all")}
                    />
                    {categories.map((category) => (
                      <FilterButton
                        key={category}
                        label={category}
                        count={
                          records.filter(
                            (record) => record.category === category,
                          ).length
                        }
                        active={filter === category}
                        onClick={() => setFilter(category)}
                      />
                    ))}
                  </div>
                  <label className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 text-[var(--content-tertiary)] lg:w-72">
                    <Search className="size-4 shrink-0" />
                    <input
                      aria-label="Search farm records"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search records"
                      className="min-w-0 flex-1 bg-transparent text-body-small-default text-[var(--content-default)] outline-none placeholder:text-[var(--content-quiet)]"
                    />
                  </label>
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-lg border border-[var(--border-base)]">
                <div className="hidden min-h-10 grid-cols-[minmax(0,2fr)_minmax(8rem,1fr)_8rem_minmax(8rem,1fr)_2rem] items-center gap-3 border-b border-[var(--border-base)] bg-[var(--surface-lift)] px-4 text-label-small text-[var(--content-tertiary)] md:grid">
                  <span>Record</span>
                  <span>Type</span>
                  <span>Updated</span>
                  <span>Status</span>
                  <span />
                </div>
                <div className="divide-y divide-[var(--border-base)]">
                  {filteredRecords.map((record) => (
                    <button
                      key={record.recordId}
                      type="button"
                      onClick={() => setSelectedRecordId(record.recordId)}
                      className="grid min-h-20 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 bg-[var(--surface-base)] px-4 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] md:grid-cols-[minmax(0,2fr)_minmax(8rem,1fr)_8rem_minmax(8rem,1fr)_2rem]"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--surface-lift)] text-[var(--content-secondary)]">
                          <FileText className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <strong className="block truncate text-body-small-strong text-[var(--content-emphasised)]">
                            {record.title}
                          </strong>
                          <span className="block truncate text-body-small-default text-[var(--content-tertiary)]">
                            {record.reference} · {record.category}
                          </span>
                        </span>
                      </span>
                      <span className="hidden truncate text-body-small-default text-[var(--content-secondary)] md:block">
                        {record.recordType}
                      </span>
                      <span className="hidden text-body-small-default text-[var(--content-tertiary)] md:block">
                        {formatFriendlyDate(new Date(record.updatedAt))}
                      </span>
                      <span className="hidden md:block">
                        <StatusLabel record={record} />
                      </span>
                      <span className="flex items-center gap-2 md:block">
                        <span className="md:hidden">
                          <StatusLabel record={record} />
                        </span>
                        <ArrowRight className="size-4 text-[var(--content-tertiary)]" />
                      </span>
                    </button>
                  ))}
                </div>
                {filteredRecords.length === 0 ? (
                  <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
                    <Search className="size-5 text-[var(--content-tertiary)]" />
                    <strong className="mt-3 text-body-small-strong text-[var(--content-emphasised)]">
                      No matching records
                    </strong>
                    <span className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                      Try another category, title, status, or reference.
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </div>

      {selectedRecord ? (
        <FarmRecordDrawer
          brandName={brandName}
          record={selectedRecord}
          onClose={() => setSelectedRecordId(null)}
          onAskWorklin={onAskWorklin}
        />
      ) : null}
    </PageShell>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-24 flex-col justify-center border-b border-[var(--border-base)] px-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span className="text-label-small text-[var(--content-tertiary)]">
        {label}
      </span>
      <strong className="mt-1 text-title-medium text-[var(--content-emphasised)]">
        {value}
      </strong>
    </div>
  );
}

function FilterButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md px-3 text-body-small-default transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        active
          ? "bg-[var(--surface-overlay)] text-[var(--content-emphasised)]"
          : "text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]"
      }`}
    >
      {label}
      <span className="text-label-small text-[var(--content-quiet)]">
        {count}
      </span>
    </button>
  );
}

function AttentionMark({ level }: { level: FarmRecordAttentionLevel }) {
  return (
    <span
      className={`size-2 rounded-full ${
        level === "urgent"
          ? "bg-[var(--system-negative-strong)]"
          : level === "action"
            ? "bg-[var(--system-warning-strong)]"
            : level === "watch"
              ? "bg-[var(--primary-base)]"
              : "bg-[var(--system-positive-strong)]"
      }`}
      aria-label={ATTENTION_LABELS[level]}
    />
  );
}

function StatusLabel({ record }: { record: FarmRecord }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
      <AttentionMark level={record.attentionLevel} />
      <span className="truncate">{record.status}</span>
    </span>
  );
}

function FarmRecordDrawer({
  brandName,
  record,
  onClose,
  onAskWorklin,
}: {
  brandName: string;
  record: FarmRecord;
  onClose: () => void;
  onAskWorklin: (prompt: string) => void;
}) {
  const downloadRecord = () => {
    const lines = [
      brandName,
      record.recordType,
      record.reference,
      "",
      `Status: ${record.status}`,
      `Category: ${record.category}`,
      ...(record.occurredAt ? [`Date: ${record.occurredAt}`] : []),
      ...(record.amount ? [`Amount: ${record.amount}`] : []),
      "",
      record.summary,
      "",
      ...record.details.map((detail) => `${detail.label}: ${detail.value}`),
    ];
    const url = URL.createObjectURL(
      new Blob([lines.join("\n")], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${record.reference.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/55"
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="farm-record-title"
        className="flex h-full w-full max-w-xl flex-col border-l border-[var(--border-base)] bg-[var(--surface-base)] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border-base)] px-5 py-5 md:px-7">
          <div className="min-w-0">
            <p className="text-label-small text-[var(--content-tertiary)]">
              {record.recordType.toUpperCase()}
            </p>
            <h2
              id="farm-record-title"
              className="mt-1 text-title-medium text-[var(--content-emphasised)]"
            >
              {record.title}
            </h2>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              {record.reference}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close record"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-6 md:px-7">
          <article className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-5">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border-base)] pb-5">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-[var(--surface-overlay)] text-label-small text-[var(--content-emphasised)]">
                  {brandName
                    .split(/\s+/u)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <div>
                  <strong className="block text-body-small-strong text-[var(--content-emphasised)]">
                    {brandName}
                  </strong>
                  <span className="text-body-small-default text-[var(--content-tertiary)]">
                    Farm record
                  </span>
                </div>
              </div>
              <StatusLabel record={record} />
            </div>

            <dl className="grid gap-x-6 gap-y-4 border-b border-[var(--border-base)] py-5 sm:grid-cols-2">
              <RecordField label="Reference" value={record.reference} />
              <RecordField label="Category" value={record.category} />
              <RecordField
                label="Record date"
                value={
                  record.occurredAt ??
                  formatFriendlyDate(new Date(record.createdAt), {
                    alwaysShowYear: true,
                  })
                }
              />
              <RecordField label="Status" value={record.status} />
              {record.amount ? (
                <RecordField label="Amount" value={record.amount} />
              ) : null}
            </dl>

            <p className="py-5 text-body-small-default leading-6 text-[var(--content-default)]">
              {record.summary}
            </p>

            {record.details.length ? (
              <dl className="divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
                {record.details.map((detail) => (
                  <div
                    key={`${detail.label}-${detail.value}`}
                    className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]"
                  >
                    <dt className="text-body-small-default text-[var(--content-tertiary)]">
                      {detail.label}
                    </dt>
                    <dd className="text-body-small-strong text-[var(--content-emphasised)] sm:text-right">
                      {detail.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            <div className="mt-5 flex items-start gap-3 text-body-small-default text-[var(--content-tertiary)]">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              <span>
                Updated{" "}
                {formatFullLocalDate(new Date(record.updatedAt).toISOString())}
              </span>
            </div>
          </article>

          {record.activity.length ? (
            <section className="mt-7" aria-labelledby="record-activity-heading">
              <h3
                id="record-activity-heading"
                className="text-label-small text-[var(--content-tertiary)]"
              >
                ACTIVITY
              </h3>
              <div className="mt-3 divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
                {[...record.activity].reverse().map((activity, index) => (
                  <div
                    key={`${activity.at}-${activity.label}-${index}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 py-4"
                  >
                    <span className="pt-1">
                      <AttentionMark
                        level={
                          activity.state === "done"
                            ? "normal"
                            : activity.state === "current"
                              ? "action"
                              : "watch"
                        }
                      />
                    </span>
                    <div>
                      <p className="text-body-small-default text-[var(--content-default)]">
                        {activity.label}
                      </p>
                      <time className="mt-1 block text-label-small text-[var(--content-tertiary)]">
                        {formatFullLocalDate(activity.at)}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--border-base)] px-5 py-4 md:px-7">
          <Button
            variant="outlined"
            leftIcon={<Download className="size-4" />}
            onClick={downloadRecord}
          >
            Download
          </Button>
          <Button
            variant="primary"
            leftIcon={<MessageSquarePlus className="size-4" />}
            onClick={() =>
              onAskWorklin(
                `Review ${record.reference} (${record.title}) for ${brandName}. Use the saved farm record, explain its current status, and tell me the next step without treating pending work as complete.`,
              )
            }
          >
            Review with Worklin
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function RecordField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-label-small text-[var(--content-tertiary)]">
        {label}
      </dt>
      <dd className="mt-1 text-body-small-strong text-[var(--content-emphasised)]">
        {value}
      </dd>
    </div>
  );
}
