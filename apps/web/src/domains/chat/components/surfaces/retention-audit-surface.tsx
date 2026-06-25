import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Download,
  Edit3,
  Eye,
  FileText,
  Grid3X3,
  LineChart,
  Maximize2,
  ShieldCheck,
} from "lucide-react";

import type { Surface } from "@/domains/chat/types/types";
import { documentsByIdPdfGet } from "@/generated/daemon/sdk.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  openPdfPreparingWindow,
  safePdfFilename,
} from "@/domains/chat/utils/pdf-export";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";

type ChartRow = Record<string, string | number | boolean | null>;

interface AuditChartSpec {
  chartId: string;
  title: string;
  family: string;
  type: string;
  data: ChartRow[];
  encodings?: Record<string, string>;
  interaction?: {
    primaryMetric?: string;
    secondaryMetric?: string;
    labelKey?: string;
    metricKeys?: string[];
    dimensionKeys?: string[];
    defaultSort?: "none" | "asc" | "desc";
    defaultFocus?: string;
    selectable?: boolean;
  };
  diagnosis?: string;
  recommendation?: string;
  caveats?: string[];
}

interface RetentionAuditSurfaceData {
  title?: string;
  brandName?: string;
  generatedAt?: string;
  charts?: AuditChartSpec[];
  modules?: Array<{
    moduleId?: string;
    title?: string;
    status?: string;
    summary?: string;
    charts?: AuditChartSpec[];
    insights?: unknown[];
    recommendations?: unknown[];
  }>;
  backlog?: Array<{
    backlogKey?: string;
    title?: string;
    impact?: number;
    confidence?: number;
    effort?: string;
    nextAction?: string;
  }>;
  safety?: {
    externalActionTaken?: boolean;
    canGoLiveNow?: boolean;
    blockedCapabilities?: string[];
  };
  documentSurfaceId?: string;
  pdfReady?: boolean;
  summary?: {
    moduleCount?: number;
    chartCount?: number;
    backlogCount?: number;
    sourceMode?: string;
  };
}

interface RetentionAuditSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  onOpenDocument?: (documentSurfaceId: string) => void;
}

const EMPTY_CHARTS: AuditChartSpec[] = [];
const CHART_PALETTE = [
  "#22c55e",
  "#ef4444",
  "#eab308",
  "#a855f7",
  "#f97316",
  "#14b8a6",
  "#ec4899",
  "#84cc16",
  "#f59e0b",
  "#6366f1",
];

const FAMILY_ACCENTS: Array<[string, string]> = [
  ["cadence", "#ef4444"],
  ["word", "#a855f7"],
  ["theme", "#f97316"],
  ["sale", "#eab308"],
  ["flow", "#14b8a6"],
  ["lifecycle", "#14b8a6"],
  ["audience", "#ec4899"],
  ["segment", "#ec4899"],
  ["acquisition", "#84cc16"],
  ["opportunity", "#a855f7"],
  ["readiness", "#eab308"],
  ["inventory", "#22c55e"],
];

function asData(value: unknown): RetentionAuditSurfaceData {
  if (!value || typeof value !== "object") return {};
  return value as RetentionAuditSurfaceData;
}

function numberKeys(row: ChartRow | undefined): string[] {
  if (!row) return [];
  return Object.entries(row)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([key]) => key);
}

function textValue(row: ChartRow, preferred: string[]): string {
  for (const key of preferred) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const firstString = Object.values(row).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return firstString ?? "Item";
}

function numericValue(row: ChartRow, preferred?: string): number {
  if (preferred && typeof row[preferred] === "number") return row[preferred];
  const firstNumber = Object.values(row).find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return firstNumber ?? 0;
}

function formatLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCellValue(value: string | number | boolean | null): string {
  if (value == null) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (Math.abs(value) < 10 && !Number.isInteger(value)) {
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return Math.round(value).toLocaleString();
  }
  return value;
}

function chartAccent(chart: AuditChartSpec): string {
  const haystack = `${chart.chartId} ${chart.family} ${chart.title}`.toLowerCase();
  const match = FAMILY_ACCENTS.find(([key]) => haystack.includes(key));
  return match?.[1] ?? "#22c55e";
}

function chartTitleParts(title: string): { section: string; headline: string } {
  const [section, ...rest] = title.split(":");
  if (rest.length === 0) {
    const normalized = title.toLowerCase();
    const inferredSection =
      normalized.includes("cadence") ||
      normalized.includes("campaign") ||
      normalized.includes("subject") ||
      normalized.includes("sale")
        ? "Campaign Report"
        : normalized.includes("flow") || normalized.includes("lifecycle")
          ? "Flow Report"
          : normalized.includes("signup") ||
              normalized.includes("form") ||
              normalized.includes("popup")
            ? "Acquisition Report"
            : normalized.includes("audience") ||
                normalized.includes("list") ||
                normalized.includes("segment")
              ? "Audience Report"
              : normalized.includes("metric") ||
                  normalized.includes("performance")
                ? "Performance Readiness"
                : normalized.includes("opportunity") ||
                    normalized.includes("strategy")
                  ? "Strategy Report"
                  : normalized.includes("data") ||
                      normalized.includes("readiness")
                    ? "Data Trust"
                    : "Audit Page";
    return { section: inferredSection, headline: title };
  }
  return { section: section.trim(), headline: rest.join(":").trim() };
}

function tableColumns(rows: ChartRow[], preferred: string[]): string[] {
  const keys = Array.from(
    new Set(
      rows.flatMap((row) =>
        Object.keys(row).filter((key) => row[key] !== undefined),
      ),
    ),
  );
  const ordered = [
    ...preferred.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferred.includes(key)),
  ];
  return ordered.slice(0, 7);
}

function preferredInitialChartId(charts: AuditChartSpec[]): string {
  return (
    charts.find((chart) => chart.chartId.includes("campaign_cadence"))
      ?.chartId ??
    charts.find((chart) => chart.family.includes("campaign"))
      ?.chartId ??
    charts[0]?.chartId ??
    ""
  );
}

function metricKeys(chart: AuditChartSpec): string[] {
  const keys = numberKeys(chart.data[0]);
  const preferred = chart.interaction?.metricKeys?.filter((key) =>
    keys.includes(key),
  );
  return preferred?.length ? preferred : keys;
}

