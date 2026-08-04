import { useQuery } from "@tanstack/react-query";
import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileWarning,
  Globe2,
  ImageOff,
  Lightbulb,
  Megaphone,
  PackageSearch,
  Play,
  Search,
  ShieldCheck,
  Store,
  Target,
  TriangleAlert,
  Users,
  XCircle,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { artifactsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";

import {
  parseCompetitorIntelligence,
  type CompetitorIntelligenceReport,
  type Confidence,
  type IntelligenceClaim,
  type IntelligenceCompetitor,
  type IntelligenceMetric,
  type IntelligenceModule,
  type IntelligenceModuleKey,
  type IntelligenceRecommendation,
  type IntelligenceVisual,
  type IntelligenceVisualization,
} from "./competitor-intelligence-model";
import { BrandResearchDashboard } from "./brand-research-dashboard";

type IntelligenceTab =
  | "briefing"
  | "brand"
  | "market"
  | "customers"
  | "offers"
  | "journey"
  | "channels"
  | "competitors"
  | "strategy"
  | "evidence";

type AssetChannel = "all" | "ads" | "emails" | "social" | "products";
type DateRange = "7d" | "30d" | "90d" | "12m" | "all";
type SortOrder = "newest" | "oldest";

const TABS: Array<{
  id: IntelligenceTab;
  label: string;
  icon: typeof BarChart3;
}> = [
  { id: "briefing", label: "Summary", icon: BarChart3 },
  { id: "brand", label: "Your brand", icon: Building2 },
  { id: "market", label: "Market", icon: Globe2 },
  { id: "customers", label: "Customers", icon: Users },
  { id: "offers", label: "Products & prices", icon: PackageSearch },
  { id: "journey", label: "Buying journey", icon: Target },
  { id: "channels", label: "Marketing", icon: Megaphone },
  { id: "competitors", label: "Competitors", icon: Store },
  { id: "strategy", label: "Next steps", icon: Lightbulb },
  { id: "evidence", label: "Sources", icon: ShieldCheck },
];

const MODULE_LABELS: Record<IntelligenceModuleKey, string> = {
  company_operating_model: "How the business works",
  market_category: "The market",
  customers_demand: "Customers and what they want",
  offers_pricing_portfolio: "Products and prices",
  brand_positioning_creative: "How the brand presents itself",
  customer_journey: "How people discover and buy",
  growth_channels_lifecycle: "How the brand reaches people",
  economics_financial: "Money and business health",
  culture_trends: "What is changing around the brand",
  reputation_risk: "What customers say and what could go wrong",
  competitors: "Competitors",
  strategic_synthesis: "What to do next",
};

const TAB_MODULES: Partial<Record<IntelligenceTab, IntelligenceModuleKey[]>> = {
  brand: ["company_operating_model", "brand_positioning_creative"],
  market: ["market_category", "culture_trends", "economics_financial"],
  customers: ["customers_demand", "reputation_risk"],
  offers: ["offers_pricing_portfolio"],
  journey: ["customer_journey"],
  channels: ["growth_channels_lifecycle"],
  competitors: ["competitors"],
  strategy: ["strategic_synthesis"],
};

const DATE_RANGES: Array<{ id: DateRange; label: string }> = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "12m", label: "12 months" },
  { id: "all", label: "All available" },
];

function formatObservedAt(value: string, includeTime = false): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        ...(includeTime
          ? { hour: "numeric", minute: "2-digit" }
          : {}),
      }).format(date)
    : "Date unavailable";
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function rangeCutoff(range: DateRange, now: number): number | null {
  const day = 24 * 60 * 60 * 1000;
  if (range === "7d") return now - 7 * day;
  if (range === "30d") return now - 30 * day;
  if (range === "90d") return now - 90 * day;
  if (range === "12m") return now - 365 * day;
  return null;
}