function labelKeyFor(chart: AuditChartSpec): string {
  const firstRow = chart.data[0];
  const preferred = [
    chart.interaction?.labelKey,
    chart.encodings?.label,
    chart.encodings?.x,
    chart.encodings?.group,
    "product",
    "opportunity",
    "segment",
    "theme",
    "week",
    "period",
    "stage",
    "word",
    "type",
  ].filter(Boolean) as string[];

  if (firstRow) {
    const match = preferred.find(
      (key) => typeof firstRow[key] === "string" && String(firstRow[key]).trim(),
    );
    if (match) return match;
  }
  return preferred[0] ?? "label";
}

function primaryMetricFor(chart: AuditChartSpec, override?: string): string {
  const keys = metricKeys(chart);
  const preferred = [
    override,
    chart.interaction?.primaryMetric,
    chart.encodings?.value,
    chart.encodings?.y,
    chart.encodings?.size,
    chart.encodings?.color,
    chart.encodings?.stage3,
    chart.encodings?.secondary,
  ].find((key) => key && keys.includes(key));
  return preferred ?? keys[0] ?? "";
}

function rowKeyFor(chart: AuditChartSpec, row: ChartRow, index: number): string {
  const labelKey = labelKeyFor(chart);
  return `${chart.chartId}:${labelKey}:${String(row[labelKey] ?? index)}:${index}`;
}

function sortRows(
  chart: AuditChartSpec,
  metricKey: string,
  sortMode: "none" | "asc" | "desc",
): ChartRow[] {
  const rows = [...chart.data];
  if (sortMode === "none") return rows;
  return rows.sort((a, b) => {
    const diff = numericValue(a, metricKey) - numericValue(b, metricKey);
    return sortMode === "asc" ? diff : -diff;
  });
}

function normalizePoint(value: number, values: number[], minPct = 8, maxPct = 92) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(value) || max === min) return 50;
  return minPct + ((value - min) / (max - min)) * (maxPct - minPct);
}

function ChartIcon({ type }: { type: string }) {
  const Icon =
    type === "heatmap"
      ? Grid3X3
      : type === "line"
        ? LineChart
        : BarChart3;
  return <Icon className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />;
}

interface ChartRenderProps {
  chart: AuditChartSpec;
  metricKey?: string;
  sortMode?: "none" | "asc" | "desc";
  selectedRowKey?: string;
  onSelectRow?: (rowKey: string, row: ChartRow) => void;
  compact?: boolean;
}

function chartColor(index: number, label?: string): string {
  const normalized = (label ?? "").toLowerCase();
  if (
    normalized.includes("wrong") ||
    normalized.includes("missing") ||
    normalized.includes("blocked") ||
    normalized.includes("risk") ||
    normalized.includes("critical") ||
    normalized.includes("none")
  ) {
    return "#ef4444";
  }
  if (
    normalized.includes("warning") ||
    normalized.includes("partial") ||
    normalized.includes("undated") ||
    normalized.includes("unknown")
  ) {
    return "#eab308";
  }
  if (
    normalized.includes("complete") ||
    normalized.includes("present") ||
    normalized.includes("active") ||
    normalized.includes("live") ||
    normalized.includes("ready")
  ) {
    return "#22c55e";
  }
  return CHART_PALETTE[index % CHART_PALETTE.length] ?? "#a855f7";
}

function isCadenceLike(chart: AuditChartSpec): boolean {
  return (
    chart.type === "column" ||
    chart.family.includes("cadence") ||
    chart.chartId.includes("cadence")
  );
}

function rowValues(row: ChartRow | null): Array<[string, string]> {
  if (!row) return [];
  return Object.entries(row).map(([key, value]) => [
    formatLabel(key),
    formatCellValue(value),
  ]);
}

function ChartEvidenceTable({
  chart,
  selectedRowKey,
  onSelectRow,
  limit = 14,
}: {
  chart: AuditChartSpec;
  selectedRowKey?: string;
  onSelectRow?: (rowKey: string, row: ChartRow) => void;
  limit?: number;
}) {
  const labelKey = labelKeyFor(chart);
  const metricKey = primaryMetricFor(chart);
  const columns = tableColumns(chart.data, [labelKey, metricKey]);
  const rows = chart.data.slice(0, limit);

  if (!rows.length || !columns.length) {
    return (
      <p className="rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-3 py-2 text-body-small-default text-[var(--content-tertiary)]">
        No row-level evidence is available for this audit page yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-base)] px-4 py-3">
        <div>
          <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
            Evidence table
          </p>
          <p className="text-body-small-default text-[var(--content-secondary)]">
            Showing {rows.length.toLocaleString()} of {chart.data.length.toLocaleString()} rows
          </p>
        </div>
        <span className="rounded-full bg-[var(--surface-active)] px-2.5 py-1 text-label-small-default text-[var(--content-secondary)]">
          Click rows to inspect
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-body-small-default">
          <thead className="sticky top-0 z-10 bg-[var(--surface-active)]">
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-[var(--border-base)] px-4 py-2.5 font-semibold text-[var(--content-strong)]"
                >
                  {formatLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const rowKey = rowKeyFor(chart, row, index);
              const selected = selectedRowKey === rowKey;
              return (
                <tr
                  key={rowKey}
                  role={onSelectRow ? "button" : undefined}
                  tabIndex={onSelectRow ? 0 : undefined}
                  onClick={() => onSelectRow?.(rowKey, row)}
                  onKeyDown={(event) => {
                    if (!onSelectRow) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectRow(rowKey, row);
                    }
                  }}
                  className={`outline-none transition ${
                    selected
                      ? "bg-[var(--surface-active)] text-[var(--content-strong)]"
                      : onSelectRow
                        ? "hover:bg-[var(--surface-active)] focus-visible:bg-[var(--surface-active)]"
                        : ""
                  }`}
                >
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="border-b border-[var(--border-subtle)] px-4 py-2.5 text-[var(--content-secondary)]"
                    >
                      {formatCellValue(row[column] ?? null)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BarLikeChart({
  chart,
  metricKey,
  sortMode = "none",
  selectedRowKey,
  onSelectRow,
  compact = false,
}: ChartRenderProps) {
  const valueKey = primaryMetricFor(chart, metricKey);
  const labelKey = labelKeyFor(chart);
  const rows = sortRows(chart, valueKey, sortMode).slice(0, compact ? 8 : 26);
  const max = Math.max(1, ...rows.map((row) => numericValue(row, valueKey)));

  return (
    <div className={compact ? "space-y-2" : "space-y-3.5"}>
      {rows.map((row, index) => {
        const label = textValue(row, [labelKey]);
        const value = numericValue(row, valueKey);
        const rowKey = rowKeyFor(chart, row, index);
        const selected = selectedRowKey === rowKey;
        const color = chartColor(index, label);
        return (
          <div
            key={rowKey}
            role={onSelectRow ? "button" : undefined}
            tabIndex={onSelectRow ? 0 : undefined}
            onClick={() => onSelectRow?.(rowKey, row)}
            onKeyDown={(event) => {
              if (!onSelectRow) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectRow(rowKey, row);
              }
            }}
            className={`grid items-center gap-3 rounded-lg border px-3 outline-none transition ${
              compact
                ? "grid-cols-[minmax(112px,1fr)_minmax(120px,2.4fr)_auto] py-2"
                : "grid-cols-[minmax(190px,1.35fr)_minmax(240px,3fr)_auto] px-4 py-4"
            } ${
              selected
                ? "border-[var(--content-strong)] bg-[var(--surface-active)] ring-2 ring-[var(--content-strong)]"
                : onSelectRow
                  ? "border-[var(--border-base)] hover:bg-[var(--surface-active)] focus-visible:bg-[var(--surface-active)]"
                  : "border-transparent"
            }`}
          >
            <span
              className={`${compact ? "truncate text-body-small-default" : "whitespace-normal break-words text-body-medium-default"} ${
                selected
                  ? "text-[var(--content-strong)]"
                  : "text-[var(--content-secondary)]"
              }`}
            >
              {label}
            </span>
            <div className={`${compact ? "h-3.5" : "h-7"} overflow-hidden rounded-full bg-[var(--border-subtle)]`}>
              <div
                className="h-full rounded-full shadow-sm"
                style={{
                  width: `${Math.max(6, (value / max) * 100)}%`,
                  background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 68%, white))`,
                }}
              />
            </div>
            <span
              className={`${compact ? "text-body-small-default" : "text-body-medium-default"} font-semibold tabular-nums ${
                selected
                  ? "text-[var(--content-strong)]"
                  : "text-[var(--content-tertiary)]"
              }`}
            >
              {formatCellValue(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function VerticalBarChart({
  chart,
  metricKey,
  sortMode = "none",
  selectedRowKey,
  onSelectRow,
  compact = false,
}: ChartRenderProps) {
  const valueKey = primaryMetricFor(chart, metricKey);
  const labelKey = labelKeyFor(chart);
  const targetMinKey = chart.encodings?.targetMin;
  const targetMaxKey = chart.encodings?.targetMax;
  const sortedRows = sortRows(chart, valueKey, sortMode);
  const rows = (compact ? sortedRows.slice(-18) : sortedRows.slice(-52)).filter(
    (row) => numericValue(row, valueKey) >= 0,
  );
  const targetValues = rows.flatMap((row) => [
    targetMinKey ? numericValue(row, targetMinKey) : 0,
    targetMaxKey ? numericValue(row, targetMaxKey) : 0,
  ]);
  const max = Math.max(
    1,
    ...rows.map((row) => numericValue(row, valueKey)),
    ...targetValues,
  );
  const targetMin = targetMinKey ? numericValue(rows[0] ?? {}, targetMinKey) : 0;
  const targetMax = targetMaxKey ? numericValue(rows[0] ?? {}, targetMaxKey) : 0;

  return (
    <div className="space-y-3">
      <div
        className={`relative overflow-x-auto rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] ${
          compact ? "h-64 p-3" : "h-[640px] p-6"
        }`}
      >
        <div className="absolute left-6 top-5 text-label-small-default uppercase text-[var(--content-tertiary)]">
          Sends per week
        </div>
        {targetMax > 0 && (
          <div
            className="pointer-events-none absolute left-5 right-5 border-t border-dashed border-[#22c55e]/80"
            style={{ bottom: `${Math.min(92, (targetMax / max) * 82 + 10)}%` }}
          >
            <span className="absolute right-0 -top-5 rounded-full bg-[#22c55e] px-2 py-0.5 text-[10px] font-semibold text-white">
              Target max {formatCellValue(targetMax)}
            </span>
          </div>
        )}
        {targetMin > 0 && (
          <div
            className="pointer-events-none absolute left-5 right-5 border-t border-dashed border-[#eab308]/80"
            style={{ bottom: `${Math.min(88, (targetMin / max) * 82 + 10)}%` }}
          >
            <span className="absolute right-0 top-1 rounded-full bg-[#eab308] px-2 py-0.5 text-[10px] font-semibold text-black">
              Target min {formatCellValue(targetMin)}
            </span>
          </div>
        )}
        <div
          className={`flex h-full items-end gap-2 pt-8 ${
            compact ? "min-w-[760px]" : "min-w-[1320px]"
          }`}
        >
          {rows.map((row, index) => {
            const value = numericValue(row, valueKey);
            const label = textValue(row, [labelKey]);
            const rowKey = rowKeyFor(chart, row, index);
            const selected = selectedRowKey === rowKey;
            const aboveTarget =
              targetMax > 0 && value > targetMax
                ? true
                : targetMin > 0 && value < targetMin
                  ? false
                  : null;
            const color =
              aboveTarget === true
                ? "#ef4444"
                : aboveTarget === false
                  ? "#eab308"
                  : "#22c55e";

            return (
              <button
                key={rowKey}
                type="button"
                className="group flex h-full min-w-8 flex-1 flex-col items-center justify-end gap-2 outline-none"
                onClick={() => onSelectRow?.(rowKey, row)}
              >
                <span
                  className={`text-[11px] font-semibold tabular-nums transition ${
                    selected
                      ? "text-[var(--content-strong)]"
                      : "text-[var(--content-tertiary)] group-hover:text-[var(--content-strong)]"
                  }`}
                >
                  {formatCellValue(value)}
                </span>
                <span
                  className={`w-full rounded-t-md shadow-sm transition ${
                    selected
                      ? "ring-4 ring-[var(--content-strong)]"
                      : "group-hover:ring-2 group-hover:ring-[var(--content-secondary)]"
                  }`}
                  style={{
                    height: `${Math.max(4, (value / max) * (compact ? 78 : 84))}%`,
                    background: `linear-gradient(180deg, color-mix(in srgb, ${color} 88%, white), ${color})`,
                  }}
                />
                <span
                  className={`h-10 max-w-20 origin-top -rotate-45 truncate text-[10px] ${
                    selected
                      ? "text-[var(--content-strong)]"
                      : "text-[var(--content-tertiary)]"
                  }`}
                  title={label}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-2 text-label-small-default">
          <span className="rounded-full bg-[#22c55e] px-2 py-1 text-white">
            In target band
          </span>
          <span className="rounded-full bg-[#ef4444] px-2 py-1 text-white">
            Spike / above band
          </span>
          <span className="rounded-full bg-[#eab308] px-2 py-1 text-black">
            Under cadence
          </span>
        </div>
      )}
    </div>
  );
}

function WordBankChart({
  chart,
  metricKey,
  sortMode = "desc",
  selectedRowKey,
  onSelectRow,
  compact = false,
}: ChartRenderProps) {
  const valueKey = primaryMetricFor(chart, metricKey);
  const labelKey = labelKeyFor(chart);
  const rows = sortRows(chart, valueKey, sortMode).slice(0, compact ? 12 : 32);
  const values = rows.map((row) => numericValue(row, valueKey));
  const max = Math.max(1, ...values);

  return (
    <div className={compact ? "flex flex-wrap gap-2" : "flex flex-wrap gap-3"}>
      {rows.map((row, index) => {
        const label = textValue(row, [labelKey]);
        const value = numericValue(row, valueKey);
        const rowKey = rowKeyFor(chart, row, index);
        const selected = selectedRowKey === rowKey;
        const color = chartColor(index, label);
        return (
          <span
            key={rowKey}
            role={onSelectRow ? "button" : undefined}
            tabIndex={onSelectRow ? 0 : undefined}
            onClick={() => onSelectRow?.(rowKey, row)}
            onKeyDown={(event) => {
              if (!onSelectRow) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectRow(rowKey, row);
              }
            }}
            className={`rounded-full border font-semibold outline-none transition ${
              compact ? "px-3 py-1.5" : "px-4 py-2"
            } ${
              selected
                ? "border-[var(--content-strong)] text-white ring-2 ring-[var(--content-strong)]"
                : "border-[var(--border-base)] text-white hover:scale-[1.03] hover:border-[var(--content-secondary)]"
            }`}
            style={{
              backgroundColor: color,
              fontSize: `${12 + Math.min(compact ? 6 : 16, (value / max) * (compact ? 6 : 16))}px`,
            }}
          >
            {label}
            <span className="ml-1 opacity-75">{formatCellValue(value)}</span>
          </span>
        );
      })}
    </div>
  );
}

function HeatmapChart({
  chart,
  metricKey,
  sortMode = "desc",
  selectedRowKey,
  onSelectRow,
  compact = false,
}: ChartRenderProps) {
  const xKey = chart.encodings?.x ?? "segment";
  const yKey = chart.encodings?.y ?? "theme";
  const valueKey = primaryMetricFor(chart, metricKey);
  const rows = sortRows(chart, valueKey, sortMode).slice(0, compact ? 6 : 16);
  const max = Math.max(1, ...rows.map((row) => numericValue(row, valueKey)));

  return (
    <div className={compact ? "grid gap-1.5 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-2"}>
      {rows.map((row, index) => {
        const value = numericValue(row, valueKey);
        const rowKey = rowKeyFor(chart, row, index);
        const selected = selectedRowKey === rowKey;
        const color = chartColor(index, textValue(row, [xKey, yKey]));
        return (
          <div
            key={rowKey}
            role={onSelectRow ? "button" : undefined}
            tabIndex={onSelectRow ? 0 : undefined}
            onClick={() => onSelectRow?.(rowKey, row)}
            onKeyDown={(event) => {
              if (!onSelectRow) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectRow(rowKey, row);
              }
            }}
            className={`rounded-lg border outline-none transition ${
              compact ? "px-3 py-3" : "px-4 py-5"
            } ${
              selected
                ? "border-[var(--content-strong)] ring-2 ring-[var(--content-strong)]"
                : "border-[var(--border-base)] hover:border-[var(--content-secondary)]"
            }`}
            style={{
              backgroundColor: selected
                ? `color-mix(in srgb, ${color} 48%, transparent)`
                : `color-mix(in srgb, ${color} ${Math.max(16, (value / max) * 58)}%, transparent)`,
            }}
          >
            <div className={`${compact ? "text-body-small-default" : "text-body-medium-default"} font-semibold text-[var(--content-strong)]`}>
              {textValue(row, [xKey])}
            </div>
            <div className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
              {textValue(row, [yKey])} · {Math.round(value).toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MatrixChart({
  chart,
  selectedRowKey,
  onSelectRow,
  compact = false,
}: ChartRenderProps) {
  const xKey = chart.encodings?.x ?? "confidence";
  const yKey = chart.encodings?.y ?? "impact";
  const labelKey = labelKeyFor(chart);
  const rows = chart.data.slice(0, compact ? 6 : 12);
  const xValues = rows.map((row) => numericValue(row, xKey));
  const yValues = rows.map((row) => numericValue(row, yKey));

  return (
    <div className={`relative ${compact ? "h-48" : "h-[500px]"} rounded-lg border border-[var(--border-base)] bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,#a855f7_18%,transparent),transparent_34%),var(--surface-base)]`}>
      <div className="absolute inset-x-4 top-1/2 border-t border-dashed border-[var(--border-base)]" />
      <div className="absolute inset-y-4 left-1/2 border-l border-dashed border-[var(--border-base)]" />
      {rows.map((row, index) => {
        const rowKey = rowKeyFor(chart, row, index);
        const selected = selectedRowKey === rowKey;
        const x = normalizePoint(numericValue(row, xKey), xValues);
        const y = normalizePoint(numericValue(row, yKey), yValues);
        const color = chartColor(index, textValue(row, [labelKey]));
        return (
          <div
            key={rowKey}
            role={onSelectRow ? "button" : undefined}
            tabIndex={onSelectRow ? 0 : undefined}
            onClick={() => onSelectRow?.(rowKey, row)}
            onKeyDown={(event) => {
              if (!onSelectRow) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectRow(rowKey, row);
              }
            }}
            className={`absolute max-w-[170px] -translate-x-1/2 -translate-y-1/2 rounded-full px-3 py-1.5 text-label-small-default font-semibold text-white shadow-sm outline-none transition ${
              selected
                ? "ring-4 ring-[var(--content-strong)]"
                : "hover:scale-[1.04] hover:ring-2 hover:ring-[var(--content-secondary)]"
            }`}
            style={{ left: `${x}%`, bottom: `${y}%`, backgroundColor: color }}
            title={textValue(row, [labelKey])}
          >
            <span className="block truncate">{textValue(row, [labelKey])}</span>
          </div>
        );
      })}
      <span className="absolute bottom-2 left-3 text-label-small-default text-[var(--content-tertiary)]">
        Lower priority
      </span>
      <span className="absolute right-3 top-2 text-label-small-default text-[var(--content-tertiary)]">
        High confidence / impact
      </span>
    </div>
  );
}

function ChartPreview(props: ChartRenderProps) {
  const { chart } = props;
  if (isCadenceLike(chart)) return <VerticalBarChart {...props} />;
  if (chart.type === "word_bank") return <WordBankChart {...props} />;
  if (chart.type === "heatmap") return <HeatmapChart {...props} />;
  if (chart.type === "matrix" || chart.type === "scatter") {
    return <MatrixChart {...props} />;
  }
  return <BarLikeChart {...props} />;
}

function AuditPageNavItem({
  chart,
  index,
  total,
  selected,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  chart: AuditChartSpec;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const parts = chartTitleParts(chart.title);
  const accent = chartAccent(chart);

  return (
    <div
      className={`rounded-lg border transition ${
        selected
          ? "border-[var(--content-strong)] bg-[var(--surface-active)]"
          : "border-[var(--border-base)] bg-[var(--surface-base)] hover:bg-[var(--surface-active)]"
      }`}
    >
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span
          className="mt-1 h-9 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--content-tertiary)]">
            Page {index + 1} of {total} · {parts.section}
          </span>
          <span className="mt-1 block text-body-small-default font-semibold leading-5 text-[var(--content-strong)]">
            {parts.headline}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-label-small-default text-[var(--content-tertiary)]">
            <ChartIcon type={chart.type} />
            {chart.family.replaceAll("_", " ")}
          </span>
        </span>
      </button>
      <div className="flex items-center justify-end gap-1 border-t border-[var(--border-base)] px-2 py-1.5">
        <button
          type="button"
          className="rounded-md border border-[var(--border-base)] p-1 text-[var(--content-secondary)] disabled:opacity-35"
          onClick={onMoveUp}
          disabled={index === 0}
          aria-label={`Move ${chart.title} up`}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--border-base)] p-1 text-[var(--content-secondary)] disabled:opacity-35"
          onClick={onMoveDown}
          disabled={index === total - 1}
          aria-label={`Move ${chart.title} down`}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function triggerPdfDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function RetentionAuditSurface({
  surface,
  onAction,
  onOpenDocument,
}: RetentionAuditSurfaceProps) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const data = asData(surface.data);
  const charts = data.charts ?? EMPTY_CHARTS;
  const modules = data.modules ?? [];
  const [artifactCharts, setArtifactCharts] = useState<AuditChartSpec[]>(charts);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [pdfExport, setPdfExport] = useState<{
    url: string;
    filename: string;
  } | null>(null);
  const [showFullAudit, setShowFullAudit] = useState(false);
  const [activeChartId, setActiveChartId] = useState(
    preferredInitialChartId(charts),
  );
  const [selectedRowKey, setSelectedRowKey] = useState<string | undefined>();
  const [selectedRow, setSelectedRow] = useState<ChartRow | null>(null);
  const [activeMetricKey, setActiveMetricKey] = useState<string | undefined>();
  const [sortMode, setSortMode] = useState<"none" | "asc" | "desc">("desc");
  const sourceMode = data.summary?.sourceMode ?? "unknown";
  const isFullLiveAudit = sourceMode === "live_readonly";
  const isKlaviyoL365Audit = sourceMode === "klaviyo_l365";
  const isKlaviyoInventoryAudit = sourceMode === "klaviyo_inventory";
  const activeChart = useMemo(
    () =>
      artifactCharts.find((chart) => chart.chartId === activeChartId) ??
      artifactCharts[0],
    [activeChartId, artifactCharts],
  );
  const activeChartIndex = useMemo(
    () =>
      activeChart
        ? artifactCharts.findIndex((chart) => chart.chartId === activeChart.chartId)
        : -1,
    [activeChart, artifactCharts],
  );
  const surfaceWithoutTitle = { ...surface, title: undefined };
  const activeMetricKeys = activeChart ? metricKeys(activeChart) : [];
  const activeTitleParts = activeChart
    ? chartTitleParts(activeChart.title)
    : null;
  const activeAccent = activeChart ? chartAccent(activeChart) : "#22c55e";
  const topBacklog = (data.backlog ?? []).slice(0, 3);
  const summaryStats = [
    {
      label: "Charts",
      value: data.summary?.chartCount ?? charts.length,
    },
    {
      label: "Modules",
      value: data.summary?.moduleCount ?? modules.length,
    },
    {
      label: "Opportunities",
      value: data.summary?.backlogCount ?? data.backlog?.length ?? 0,
    },
    {
      label: "Source",
      value: sourceMode.replaceAll("_", " "),
    },
  ];

  useEffect(() => {
    setArtifactCharts(charts);
    setActiveChartId((current) =>
      charts.some((chart) => chart.chartId === current)
        ? current
        : preferredInitialChartId(charts),
    );
  }, [charts]);

  useEffect(() => {
    setSelectedRowKey(undefined);
    setSelectedRow(null);
    setActiveMetricKey((current) =>
      activeChart && current && metricKeys(activeChart).includes(current)
        ? current
        : activeChart
          ? primaryMetricFor(activeChart)
          : undefined,
    );
    setSortMode(activeChart?.interaction?.defaultSort ?? "desc");
  }, [activeChart?.chartId]);

  useEffect(
    () => () => {
      if (pdfExport) URL.revokeObjectURL(pdfExport.url);
    },
    [pdfExport],
  );

  const moveChart = (chartId: string, direction: -1 | 1) => {
    setArtifactCharts((current) => {
      const from = current.findIndex((chart) => chart.chartId === chartId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return next;
    });
    setActiveChartId(chartId);
  };

  const updateActiveChart = (patch: Partial<AuditChartSpec>) => {
    if (!activeChart) return;
    setArtifactCharts((current) =>
      current.map((chart) =>
        chart.chartId === activeChart.chartId ? { ...chart, ...patch } : chart,
      ),
    );
  };

  const handleDownloadPdf = async (action: "download" | "open" = "download") => {
    if (!assistantId || !data.documentSurfaceId) return;
    const previewWindow =
      action === "open"
        ? openPdfPreparingWindow(
            `${data.brandName ?? "Worklin"} ${data.title ?? "Audit"} PDF Export`,
          )
        : null;
    setDownloadError(null);
    setDownloadNotice(null);
    setIsDownloadingPdf(true);
    if (pdfExport) {
      URL.revokeObjectURL(pdfExport.url);
      setPdfExport(null);
    }
    try {
      const { data: blob, response } = await documentsByIdPdfGet({
        path: { assistant_id: assistantId, id: data.documentSurfaceId },
        throwOnError: false,
        parseAs: "blob",
      });
      if (!response?.ok || !blob) {
        setDownloadError("PDF export is not available yet.");
        return;
      }
      const filename = safePdfFilename(
        `${data.brandName ?? "Worklin"} ${data.title ?? "Deep Retention Audit"}`,
      );
      const pdfBlob =
        blob.type === "application/pdf"
          ? blob
          : new Blob([blob], { type: "application/pdf" });
      const url = URL.createObjectURL(pdfBlob);
      setPdfExport({ url, filename });
      if (action === "download") {
        triggerPdfDownload(url, filename);
        setDownloadNotice(
          "PDF download started. If your browser blocks it, use the Download PDF fallback below.",
        );
      } else {
        if (previewWindow && !previewWindow.closed) {
          previewWindow.location.href = url;
          setDownloadNotice(
            "PDF opened in a new tab. Fallback links are also available below.",
          );
        } else {
          setDownloadNotice(
            "Your browser blocked the PDF tab. Use the Open PDF fallback below.",
          );
        }
      }
    } catch {
      if (previewWindow && !previewWindow.closed) previewWindow.close();
      setDownloadError("PDF export failed. Open the document and try Export.");
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  return (
    <SurfaceContainer surface={surfaceWithoutTitle} onAction={onAction}>
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-label-small-default uppercase text-[var(--content-tertiary)]">
              Worklin retention
            </div>
            <h3 className="mt-1 text-title-medium text-[var(--content-strong)]">
              {data.title ?? surface.title ?? "Deep Retention Audit"}
            </h3>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
              {data.brandName ?? "Brand"} · {sourceMode} · {data.summary?.chartCount ?? charts.length} charts
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--system-positive-weak)] px-2 py-1 text-label-small-default text-[var(--system-positive-strong)]">
              <ShieldCheck className="h-3.5 w-3.5" />
              No external action
            </span>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-active)] p-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                Client-ready audit
              </p>
              <h4 className="mt-1 text-title-small text-[var(--content-strong)]">
                Browse the summary, then open or download the full report.
              </h4>
              <p className="mt-1 max-w-3xl text-body-small-default text-[var(--content-secondary)]">
                The PDF includes the written audit plus visual chart sections
                for sharing. The full interactive audit stays tucked away until
                you want to inspect charts, data points, modules, and backlog.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {data.pdfReady && (
                <>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--content-strong)] px-3 py-2 text-label-small-default text-[var(--surface-base)] disabled:opacity-60"
                    disabled={!assistantId || !data.documentSurfaceId || isDownloadingPdf}
                    onClick={() => void handleDownloadPdf("download")}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {isDownloadingPdf ? "Preparing PDF" : "Download PDF"}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-label-small-default text-[var(--content-secondary)] disabled:opacity-60"
                    disabled={!assistantId || !data.documentSurfaceId || isDownloadingPdf}
                    onClick={() => void handleDownloadPdf("open")}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Open PDF
                  </button>
                </>
              )}
              {charts.length > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-label-small-default text-[var(--content-secondary)]"
                  onClick={() => setShowFullAudit((current) => !current)}
                >
                  {showFullAudit ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {showFullAudit ? "Hide full audit" : "View full audit"}
                </button>
              )}
              {data.documentSurfaceId && onOpenDocument && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-label-small-default text-[var(--content-secondary)]"
                  onClick={() => onOpenDocument(data.documentSurfaceId!)}
                >
                  <FileText className="h-3.5 w-3.5" />
                  Open editable doc
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {summaryStats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2.5"
              >
                <p className="text-label-small-default text-[var(--content-tertiary)]">
                  {stat.label}
                </p>
                <p className="mt-0.5 text-body-medium-default text-[var(--content-strong)]">
                  {typeof stat.value === "number"
                    ? stat.value.toLocaleString()
                    : stat.value}
                </p>
              </div>
            ))}
          </div>

          {topBacklog.length > 0 && (
            <div className="mt-4 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-3">
              <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                Top next actions
              </p>
              <div className="mt-2 divide-y divide-[var(--border-base)]">
                {topBacklog.map((item, index) => (
                  <div
                    key={item.backlogKey ?? `${item.title}-${index}`}
                    className="py-2 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-body-small-default font-medium text-[var(--content-strong)]">
                        {index + 1}. {item.title}
                      </p>
                      <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                        impact {item.impact ?? "-"}
                      </span>
                    </div>
                    {item.nextAction && (
                      <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
                        {item.nextAction}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {downloadError && (
          <p className="mt-2 text-body-small-default text-[var(--system-negative-strong)]">
            {downloadError}
          </p>
        )}
        {downloadNotice && (
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            {downloadNotice}
          </p>
        )}
        {isDownloadingPdf && (
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            Long audit PDFs can take 20-40 seconds to render.
          </p>
        )}
        {pdfExport && (
          <div className="mt-3 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body-small-default text-[var(--content-secondary)]">
                PDF ready fallback
              </span>
              <a
                href={pdfExport.url}
                download={pdfExport.filename}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--content-strong)] px-2.5 py-1.5 text-label-small-default text-[var(--surface-base)]"
              >
                <Download className="h-3.5 w-3.5" />
                Download PDF
              </a>
              <a
                href={pdfExport.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2.5 py-1.5 text-label-small-default text-[var(--content-secondary)]"
              >
                <Eye className="h-3.5 w-3.5" />
                Open PDF
              </a>
            </div>
          </div>
        )}

        {!isFullLiveAudit && (
          <div
            className={
              isKlaviyoL365Audit || isKlaviyoInventoryAudit
                ? "mt-4 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-3 py-2.5"
                : "mt-4 rounded-md border border-[var(--system-negative-strong)] bg-[color-mix(in_srgb,var(--system-negative-strong)_12%,transparent)] px-3 py-2.5"
            }
          >
            <p
              className={
                isKlaviyoL365Audit || isKlaviyoInventoryAudit
                  ? "text-body-small-default font-medium text-[var(--content-strong)]"
                  : "text-body-small-default font-medium text-[var(--system-negative-strong)]"
              }
            >
              {isKlaviyoL365Audit
                ? "Live audit: Klaviyo L365 account scope."
                : isKlaviyoInventoryAudit
                  ? "Partial live audit: Klaviyo inventory only."
                : "Source warning: this is not a valid real-client deep audit."}
            </p>
            <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
              {isKlaviyoL365Audit
                ? "This artifact uses the live read-only Klaviyo L365 snapshot. Shopify is optional commerce enrichment for product, order, LTV, AOV, replenishment, and revenue reconciliation; it is not required for this Klaviyo account audit. No fixture/sample commerce data was used."
                : isKlaviyoInventoryAudit
                  ? "This artifact uses the live read-only Klaviyo inventory snapshot. It does not use fixture/sample Shopify, product, revenue, customer, campaign-performance, segment-performance, or flow-performance data. The full commerce audit is blocked until Shopify and deeper Klaviyo history are connected."
                : `Source mode is ${sourceMode}. Worklin may have used fixture/sample data for missing Shopify, revenue, product, campaign-performance, segment, or flow-performance inputs. Regenerate only after the new source coverage check passes.`}
            </p>
          </div>
        )}

        {showFullAudit && charts.length > 0 && (
          <div className="mt-6">
            <div className="mb-3">
              <h4 className="text-title-small text-[var(--content-strong)]">
                Interactive audit pages
              </h4>
              <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
                Each page is built like the manual audits: a large visual,
                the diagnosis, the recommended action, and clickable data
                underneath.
              </p>
            </div>

            <div className="grid gap-6 2xl:grid-cols-[290px_minmax(0,1fr)] 2xl:items-start">
              <aside className="order-2 2xl:order-1 2xl:sticky 2xl:top-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                    Audit pages
                  </p>
                  <span className="rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                    {artifactCharts.length.toLocaleString()}
                  </span>
                </div>
                <div className="max-h-[720px] space-y-2 overflow-y-auto pr-1">
                  {artifactCharts.map((chart, index) => (
                    <AuditPageNavItem
                      key={chart.chartId}
                      chart={chart}
                      index={index}
                      total={artifactCharts.length}
                      selected={activeChart?.chartId === chart.chartId}
                      onSelect={() => setActiveChartId(chart.chartId)}
                      onMoveUp={() => moveChart(chart.chartId, -1)}
                      onMoveDown={() => moveChart(chart.chartId, 1)}
                    />
                  ))}
                </div>
              </aside>

              {activeChart && activeTitleParts && (
                <section className="order-1 overflow-hidden rounded-lg border border-[var(--content-strong)] bg-[var(--surface-base)] shadow-[0_18px_70px_color-mix(in_srgb,var(--content-strong)_16%,transparent)] 2xl:order-2">
                  <div
                    className="h-2 w-full"
                    style={{ backgroundColor: activeAccent }}
                  />
                  <div className="border-b border-[var(--border-base)] px-6 py-5 md:px-8">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                          {activeTitleParts.section}
                        </p>
                        <h4 className="mt-1 text-title-medium text-[var(--content-strong)]">
                          {activeTitleParts.headline}
                        </h4>
                        <p className="mt-1 inline-flex items-center gap-1.5 text-body-small-default text-[var(--content-secondary)]">
                          <Maximize2 className="h-3.5 w-3.5" />
                          Page {activeChartIndex + 1} of {artifactCharts.length} · interactive report page
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] px-2.5 py-1.5 text-label-small-default text-[var(--content-secondary)] disabled:opacity-35"
                          disabled={activeChartIndex <= 0}
                          onClick={() => moveChart(activeChart.chartId, -1)}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                          Move up
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] px-2.5 py-1.5 text-label-small-default text-[var(--content-secondary)] disabled:opacity-35"
                          disabled={
                            activeChartIndex < 0 ||
                            activeChartIndex >= artifactCharts.length - 1
                          }
                          onClick={() => moveChart(activeChart.chartId, 1)}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                          Move down
                        </button>
                        {data.documentSurfaceId && onOpenDocument && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--content-strong)] px-2.5 py-1.5 text-label-small-default text-[var(--surface-base)]"
                            onClick={() => onOpenDocument(data.documentSurfaceId!)}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            Edit document
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-5 p-5 md:p-8">
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-label-small-default text-[var(--content-tertiary)]">
                          Metric
                        </span>
                        {activeMetricKeys.length > 0 ? (
                          activeMetricKeys.slice(0, 5).map((key) => (
                            <button
                              key={key}
                              type="button"
                              className={`rounded-full px-2.5 py-1 text-label-small-default ${
                                (activeMetricKey ?? activeMetricKeys[0]) === key
                                  ? "bg-[var(--content-strong)] text-[var(--surface-base)]"
                                  : "border border-[var(--border-base)] text-[var(--content-secondary)]"
                              }`}
                              onClick={() => setActiveMetricKey(key)}
                            >
                              {formatLabel(key)}
                            </button>
                          ))
                        ) : (
                          <span className="text-body-small-default text-[var(--content-tertiary)]">
                            Auto
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {(["desc", "asc", "none"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={`rounded-full px-2.5 py-1 text-label-small-default ${
                              sortMode === mode
                                ? "bg-[var(--content-strong)] text-[var(--surface-base)]"
                                : "border border-[var(--border-base)] text-[var(--content-secondary)]"
                            }`}
                            onClick={() => setSortMode(mode)}
                          >
                            {mode === "none" ? "Original" : mode === "desc" ? "High first" : "Low first"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="min-h-[720px] rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4 md:p-7">
                      <ChartPreview
                        chart={activeChart}
                        metricKey={activeMetricKey}
                        sortMode={sortMode}
                        selectedRowKey={selectedRowKey}
                        onSelectRow={(rowKey, row) => {
                          setSelectedRowKey(rowKey);
                          setSelectedRow(row);
                        }}
                      />
                    </div>

                    <div className="grid gap-3 lg:grid-cols-2">
                      <label
                        className="block rounded-lg border border-[var(--border-base)] bg-[var(--surface-active)] p-4"
                        style={{
                          boxShadow: `inset 4px 0 0 ${activeAccent}`,
                        }}
                      >
                        <span className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                          Diagnosis
                        </span>
                        <textarea
                          className="mt-2 min-h-36 w-full resize-y rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default leading-5 text-[var(--content-secondary)] outline-none focus:border-[var(--content-strong)]"
                          value={activeChart.diagnosis ?? ""}
                          onChange={(event) =>
                            updateActiveChart({ diagnosis: event.target.value })
                          }
                        />
                      </label>
                      <label
                        className="block rounded-lg border border-[var(--border-base)] bg-[var(--surface-active)] p-4"
                        style={{
                          boxShadow: `inset 4px 0 0 ${activeAccent}`,
                        }}
                      >
                        <span className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                          Recommended action
                        </span>
                        <textarea
                          className="mt-2 min-h-36 w-full resize-y rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default leading-5 text-[var(--content-secondary)] outline-none focus:border-[var(--content-strong)]"
                          value={activeChart.recommendation ?? ""}
                          onChange={(event) =>
                            updateActiveChart({
                              recommendation: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>

                    <ChartEvidenceTable
                      chart={activeChart}
                      selectedRowKey={selectedRowKey}
                      onSelectRow={(rowKey, row) => {
                        setSelectedRowKey(rowKey);
                        setSelectedRow(row);
                      }}
                    />

                    <div className="rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-3 py-2.5">
                      <p className="text-label-small-default uppercase text-[var(--content-tertiary)]">
                        Clicked data point
                      </p>
                      {selectedRow ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {rowValues(selectedRow).map(([key, value]) => (
                            <div
                              key={key}
                              className="rounded-md bg-[var(--surface-base)] px-2.5 py-2"
                            >
                              <p className="text-label-small-default text-[var(--content-tertiary)]">
                                {key}
                              </p>
                              <p className="mt-0.5 text-body-small-default font-medium text-[var(--content-strong)]">
                                {value}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-body-small-default text-[var(--content-secondary)]">
                          Click a bar, word, block, matrix point, or evidence row to inspect the underlying data.
                        </p>
                      )}
                    </div>

                    <p className="text-body-small-default text-[var(--content-tertiary)]">
                      These edits update the interactive artifact view. Use Edit
                      document to revise the exportable audit copy.
                    </p>
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {showFullAudit && modules.length > 0 && (
          <section className="mt-5 border-t border-[var(--border-base)] pt-4">
            <h4 className="text-title-small text-[var(--content-strong)]">
              Audit modules
            </h4>
            <div className="mt-3 grid gap-2">
              {modules.map((module, index) => (
                <div
                  key={module.moduleId ?? `${module.title}-${index}`}
                  className="rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-body-medium-default text-[var(--content-strong)]">
                      {module.title ?? `Module ${index + 1}`}
                    </p>
                    <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                      {module.status ?? "ready"}
                    </span>
                  </div>
                  {module.summary && (
                    <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
                      {module.summary}
                    </p>
                  )}
                  <p className="mt-2 text-label-small-default text-[var(--content-tertiary)]">
                    {(module.charts?.length ?? 0).toLocaleString()} charts /{" "}
                    {(module.insights?.length ?? 0).toLocaleString()} insights /{" "}
                    {(module.recommendations?.length ?? 0).toLocaleString()} recommendations
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {showFullAudit && (data.backlog?.length ?? 0) > 0 && (
          <section className="mt-5 border-t border-[var(--border-base)] pt-4">
            <h4 className="text-title-small text-[var(--content-strong)]">
              Prioritized backlog
            </h4>
            <div className="mt-3 divide-y divide-[var(--border-base)]">
              {(data.backlog ?? []).slice(0, 5).map((item, index) => (
                <div
                  key={item.backlogKey ?? `${item.title}-${index}`}
                  className="py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-body-medium-default text-[var(--content-strong)]">
                      {index + 1}. {item.title}
                    </p>
                    <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                      impact {item.impact ?? "-"}
                    </span>
                  </div>
                  {item.nextAction && (
                    <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
                      {item.nextAction}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {showFullAudit && (
          <section className="mt-5 border-t border-[var(--border-base)] pt-4">
            <h4 className="text-title-small text-[var(--content-strong)]">
              Safety
            </h4>
            <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
              externalActionTaken:{String(data.safety?.externalActionTaken ?? false)} · canGoLiveNow:{String(data.safety?.canGoLiveNow ?? false)}
            </p>
            {(data.safety?.blockedCapabilities?.length ?? 0) > 0 && (
              <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                Blocked: {data.safety?.blockedCapabilities?.join(", ")}
              </p>
            )}
          </section>
        )}
      </div>
    </SurfaceContainer>
  );
}