function visualTimestamp(item: IntelligenceVisual): number {
  const value = new Date(item.observedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function coverageLabel(items: IntelligenceVisual[]): string {
  const timestamps = items
    .map(visualTimestamp)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (!timestamps.length) return "Dates are not available";
  return `${formatObservedAt(new Date(timestamps[0]).toISOString())} - ${formatObservedAt(
    new Date(timestamps[timestamps.length - 1]).toISOString(),
  )}`;
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function friendlyProviderName(value: string): string {
  return value.toLowerCase() === "trendtrack"
    ? "Market research"
    : value;
}

function friendlyResearchNote(value: string): string {
  return value
    .replaceAll(/trendtrack/gi, "the connected research service")
    .replaceAll(/provider/gi, "research service")
    .replaceAll(/credits?/gi, "uses");
}

function friendlyFindingType(value: IntelligenceClaim["type"]): string {
  if (value === "fact") return "Confirmed";
  if (value === "estimate" || value === "calculation") return "Estimate";
  if (value === "pattern") return "Repeated pattern";
  if (value === "inference") return "Best reading";
  if (value === "hypothesis") return "Idea to test";
  return "Open question";
}

function friendlyMetricKind(value: IntelligenceMetric["kind"]): string {
  if (value === "observed") return "Seen directly";
  if (value === "calculated") return "Calculated";
  return "Estimate";
}

function friendlyEffort(value: IntelligenceRecommendation["effort"]): string {
  if (value === "low") return "Quick";
  if (value === "high") return "Large job";
  return "Some work";
}

function friendlyVisualizationType(
  value: IntelligenceVisualization["type"],
): string {
  const labels: Record<IntelligenceVisualization["type"], string> = {
    metric_tiles: "At a glance",
    timeline: "What changed over time",
    comparison_matrix: "Side-by-side view",
    journey_map: "How people move toward a purchase",
    positioning_map: "How the brands differ",
    theme_clusters: "Repeated themes",
    offer_ladder: "Products and prices",
    claim_proof_matrix: "Claims and proof",
    channel_map: "Where the brand appears",
    risk_matrix: "Risks to watch",
    opportunity_matrix: "Opportunities",
    recommendation_sequence: "Order of work",
    evidence_gallery: "Examples",
  };
  return labels[value];
}

function friendlyCompetitorType(
  value: IntelligenceCompetitor["classification"],
): string {
  if (value === "direct") return "Direct competitor";
  if (value === "adjacent") return "Similar option";
  if (value === "substitute") return "Different solution";
  if (value === "aspirational") return "Brand to learn from";
  return "Type not set";
}

function SignalList({
  title,
  items,
  empty = "We did not find enough reliable information for this yet.",
}: {
  title: string;
  items: string[];
  empty?: string;
}) {
  return (
    <section className="border-t border-[var(--border-base)] py-5 first:border-t-0 first:pt-0">
      <h3 className="text-title-small text-[var(--content-default)]">
        {title}
      </h3>
      {items.length ? (
        <ul className="mt-3 grid gap-2">
          {items.map((item, index) => (
            <li
              key={`${title}-${index}`}
              className="flex gap-3 text-body-medium-default text-[var(--content-subtle)]"
            >
              <span
                className="mt-[9px] size-1.5 shrink-0 rounded-full bg-[var(--content-accent)]"
                aria-hidden
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-body-medium-default text-[var(--content-subtlest)]">
          {empty}
        </p>
      )}
    </section>
  );
}

function ConfidenceLabel({ value }: { value: Confidence }) {
  const label =
    value === "high"
      ? "Very sure"
      : value === "medium"
        ? "Fairly sure"
        : value === "low"
          ? "Needs checking"
          : "Idea to test";
  return (
    <span
      className={cn(
        "rounded px-2 py-1 text-label-small capitalize",
        value === "high" &&
          "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]",
        value === "medium" &&
          "bg-[var(--surface-sunken)] text-[var(--content-subtle)]",
        value === "low" &&
          "bg-[var(--system-warning-weak)] text-[var(--system-warning-strong)]",
        value === "hypothesis" &&
          "bg-[var(--system-information-weak)] text-[var(--system-information-strong)]",
      )}
    >
      {label}
    </span>
  );
}

function StatusLabel({ status }: { status: IntelligenceModule["status"] }) {
  const Icon =
    status === "complete"
      ? CheckCircle2
      : status === "partial"
        ? CircleAlert
        : XCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-label-small",
        status === "complete" &&
          "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]",
        status === "partial" &&
          "bg-[var(--system-warning-weak)] text-[var(--system-warning-strong)]",
        (status === "unavailable" || status === "not_observable") &&
          "bg-[var(--surface-sunken)] text-[var(--content-subtle)]",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {status === "complete"
        ? "Done"
        : status === "partial"
          ? "More work needed"
          : "Could not confirm"}
    </span>
  );
}

function EvidenceLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-body-small-default text-[var(--content-accent)] hover:underline",
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function SectionHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-title-medium text-[var(--content-default)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-body-small-default text-[var(--content-subtle)]">
            {description}
          </p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

function MetricValue({ metric }: { metric: IntelligenceMetric }) {
  const value =
    metric.value !== undefined
      ? typeof metric.value === "number"
        ? compactNumber(metric.value)
        : metric.value
      : metric.range
        ? `${compactNumber(metric.range.min)} - ${compactNumber(metric.range.max)}`
        : "Unavailable";
  return (
    <div className="border-l-2 border-[var(--border-base)] pl-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-label-small text-[var(--content-subtlest)]">
          {metric.label}
        </p>
        <ConfidenceLabel value={metric.confidence.band} />
      </div>
      <p className="mt-1 text-title-large text-[var(--content-default)]">
        {metric.currency ? `${metric.currency} ` : ""}
        {value}
        {metric.unit ? (
          <span className="ml-1 text-body-small-default text-[var(--content-subtle)]">
            {metric.unit}
          </span>
        ) : null}
      </p>
      <p className="mt-1 text-label-small text-[var(--content-subtlest)]">
        {friendlyMetricKind(metric.kind)}
        {metric.period ? ` | ${metric.period}` : ""}
        {metric.geography ? ` | ${metric.geography}` : ""}
      </p>
    </div>
  );
}

function dataRows(
  data: Record<string, unknown>,
): Array<{ label: string; value: string | number }> {
  const rowSource = Array.isArray(data.rows)
    ? data.rows
    : Array.isArray(data.points)
      ? data.points
      : null;
  if (rowSource) {
    return rowSource.slice(0, 12).flatMap((value, index) => {
      if (typeof value === "number" || typeof value === "string") {
        return [{ label: `Item ${index + 1}`, value }];
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const label =
        typeof record.label === "string"
          ? record.label
          : typeof record.name === "string"
            ? record.name
            : typeof record.category === "string"
              ? record.category
              : `Item ${index + 1}`;
      const candidate =
        record.value ?? record.score ?? record.count ?? record.amount;
      return typeof candidate === "number" || typeof candidate === "string"
        ? [{ label, value: candidate }]
        : [];
    });
  }
  return Object.entries(data).flatMap(([label, value]) =>
    typeof value === "number" || typeof value === "string"
      ? [{ label: titleCase(label), value }]
      : [],
  );
}

function VisualizationPanel({
  visualization,
}: {
  visualization: IntelligenceVisualization;
}) {
  const rows = dataRows(visualization.data);
  const numericRows = rows.filter(
    (row): row is { label: string; value: number } =>
      typeof row.value === "number",
  );
  const max = Math.max(1, ...numericRows.map((row) => Math.abs(row.value)));

  return (
    <section className="border-y border-[var(--border-base)] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-label-small uppercase text-[var(--content-subtlest)]">
            {friendlyVisualizationType(visualization.type)}
          </p>
          <h3 className="mt-1 text-title-small text-[var(--content-default)]">
            {visualization.title || "What the information shows"}
          </h3>
          {visualization.businessQuestion ? (
            <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
              {visualization.businessQuestion}
            </p>
          ) : null}
        </div>
        <span className="text-label-small text-[var(--content-subtlest)]">
          {visualization.evidenceIds.length} sources
        </span>
      </div>
      {rows.length ? (
        <div className="mt-5 grid gap-3">
          {rows.map((row, index) => (
            <div
              key={`${visualization.id}-${row.label}-${index}`}
              className="grid min-w-0 gap-2 sm:grid-cols-[minmax(140px,0.7fr)_minmax(180px,1fr)_auto] sm:items-center"
            >
              <span className="truncate text-body-small-default text-[var(--content-subtle)]">
                {row.label}
              </span>
              <div className="h-2 overflow-hidden rounded bg-[var(--surface-sunken)]">
                <div
                  className="h-full rounded bg-[var(--content-accent)]"
                  style={{
                    width:
                      typeof row.value === "number"
                        ? `${Math.max(4, (Math.abs(row.value) / max) * 100)}%`
                        : "18%",
                  }}
                />
              </div>
              <strong className="text-body-small-strong text-[var(--content-default)]">
                {typeof row.value === "number"
                  ? compactNumber(row.value)
                  : row.value}
              </strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-body-small-default text-[var(--content-subtlest)]">
          The conclusion is saved, but this research run did not provide
          numbers that can be shown in a chart.
        </p>
      )}
      {visualization.caveats.length ? (
        <p className="mt-4 border-t border-[var(--border-base)] pt-3 text-label-small text-[var(--content-subtlest)]">
          {visualization.caveats.join(" ")}
        </p>
      ) : null}
    </section>
  );
}

function ClaimList({ claims }: { claims: IntelligenceClaim[] }) {
  if (!claims.length) {
    return (
      <p className="text-body-medium-default text-[var(--content-subtlest)]">
        We did not find enough reliable information for this section yet.
      </p>
    );
  }
  return (
    <div className="divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
      {claims.map((claim) => (
        <article key={claim.id} className="py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-label-small text-[var(--content-subtle)]">
                  {friendlyFindingType(claim.type)}
                </span>
                {claim.material ? (
                  <span className="text-label-small text-[var(--system-warning-strong)]">
                    Important
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-body-medium-default text-[var(--content-default)]">
                {claim.statement}
              </p>
            </div>
            <ConfidenceLabel value={claim.confidence.band} />
          </div>
          <p className="mt-2 text-label-small text-[var(--content-subtlest)]">
            {claim.evidenceIds.length
              ? `${claim.evidenceIds.length} linked sources`
              : "No source linked yet"}
          </p>
        </article>
      ))}
    </div>
  );
}

function ModuleSection({
  module,
  report,
}: {
  module: IntelligenceModule;
  report: CompetitorIntelligenceReport;
}) {
  const intelligence = report.intelligence;
  if (!intelligence) return null;
  const claims = intelligence.claims.filter(
    (claim) => claim.module === module.key,
  );
  const metrics = intelligence.metrics.filter(
    (metric) => metric.module === module.key,
  );
  const visualizations = intelligence.visualizations.filter(
    (visualization) => visualization.module === module.key,
  );

  return (
    <section className="border-t border-[var(--border-base)] pt-7 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-title-medium text-[var(--content-default)]">
            {MODULE_LABELS[module.key]}
          </h2>
          <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
            How sure we are: {module.confidence.score}/100
            {module.confidence.rationale
              ? ` | ${module.confidence.rationale}`
              : ""}
          </p>
        </div>
        <StatusLabel status={module.status} />
      </div>

      {metrics.length ? (
        <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.slice(0, 8).map((metric) => (
            <MetricValue key={metric.id} metric={metric} />
          ))}
        </div>
      ) : null}

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)]">
        <div>
          <h3 className="mb-3 text-title-small text-[var(--content-default)]">
            Findings
          </h3>
          <ClaimList claims={claims} />
        </div>
        <div>
          <SignalList title="What this means" items={module.implications} />
          <SignalList title="What we still do not know" items={module.gaps} />
          <SignalList
            title="How we can check it"
            items={module.nextValidationSteps}
          />
        </div>
      </div>

      {visualizations.length ? (
        <div className="mt-7 grid gap-6 lg:grid-cols-2">
          {visualizations.map((visualization) => (
            <VisualizationPanel
              key={visualization.id}
              visualization={visualization}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ModuleGroupView({
  report,
  modules,
}: {
  report: CompetitorIntelligenceReport;
  modules: IntelligenceModuleKey[];
}) {
  if (!report.intelligence) {
    return (
      <div className="grid gap-x-8 lg:grid-cols-2">
        <SignalList
          title="How the brand presents itself"
          items={[report.identity.positioning].filter(Boolean)}
        />
        <SignalList title="Offers" items={report.identity.offers} />
        <SignalList
          title="What customers care about"
          items={report.identity.audienceSignals}
        />
        <SignalList
          title="What is changing in the market"
          items={[...report.marketSignals, ...report.trendSignals]}
        />
        <SignalList
          title="What customers say and do"
          items={report.customerSignals}
        />
        <SignalList
          title="What we still do not know"
          items={report.gaps}
        />
      </div>
    );
  }
  const selected = modules.flatMap((key) => {
    const module = report.intelligence?.modules.find((item) => item.key === key);
    return module ? [module] : [];
  });
  return (
    <div className="grid gap-9">
      {selected.map((module) => (
        <ModuleSection key={module.key} module={module} report={report} />
      ))}
    </div>
  );
}

function QualityPanel({ report }: { report: CompetitorIntelligenceReport }) {
  const quality = report.quality;
  if (!quality) {
    return (
      <div className="flex items-start gap-3 border-l-2 border-[var(--system-warning-strong)] pl-4">
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-[var(--system-warning-strong)]"
          aria-hidden
        />
        <div>
          <h3 className="text-title-small text-[var(--content-default)]">
            Earlier research
          </h3>
          <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
            This report was created before Worklin added its newer research
            checks. You can still see the findings and sources, but Worklin
            does not call it complete.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-l-2 pl-4",
        quality.accepted
          ? "border-[var(--system-positive-strong)]"
          : "border-[var(--system-warning-strong)]",
      )}
    >
      {quality.accepted ? (
        <CheckCircle2
          className="mt-0.5 size-5 shrink-0 text-[var(--system-positive-strong)]"
          aria-hidden
        />
      ) : (
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-[var(--system-warning-strong)]"
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-title-small text-[var(--content-default)]">
            {quality.accepted ? "Ready to use" : "More research needed"}
          </h3>
          <strong className="text-title-medium text-[var(--content-default)]">
            {Math.round(quality.score)}/100
          </strong>
        </div>
        <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
          {Math.round(quality.triangulatedMaterialClaimRatio * 100)}% of the
          important findings were confirmed by more than one source.
        </p>
        {quality.blockingFailures.length ? (
          <p className="mt-2 text-label-small text-[var(--system-warning-strong)]">
            Some important areas need more reliable sources before Worklin can
            call this ready.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BriefingView({ report }: { report: CompetitorIntelligenceReport }) {
  const intelligence = report.intelligence;
  const completedModules =
    intelligence?.modules.filter((module) => module.status === "complete")
      .length ?? 0;
  const sourceAssets = report.visualEvidence.filter(
    (item) => item.thumbnailUrl || item.mediaUrl,
  );
  const strategicWindow = intelligence?.scope.periodStart
    ? `${formatObservedAt(intelligence.scope.periodStart)} - ${formatObservedAt(
        intelligence.scope.periodEnd,
      )}`
    : "Dates reviewed are not available";
  const priorityDecisions = intelligence?.recommendations.length
    ? intelligence.recommendations.map((recommendation) => ({
        id: recommendation.id,
        priority: recommendation.priority,
        action: recommendation.action,
        rationale: recommendation.rationale,
        effort: recommendation.effort,
      }))
    : report.recommendations.map((recommendation, index) => ({
        id: `legacy-${index}`,
        priority: recommendation.priority,
        action: recommendation.action,
        rationale: recommendation.rationale,
        effort: undefined,
      }));

  return (
    <div>
      <div className="grid gap-5 border-b border-[var(--border-base)] pb-7 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.7fr)]">
        <section>
          <p className="text-label-small uppercase text-[var(--content-subtlest)]">
            Quick summary
          </p>
          <h2 className="mt-2 max-w-4xl text-title-large text-[var(--content-default)]">
            What you should know now
          </h2>
          <div className="mt-5">
            <SignalList
              title="Key findings"
              items={report.executiveSummary}
            />
          </div>
        </section>
        <aside className="border-l border-[var(--border-base)] pl-5">
          <QualityPanel report={report} />
          <dl className="mt-6 grid gap-4 text-body-small-default">
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--content-subtlest)]">
                Dates reviewed
              </dt>
              <dd className="text-right text-[var(--content-default)]">
                {strategicWindow}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--content-subtlest)]">
                Examples found between
              </dt>
              <dd className="text-right text-[var(--content-default)]">
                {coverageLabel(sourceAssets)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--content-subtlest)]">Updates</dt>
              <dd className="text-right text-[var(--content-default)]">
                Updates are paused
              </dd>
            </div>
          </dl>
        </aside>
      </div>

      <div className="grid border-b border-[var(--border-base)] sm:grid-cols-2 xl:grid-cols-5">
        {[
          [
            "Areas fully checked",
            `${completedModules} of ${intelligence?.modules.length ?? 0}`,
          ],
          ["Possible matches", report.competitorLandscape.length],
          ["Sources", report.evidence.length],
          ["Examples", sourceAssets.length],
          ["Open questions", report.gaps.length],
        ].map(([label, value], index) => (
          <div
            key={String(label)}
            className={cn(
              "px-4 py-5",
              index > 0 && "border-t border-[var(--border-base)] sm:border-t-0",
              index % 2 === 1 && "sm:border-l",
              index > 1 && "xl:border-l",
            )}
          >
            <p className="text-label-small text-[var(--content-subtlest)]">
              {label}
            </p>
            <p className="mt-1 text-title-large text-[var(--content-default)]">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <section>
          <SectionHeading
            title="What we learned"
            description="Patterns in the market, customer behaviour, and the brand that may change what you do next."
          />
          <div className="mt-5 grid gap-x-8 lg:grid-cols-2">
            <SignalList
              title="The market"
              items={[...report.marketSignals, ...report.trendSignals]}
            />
            <SignalList
              title="What customers want"
              items={report.customerSignals}
            />
            <SignalList
              title="How the brand presents itself"
              items={[
                report.identity.category,
                report.identity.positioning,
              ].filter(Boolean)}
            />
            <SignalList
              title="What the audience cares about"
              items={report.identity.audienceSignals}
            />
          </div>
        </section>
        <section>
          <SectionHeading title="What to do next" />
          <div className="mt-4 divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
            {priorityDecisions.slice(0, 5).map((recommendation) => (
                <div key={recommendation.id} className="py-4">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-label-small uppercase text-[var(--content-subtle)]">
                      {recommendation.priority}
                    </span>
                    {recommendation.effort ? (
                      <span className="text-label-small text-[var(--content-subtlest)]">
                        {friendlyEffort(recommendation.effort)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-body-medium-default text-[var(--content-default)]">
                    {recommendation.action}
                  </p>
                  {recommendation.rationale ? (
                    <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
                      {recommendation.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function assetChannel(item: IntelligenceVisual): AssetChannel {
  if (item.kind === "ad" || item.kind === "landing_page") return "ads";
  if (item.kind === "email") return "emails";
  if (item.kind === "social") return "social";
  if (
    item.kind === "product" ||
    item.kind === "brand" ||
    item.kind === "competitor"
  ) {
    return "products";
  }
  return "all";
}

function VisualAssetCard({
  item,
  onOpen,
}: {
  item: IntelligenceVisual;
  onOpen: (item: IntelligenceVisual) => void;
}) {
  const previewUrl =
    item.thumbnailUrl ??
    (item.mediaType === "image" ? item.mediaUrl : undefined);
  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="group block w-full text-left"
      >
        <div
          className={cn(
            "relative flex items-center justify-center overflow-hidden bg-[var(--surface-sunken)]",
            item.kind === "email" ? "aspect-[3/4]" : "aspect-[4/3]",
          )}
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              loading="lazy"
              className="size-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : item.mediaType === "video" && item.mediaUrl ? (
            <video
              src={item.mediaUrl}
              preload="metadata"
              muted
              playsInline
              className="size-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-[var(--content-subtlest)]">
              <ImageOff className="size-7" aria-hidden />
              <span className="text-label-small">Preview unavailable</span>
            </div>
          )}
          {item.mediaType === "video" ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/10">
              <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-black shadow-sm">
                <Play className="ml-0.5 size-5" fill="currentColor" aria-hidden />
              </span>
            </span>
          ) : null}
        </div>
        <div className="p-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-label-small uppercase text-[var(--content-subtlest)]">
                {item.platform ?? titleCase(item.kind)}
              </p>
              <h3 className="mt-1 line-clamp-2 text-title-small text-[var(--content-default)]">
                {item.title}
              </h3>
            </div>
            <ArrowUpRight
              className="size-4 shrink-0 text-[var(--content-subtlest)]"
              aria-hidden
            />
          </div>
          {item.caption ? (
            <p className="mt-2 line-clamp-3 text-body-small-default text-[var(--content-subtle)]">
              {item.caption}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-label-small text-[var(--content-subtlest)]">
              {formatObservedAt(item.observedAt)}
            </span>
            <span className="text-label-small text-[var(--content-subtle)]">
              View details
            </span>
          </div>
        </div>
      </button>
    </article>
  );
}

function detailRows(data: Record<string, unknown>) {
  return Object.entries(data)
    .filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
    .slice(0, 18);
}

function AssetDetailModal({
  item,
  onClose,
}: {
  item: IntelligenceVisual | null;
  onClose: () => void;
}) {
  const previewUrl =
    item?.mediaUrl ??
    item?.thumbnailUrl;
  return (
    <Modal.Root open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content size="lg">
        {item ? (
          <>
            <Modal.Header>
              <Modal.Title>{item.title}</Modal.Title>
              <Modal.Description>
                {item.platform ?? titleCase(item.kind)} example found{" "}
                {formatObservedAt(item.observedAt, true)}
              </Modal.Description>
            </Modal.Header>
            <Modal.Body className="max-h-[76vh] overflow-y-auto">
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
                <div className="flex min-h-80 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-sunken)]">
                  {item.mediaType === "video" && item.mediaUrl ? (
                    <video
                      src={item.mediaUrl}
                      poster={item.thumbnailUrl}
                      controls
                      autoPlay
                      playsInline
                      className="max-h-[66vh] max-w-full object-contain"
                    />
                  ) : previewUrl ? (
                    <img
                      src={previewUrl}
                      alt=""
                      className="max-h-[66vh] max-w-full object-contain"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-[var(--content-subtlest)]">
                      <ImageOff className="size-9" aria-hidden />
                      <span className="text-body-small-default">
                        Preview unavailable
                      </span>
                    </div>
                  )}
                </div>
                <aside>
                  {item.caption ? (
                    <section className="border-b border-[var(--border-base)] pb-5">
                      <h3 className="text-title-small text-[var(--content-default)]">
                        What Worklin observed
                      </h3>
                      <p className="mt-2 text-body-small-default text-[var(--content-subtle)]">
                        {item.caption}
                      </p>
                    </section>
                  ) : null}
                  <dl className="divide-y divide-[var(--border-base)]">
                    {[
                      ["Type", item.mediaType ?? "unknown"],
                      [
                        "Where it appeared",
                        item.platform ?? titleCase(item.kind),
                      ],
                      ["Found", formatObservedAt(item.observedAt, true)],
                      [
                        "Sources",
                        `${item.evidenceIds.length} linked source${
                          item.evidenceIds.length === 1 ? "" : "s"
                        }`,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex justify-between gap-4 py-3 text-body-small-default"
                      >
                        <dt className="text-[var(--content-subtlest)]">
                          {label}
                        </dt>
                        <dd className="text-right text-[var(--content-default)]">
                          {value}
                        </dd>
                      </div>
                    ))}
                    {detailRows(item.data).map(([label, value]) => (
                      <div
                        key={label}
                        className="flex justify-between gap-4 py-3 text-body-small-default"
                      >
                        <dt className="text-[var(--content-subtlest)]">
                          {titleCase(label)}
                        </dt>
                        <dd className="max-w-[60%] break-words text-right text-[var(--content-default)]">
                          {String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {item.caveats.length ? (
                    <div className="mt-5 border-l-2 border-[var(--system-warning-strong)] pl-3">
                      <p className="text-label-small text-[var(--content-subtle)]">
                        {item.caveats.join(" ")}
                      </p>
                    </div>
                  ) : null}
                </aside>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outlined" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  window.open(item.sourceUrl, "_blank", "noopener,noreferrer")
                }
                rightIcon={<ExternalLink />}
              >
                Open public source
              </Button>
            </Modal.Footer>
          </>
        ) : null}
      </Modal.Content>
    </Modal.Root>
  );
}

function AssetLibrary({
  report,
  initialChannel = "all",
  kinds,
  title = "Examples",
  description = "Public images, videos, emails, products, and pages found during this research.",
}: {
  report: CompetitorIntelligenceReport;
  initialChannel?: AssetChannel;
  kinds?: IntelligenceVisual["kind"][];
  title?: string;
  description?: string;
}) {
  const [channel, setChannel] = useState<AssetChannel>(initialChannel);
  const [dateRange, setDateRange] = useState<DateRange>("90d");
  const [platform, setPlatform] = useState("all");
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [selected, setSelected] = useState<IntelligenceVisual | null>(null);

  const candidateItems = useMemo(
    () =>
      report.visualEvidence.filter((item) =>
        kinds ? kinds.includes(item.kind) : true,
      ),
    [kinds, report.visualEvidence],
  );
  const platforms = useMemo(
    () =>
      Array.from(
        new Set(
          candidateItems
            .map((item) => item.platform)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort(),
    [candidateItems],
  );
  const filtered = useMemo(() => {
    const newestObservation = Math.max(
      0,
      ...candidateItems.map(visualTimestamp),
    );
    const cutoff = rangeCutoff(dateRange, newestObservation);
    const normalizedQuery = query.trim().toLowerCase();
    return candidateItems
      .filter((item) => channel === "all" || assetChannel(item) === channel)
      .filter((item) => platform === "all" || item.platform === platform)
      .filter((item) => !cutoff || visualTimestamp(item) >= cutoff)
      .filter(
        (item) =>
          !normalizedQuery ||
          `${item.title} ${item.caption ?? ""} ${item.platform ?? ""}`
            .toLowerCase()
            .includes(normalizedQuery),
      )
      .sort((left, right) =>
        sortOrder === "newest"
          ? visualTimestamp(right) - visualTimestamp(left)
          : visualTimestamp(left) - visualTimestamp(right),
      );
  }, [candidateItems, channel, dateRange, platform, query, sortOrder]);

  return (
    <section>
      <SectionHeading
        title={title}
        description={description}
        aside={
          <span className="text-label-small text-[var(--content-subtlest)]">
            {filtered.length} of {candidateItems.length} examples
          </span>
        }
      />
      <div className="mt-5 border-y border-[var(--border-base)] py-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "ads", "emails", "social", "products"] as AssetChannel[]).map(
            (value) => (
              <button
                key={value}
                type="button"
                onClick={() => setChannel(value)}
                className={cn(
                  "h-8 rounded-md px-3 text-label-small capitalize",
                  channel === value
                    ? "bg-[var(--content-default)] text-[var(--content-inverse)]"
                    : "bg-[var(--surface-sunken)] text-[var(--content-subtle)] hover:text-[var(--content-default)]",
                )}
              >
                {value}
              </button>
            ),
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-2 size-4 text-[var(--content-subtlest)]"
                aria-hidden
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search examples"
                className="h-8 w-44 rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] pl-8 pr-3 text-body-small-default text-[var(--content-default)] outline-none focus:border-[var(--border-strong)]"
              />
            </label>
            <label className="relative">
              <span className="sr-only">Where it appeared</span>
              <select
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
                className="h-8 rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 text-body-small-default text-[var(--content-default)]"
              >
                <option value="all">All places</option>
                {platforms.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="relative">
              <span className="sr-only">Sort order</span>
              <select
                value={sortOrder}
                onChange={(event) =>
                  setSortOrder(event.target.value as SortOrder)
                }
                className="h-8 rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 text-body-small-default text-[var(--content-default)]"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-md bg-[var(--surface-sunken)] p-1">
            {DATE_RANGES.map((range) => (
              <button
                key={range.id}
                type="button"
                onClick={() => setDateRange(range.id)}
                className={cn(
                  "h-7 rounded px-2.5 text-label-small",
                  dateRange === range.id
                    ? "bg-[var(--surface-overlay)] text-[var(--content-default)] shadow-sm"
                    : "text-[var(--content-subtle)]",
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
          <p className="text-label-small text-[var(--content-subtlest)]">
            Dates in this report: {coverageLabel(candidateItems)}
          </p>
        </div>
      </div>

      {filtered.length ? (
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((item) => (
            <VisualAssetCard key={item.id} item={item} onOpen={setSelected} />
          ))}
        </div>
      ) : (
        <div className="flex min-h-64 flex-col items-center justify-center border-b border-[var(--border-base)] text-center">
          <ImageOff
            className="size-8 text-[var(--content-subtlest)]"
            aria-hidden
          />
          <p className="mt-3 max-w-md text-body-medium-default text-[var(--content-subtle)]">
            No examples match these filters. Try a longer date range or
            another type.
          </p>
        </div>
      )}
      <AssetDetailModal item={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function CompetitorTable({
  competitors,
}: {
  competitors: IntelligenceCompetitor[];
}) {
  if (!competitors.length) {
    return (
      <p className="border-y border-[var(--border-base)] py-10 text-center text-body-medium-default text-[var(--content-subtle)]">
        We did not find a competitor with enough reliable information yet.
      </p>
    );
  }
  return (
    <div className="mt-5 overflow-x-auto border-y border-[var(--border-base)]">
      <table className="w-full min-w-[980px] border-collapse text-left">
        <thead>
          <tr className="bg-[var(--surface-sunken)] text-label-small text-[var(--content-subtlest)]">
            <th className="px-4 py-3 font-normal">Competitor</th>
            <th className="px-4 py-3 font-normal">
              How they present themselves
            </th>
            <th className="px-4 py-3 font-normal">
              What they sell and charge
            </th>
            <th className="px-4 py-3 font-normal">Marketing activity</th>
            <th className="px-4 py-3 font-normal">Sources</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-base)]">
          {competitors.map((competitor) => (
            <tr key={`${competitor.name}-${competitor.websiteUrl ?? ""}`}>
              <td className="w-52 px-4 py-4 align-top">
                <p className="text-body-medium-strong text-[var(--content-default)]">
                  {competitor.name}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-label-small capitalize text-[var(--content-subtle)]">
                    {friendlyCompetitorType(competitor.classification)}
                  </span>
                  <ConfidenceLabel value={competitor.confidence} />
                </div>
                {competitor.websiteUrl ? (
                  <EvidenceLink href={competitor.websiteUrl} className="mt-3">
                    Website
                  </EvidenceLink>
                ) : null}
              </td>
              <td className="max-w-xs px-4 py-4 align-top text-body-small-default text-[var(--content-subtle)]">
                {competitor.positioning || competitor.rationale || "Unknown"}
              </td>
              <td className="max-w-xs px-4 py-4 align-top">
                <ul className="grid gap-1.5 text-body-small-default text-[var(--content-subtle)]">
                  {[
                    ...competitor.offers.slice(0, 3),
                    competitor.pricingPosture,
                  ]
                    .filter(Boolean)
                    .map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                </ul>
              </td>
              <td className="max-w-sm px-4 py-4 align-top">
                <ul className="grid gap-1.5 text-body-small-default text-[var(--content-subtle)]">
                  {[
                    ...competitor.channelSignals.paidMedia,
                    ...competitor.channelSignals.social,
                    ...competitor.channelSignals.emailAndLifecycle,
                  ]
                    .slice(0, 4)
                    .map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                </ul>
              </td>
              <td className="px-4 py-4 align-top text-body-small-default text-[var(--content-default)]">
                {competitor.evidenceIds.length} linked sources
                {competitor.gaps.length ? (
                  <p className="mt-2 text-label-small text-[var(--system-warning-strong)]">
                    {competitor.gaps.length} missing details
                  </p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompetitorsView({
  report,
}: {
  report: CompetitorIntelligenceReport;
}) {
  return (
    <div>
      <SectionHeading
        title="Possible competitors"
        description="Possible matches Worklin will check before calling them real competitors."
        aside={
          <span className="text-label-small text-[var(--content-subtlest)]">
            {report.competitorLandscape.length} possible matches
          </span>
        }
      />
      <CompetitorTable competitors={report.competitorLandscape} />

      {report.intelligence ? (
        <div className="mt-9">
          <ModuleGroupView report={report} modules={["competitors"]} />
        </div>
      ) : null}

      <div className="mt-10">
        <AssetLibrary
          report={report}
          title="Competitor examples"
          description="Ads, products, pages, emails, and social posts that show what competitors are doing."
        />
      </div>
    </div>
  );
}

function ChannelView({ report }: { report: CompetitorIntelligenceReport }) {
  return (
    <div>
      {report.intelligence ? (
        <ModuleGroupView
          report={report}
          modules={["growth_channels_lifecycle"]}
        />
      ) : (
        <div className="grid gap-x-8 lg:grid-cols-2">
          <SignalList
            title="Search and website content"
            items={report.channelFindings.seoAndContent}
          />
          <SignalList
            title="Ads and social posts"
            items={report.channelFindings.social}
          />
          <SignalList
            title="Email and customer follow-up"
            items={report.channelFindings.emailAndLifecycle}
          />
          <SignalList
            title="Text messages"
            items={report.channelFindings.sms}
          />
        </div>
      )}
      <div className="mt-10">
        <AssetLibrary
          report={report}
          title="Marketing examples"
          description="Filter real public ads, posts, emails, and pages by kind, where they appeared, and date."
        />
      </div>
    </div>
  );
}

function RecommendationRow({
  recommendation,
  index,
}: {
  recommendation: IntelligenceRecommendation;
  index: number;
}) {
  const impact =
    recommendation.expectedImpact.low !== null ||
    recommendation.expectedImpact.high !== null
      ? [
          recommendation.expectedImpact.low,
          recommendation.expectedImpact.high,
        ]
          .filter((value): value is number => value !== null)
          .map(compactNumber)
          .join(" - ")
      : "Not estimated";
  return (
    <article className="grid gap-5 border-t border-[var(--border-base)] py-6 first:border-t-0 first:pt-0 xl:grid-cols-[70px_minmax(0,1.3fr)_minmax(260px,0.7fr)]">
      <div>
        <span className="text-title-large text-[var(--content-subtlest)]">
          {String(index + 1).padStart(2, "0")}
        </span>
        <p className="mt-1 text-label-small uppercase text-[var(--content-subtle)]">
          {recommendation.priority}
        </p>
      </div>
      <div>
        {recommendation.decision ? (
          <p className="text-label-small uppercase text-[var(--content-subtlest)]">
            {recommendation.decision}
          </p>
        ) : null}
        <h3 className="mt-1 text-title-medium text-[var(--content-default)]">
          {recommendation.action}
        </h3>
        <p className="mt-2 text-body-medium-default text-[var(--content-subtle)]">
          {recommendation.rationale}
        </p>
        {recommendation.mechanism ? (
          <p className="mt-3 text-body-small-default text-[var(--content-subtle)]">
            <strong className="text-[var(--content-default)]">
              Why it should work:
            </strong>{" "}
            {recommendation.mechanism}
          </p>
        ) : null}
      </div>
      <dl className="grid gap-3 text-body-small-default">
        {[
          ["Expected impact", `${impact} ${recommendation.expectedImpact.unit}`],
          ["Amount of work", friendlyEffort(recommendation.effort)],
          ["Owner", recommendation.suggestedOwner || "Unassigned"],
          ["Timing", recommendation.timing || "Not set"],
          ["How success is measured", recommendation.kpi || "Not set"],
          ["First test", recommendation.firstTest || "Not set"],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-[var(--content-subtlest)]">{label}</dt>
            <dd className="max-w-[65%] text-right text-[var(--content-default)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function StrategyView({ report }: { report: CompetitorIntelligenceReport }) {
  const recommendations = report.intelligence?.recommendations ?? [];
  return (
    <div>
      <SectionHeading
        title="What to do next"
        description="Each step explains why it matters, who should own it, how to test it, and how to know whether it worked."
      />
      {recommendations.length ? (
        <div className="mt-6">
          {recommendations.map((recommendation, index) => (
            <RecommendationRow
              key={recommendation.id}
              recommendation={recommendation}
              index={index}
            />
          ))}
        </div>
      ) : (
        <div className="mt-6 divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
          {report.recommendations.map((recommendation, index) => (
            <div key={index} className="py-5">
              <span className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-label-small uppercase text-[var(--content-subtle)]">
                {recommendation.priority}
              </span>
              <p className="mt-3 text-body-medium-default text-[var(--content-default)]">
                {recommendation.action}
              </p>
              <p className="mt-1 text-body-small-default text-[var(--content-subtle)]">
                {recommendation.rationale}
              </p>
            </div>
          ))}
        </div>
      )}
      {report.intelligence ? (
        <div className="mt-10">
          <ModuleGroupView report={report} modules={["strategic_synthesis"]} />
        </div>
      ) : null}
    </div>
  );
}

function EvidenceView({ report }: { report: CompetitorIntelligenceReport }) {
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.7fr)]">
      <section>
        <SectionHeading
          title="Where this came from"
          description="Every important finding should point to a dated public or approved source."
          aside={
            <span className="text-label-small text-[var(--content-subtlest)]">
              {report.evidence.length} sources
            </span>
          }
        />
        <div className="mt-5 overflow-hidden border-y border-[var(--border-base)]">
          {report.evidence.length ? (
            <ul className="divide-y divide-[var(--border-base)]">
              {report.evidence.map((item) => (
                <li key={item.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-label-small uppercase text-[var(--content-subtlest)]">
                        {titleCase(item.sourceType)}
                        {item.provider
                          ? ` | ${friendlyProviderName(item.provider)}`
                          : ""}
                      </p>
                      <h3 className="mt-1 text-title-small text-[var(--content-default)]">
                        {item.title}
                      </h3>
                    </div>
                    <ConfidenceLabel value={item.confidence} />
                  </div>
                  <p className="mt-2 text-body-small-default text-[var(--content-subtle)]">
                    {item.finding}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-label-small text-[var(--content-subtlest)]">
                      Checked {formatObservedAt(item.observedAt)}
                    </span>
                    <EvidenceLink href={item.url}>View original</EvidenceLink>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-10 text-center text-body-medium-default text-[var(--content-subtle)]">
              No sources were saved.
            </div>
          )}
        </div>
      </section>
      <aside>
        <QualityPanel report={report} />
        <div className="mt-7">
          <SignalList title="What we still do not know" items={report.gaps} />
          <SignalList
            title="Limits and notes"
            items={report.safety.caveats.map(friendlyResearchNote)}
          />
          <SignalList
            title="What this research could not cover"
            items={report.intelligence?.limitations ?? []}
          />
        </div>
      </aside>
    </div>
  );
}

export function CompetitorIntelligencePage({
  previewReport,
  previewBrandId,
}: {
  previewReport?: CompetitorIntelligenceReport;
  previewBrandId?: string;
} = {}) {
  const assistantId = useActiveAssistantId();
  const { artifactId = "", brandId: routeBrandId = "" } = useParams();
  const brandId = previewBrandId ?? routeBrandId;
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const [tab, setTab] = useState<IntelligenceTab>("briefing");
  const artifactQuery = useQuery({
    ...artifactsByIdGetOptions({
      path: { assistant_id: assistantId, id: artifactId },
    }),
    enabled: !previewReport && Boolean(artifactId),
  });
  const metadata = artifactQuery.data?.metadata;
  const reportValue =
    metadata?.brandIntelligence ?? metadata?.competitorIntelligence;
  const report = useMemo(
    () =>
      previewReport ??
      parseCompetitorIntelligence(reportValue, metadata?.quality),
    [metadata?.quality, previewReport, reportValue],
  );
  const artifactTitle = report?.intelligence
    ? "Brand Research"
    : "Competitor Research";

  useEffect(() => {
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        {artifactTitle}
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [artifactTitle, setTopBarCenter]);

  if (!previewReport && artifactQuery.isLoading) {
    return (
      <PageShell className="items-center justify-center">
        <p className="text-body-medium-default text-[var(--content-subtle)]">
          Loading brand research...
        </p>
      </PageShell>
    );
  }

  if (!report) {
    return (
      <PageShell>
        <Link
          to={routes.work.brandArtifacts(brandId)}
          className="inline-flex w-fit items-center gap-2 text-body-small-default text-[var(--content-subtle)] hover:text-[var(--content-default)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to Work
        </Link>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <FileWarning
            className="size-9 text-[var(--content-subtlest)]"
            aria-hidden
          />
          <h1 className="mt-4 text-title-medium text-[var(--content-default)]">
            This report cannot be shown yet
          </h1>
          <p className="mt-2 max-w-lg text-body-medium-default text-[var(--content-subtle)]">
            This report is missing some details Worklin needs to show it here.
            You can still open the original document from Work.
          </p>
        </div>
      </PageShell>
    );
  }

  if (report.intelligence) {
    return <BrandResearchDashboard report={report} brandId={brandId} />;
  }

  return (
    <PageShell className="px-0 py-0">
      <header className="border-b border-[var(--border-base)] px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              to={routes.work.brandArtifacts(brandId)}
              className="inline-flex items-center gap-2 text-body-small-default text-[var(--content-subtle)] hover:text-[var(--content-default)]"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to Work
            </Link>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-sunken)] text-[var(--content-default)]">
                <BriefcaseBusiness className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-title-large text-[var(--content-default)]">
                  {report.query.brandName}
                </h1>
                <p className="text-body-small-default text-[var(--content-subtle)]">
                  {artifactTitle} | Updated{" "}
                  {formatObservedAt(report.generatedAt, true)}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-label-small text-[var(--content-subtlest)]">
              <CalendarClock className="size-4" aria-hidden />
              Saved report
            </div>
            {report.query.websiteUrl ? (
              <EvidenceLink href={report.query.websiteUrl}>
                Official website
              </EvidenceLink>
            ) : null}
          </div>
        </div>
      </header>

      <nav
        role="tablist"
        aria-label="Brand research sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-base)] px-4 py-2 md:px-6"
      >
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-label-medium-default transition-colors",
                tab === item.id
                  ? "bg-[var(--surface-sunken)] text-[var(--content-default)]"
                  : "text-[var(--content-subtle)] hover:bg-[var(--surface-sunken)] hover:text-[var(--content-default)]",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {item.label}
            </button>
          );
        })}
      </nav>

      <main
        role="tabpanel"
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-6"
      >
        {tab === "briefing" ? <BriefingView report={report} /> : null}
        {tab === "channels" ? <ChannelView report={report} /> : null}
        {tab === "competitors" ? <CompetitorsView report={report} /> : null}
        {tab === "strategy" ? <StrategyView report={report} /> : null}
        {tab === "evidence" ? <EvidenceView report={report} /> : null}
        {TAB_MODULES[tab] &&
        tab !== "channels" &&
        tab !== "competitors" &&
        tab !== "strategy" ? (
          <ModuleGroupView report={report} modules={TAB_MODULES[tab] ?? []} />
        ) : null}
      </main>
    </PageShell>
  );
}
