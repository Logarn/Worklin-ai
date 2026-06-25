import { randomUUID } from "node:crypto";

import {
  buildDeepRetentionAudit,
  buildRetentionContextPack,
  buildRetentionMicroSegments,
  buildUnifiedCustomerView,
  computeRetentionCustomerFeatures,
  createRetentionSafetyMetadata,
  type ComputeRetentionOptions,
  findRetentionCampaignOpportunities,
  findRetentionMissingPieces,
  generateRetentionAuditArtifact,
  generateRetentionCampaignPackage,
  getRetentionAuditStatus,
  getRetentionBrandBrain,
  getRetentionKlaviyoSnapshot,
  getRetentionShopifySnapshot,
  getRetentionSourceStatus,
  runRetentionQa,
  scheduleRetentionAudit,
  scoreRetentionCustomers,
  type RetentionAuditRun,
  type RetentionDataset,
} from "@vellumai/retention-domain";

import { RiskLevel } from "../../permissions/types.js";
import { getMessages } from "../../memory/conversation-crud.js";
import { getSubagentManager, TERMINAL_STATUSES } from "../../subagent/index.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import { executeDocumentCreate } from "../document/document-tool.js";
import {
  buildLiveReadonlyKlaviyoDatasetFromStoredConnection,
  executeRetentionConnectKlaviyoConnection,
  executeRetentionListKlaviyoConnections,
  type KlaviyoConnectionSelector,
} from "./klaviyo-connection.js";

function numberInput(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringInput(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function booleanInput(
  input: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => {
    const value = input[key];
    return value === true || value === "true" || value === 1 || value === "1";
  });
}

function retentionOptions(
  input: Record<string, unknown>,
): ComputeRetentionOptions {
  const opportunityKey =
    typeof input.opportunity_key === "string"
      ? input.opportunity_key
      : typeof input.opportunityKey === "string"
        ? input.opportunityKey
        : undefined;
  const cadence: ComputeRetentionOptions["cadence"] =
    input.cadence === "weekly" ||
    input.cadence === "monthly" ||
    input.cadence === "quarterly" ||
    input.cadence === "first_run"
      ? input.cadence
      : undefined;

  return {
    timeframeDays: numberInput(input, "timeframe_days"),
    limit: numberInput(input, "limit"),
    opportunityKey,
    cadence,
    brandName: stringInput(input, "brand_name", "brandName"),
    websiteUrl: stringInput(input, "website_url", "websiteUrl"),
  };
}

function klaviyoSelector(
  input: Record<string, unknown>,
): KlaviyoConnectionSelector {
  return {
    klaviyoAccount:
      typeof input.klaviyo_account === "string"
        ? input.klaviyo_account
        : typeof input.klaviyoAccount === "string"
          ? input.klaviyoAccount
          : undefined,
    klaviyoConnectionId:
      typeof input.klaviyo_connection_id === "string"
        ? input.klaviyo_connection_id
        : typeof input.klaviyoConnectionId === "string"
          ? input.klaviyoConnectionId
          : undefined,
    account: typeof input.account === "string" ? input.account : undefined,
    connectionId:
      typeof input.connection_id === "string" ? input.connection_id : undefined,
  };
}

async function retentionDatasetForInput(input: Record<string, unknown>) {
  return buildLiveReadonlyKlaviyoDatasetFromStoredConnection(
    klaviyoSelector(input),
  );
}

function fixtureDataAllowed(input: Record<string, unknown>): boolean {
  return booleanInput(
    input,
    "allow_fixture_data",
    "allowFixtureData",
    "demo_mode",
    "demoMode",
  );
}

function connectorStatus(
  dataset: RetentionDataset | undefined,
  connectorId: "shopify" | "klaviyo",
) {
  return dataset?.connectors.find((connector) => connector.id === connectorId);
}

function sourceInventory(dataset: RetentionDataset | undefined) {
  const klaviyo = dataset?.klaviyoSnapshot;
  return {
    sourceMode: dataset?.sourceMode ?? "none",
    brandName: dataset?.brandName ?? null,
    generatedAt: dataset?.generatedAt ?? null,
    connectors:
      dataset?.connectors.map((connector) => ({
        id: connector.id,
        label: connector.label,
        status: connector.status,
        lastSyncedAt: connector.lastSyncedAt,
        readCapabilities: connector.readCapabilities,
        caveats: connector.caveats,
      })) ?? [],
    klaviyoInventory: klaviyo
      ? {
          accountLabel: dataset?.brandName ?? "Klaviyo Account",
          depth: klaviyo.depth,
          generatedAt: klaviyo.generatedAt,
          campaigns: {
            count: klaviyo.campaigns.count,
            byStatus: klaviyo.campaigns.byStatus,
            recent: klaviyo.campaigns.recent.slice(0, 10).map((campaign) => ({
              name: campaign.name,
              status: campaign.status,
              channel: campaign.channel,
              subject: campaign.subject,
            })),
          },
          flows: {
            count: klaviyo.flows.count,
            activeLikeCount: klaviyo.flows.activeLikeCount,
            recent: klaviyo.flows.recent.slice(0, 10).map((flow) => ({
              name: flow.name,
              status: flow.status,
              triggerType: flow.triggerType,
            })),
          },
          audiences: klaviyo.audiences,
          metrics: klaviyo.metrics,
          lifecycleCoverage: klaviyo.lifecycleCoverage,
          caveats: klaviyo.caveats,
        }
      : null,
  };
}

function deepAuditReadiness(
  input: Record<string, unknown>,
  dataset: RetentionDataset | undefined,
) {
  const allowFixtureData = fixtureDataAllowed(input);
  const sourceMode = dataset?.sourceMode ?? "none";
  const blockers: string[] = [];

  if (!dataset) {
    blockers.push(
      "No saved live source connection is loaded. A full brand audit needs real read-only Shopify + Klaviyo data.",
    );
  } else {
    const shopify = connectorStatus(dataset, "shopify");
    const klaviyo = connectorStatus(dataset, "klaviyo");

    if (sourceMode !== "live_readonly") {
      blockers.push(
        `Current source mode is "${sourceMode}". Full Dr. Rachael-style audits require live read-only Shopify + Klaviyo source data, not fixture or mixed data.`,
      );
    }
    if (shopify?.status !== "connected") {
      blockers.push(
        "Shopify is not connected with live read-only customers, orders, products, revenue, and product-performance data.",
      );
    }
    if (klaviyo?.status !== "connected") {
      blockers.push(
        "Klaviyo is not connected with live read-only campaign, flow, profile, audience, and metric data.",
      );
    }
    if (dataset.klaviyoSnapshot && dataset.klaviyoSnapshot.depth !== "full") {
      blockers.push(
        "The current Klaviyo connector is an account inventory snapshot only; it does not yet fetch 365-day campaign performance, attributed revenue, message bodies, flow performance, or profile/event history.",
      );
    }
  }

  return {
    canRunFullAudit: allowFixtureData || blockers.length === 0,
    allowFixtureData,
    sourceMode,
    blockers: allowFixtureData ? [] : blockers,
    availableSourceData: sourceInventory(dataset),
    nextSteps: [
      "Connect a live read-only Shopify source for customers, orders, products, revenue, cohorts, and product performance.",
      "Upgrade or run the Klaviyo connector in full-read mode for 365-day campaign, flow, revenue, profile, and engagement history.",
      "Complete Brand Brain setup for voice, positioning, offers, product rules, CTAs, forbidden language, and campaign memory.",
      "Run retention_deep_audit again after the source coverage check passes.",
      "Use allow_fixture_data:true only for internal demos, never for a real client audit.",
    ],
  };
}

function blockedDeepAuditResult(
  input: Record<string, unknown>,
  dataset: RetentionDataset | undefined,
) {
  const options = retentionOptions(input);
  const readiness = deepAuditReadiness(input, dataset);
  const safety = createRetentionSafetyMetadata(
    [
      "Worklin refused to generate a full audit because current source coverage is incomplete.",
      "No fixture product, revenue, customer, or campaign-performance data was used as if it belonged to the connected brand.",
      "No external action was taken.",
    ],
    "blocked",
  );

  return {
    title: "Deep Retention Audit Blocked: Real Source Data Required",
    status: "blocked",
    brandName: options.brandName ?? dataset?.brandName ?? "Brand",
    websiteUrl: options.websiteUrl ?? dataset?.websiteUrl ?? null,
    reason:
      "Worklin will not produce a Dr. Rachael-style full audit until it has real source coverage for the brand. The current connection can support a limited Klaviyo inventory/readiness snapshot, but not product performance, revenue, segment heatmaps, flow performance, or opportunity recommendations.",
    readiness,
    safety,
  };
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function markdownForKlaviyoInventoryAudit(input: {
  title: string;
  brandName: string;
  generatedAt: string;
  fullAuditBlockers: string[];
  availableSourceData: ReturnType<typeof sourceInventory>;
  safety: ReturnType<typeof createRetentionSafetyMetadata>;
}): string {
  const klaviyo = input.availableSourceData.klaviyoInventory;
  const connectorLines = input.availableSourceData.connectors
    .map(
      (connector) =>
        `- ${connector.label}: ${connector.status}. ${connector.caveats.join(" ")}`,
    )
    .join("\n");
  const recentFlowLines =
    klaviyo?.flows.recent
      .map((flow) => `- ${flow.name} (${flow.status}, ${flow.triggerType})`)
      .join("\n") || "- No flows returned by the current inventory snapshot.";
  const recentCampaignLines =
    klaviyo?.campaigns.recent
      .map(
        (campaign) =>
          `- ${campaign.name} (${campaign.status}, ${campaign.channel})${campaign.subject ? ` - ${campaign.subject}` : ""}`,
      )
      .join("\n") ||
    "- No campaigns returned by the current inventory snapshot.";
  const presentLifecycle =
    klaviyo?.lifecycleCoverage.present
      .map((item) => `- ${item.label}`)
      .join("\n") || "- None detected.";
  const missingLifecycle =
    klaviyo?.lifecycleCoverage.missing
      .map((item) => `- ${item.label}`)
      .join("\n") || "- None detected.";
  const missingMetrics =
    klaviyo?.metrics.importantMetrics.missing
      .map((metric) => `- ${metric}`)
      .join("\n") || "- None.";
  const blockerLines = input.fullAuditBlockers
    .map((blocker) => `- ${blocker}`)
    .join("\n");

  return [
    `# ${input.title}`,
    "",
    `Brand: ${input.brandName}`,
    `Generated: ${input.generatedAt}`,
    "",
    "## Executive Summary",
    "",
    "Worklin produced a real Klaviyo inventory audit from the live read-only Klaviyo connection. It did not run the full Dr. Rachael-style revenue/product audit because source coverage is incomplete.",
    "",
    "This audit is useful for onboarding, source readiness, lifecycle coverage, and connector gap diagnosis. It is not a product performance, revenue, segment-response, campaign-performance, or opportunity-sizing audit yet.",
    "",
    "## Full Audit Blockers",
    "",
    blockerLines || "- No blockers reported.",
    "",
    "## Source Inventory",
    "",
    connectorLines || "- No source connectors found.",
    "",
    "## Klaviyo Campaign Inventory",
    "",
    `Campaigns found in current inventory snapshot: ${klaviyo?.campaigns.count ?? 0}`,
    "",
    recentCampaignLines,
    "",
    "Diagnosis: The current safe inventory snapshot did not return campaign history/performance, so Worklin cannot analyze cadence, themes, send-time, subject-line performance, revenue attribution, or segment response yet.",
    "",
    "Recommendation: Upgrade the Klaviyo reader to fetch 365-day campaign performance, message metadata, attributed revenue, opens, clicks, unsubscribes, spam complaints, and send timestamps before producing the campaign report.",
    "",
    "## Klaviyo Flow Inventory",
    "",
    `Flows found: ${klaviyo?.flows.count ?? 0}`,
    `Active-like flows: ${klaviyo?.flows.activeLikeCount ?? 0}`,
    "",
    recentFlowLines,
    "",
    "## Lifecycle Coverage",
    "",
    "Detected:",
    presentLifecycle,
    "",
    "Missing or not detected:",
    missingLifecycle,
    "",
    "Diagnosis: Flow-name inventory gives a first lifecycle map, but message-level flow performance is still missing.",
    "",
    "Recommendation: Use this as an onboarding map only, then fetch full flow actions/messages and 365-day flow performance before ranking lifecycle opportunities.",
    "",
    "## Audience and Metrics Readiness",
    "",
    `Lists: ${klaviyo?.audiences.lists ?? 0}`,
    `Segments: ${klaviyo?.audiences.segments ?? 0}`,
    `Metrics returned: ${klaviyo?.metrics.count ?? 0}`,
    `Metrics readiness: ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}`,
    "",
    "Missing important metrics:",
    missingMetrics,
    "",
    "## Next Data Needed",
    "",
    "- Connect live read-only Shopify customers, orders, products, revenue, cohorts, refunds, and product-performance data.",
    "- Fetch full Klaviyo 365-day campaign, flow, profile, event, and engagement history.",
    "- Complete Brand Brain setup: voice, positioning, offers, product rules, CTAs, forbidden language, and campaign memory.",
    "",
    "## Safety & Provenance",
    "",
    "- Source mode: klaviyo_inventory",
    "- No fixture/sample Shopify, product, revenue, customer, campaign-performance, segment-performance, or flow-performance data was used.",
    "- externalActionTaken:false",
    "- canGoLiveNow:false",
    `- Blocked capabilities: ${input.safety.blockedCapabilities.join(", ")}`,
  ].join("\n");
}

function buildKlaviyoInventoryAudit(
  input: Record<string, unknown>,
  dataset: RetentionDataset,
  blockedFullAudit: ReturnType<typeof blockedDeepAuditResult>,
) {
  const generatedAt = new Date().toISOString();
  const klaviyo = dataset.klaviyoSnapshot;
  const brandName =
    retentionOptions(input).brandName ?? dataset.brandName ?? "Klaviyo Account";
  const safety = createRetentionSafetyMetadata(
    [
      "Klaviyo inventory audit used only live read-only Klaviyo inventory data.",
      "Full Dr. Rachael-style revenue/product audit remains blocked until Shopify and deeper Klaviyo history are connected.",
      "No fixture/sample product, revenue, customer, campaign-performance, segment-performance, or flow-performance data was used.",
    ],
    "not_required",
  );
  const lifecycleRows = [
    ...(klaviyo?.lifecycleCoverage.present ?? []).map((item) => ({
      lifecycleStage: item.label,
      status: "present",
      coverage: 1,
    })),
    ...(klaviyo?.lifecycleCoverage.missing ?? []).map((item) => ({
      lifecycleStage: item.label,
      status: "missing",
      coverage: 0,
    })),
  ];
  const flowStatusCounts = countValues(
    klaviyo?.flows.recent.map((flow) => flow.status || "unknown") ?? [],
  );
  const campaignStatusCounts = countValues(
    klaviyo?.campaigns.recent.map((campaign) => campaign.status || "unknown") ??
      [],
  );
  const metricRows = [
    ...(klaviyo?.metrics.importantMetrics.found ?? []).map((metric) => ({
      metric,
      status: "found",
      readiness: 1,
    })),
    ...(klaviyo?.metrics.importantMetrics.missing ?? []).map((metric) => ({
      metric,
      status: "missing",
      readiness: 0,
    })),
  ];
  const charts = [
    {
      chartId: "klaviyo_flow_status_inventory",
      title: "Klaviyo Flow Status Inventory",
      family: "klaviyo_inventory",
      type: "bar",
      data: Object.entries(flowStatusCounts).map(([status, count]) => ({
        status,
        count,
      })),
      encodings: { label: "status", value: "count" },
      diagnosis: `${klaviyo?.flows.count ?? 0} flows were returned by the live read-only Klaviyo inventory snapshot, with ${klaviyo?.flows.activeLikeCount ?? 0} active-like flows.`,
      recommendation:
        "Use this as the first lifecycle map, then fetch message-level flow performance before ranking revenue opportunities.",
      caveats: [
        "Inventory only; no flow revenue, event, message-body, or step-level performance data was fetched.",
      ],
    },
    {
      chartId: "klaviyo_lifecycle_coverage_inventory",
      title: "Detected Lifecycle Coverage",
      family: "klaviyo_lifecycle_coverage",
      type: "bar",
      data: lifecycleRows,
      encodings: { label: "lifecycleStage", value: "coverage" },
      diagnosis:
        "Lifecycle coverage is inferred from live flow names and statuses only.",
      recommendation:
        "Treat detected stages as a setup map, not as performance proof. Fetch flow actions/messages and 365-day flow metrics next.",
      caveats: klaviyo?.lifecycleCoverage.caveats ?? [],
    },
    {
      chartId: "klaviyo_campaign_status_inventory",
      title: "Klaviyo Campaign Inventory",
      family: "klaviyo_campaign_inventory",
      type: "bar",
      data:
        Object.keys(campaignStatusCounts).length > 0
          ? Object.entries(campaignStatusCounts).map(([status, count]) => ({
              status,
              count,
            }))
          : [{ status: "none_returned", count: 0 }],
      encodings: { label: "status", value: "count" },
      diagnosis: `${klaviyo?.campaigns.count ?? 0} campaigns were returned by the current safe inventory snapshot.`,
      recommendation:
        "Fetch 365-day campaign sends, timestamps, subject lines, themes, opens, clicks, revenue, unsubscribes, spam complaints, and segment targeting before producing the campaign report.",
      caveats: [
        "Campaign inventory is not campaign performance. Do not infer cadence or revenue from this snapshot.",
      ],
    },
    {
      chartId: "klaviyo_audience_inventory",
      title: "Audience Inventory",
      family: "klaviyo_audience_inventory",
      type: "bar",
      data: [
        { audienceType: "lists", count: klaviyo?.audiences.lists ?? 0 },
        { audienceType: "segments", count: klaviyo?.audiences.segments ?? 0 },
      ],
      encodings: { label: "audienceType", value: "count" },
      diagnosis:
        "Lists and segments are visible, but audience performance and profile counts may be limited by the current snapshot.",
      recommendation:
        "Fetch profile counts and segment definitions before building segment-response heatmaps.",
      caveats: [
        "No Klaviyo segment mutation is allowed; this is read-only inventory.",
      ],
    },
    {
      chartId: "klaviyo_metric_readiness",
      title: "Important Metric Readiness",
      family: "klaviyo_metric_readiness",
      type: "bar",
      data:
        metricRows.length > 0 ? metricRows : [{ metric: "none", readiness: 0 }],
      encodings: { label: "metric", value: "readiness" },
      diagnosis: `Important metric readiness is ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}.`,
      recommendation:
        "Resolve metric availability before computing opens, clicks, placed orders, unsubscribe risk, spam risk, or revenue attribution.",
      caveats: [
        "Metric names alone are not event history; 365-day event exports are still required.",
      ],
    },
  ];
  const modules = [
    {
      moduleId: "source_readiness",
      title: "Source Readiness",
      status: "partial",
      summary:
        "Full deep audit is blocked, but a live read-only Klaviyo inventory audit is available.",
      charts: [],
      insights: blockedFullAudit.readiness.blockers,
      recommendations: blockedFullAudit.readiness.nextSteps,
    },
    {
      moduleId: "klaviyo_flow_inventory",
      title: "Klaviyo Flow Inventory",
      status: "partial",
      summary:
        "Audits visible flow names, statuses, trigger types, and inferred lifecycle coverage.",
      charts: charts.slice(0, 2),
      insights: klaviyo?.flows.recent.map((flow) => flow.name) ?? [],
      recommendations: [
        "Fetch flow actions/messages and 365-day flow performance before ranking lifecycle opportunities.",
      ],
    },
    {
      moduleId: "klaviyo_campaign_inventory",
      title: "Klaviyo Campaign Inventory",
      status: "partial",
      summary:
        "Audits whether campaign inventory is available without inferring cadence, theme, revenue, or performance.",
      charts: [charts[2]],
      insights:
        klaviyo?.campaigns.recent.map((campaign) => campaign.name) ?? [],
      recommendations: [
        "Fetch full campaign history/performance before producing the campaign report.",
      ],
    },
    {
      moduleId: "audience_metric_readiness",
      title: "Audience and Metric Readiness",
      status: "partial",
      summary:
        "Checks visible lists, segments, metric catalog, and missing important metrics.",
      charts: charts.slice(3),
      insights: [
        `Lists: ${klaviyo?.audiences.lists ?? 0}`,
        `Segments: ${klaviyo?.audiences.segments ?? 0}`,
        `Metric readiness: ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}`,
      ],
      recommendations: [
        "Fetch profile counts, segment definitions, and 365-day event history before segment heatmaps.",
      ],
    },
  ];
  const backlog = [
    {
      backlogKey: "connect_shopify_readonly",
      title: "Connect live read-only Shopify",
      type: "source_gap",
      impact: 95,
      confidence: 100,
      effort: "medium",
      nextAction:
        "Connect customers, orders, products, revenue, refunds, cohorts, and product-performance data.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "upgrade_klaviyo_performance_history",
      title: "Upgrade Klaviyo reader to 365-day performance history",
      type: "source_gap",
      impact: 92,
      confidence: 100,
      effort: "medium",
      nextAction:
        "Fetch campaign, flow, profile, event, engagement, and attributed revenue history.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "complete_brand_brain",
      title: "Complete Brand Brain setup",
      type: "setup_gap",
      impact: 82,
      confidence: 95,
      effort: "low",
      nextAction:
        "Store voice, positioning, offers, product rules, CTAs, forbidden language, and campaign memory.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
  ];
  const title = "Klaviyo Inventory Audit";
  const availableSourceData = sourceInventory(dataset);
  const contentMarkdown = markdownForKlaviyoInventoryAudit({
    title,
    brandName,
    generatedAt,
    fullAuditBlockers: blockedFullAudit.readiness.blockers,
    availableSourceData,
    safety,
  });

  return {
    auditId: `klaviyo_inventory_${generatedAt.replaceAll(/\W+/g, "_")}`,
    generatedAt,
    title,
    brandName,
    status: "partial",
    blockedFullAudit,
    modules,
    charts,
    backlog,
    artifact: {
      title,
      contentMarkdown,
      charts,
      generatedAt,
      exportReady: true,
    },
    safety,
    summary: {
      moduleCount: modules.length,
      chartCount: charts.length,
      recommendationCount: modules.reduce(
        (count, module) => count + module.recommendations.length,
        0,
      ),
      backlogCount: backlog.length,
      sourceMode: "klaviyo_inventory",
    },
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function countRecordRows(
  values: Record<string, number> | undefined,
  labelKey: string,
  fallbackLabel: string,
): Array<Record<string, string | number>> {
  const rows = Object.entries(values ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ [labelKey]: label, count }));
  return rows.length ? rows : [{ [labelKey]: fallbackLabel, count: 0 }];
}

function countRecordLines(
  values: Record<string, number> | undefined,
  fallback: string,
): string {
  const lines = Object.entries(values ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `- ${label}: ${count}`);
  return lines.length ? lines.join("\n") : fallback;
}

function markdownCell(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownTableForRows(
  rows: Array<Record<string, string | number | boolean | null>> | undefined,
  limit = 18,
): string {
  if (!rows?.length) return "No chart rows were available.";
  const visibleRows = rows.slice(0, limit);
  const columns = Array.from(
    new Set(
      visibleRows.flatMap((row) =>
        Object.keys(row).filter((key) => row[key] !== undefined),
      ),
    ),
  ).slice(0, 6);
  if (!columns.length) return "No chart columns were available.";

  const header = `| ${columns.map(markdownCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = visibleRows
    .map(
      (row) =>
        `| ${columns.map((column) => markdownCell(row[column])).join(" | ")} |`,
    )
    .join("\n");
  const hiddenCount = rows.length - visibleRows.length;

  return [
    header,
    separator,
    body,
    hiddenCount > 0
      ? `\nShowing ${visibleRows.length} of ${rows.length} rows.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const PDF_CHART_COLORS = [
  "#22c55e",
  "#ef4444",
  "#eab308",
  "#a855f7",
  "#f97316",
  "#14b8a6",
  "#ec4899",
  "#6366f1",
];

function htmlCell(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function printableRowsForChart(
  chart: KlaviyoL365AuditChartRef,
): Array<Record<string, string | number | boolean | null>> {
  return (chart.data ?? [])
    .filter(
      (row): row is Record<string, string | number | boolean | null> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row),
    )
    .map((row) => row);
}

function pdfNumberKeys(
  row: Record<string, string | number | boolean | null>,
): string[] {
  return Object.entries(row)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([key]) => key);
}

function pdfLabelKey(
  chart: KlaviyoL365AuditChartRef,
  rows: Array<Record<string, string | number | boolean | null>>,
): string {
  const first = rows[0];
  if (!first) return "label";
  const preferred = [
    chart.interaction?.labelKey,
    "label",
    "name",
    "title",
    "weekStart",
    "theme",
    "status",
    "channel",
    "word",
    "flowStage",
    "opportunity",
  ].filter((key): key is string => Boolean(key));
  return (
    preferred.find((key) => typeof first[key] === "string") ??
    Object.keys(first).find((key) => typeof first[key] === "string") ??
    Object.keys(first)[0] ??
    "label"
  );
}

function pdfMetricKey(
  chart: KlaviyoL365AuditChartRef,
  rows: Array<Record<string, string | number | boolean | null>>,
): string | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const preferred = [
    chart.interaction?.primaryMetric,
    ...(chart.interaction?.metricKeys ?? []),
    "count",
    "campaignCount",
    "flowCount",
    "profileCount",
    "impact",
    "confidence",
    "score",
  ].filter((key): key is string => Boolean(key));
  return (
    preferred.find((key) => typeof first[key] === "number") ??
    pdfNumberKeys(first)[0]
  );
}

function pdfChartHtml(chart: KlaviyoL365AuditChartRef): string {
  const rows = printableRowsForChart(chart).slice(0, 12);
  if (!rows.length) return "";

  const labelKey = pdfLabelKey(chart, rows);
  const metricKey = pdfMetricKey(chart, rows);
  const chartTitle = htmlCell(chart.title);
  const chartKind =
    `${chart.type ?? chart.chartId ?? chart.title}`.toLowerCase();

  if (chartKind.includes("word")) {
    const chips = rows
      .map((row, index) => {
        const label = htmlCell(row[labelKey] ?? `Term ${index + 1}`);
        const value =
          metricKey && typeof row[metricKey] === "number"
            ? ` <strong>${htmlCell(markdownCell(row[metricKey]))}</strong>`
            : "";
        const color = PDF_CHART_COLORS[index % PDF_CHART_COLORS.length];
        return `<span class="worklin-pdf-chip" style="--chip-color:${color}">${label}${value}</span>`;
      })
      .join("");
    return `<div class="worklin-pdf-chart-card"><div class="worklin-pdf-chart-eyebrow">Editable visual artifact</div><h4>${chartTitle}</h4><div class="worklin-pdf-chip-grid">${chips}</div></div>`;
  }

  if (!metricKey) {
    return "";
  }

  const values = rows.map((row) =>
    typeof row[metricKey] === "number" ? Number(row[metricKey]) : 0,
  );
  const max = Math.max(...values.map((value) => Math.abs(value)), 1);
  const bars = rows
    .map((row, index) => {
      const rawValue =
        typeof row[metricKey] === "number" ? Number(row[metricKey]) : 0;
      const width = Math.max(
        4,
        Math.min(100, Math.round((Math.abs(rawValue) / max) * 100)),
      );
      const label = htmlCell(row[labelKey] ?? `Item ${index + 1}`);
      const value = htmlCell(markdownCell(rawValue));
      const color = PDF_CHART_COLORS[index % PDF_CHART_COLORS.length];
      return `<div class="worklin-pdf-chart-row"><span class="worklin-pdf-chart-label">${label}</span><span class="worklin-pdf-chart-track"><span class="worklin-pdf-chart-fill" style="width:${width}%;background:${color}"></span></span><strong>${value}</strong></div>`;
    })
    .join("");

  return `<div class="worklin-pdf-chart-card"><div class="worklin-pdf-chart-eyebrow">Editable visual artifact</div><h4>${chartTitle}</h4><div class="worklin-pdf-chart-bars">${bars}</div><p class="worklin-pdf-chart-caption">Metric: ${htmlCell(metricKey.replace(/_/g, " "))}</p></div>`;
}

function klaviyoAuditWindowLabel(dataset: RetentionDataset): string {
  const window = dataset.klaviyoSnapshot?.analysisWindow;
  if (!window) return "last 365 days compared with previous 365 days";
  return `${window.currentStart.slice(0, 10)} to ${window.currentEnd.slice(0, 10)} compared with ${window.previousStart.slice(0, 10)} to ${window.previousEnd.slice(0, 10)}`;
}

function klaviyoL365Backlog(dataset: RetentionDataset) {
  const klaviyo = dataset.klaviyoSnapshot;
  const campaignPerformance = klaviyo?.campaignPerformance;
  const lifecycleMissing = klaviyo?.lifecycleCoverage.missing ?? [];
  const formsCount = klaviyo?.forms?.count ?? 0;
  const metricReadiness = klaviyo?.metrics.importantMetrics.readiness;
  const datedWeeks =
    campaignPerformance?.cadenceByWeek.filter(
      (row) => row.weekStart !== "undated",
    ).length ?? 0;
  const weeklyAverage =
    datedWeeks > 0 && campaignPerformance
      ? campaignPerformance.cadenceByWeek
          .filter((row) => row.weekStart !== "undated")
          .reduce((sum, row) => sum + row.campaignCount, 0) / datedWeeks
      : null;

  return [
    {
      backlogKey: "klaviyo_campaign_cadence_l365",
      title: "Normalize weekly campaign cadence",
      type: "campaign",
      impact: weeklyAverage == null || weeklyAverage < 2 ? 88 : 72,
      confidence: datedWeeks > 0 ? 82 : 58,
      effort: "medium",
      nextAction:
        weeklyAverage == null
          ? "Klaviyo did not expose enough dated campaign rows for reliable cadence math. Export or enable campaign send timestamps, then rerun the L365 audit."
          : weeklyAverage < 2
            ? `Average visible cadence is ${weeklyAverage.toFixed(1)} campaigns/week, below the 2-4/week target band. Build a weekly campaign calendar with non-sale education/product/story moments.`
            : `Visible cadence is ${weeklyAverage.toFixed(1)} campaigns/week. Keep the rhythm, then diversify themes and segment-specific angles.`,
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "klaviyo_subject_word_bank",
      title: "Build a brand-specific subject-line word bank",
      type: "campaign",
      impact: 78,
      confidence:
        (campaignPerformance?.subjectWordBank.length ?? 0) > 0 ? 84 : 52,
      effort: "low",
      nextAction:
        (campaignPerformance?.subjectWordBank.length ?? 0) > 0
          ? "Use the L365 subject word bank to separate overused sale language from reusable brand/product education language."
          : "Campaign subject lines were not exposed in the current snapshot. Pull campaign message metadata before final subject-line scoring.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "klaviyo_lifecycle_gap_l365",
      title: "Close lifecycle coverage gaps",
      type: "flow",
      impact: lifecycleMissing.length > 0 ? 86 : 68,
      confidence: 80,
      effort: "medium",
      nextAction:
        lifecycleMissing.length > 0
          ? `Missing or undetected lifecycle stages: ${lifecycleMissing.map((item) => item.label).join(", ")}. Prioritize the highest-intent missing stage first.`
          : "Core lifecycle stages are visible by name. Next, inspect flow messages and metric aggregates before rewriting or expanding flows.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "klaviyo_popup_lead_capture",
      title: "Audit popup and lead capture posture",
      type: "acquisition",
      impact: formsCount > 0 ? 70 : 82,
      confidence: formsCount > 0 ? 78 : 48,
      effort: "medium",
      nextAction:
        formsCount > 0
          ? "Review signup forms for offer clarity, segmentation fields, consent posture, and routing into welcome/quiz follow-up."
          : "No signup forms were returned by the safe Klaviyo forms read. Confirm whether forms are unavailable, permission-limited, or managed outside Klaviyo.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
    {
      backlogKey: "klaviyo_metric_readiness",
      title: "Unlock performance-grade Klaviyo metrics",
      type: "data_trust",
      impact: metricReadiness === "performance_ready" ? 66 : 90,
      confidence: 88,
      effort: "medium",
      nextAction:
        metricReadiness === "performance_ready"
          ? "Important metric names are visible. Add read-only aggregate queries next so Worklin can score opens, clicks, placed orders, unsubscribes, spam complaints, and revenue by campaign/flow."
          : "Important metric names are missing or partial. Fix permissions/API revision before expecting revenue, engagement, or suppression-risk scoring.",
      artifactOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
    },
  ].sort((a, b) => b.impact * b.confidence - a.impact * a.confidence);
}

type SwarmAgentStatus = "complete" | "partial" | "blocked";
type LiveAuditSubagentStatus = "completed" | "failed" | "aborted" | "timed_out";

interface KlaviyoL365AuditChartRef {
  chartId?: string;
  title: string;
  family?: string;
  type?: string;
  encodings?: Record<string, string | undefined>;
  interaction?: {
    primaryMetric?: string;
    secondaryMetric?: string;
    labelKey?: string;
    metricKeys?: string[];
    dimensionKeys?: string[];
    defaultSort?: string;
    defaultFocus?: string;
    selectable?: boolean;
  };
  diagnosis?: string;
  recommendation?: string;
  caveats?: string[];
  data?: unknown[];
}

interface KlaviyoL365AuditModuleRef {
  moduleId: string;
  title: string;
  status: string;
  summary: string;
  charts: KlaviyoL365AuditChartRef[];
  insights: string[];
  recommendations: string[];
}

interface KlaviyoL365AuditSwarmAgent {
  agentId: string;
  title: string;
  role: string;
  objective: string;
  liveSubagent?: {
    subagentId: string;
    conversationId: string;
    status: LiveAuditSubagentStatus;
    durationMs: number;
    output: string;
  };
  sourceRefs: string[];
  status: SwarmAgentStatus;
  confidence: number;
  findings: string[];
  evidence: string[];
  chartIds: string[];
  chartTitles: string[];
  missingData: string[];
  recommendations: string[];
  handoff: string;
  nextAgent?: string;
  safety: string[];
}

interface KlaviyoL365AuditSwarmRun {
  mode: "section_agent_swarm";
  version: "worklin-audit-swarm-v1";
  status: SwarmAgentStatus;
  executionModel:
    | "deterministic_section_agents"
    | "background_child_conversations";
  sourceMode: "klaviyo_l365";
  generatedAt: string;
  agentCount: number;
  parallelizable: boolean;
  liveSubagents: {
    enabled: boolean;
    completed: number;
    failed: number;
    timedOut: number;
    timeoutMs: number;
  };
  auditDepth: {
    requestedShape: string;
    completedAgents: number;
    partialAgents: number;
    blockedAgents: number;
    blockedSections: string[];
    defaultSections: string[];
  };
  agents: KlaviyoL365AuditSwarmAgent[];
  finalSynthesis: {
    headline: string;
    strongestSignals: string[];
    nextActions: string[];
    defaultAuditShape: string[];
  };
  safety: {
    externalActionTaken: false;
    canGoLiveNow: false;
    blockedCapabilities: string[];
  };
}

function compactList(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function statusForSwarm(value: string | undefined): SwarmAgentStatus {
  if (value === "complete" || value === "blocked") return value;
  return "partial";
}

function topRecordEvidence(
  values: Record<string, number> | undefined,
  label: string,
  fallback: string,
  limit = 5,
): string[] {
  const rows = Object.entries(values ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${label} ${name}: ${count}`);
  return rows.length ? rows : [fallback];
}

function moduleById(
  modules: KlaviyoL365AuditModuleRef[],
  moduleId: string,
): KlaviyoL365AuditModuleRef | undefined {
  return modules.find((module) => module.moduleId === moduleId);
}

function chartRefs(
  charts: KlaviyoL365AuditChartRef[],
  ids: string[],
): KlaviyoL365AuditChartRef[] {
  return charts.filter((chart) => chart.chartId && ids.includes(chart.chartId));
}

function chartIds(charts: KlaviyoL365AuditChartRef[]): string[] {
  return charts
    .map((chart) => chart.chartId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function chartTitles(charts: KlaviyoL365AuditChartRef[]): string[] {
  return charts.map((chart) => chart.title);
}

function runKlaviyoL365AuditSwarm(input: {
  generatedAt: string;
  windowLabel: string;
  dataset: RetentionDataset;
  modules: KlaviyoL365AuditModuleRef[];
  charts: KlaviyoL365AuditChartRef[];
  backlog: ReturnType<typeof klaviyoL365Backlog>;
  safety: ReturnType<typeof createRetentionSafetyMetadata>;
}): KlaviyoL365AuditSwarmRun {
  const klaviyo = input.dataset.klaviyoSnapshot;
  const campaignPerformance = klaviyo?.campaignPerformance;
  const cadenceRows =
    campaignPerformance?.cadenceByWeek.filter(
      (row) => row.weekStart !== "undated",
    ) ?? [];
  const totalDatedCampaigns = cadenceRows.reduce(
    (sum, row) => sum + row.campaignCount,
    0,
  );
  const weeklyAverage =
    cadenceRows.length > 0 ? totalDatedCampaigns / cadenceRows.length : null;
  const weeksBelowTarget = cadenceRows.filter(
    (row) => row.campaignCount < row.targetMin,
  ).length;
  const weeksInTarget = cadenceRows.filter(
    (row) =>
      row.campaignCount >= row.targetMin && row.campaignCount <= row.targetMax,
  ).length;
  const weeksAboveTarget = cadenceRows.filter(
    (row) => row.campaignCount > row.targetMax,
  ).length;
  const topCadenceWeek = cadenceRows
    .slice()
    .sort((a, b) => b.campaignCount - a.campaignCount)[0];
  const salePostureCounts = countValues(
    campaignPerformance?.recent.map((campaign) => campaign.salePosture) ?? [],
  );
  const topWords =
    campaignPerformance?.subjectWordBank
      .slice(0, 8)
      .map((item) => `${item.word} (${item.count})`) ?? [];
  const lifecycleMissing =
    klaviyo?.lifecycleCoverage.missing.map((item) => item.label) ?? [];
  const lifecyclePresent =
    klaviyo?.lifecycleCoverage.present.map((item) => item.label) ?? [];
  const queryCaveats =
    klaviyo?.queryErrors?.map(
      (error) =>
        `${error.path}: HTTP ${error.status}${error.detail ? ` (${error.detail})` : ""}`,
    ) ?? [];
  const readOnlySafety = [
    "Read-only Klaviyo L365 audit.",
    "No campaign send, schedule, flow activation, segment mutation, profile mutation, or Shopify write was attempted.",
    "externalActionTaken:false",
    "canGoLiveNow:false",
  ];

  const makeAgent = (
    agent: Omit<KlaviyoL365AuditSwarmAgent, "safety">,
  ): KlaviyoL365AuditSwarmAgent => ({
    ...agent,
    findings: compactList(agent.findings),
    evidence: compactList(agent.evidence),
    missingData: compactList(agent.missingData),
    recommendations: compactList(agent.recommendations),
    safety: readOnlySafety,
  });

  const dataTrustModule = moduleById(input.modules, "data_trust");
  const campaignModule = moduleById(input.modules, "campaign_performance");
  const flowModule = moduleById(input.modules, "lifecycle_flow");
  const formsModule = moduleById(input.modules, "acquisition_tofu");
  const audienceModule = moduleById(input.modules, "audience_metric_readiness");
  const backlogModule = moduleById(input.modules, "opportunity_backlog");

  const agents = [
    makeAgent({
      agentId: "data_trust_agent",
      title: "Data Trust Agent",
      role: "Source auditor",
      objective:
        "Separate real Klaviyo evidence from unavailable performance, revenue, and commerce inputs before any strategy is written.",
      sourceRefs: [
        "Klaviyo account metadata",
        "Klaviyo metric catalog",
        "Connector caveats",
        "Optional query errors",
      ],
      status: statusForSwarm(dataTrustModule?.status),
      confidence: queryCaveats.length > 0 ? 78 : 88,
      findings: [
        "Source mode is klaviyo_l365.",
        `${campaignPerformance?.count ?? 0} campaign rows are visible in the L365 snapshot.`,
        `${klaviyo?.flows.count ?? 0} flows and ${klaviyo?.forms?.count ?? 0} forms/popups are visible.`,
        `Important metric readiness is ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}.`,
      ],
      evidence: [
        `Optional read caveats: ${queryCaveats.length}.`,
        `Visible lists: ${klaviyo?.audiences.lists ?? 0}.`,
        `Visible segments: ${klaviyo?.audiences.segments ?? 0}.`,
        ...queryCaveats.slice(0, 3),
      ],
      chartIds: chartIds(
        chartRefs(input.charts, [
          "klaviyo_l365_data_readiness",
          "klaviyo_l365_metric_readiness",
        ]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, [
          "klaviyo_l365_data_readiness",
          "klaviyo_l365_metric_readiness",
        ]),
      ),
      missingData: [
        "Campaign revenue/open/click/unsubscribe/spam aggregate performance.",
        "Shopify product, order, LTV, AOV, replenishment, and revenue-reconciliation data.",
      ],
      recommendations: [
        "Keep this run Klaviyo-only and label commerce/revenue gaps explicitly.",
        "Add safe aggregate metric reads before making performance-grade claims.",
      ],
      handoff:
        "Campaign, flow, audience, and opportunity agents may proceed, but must not invent revenue, product, LTV, or segment-performance claims.",
      nextAgent: "campaign_cadence_agent",
    }),
    makeAgent({
      agentId: "campaign_cadence_agent",
      title: "Campaign Cadence Agent",
      role: "Campaign calendar analyst",
      objective:
        "Analyze last-365-day campaign send rhythm, week-by-week operating pressure, channel/status mix, and cadence gaps.",
      sourceRefs: [
        "Klaviyo campaigns",
        "Campaign send timestamps",
        "Campaign statuses",
        "Campaign channels",
      ],
      status: statusForSwarm(campaignModule?.status),
      confidence: cadenceRows.length > 0 ? 84 : 54,
      findings: [
        `${campaignPerformance?.count ?? 0} campaign rows were available for the campaign report.`,
        weeklyAverage == null
          ? "Weekly average could not be computed because dated campaign sends were unavailable."
          : `Visible weekly average is ${weeklyAverage.toFixed(1)} campaign(s)/week.`,
        `${weeksBelowTarget} week(s) below the 2/week floor, ${weeksInTarget} week(s) inside the 2-4/week target band, ${weeksAboveTarget} week(s) above the 4/week spike threshold.`,
        topCadenceWeek
          ? `Highest visible week: ${topCadenceWeek.weekStart} with ${topCadenceWeek.campaignCount} campaign(s).`
          : "No highest-volume week could be identified.",
      ],
      evidence: [
        ...topRecordEvidence(
          campaignPerformance?.byStatus,
          "Campaign status",
          "No campaign status evidence was available.",
        ),
        ...topRecordEvidence(
          campaignPerformance?.byChannel,
          "Campaign channel",
          "No campaign channel evidence was available.",
        ),
      ],
      chartIds: chartIds(
        chartRefs(input.charts, [
          "klaviyo_l365_campaign_cadence",
          "klaviyo_l365_campaign_status",
          "klaviyo_l365_campaign_channel",
        ]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, [
          "klaviyo_l365_campaign_cadence",
          "klaviyo_l365_campaign_status",
          "klaviyo_l365_campaign_channel",
        ]),
      ),
      missingData: [
        "Campaign-level revenue, opens, clicks, unsubscribe rate, spam complaint rate, and segment response.",
      ],
      recommendations: [
        weeklyAverage == null || weeklyAverage < 2
          ? "Build a 2-4/week campaign calendar with education, product, proof, routine, lifecycle, and light-sale moments."
          : "Keep cadence steady, then diversify theme and audience strategy instead of only increasing volume.",
      ],
      handoff:
        "Creative and opportunity agents should use cadence as operating pressure, not as proof of performance.",
      nextAgent: "campaign_creative_agent",
    }),
    makeAgent({
      agentId: "campaign_creative_agent",
      title: "Campaign Creative Agent",
      role: "Subject-line and theme analyst",
      objective:
        "Build the subject-line word bank, infer theme mix, and identify whether the campaign calendar overuses sale language.",
      sourceRefs: [
        "Campaign names",
        "Subject lines",
        "Theme classifier",
        "Sale/non-sale text classifier",
      ],
      status: statusForSwarm(campaignModule?.status),
      confidence:
        (campaignPerformance?.subjectWordBank.length ?? 0) > 0 ? 82 : 58,
      findings: [
        topWords.length > 0
          ? `Top visible subject/name words: ${topWords.join(", ")}.`
          : "Subject-line word bank is sparse or unavailable.",
        ...topRecordEvidence(
          campaignPerformance?.byTheme,
          "Theme",
          "No theme evidence was available.",
        ).slice(0, 4),
        ...topRecordEvidence(
          salePostureCounts,
          "Sale posture",
          "No sale/non-sale evidence was available.",
        ).slice(0, 3),
      ],
      evidence:
        campaignPerformance?.recent
          .slice(0, 6)
          .map(
            (campaign) =>
              `${campaign.sentAt?.slice(0, 10) ?? "undated"}: ${campaign.name}${campaign.subject ? ` | ${campaign.subject}` : ""}`,
          ) ?? [],
      chartIds: chartIds(
        chartRefs(input.charts, [
          "klaviyo_l365_subject_word_bank",
          "klaviyo_l365_campaign_theme_mix",
          "klaviyo_l365_sale_non_sale",
        ]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, [
          "klaviyo_l365_subject_word_bank",
          "klaviyo_l365_campaign_theme_mix",
          "klaviyo_l365_sale_non_sale",
        ]),
      ),
      missingData: [
        "Email body copy, creative/design screenshots, click maps, offer details, and performance by creative angle.",
      ],
      recommendations: [
        "Use the word bank to create a reusable brand language library, then separate promo-heavy phrasing from evergreen education/proof/product language.",
      ],
      handoff:
        "Flow and opportunity agents should borrow proven themes only after performance aggregates are added; for now these are creative structure signals.",
      nextAgent: "flow_lifecycle_agent",
    }),
    makeAgent({
      agentId: "flow_lifecycle_agent",
      title: "Flow Lifecycle Agent",
      role: "Lifecycle architecture analyst",
      objective:
        "Map welcome, browse, cart, checkout, post-purchase, replenishment, winback, VIP, review, birthday, and sunset coverage from visible flows.",
      sourceRefs: [
        "Klaviyo flows",
        "Flow names",
        "Flow statuses",
        "Flow trigger metadata",
        "Lifecycle coverage classifier",
      ],
      status: statusForSwarm(flowModule?.status),
      confidence: (klaviyo?.flows.count ?? 0) > 0 ? 80 : 48,
      findings: [
        `${klaviyo?.flows.count ?? 0} flows are visible.`,
        `${klaviyo?.flows.activeLikeCount ?? 0} flows are active-like.`,
        lifecyclePresent.length
          ? `Detected lifecycle stages: ${lifecyclePresent.join(", ")}.`
          : "No lifecycle stages were confidently detected.",
        lifecycleMissing.length
          ? `Missing or undetected lifecycle stages: ${lifecycleMissing.join(", ")}.`
          : "No core lifecycle stage gaps were detected by name.",
      ],
      evidence: [
        ...topRecordEvidence(
          klaviyo?.flowPerformance?.byStatus,
          "Flow status",
          "No flow status evidence was available.",
        ),
        ...topRecordEvidence(
          klaviyo?.flowPerformance?.byTriggerType,
          "Flow trigger",
          "No flow trigger evidence was available.",
        ),
      ],
      chartIds: chartIds(
        chartRefs(input.charts, [
          "klaviyo_l365_flow_lifecycle_coverage",
          "klaviyo_l365_flow_status",
        ]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, [
          "klaviyo_l365_flow_lifecycle_coverage",
          "klaviyo_l365_flow_status",
        ]),
      ),
      missingData: [
        "Flow message bodies, step-level drop-off, flow revenue, flow open/click rates, and suppression/fatigue data.",
      ],
      recommendations: [
        lifecycleMissing.length
          ? "Prioritize the highest-intent missing lifecycle stage before creating new campaigns."
          : "Review inactive/draft flows and step-level metrics before rewriting working lifecycle infrastructure.",
      ],
      handoff:
        "Acquisition and backlog agents should treat lifecycle gaps as account architecture opportunities, not live-change permission.",
      nextAgent: "forms_acquisition_agent",
    }),
    makeAgent({
      agentId: "forms_acquisition_agent",
      title: "Forms and Acquisition Agent",
      role: "Popup, form, and TOFU handoff analyst",
      objective:
        "Inspect signup forms/popups and identify whether acquisition assets can feed the welcome, quiz, and first-purchase journey.",
      sourceRefs: [
        "Klaviyo forms",
        "Form names",
        "Form statuses",
        "Form types",
      ],
      status: statusForSwarm(formsModule?.status),
      confidence: (klaviyo?.forms?.count ?? 0) > 0 ? 76 : 44,
      findings: [
        `${klaviyo?.forms?.count ?? 0} signup form or popup resources are visible.`,
        ...topRecordEvidence(
          klaviyo?.forms?.byStatus,
          "Form status",
          "No form status evidence was available.",
        ).slice(0, 4),
      ],
      evidence:
        klaviyo?.forms?.recent
          .slice(0, 8)
          .map((form) => `${form.name} (${form.status}, ${form.type})`) ?? [],
      chartIds: chartIds(
        chartRefs(input.charts, ["klaviyo_l365_form_inventory"]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, ["klaviyo_l365_form_inventory"]),
      ),
      missingData: [
        "Form conversion rate, quiz answers, lead source, offer A/B test data, and welcome-flow downstream performance.",
      ],
      recommendations: [
        "Review offer clarity, segmentation fields, consent posture, welcome routing, quiz routing, and first-purchase handoff.",
      ],
      handoff:
        "Audience and opportunity agents should separate form presence from form performance until analytics are connected.",
      nextAgent: "audience_metrics_agent",
    }),
    makeAgent({
      agentId: "audience_metrics_agent",
      title: "Audience and Metrics Agent",
      role: "Segment and metric readiness analyst",
      objective:
        "Check whether lists, segments, and core metric catalog visibility are sufficient for future segment-response heatmaps.",
      sourceRefs: [
        "Klaviyo lists",
        "Klaviyo segments",
        "Metric catalog",
        "Important metric readiness",
      ],
      status: statusForSwarm(audienceModule?.status),
      confidence:
        klaviyo?.metrics.importantMetrics.readiness === "performance_ready"
          ? 82
          : 56,
      findings: [
        `${klaviyo?.audiences.lists ?? 0} lists and ${klaviyo?.audiences.segments ?? 0} segments are visible.`,
        `Important metrics found: ${klaviyo?.metrics.importantMetrics.found.join(", ") || "none"}.`,
        `Important metrics missing: ${klaviyo?.metrics.importantMetrics.missing.join(", ") || "none"}.`,
      ],
      evidence:
        klaviyo?.audiences.top
          .slice(0, 8)
          .map(
            (audience) =>
              `${audience.name} (${audience.type})${audience.profileCount != null ? ` - ${audience.profileCount} profiles` : ""}`,
          ) ?? [],
      chartIds: chartIds(
        chartRefs(input.charts, [
          "klaviyo_l365_audience_inventory",
          "klaviyo_l365_metric_readiness",
        ]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, [
          "klaviyo_l365_audience_inventory",
          "klaviyo_l365_metric_readiness",
        ]),
      ),
      missingData: [
        "Segment definitions, profile counts for all audiences, revenue per audience, and campaign-theme response by segment.",
      ],
      recommendations: [
        "Add safe aggregate metrics and segment definitions before generating segment-theme heatmaps or audience-specific campaign packages.",
      ],
      handoff:
        "Opportunity strategy must rank source gaps separately from true performance gaps.",
      nextAgent: "opportunity_strategy_agent",
    }),
    makeAgent({
      agentId: "opportunity_strategy_agent",
      title: "Opportunity Strategy Agent",
      role: "Backlog strategist",
      objective:
        "Turn the section findings into a prioritized, artifact-only opportunity backlog with impact, confidence, effort, and next action.",
      sourceRefs: [
        "All section-agent findings",
        "Opportunity priority matrix",
        "Blocked capability list",
      ],
      status: statusForSwarm(backlogModule?.status),
      confidence: input.backlog.length > 0 ? 86 : 50,
      findings: input.backlog
        .slice(0, 5)
        .map(
          (item, index) =>
            `${index + 1}. ${item.title}: impact ${item.impact}, confidence ${item.confidence}, effort ${item.effort}.`,
        ),
      evidence: input.backlog.slice(0, 5).map((item) => item.nextAction),
      chartIds: chartIds(
        chartRefs(input.charts, ["klaviyo_l365_opportunity_priority"]),
      ),
      chartTitles: chartTitles(
        chartRefs(input.charts, ["klaviyo_l365_opportunity_priority"]),
      ),
      missingData: [
        "Performance aggregates are needed before backlog items can be converted into revenue-sized packages.",
      ],
      recommendations: input.backlog.slice(0, 3).map((item) => item.nextAction),
      handoff:
        "Artifact and QA agents should preserve the ranked backlog, caveats, and no-live-action boundary.",
      nextAgent: "artifact_chart_agent",
    }),
    makeAgent({
      agentId: "artifact_chart_agent",
      title: "Artifact Chart Agent",
      role: "Visual artifact builder",
      objective:
        "Confirm each audit section has clickable chart specs, evidence tables, diagnoses, recommendations, and PDF-ready markdown.",
      sourceRefs: [
        "Audit chart specs",
        "Chart diagnoses",
        "Evidence tables",
        "Audit document markdown",
      ],
      status: input.charts.length > 0 ? "complete" : "blocked",
      confidence: input.charts.length > 0 ? 90 : 30,
      findings: [
        `${input.charts.length} interactive chart specs are attached to the audit artifact.`,
        `${input.charts.filter((chart) => chart.data && chart.data.length > 0).length} chart(s) include visible data rows.`,
        `${input.charts.filter((chart) => chart.diagnosis && chart.recommendation).length} chart(s) include diagnosis and recommendation copy.`,
      ],
      evidence: input.charts
        .slice(0, 10)
        .map((chart) => `${chart.title}: ${chart.data?.length ?? 0} row(s).`),
      chartIds: chartIds(input.charts),
      chartTitles: chartTitles(input.charts),
      missingData: [
        "Editable drag/move canvas behavior is a UI layer concern; this tool emits structured chart specs and evidence tables.",
      ],
      recommendations: [
        "Use the retention audit surface for interactive chart inspection and the Worklin document for PDF export.",
      ],
      handoff:
        "QA should verify artifact-only output, PDF readiness, and that chart caveats remain visible.",
      nextAgent: "qa_safety_agent",
    }),
    makeAgent({
      agentId: "qa_safety_agent",
      title: "QA and Safety Agent",
      role: "Retention safety reviewer",
      objective:
        "Verify the audit did not create drafts, send campaigns, schedule campaigns, activate flows, mutate profiles/segments, or write Shopify data.",
      sourceRefs: [
        "Safety metadata",
        "Blocked capabilities",
        "Artifact-only backlog",
      ],
      status:
        input.safety.externalActionTaken === false &&
        input.safety.canGoLiveNow === false
          ? "complete"
          : "blocked",
      confidence: 100,
      findings: [
        "externalActionTaken:false.",
        "canGoLiveNow:false.",
        `Blocked capabilities: ${input.safety.blockedCapabilities.join(", ")}.`,
      ],
      evidence: input.safety.caveats,
      chartIds: [],
      chartTitles: [],
      missingData: [],
      recommendations: [
        "Keep this v1 audit read-only. Draft creation remains a separate high-risk approval path and is not part of the audit run.",
      ],
      handoff:
        "Final editor may publish the audit as an artifact/document with safety and provenance attached.",
      nextAgent: "final_editor_agent",
    }),
    makeAgent({
      agentId: "final_editor_agent",
      title: "Final Editor Agent",
      role: "Audit synthesis editor",
      objective:
        "Combine section-agent outputs into one Worklin audit that mirrors the manual audit structure while preserving source caveats.",
      sourceRefs: [
        "All section-agent handoffs",
        "Audit modules",
        "Visual artifact pack",
        "Opportunity backlog",
      ],
      status: "complete",
      confidence: 88,
      findings: [
        "The default audit shape is now swarm-based: every major section has a named analyst, evidence, missing-data notes, chart refs, and handoff.",
        "The final audit remains Klaviyo-only unless Shopify or aggregate performance data is explicitly available.",
      ],
      evidence: [
        `${input.modules.length} audit modules.`,
        `${input.charts.length} chart specs.`,
        `${input.backlog.length} backlog items.`,
      ],
      chartIds: chartIds(input.charts),
      chartTitles: chartTitles(input.charts),
      missingData: [
        "Add safe aggregate Klaviyo performance reads before making winner/loser, revenue, or deliverability-grade claims.",
      ],
      recommendations: [
        "Use this swarm contract as the default audit shape for every new brand audit.",
      ],
      handoff:
        "Return the visual artifact, PDF-ready document, visible swarm reasoning, backlog, and safety metadata to the user.",
    }),
  ];

  const completedAgents = agents.filter(
    (agent) => agent.status === "complete",
  ).length;
  const partialAgents = agents.filter(
    (agent) => agent.status === "partial",
  ).length;
  const blockedAgents = agents.filter(
    (agent) => agent.status === "blocked",
  ).length;
  const status: SwarmAgentStatus =
    blockedAgents > 0 || partialAgents > 0 ? "partial" : "complete";

  return {
    mode: "section_agent_swarm",
    version: "worklin-audit-swarm-v1",
    status,
    executionModel: "deterministic_section_agents",
    sourceMode: "klaviyo_l365",
    generatedAt: input.generatedAt,
    agentCount: agents.length,
    parallelizable: false,
    liveSubagents: {
      enabled: false,
      completed: 0,
      failed: 0,
      timedOut: 0,
      timeoutMs: 0,
    },
    auditDepth: {
      requestedShape:
        "Dr. Rachael-style deep audit split across data trust, campaign, creative, flow, acquisition, audience, opportunity, artifact, QA, and final editor agents.",
      completedAgents,
      partialAgents,
      blockedAgents,
      blockedSections: agents
        .filter((agent) => agent.status === "blocked")
        .map((agent) => agent.title),
      defaultSections: agents.map((agent) => agent.title),
    },
    agents,
    finalSynthesis: {
      headline:
        "Worklin ran the Klaviyo L365 audit as a section-agent swarm and merged the handoffs into one artifact-only retention audit.",
      strongestSignals: compactList([
        weeklyAverage == null
          ? "Campaign cadence needs dated send exports before final scoring."
          : `Campaign cadence averages ${weeklyAverage.toFixed(1)} send(s)/week across visible dated weeks.`,
        lifecycleMissing.length
          ? `Lifecycle gaps detected: ${lifecycleMissing.join(", ")}.`
          : "Core lifecycle coverage is visible by flow name.",
        topWords.length
          ? `Subject/name word bank is available: ${topWords.slice(0, 5).join(", ")}.`
          : "Subject-line word bank is sparse.",
        `Opportunity backlog has ${input.backlog.length} artifact-only next action(s).`,
      ]),
      nextActions: input.backlog.slice(0, 3).map((item) => item.nextAction),
      defaultAuditShape: [
        "Data trust and source caveats",
        "Campaign cadence, status, channel, theme, sale posture, and word bank",
        "Flow/lifecycle coverage",
        "Forms, popups, and acquisition handoff",
        "Audience, segments, and metric readiness",
        "Opportunity backlog",
        "Interactive artifact charts",
        "QA/safety and final synthesis",
      ],
    },
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blockedCapabilities: input.safety.blockedCapabilities,
    },
  };
}

function auditTraceFromSwarm(
  swarm: KlaviyoL365AuditSwarmRun,
  windowLabel: string,
) {
  return swarm.agents.map((agent) => ({
    cardId: `audit_swarm_${agent.agentId}`,
    moduleId: agent.agentId,
    title: agent.title,
    status: agent.status,
    analysisWindow: windowLabel,
    dataRead: agent.sourceRefs,
    ruleApplied: agent.objective,
    rationale: agent.handoff,
    evidence: [...agent.findings.slice(0, 4), ...agent.evidence.slice(0, 4)],
    caveats: [...agent.missingData.slice(0, 4), ...agent.safety.slice(0, 3)],
    recommendation:
      agent.recommendations[0] ??
      "Review this section's chart, evidence table, caveats, and handoff.",
  }));
}

function markdownForAuditSwarm(swarm: KlaviyoL365AuditSwarmRun): string {
  const agentBlocks = swarm.agents
    .map((agent, index) =>
      [
        `### ${index + 1}. ${agent.title}`,
        "",
        `Status: ${agent.status}`,
        `Role: ${agent.role}`,
        `Confidence: ${agent.confidence}`,
        agent.liveSubagent
          ? `Live child conversation: ${agent.liveSubagent.status} (${agent.liveSubagent.durationMs}ms)`
          : "Live child conversation: not used in this execution",
        "",
        `Objective: ${agent.objective}`,
        "",
        agent.liveSubagent?.output
          ? ["Agent note:", "", agent.liveSubagent.output].join("\n")
          : "Agent note: deterministic source packet only.",
        "",
        "Findings:",
        agent.findings.map((finding) => `- ${finding}`).join("\n") ||
          "- No findings reported.",
        "",
        "Evidence:",
        agent.evidence.map((item) => `- ${item}`).join("\n") ||
          "- No evidence rows reported.",
        "",
        "Charts:",
        agent.chartTitles.map((title) => `- ${title}`).join("\n") ||
          "- No charts attached to this agent.",
        "",
        "Missing data / caveats:",
        agent.missingData.map((item) => `- ${item}`).join("\n") ||
          "- No additional missing data reported.",
        "",
        "Handoff:",
        agent.handoff,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "## Audit Swarm Method",
    "",
    "Worklin split this audit into section agents and then merged their handoffs into one audit artifact. This is visible audit reasoning: source reads, rules applied, evidence, caveats, and recommendations. It is not private model scratchpad.",
    "",
    `Execution model: ${swarm.executionModel}`,
    `Swarm status: ${swarm.status}`,
    `Agents: ${swarm.agentCount}`,
    `Live child agents: ${swarm.liveSubagents.enabled ? `${swarm.liveSubagents.completed} completed, ${swarm.liveSubagents.failed} failed, ${swarm.liveSubagents.timedOut} timed out` : "not used"}`,
    `Background child agents: ${swarm.executionModel === "background_child_conversations" ? "yes" : "not used"}`,
    "",
    "Final synthesis:",
    "",
    swarm.finalSynthesis.headline,
    "",
    "Strongest signals:",
    swarm.finalSynthesis.strongestSignals
      .map((signal) => `- ${signal}`)
      .join("\n"),
    "",
    agentBlocks,
  ].join("\n");
}

const LIVE_AUDIT_SWARM_DEFAULT_TIMEOUT_MS = 300_000;
const LIVE_AUDIT_SWARM_POLL_MS = 1_000;

function auditSwarmTimeoutMs(input: Record<string, unknown>): number {
  const requested = numberInput(input, "swarm_timeout_ms");
  if (!requested) return LIVE_AUDIT_SWARM_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(requested, 30_000), 600_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function subagentConversationText(conversationId: string): string {
  const rows = getMessages(conversationId);
  const assistantMessages: string[] = [];

  for (const row of rows) {
    if (row.role !== "assistant") continue;
    const blocks: string[] = [];
    try {
      const content = JSON.parse(row.content);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            blocks.push((block as Record<string, string>).text);
          }
        }
      } else if (typeof content === "string") {
        blocks.push(content);
      }
    } catch {
      blocks.push(row.content);
    }
    if (blocks.length > 0) assistantMessages.push(blocks.join("\n\n"));
  }

  return assistantMessages.slice(-1)[0]?.trim() ?? "";
}

function compactSubagentOutput(output: string, maxLength = 1_800): string {
  const normalized = output.replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}\n\n[Trimmed for the final audit. Open the child conversation for the full section note.]`;
}

function agentChartPacket(
  agent: KlaviyoL365AuditSwarmAgent,
  charts: KlaviyoL365AuditChartRef[],
) {
  const selected = charts.filter(
    (chart) => chart.chartId && agent.chartIds.includes(chart.chartId),
  );
  return selected.map((chart) => ({
    chartId: chart.chartId,
    title: chart.title,
    diagnosis: chart.diagnosis,
    recommendation: chart.recommendation,
    caveats: chart.caveats,
    data: Array.isArray(chart.data) ? chart.data.slice(0, 14) : [],
  }));
}

function buildAuditSubagentObjective(input: {
  agent: KlaviyoL365AuditSwarmAgent;
  charts: KlaviyoL365AuditChartRef[];
  brandName: string;
  windowLabel: string;
  sourceMode: "klaviyo_l365";
}): string {
  const packet = {
    brandName: input.brandName,
    sourceMode: input.sourceMode,
    analysisWindow: input.windowLabel,
    section: {
      agentId: input.agent.agentId,
      title: input.agent.title,
      role: input.agent.role,
      objective: input.agent.objective,
      sourceRefs: input.agent.sourceRefs,
      findings: input.agent.findings,
      evidence: input.agent.evidence,
      missingData: input.agent.missingData,
      recommendations: input.agent.recommendations,
      charts: agentChartPacket(input.agent, input.charts),
    },
    safety: {
      externalActionTaken: false,
      canGoLiveNow: false,
      blockedCapabilities: [
        "klaviyo_send_campaign",
        "klaviyo_schedule_campaign",
        "klaviyo_activate_flow",
        "klaviyo_mutate_segment",
        "klaviyo_mutate_profile",
        "shopify_write",
      ],
    },
  };

  return [
    `You are the ${input.agent.title} for a Worklin deep retention audit.`,
    "",
    "Write the section handoff like a senior retention marketer talking to an e-commerce founder or marketing lead. Be concrete, plain-spoken, and useful. Avoid robotic phrases like source mode, artifact-only, implementation pass, deterministic packet, or model scratchpad unless you are in the caveats section.",
    "",
    "Use only the source packet below. Do not invent Shopify, revenue, LTV, open-rate, click-rate, or product-performance facts that are not present. If data is missing, say what that prevents you from concluding and what to connect next.",
    "",
    "Return this exact markdown shape:",
    "### Client-ready take",
    "2-4 sentences in a human audit voice.",
    "",
    "### What I see",
    "- 3-6 evidence bullets.",
    "",
    "### Why it matters",
    "1-3 sentences.",
    "",
    "### What I would do next",
    "- 2-4 concrete next moves.",
    "",
    "### Caveats",
    "- Missing data or safety limits.",
    "",
    "Source packet:",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ].join("\n");
}

async function runLiveAuditSwarm(input: {
  swarm: KlaviyoL365AuditSwarmRun;
  charts: KlaviyoL365AuditChartRef[];
  brandName: string;
  windowLabel: string;
  timeoutMs: number;
  context: ToolContext;
}): Promise<KlaviyoL365AuditSwarmRun> {
  const sendToClient = input.context.sendToClient as
    | ((message: unknown) => void)
    | undefined;
  if (!sendToClient || !input.context.conversationId) {
    return input.swarm;
  }

  const manager = getSubagentManager();
  const runKey = `audit-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const spawned = await Promise.all(
    input.swarm.agents.map(async (agent, index) => {
      const label = `${runKey}-${index + 1}-${agent.agentId}`;
      try {
        const subagentId = await manager.spawn(
          {
            parentConversationId: input.context.conversationId,
            label,
            objective: buildAuditSubagentObjective({
              agent,
              charts: input.charts,
              brandName: input.brandName,
              windowLabel: input.windowLabel,
              sourceMode: "klaviyo_l365",
            }),
            role: "planner",
            sendResultToUser: false,
            ...(input.context.overrideProfile
              ? { overrideProfile: input.context.overrideProfile }
              : {}),
            ...(input.context.toolUseId
              ? { parentToolUseId: input.context.toolUseId }
              : {}),
          },
          sendToClient,
        );
        return { agentId: agent.agentId, subagentId, startedAt: Date.now() };
      } catch (error) {
        return {
          agentId: agent.agentId,
          subagentId: null,
          startedAt: Date.now(),
          error:
            error instanceof Error
              ? error.message
              : "Unable to spawn this audit subagent.",
        };
      }
    }),
  );

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const pending = spawned.some((item) => {
      if (!item.subagentId) return false;
      const state = manager.getState(item.subagentId);
      return !state || !TERMINAL_STATUSES.has(state.status);
    });
    if (!pending) break;
    await sleep(LIVE_AUDIT_SWARM_POLL_MS);
  }

  let completed = 0;
  let failed = 0;
  let timedOut = 0;

  const agents = input.swarm.agents.map((agent) => {
    const live = spawned.find((item) => item.agentId === agent.agentId);
    if (!live || !live.subagentId) {
      failed += 1;
      const output = live?.error ?? "This audit subagent could not be spawned.";
      return {
        ...agent,
        status: "partial" as const,
        confidence: Math.max(30, agent.confidence - 25),
        findings: [output, ...agent.findings],
        handoff: `${agent.handoff}\n\nLive agent note: ${output}`,
        liveSubagent: {
          subagentId: "not_spawned",
          conversationId: "not_spawned",
          status: "failed" as const,
          durationMs: Date.now() - startedAt,
          output,
        },
      };
    }

    const state = manager.getState(live.subagentId);
    if (!state || !TERMINAL_STATUSES.has(state.status)) {
      timedOut += 1;
      manager.abort(
        live.subagentId,
        sendToClient,
        input.context.conversationId,
        { suppressNotification: true },
      );
      const output =
        "This audit subagent timed out before returning a section note, so Worklin used the deterministic source packet for this section.";
      return {
        ...agent,
        status: "partial" as const,
        confidence: Math.max(35, agent.confidence - 15),
        findings: [output, ...agent.findings],
        handoff: `${agent.handoff}\n\nLive agent note: ${output}`,
        liveSubagent: {
          subagentId: live.subagentId,
          conversationId: state?.conversationId ?? "unknown",
          status: "timed_out" as const,
          durationMs: Date.now() - live.startedAt,
          output,
        },
      };
    }

    const rawOutput = subagentConversationText(state.conversationId);
    const output =
      compactSubagentOutput(rawOutput) ||
      "This audit subagent completed but did not return a text section note.";
    if (state.status === "completed") completed += 1;
    else failed += 1;
    const liveStatus: LiveAuditSubagentStatus =
      state.status === "completed"
        ? "completed"
        : state.status === "failed"
          ? "failed"
          : "aborted";

    return {
      ...agent,
      status:
        state.status === "completed"
          ? ("complete" as SwarmAgentStatus)
          : ("partial" as SwarmAgentStatus),
      confidence:
        state.status === "completed"
          ? Math.min(100, agent.confidence + 4)
          : Math.max(35, agent.confidence - 18),
      findings: [output, ...agent.findings],
      evidence: [...agent.evidence],
      handoff: output,
      liveSubagent: {
        subagentId: live.subagentId,
        conversationId: state.conversationId,
        status: liveStatus,
        durationMs: Date.now() - live.startedAt,
        output,
      },
    };
  });

  const blockedAgents = agents.filter(
    (agent) => agent.status === "blocked",
  ).length;
  const partialAgents = agents.filter(
    (agent) => agent.status === "partial",
  ).length;
  const completedAgents = agents.filter(
    (agent) => agent.status === "complete",
  ).length;

  return {
    ...input.swarm,
    status:
      failed > 0 || timedOut > 0 || partialAgents > 0 || blockedAgents > 0
        ? "partial"
        : "complete",
    executionModel: "background_child_conversations",
    liveSubagents: {
      enabled: true,
      completed,
      failed,
      timedOut,
      timeoutMs: input.timeoutMs,
    },
    auditDepth: {
      ...input.swarm.auditDepth,
      completedAgents,
      partialAgents,
      blockedAgents,
      blockedSections: agents
        .filter((agent) => agent.status === "blocked")
        .map((agent) => agent.title),
    },
    agents,
    finalSynthesis: {
      ...input.swarm.finalSynthesis,
      headline:
        completed > 0
          ? `Worklin spawned ${agents.length} audit section agents, waited for ${completed} completed handoff(s), and merged them into one client-ready Klaviyo audit.`
          : input.swarm.finalSynthesis.headline,
      strongestSignals: input.swarm.finalSynthesis.strongestSignals,
      nextActions: input.swarm.finalSynthesis.nextActions,
    },
  };
}

async function upgradeKlaviyoL365AuditWithLiveSwarm(
  audit: ReturnType<typeof buildKlaviyoL365Audit>,
  input: Record<string, unknown>,
  dataset: RetentionDataset,
  context: ToolContext,
) {
  const windowLabel = klaviyoAuditWindowLabel(dataset);
  const swarm = await runLiveAuditSwarm({
    swarm: audit.swarm,
    charts: audit.charts,
    brandName: audit.brandName,
    windowLabel,
    timeoutMs: auditSwarmTimeoutMs(input),
    context,
  });
  const contentMarkdown = markdownForKlaviyoL365Audit({
    title: audit.title,
    brandName: audit.brandName,
    generatedAt: audit.generatedAt,
    windowLabel,
    dataset,
    charts: audit.charts,
    backlog: audit.backlog,
    swarm,
    safety: audit.safety,
  });

  return {
    ...audit,
    swarm,
    auditTrace: auditTraceFromSwarm(swarm, windowLabel),
    artifact: {
      ...audit.artifact,
      contentMarkdown,
    },
  };
}

function markdownForKlaviyoL365Audit(input: {
  title: string;
  brandName: string;
  generatedAt: string;
  windowLabel: string;
  dataset: RetentionDataset;
  charts: Array<{
    chartId?: string;
    title: string;
    diagnosis: string;
    recommendation: string;
    caveats: string[];
    data?: Array<Record<string, string | number | boolean | null>>;
  }>;
  backlog: ReturnType<typeof klaviyoL365Backlog>;
  swarm: KlaviyoL365AuditSwarmRun;
  safety: ReturnType<typeof createRetentionSafetyMetadata>;
}): string {
  const klaviyo = input.dataset.klaviyoSnapshot;
  const campaignPerformance = klaviyo?.campaignPerformance;
  const themeLines = countRecordLines(
    campaignPerformance?.byTheme,
    "- No campaign themes could be inferred from the current campaign metadata.",
  );
  const statusLines = countRecordLines(
    campaignPerformance?.byStatus,
    "- No campaign status breakdown was available.",
  );
  const channelLines = countRecordLines(
    campaignPerformance?.byChannel,
    "- No campaign channel breakdown was available.",
  );
  const wordBankLines =
    campaignPerformance?.subjectWordBank
      .slice(0, 35)
      .map((item) => `- ${item.word}: ${item.count}`)
      .join("\n") || "- No subject-line words were exposed in this snapshot.";
  const recentCampaignLines =
    campaignPerformance?.recent
      .slice(0, 50)
      .map(
        (campaign) =>
          `- ${campaign.sentAt?.slice(0, 10) ?? "undated"} - ${campaign.name} (${campaign.status}, ${campaign.channel}, ${campaign.theme})${campaign.subject ? ` - ${campaign.subject}` : ""}`,
      )
      .join("\n") || "- No campaigns returned for the L365 account snapshot.";
  const saleLines = countRecordLines(
    countValues(
      campaignPerformance?.recent.map((campaign) => campaign.salePosture) ?? [],
    ),
    "- Sale/non-sale posture could not be inferred from visible campaign names or subjects.",
  );
  const cadenceLines =
    campaignPerformance?.cadenceByWeek
      .slice(-52)
      .map(
        (row) =>
          `- ${row.weekStart}: ${row.campaignCount} campaign(s), target band ${row.targetMin}-${row.targetMax}`,
      )
      .join("\n") || "- No dated weekly cadence rows were available.";
  const lifecyclePresent =
    klaviyo?.lifecycleCoverage.present
      .map((item) => `- ${item.label}`)
      .join("\n") || "- None detected.";
  const lifecycleMissing =
    klaviyo?.lifecycleCoverage.missing
      .map((item) => `- ${item.label}`)
      .join("\n") || "- None detected.";
  const flowStatusLines = countRecordLines(
    klaviyo?.flowPerformance?.byStatus,
    "- No flow status breakdown was available.",
  );
  const flowTriggerLines = countRecordLines(
    klaviyo?.flowPerformance?.byTriggerType,
    "- No flow trigger breakdown was available.",
  );
  const formLines =
    klaviyo?.forms?.recent
      .slice(0, 50)
      .map((form) => `- ${form.name} (${form.status}, ${form.type})`)
      .join("\n") ||
    "- No forms/popups returned by the safe Klaviyo forms read.";
  const audienceLines =
    klaviyo?.audiences.top
      .slice(0, 30)
      .map(
        (audience) =>
          `- ${audience.name} (${audience.type})${audience.profileCount != null ? ` - ${audience.profileCount} profiles` : ""}`,
      )
      .join("\n") || "- No list/segment inventory rows were returned.";
  const metricFoundLines =
    klaviyo?.metrics.importantMetrics.found
      .map((metric) => `- ${metric}`)
      .join("\n") || "- None.";
  const metricMissingLines =
    klaviyo?.metrics.importantMetrics.missing
      .map((metric) => `- ${metric}`)
      .join("\n") || "- None.";
  const chartLines = input.charts
    .map((chart) =>
      [
        `### ${chart.title}`,
        "",
        `Diagnosis: ${chart.diagnosis}`,
        "",
        `Recommendation: ${chart.recommendation}`,
        "",
        pdfChartHtml(chart),
        "",
        "Evidence table:",
        "",
        markdownTableForRows(
          chart.data,
          chart.title.toLowerCase().includes("cadence") ? 30 : 18,
        ),
        "",
        `Caveats: ${(chart.caveats ?? []).join(" ") || "None."}`,
      ].join("\n"),
    )
    .join("\n\n");
  const backlogLines = input.backlog
    .map(
      (item, index) =>
        `${index + 1}. ${item.title} - impact ${item.impact}, confidence ${item.confidence}. ${item.nextAction}`,
    )
    .join("\n");
  const strongestSignalLines =
    input.swarm.finalSynthesis.strongestSignals
      .map((signal) => `- ${signal}`)
      .join("\n") ||
    "- The account has enough Klaviyo structure to audit, but deeper performance data is still needed for revenue-grade decisions.";
  const nextActionLines =
    input.swarm.finalSynthesis.nextActions
      .map((action) => `- ${action}`)
      .join("\n") ||
    "- Review the account map, then connect safe aggregate metrics before asking Worklin to draft campaign packages.";
  const queryErrors =
    klaviyo?.queryErrors
      ?.map(
        (error) =>
          `- ${error.path}: HTTP ${error.status}${error.detail ? ` (${error.detail})` : ""}`,
      )
      .join("\n") || "- No optional Klaviyo reads reported an error.";
  const chartHtml = (chartId: string): string => {
    const chart = input.charts.find((item) => item.chartId === chartId);
    return chart ? pdfChartHtml(chart) : "";
  };

  return [
    `# ${input.title}`,
    "",
    "A comprehensive diagnostic of Klaviyo infrastructure, campaign cadence, lifecycle architecture, list capture, and prioritized recommendations for the next growth phase.",
    "",
    `REPORT DATE: ${input.generatedAt.slice(0, 10)}`,
    "VERSION 1.0 - CONFIDENTIAL",
    `BRAND: ${input.brandName}`,
    `ANALYSIS WINDOW: ${input.windowLabel}`,
    "",
    "## Data Trust & Input Readiness Dashboard",
    "",
    "Ingestion status across all connected Klaviyo data sources. Green means ready for this audit; grey highlights the next integration phase.",
    "",
    chartHtml("klaviyo_l365_data_readiness"),
    "",
    "## Executive Summary",
    "",
    "I treated this as a Klaviyo account audit first: what is being sent, what lifecycle infrastructure exists, where the list is being captured, and which gaps should be fixed before anyone writes more campaigns. Shopify was not required for this pass. It becomes useful later when we want product truth: best sellers, underperformers, replenishment windows, LTV, AOV, product affinity, refunds, and revenue reconciliation.",
    "",
    `Visible account campaigns: ${klaviyo?.campaigns.count ?? 0}`,
    `L365 campaign rows analyzed: ${campaignPerformance?.count ?? 0}`,
    `Visible flows: ${klaviyo?.flows.count ?? 0}`,
    `Visible signup forms/popups: ${klaviyo?.forms?.count ?? 0}`,
    `Visible lists: ${klaviyo?.audiences.lists ?? 0}`,
    `Visible segments: ${klaviyo?.audiences.segments ?? 0}`,
    `Important metric readiness: ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}`,
    "",
    "## What I'd Tell the Client First",
    "",
    input.swarm.finalSynthesis.headline,
    "",
    "The strongest signals:",
    "",
    strongestSignalLines,
    "",
    "What I would do next:",
    "",
    nextActionLines,
    "",
    "This audit is intentionally honest about source coverage. I can inspect Klaviyo account structure, campaigns, flows, signup forms, audiences, metric readiness, missing lifecycle coverage, and operating gaps. I will not pretend to know product performance, order history, LTV, AOV, or attributed revenue until Shopify/order data or safe aggregate event exports are connected.",
    "",
    "## Data Trust and Scope",
    "",
    "- Source mode: klaviyo_l365",
    "- Klaviyo reads are GET-only.",
    "- No fixture/sample Shopify, product, revenue, customer, campaign-performance, segment-performance, or flow-performance data was used.",
    "- Revenue and order-level claims are not made without Shopify or safe aggregate metric access.",
    "",
    "What this Klaviyo-only audit can do now:",
    "",
    "- Build an account map from live Klaviyo metadata.",
    "- Inspect campaign cadence, campaign status, channel mix, inferred themes, and subject-line language where campaign metadata is exposed.",
    "- Inspect lifecycle/flow coverage from visible flow names, statuses, and trigger metadata.",
    "- Inspect signup forms/popups, lists, segments, and metric catalog readiness.",
    "- Produce a prioritized opportunity backlog with no external writes.",
    "",
    "What remains unavailable until deeper source coverage is added:",
    "",
    "- Product performance tiers: top performers, hidden gems, underperformers.",
    "- Klaviyo vs Shopify revenue reconciliation.",
    "- LTV, AOV, replenishment windows, product affinity, and customer cohorts.",
    "- Campaign revenue, open rate, click rate, unsubscribe rate, spam complaint rate, and segment response.",
    "- Flow message-level revenue/drop-off and step-level conversion.",
    "",
    "Optional read caveats:",
    queryErrors,
    "",
    markdownForAuditSwarm(input.swarm),
    "",
    "## Campaign Cadence Heatmap",
    "",
    "Weekly send frequency over the audit window. The healthy band is 2-4 sends/week; spikes indicate potential over-saturation risk.",
    "",
    "What Worklin inspected: dated L365 campaign rows, campaign count by week, and the target operating band. This is a cadence audit, not a revenue audit.",
    "",
    "Why it matters: inconsistent cadence creates two different problems at once. Quiet weeks leave demand uncaptured; spike weeks train subscribers to expect urgency and can increase fatigue. The right answer is not always more email. The right answer is a stable operating rhythm with intentional education, proof, product, lifecycle, and sale moments.",
    "",
    "Recommended next action: turn the cadence chart into a four-week campaign calendar. Cap normal weeks inside the target band, reserve spikes for true launches/promotions, and assign a non-sale purpose to every campaign before writing creative.",
    "",
    chartHtml("klaviyo_l365_campaign_cadence"),
    "",
    "## Theme Mix & Subject Line Repetition",
    "",
    "Content categories reveal reliance on general retention messaging, sale language, education, proof, product, and lifecycle angles. The word bank shows repeated language Worklin should either reuse intentionally or diversify.",
    "",
    "What Worklin inspected: campaign names, visible subject lines, inferred theme tags, and repeated words across the L365 campaign set.",
    "",
    "Why it matters: brands often think they have a campaign-volume problem when they really have a message-architecture problem. If subject lines repeat the same urgency or generic benefit language, the calendar becomes easier to ignore even when send volume looks healthy.",
    "",
    "Recommended next action: build a brand-specific language bank. Keep words that clearly belong to the brand, retire overused promo crutches, and create separate subject-line frameworks for education, proof, objection handling, product discovery, replenishment, winback, and VIP moments.",
    "",
    chartHtml("klaviyo_l365_campaign_theme_mix"),
    "",
    chartHtml("klaviyo_l365_subject_word_bank"),
    "",
    "## Campaign Report",
    "",
    "### Campaign Status Breakdown",
    "",
    statusLines,
    "",
    "### Campaign Channel Breakdown",
    "",
    channelLines,
    "",
    "### Weekly Cadence",
    "",
    cadenceLines,
    "",
    "### Recent L365 Campaign Rows",
    "",
    recentCampaignLines,
    "",
    "### Theme Mix",
    "",
    themeLines,
    "",
    "### Sale vs Non-Sale Posture",
    "",
    saleLines,
    "",
    "### Subject-Line Word Bank",
    "",
    wordBankLines,
    "",
    "Campaign diagnosis:",
    "",
    "Use the campaign report the same way the manual audits use campaign tables and charts: first establish whether the brand is sending consistently, then identify whether the calendar is too promotional, too generic, or missing educational/product/story/proof moments. When performance aggregates are added, Worklin should rank themes and subject-line patterns by opens, clicks, revenue, unsubscribe rate, and spam complaint rate.",
    "",
    "## Lifecycle Flow Backbone Map",
    "",
    "Structural overview of visible automation flows. This separates active-like lifecycle infrastructure from gaps, drafts, paused flows, and list-triggered architecture.",
    "",
    "What Worklin inspected: visible flow names, statuses, trigger metadata, inferred lifecycle stage, and active-like coverage.",
    "",
    "Why it matters: campaigns are not a substitute for lifecycle infrastructure. If welcome, browse/cart/checkout, post-purchase, replenishment, winback, VIP, review, birthday, or sunset coverage is missing, the account is relying too heavily on manual campaign pressure.",
    "",
    "Recommended next action: fix the highest-intent missing lifecycle stage before adding more campaign volume. If a stage exists only as a paused or draft flow, review that asset before building from scratch.",
    "",
    chartHtml("klaviyo_l365_flow_lifecycle_coverage"),
    "",
    "## Flow and Lifecycle Report",
    "",
    "Detected lifecycle coverage:",
    lifecyclePresent,
    "",
    "Missing or not detected:",
    lifecycleMissing,
    "",
    "Flow status breakdown:",
    flowStatusLines,
    "",
    "Flow trigger breakdown:",
    flowTriggerLines,
    "",
    "Flow diagnosis:",
    "",
    "This is the lifecycle map. Missing stages should be treated as account architecture gaps; inactive/draft flows should be reviewed before creating net-new automation. Worklin did not activate or edit any flow.",
    "",
    "## Popup and Lead Capture Report",
    "",
    formLines,
    "",
    "Popup diagnosis:",
    "",
    "Forms/popups should be reviewed for offer clarity, segmentation fields, consent posture, welcome routing, quiz routing, and first-purchase follow-up. Conversion rate and revenue impact require form analytics or event aggregates.",
    "",
    "## Audience, Lists, Segments, and Metrics",
    "",
    "Visible audiences:",
    audienceLines,
    "",
    "Important metrics found:",
    metricFoundLines,
    "",
    "Important metrics missing:",
    metricMissingLines,
    "",
    "Metrics diagnosis:",
    "",
    "Metric catalog visibility is only readiness. Worklin still needs safe aggregate reads or exports before it can score campaigns and flows by open, click, order, revenue, unsubscribe, spam complaint, segment response, or fatigue.",
    "",
    "## Visual Artifact Pack",
    "",
    chartLines || "No visual artifacts generated.",
    "",
    "## The Priority Backlog Matrix",
    "",
    "Ranked quick wins ordered by weighted impact and confidence. Top items deliver maximum lift with minimal implementation friction.",
    "",
    "What Worklin inspected: all section findings, source caveats, account readiness, likely implementation effort, confidence, and the no-live-action boundary.",
    "",
    "Why it matters: a good audit should not leave the client with twenty interesting observations and no operating order. The backlog turns the audit into a decision queue.",
    "",
    "Recommended next action: review the top two items first. Approve one implementation track at a time, then ask Worklin to generate the campaign package or QA checklist for that specific opportunity.",
    "",
    chartHtml("klaviyo_l365_opportunity_priority"),
    "",
    "## Prioritized Opportunity Backlog",
    "",
    backlogLines || "No backlog items generated.",
    "",
    "## Safety & Provenance",
    "",
    "- externalActionTaken:false",
    "- canGoLiveNow:false",
    `- Blocked capabilities: ${input.safety.blockedCapabilities.join(", ")}`,
  ].join("\n");
}

function buildKlaviyoL365Audit(
  input: Record<string, unknown>,
  dataset: RetentionDataset,
  blockedFullAudit: ReturnType<typeof blockedDeepAuditResult>,
) {
  const generatedAt = new Date().toISOString();
  const klaviyo = dataset.klaviyoSnapshot;
  const brandName =
    retentionOptions(input).brandName ?? dataset.brandName ?? "Klaviyo Account";
  const windowLabel = klaviyoAuditWindowLabel(dataset);
  const campaignPerformance = klaviyo?.campaignPerformance;
  const flowPerformance = klaviyo?.flowPerformance;
  const forms = klaviyo?.forms;
  const lifecycleRows = [
    ...(klaviyo?.lifecycleCoverage.present ?? []).map((item) => ({
      lifecycleStage: item.label,
      status: "present",
      coverage: 1,
    })),
    ...(klaviyo?.lifecycleCoverage.missing ?? []).map((item) => ({
      lifecycleStage: item.label,
      status: "missing",
      coverage: 0,
    })),
  ];
  const saleRows = countValues(
    campaignPerformance?.recent.map((campaign) => campaign.salePosture) ?? [],
  );
  const metricRows = [
    ...(klaviyo?.metrics.importantMetrics.found ?? []).map((metric) => ({
      metric,
      status: "found",
      readiness: 1,
    })),
    ...(klaviyo?.metrics.importantMetrics.missing ?? []).map((metric) => ({
      metric,
      status: "missing",
      readiness: 0,
    })),
  ];
  const missingInputRows = [
    {
      input: "Klaviyo account metadata",
      status: "available",
      readiness: 1,
    },
    {
      input: "Campaign names, status, channel, subject",
      status: campaignPerformance?.count ? "available" : "missing",
      readiness: campaignPerformance?.count ? 1 : 0,
    },
    {
      input: "Flows and lifecycle architecture",
      status: klaviyo?.flows.count ? "available" : "missing",
      readiness: klaviyo?.flows.count ? 1 : 0,
    },
    {
      input: "Signup forms and popups",
      status: forms?.count ? "available" : "missing",
      readiness: forms?.count ? 1 : 0,
    },
    {
      input: "Campaign revenue/open/click aggregates",
      status: "missing",
      readiness: 0,
    },
    {
      input: "Shopify products, orders, LTV, AOV",
      status: "optional_missing",
      readiness: 0,
    },
  ];
  const backlog = klaviyoL365Backlog(dataset);
  const charts = [
    {
      chartId: "klaviyo_l365_data_readiness",
      title: "Data Trust & Input Readiness Dashboard",
      family: "klaviyo_inventory",
      type: "bar",
      data: missingInputRows,
      encodings: { label: "input", value: "readiness", group: "status" },
      interaction: {
        labelKey: "input",
        primaryMetric: "readiness",
        metricKeys: ["readiness"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin separated real Klaviyo reads from missing performance and commerce inputs before generating the audit.",
      recommendation:
        "Treat unavailable inputs as source gaps, not as empty performance. Add safe aggregates and optional Shopify later before making revenue/product claims.",
      caveats: [
        "Readiness is binary source coverage, not a performance score.",
      ],
    },
    {
      chartId: "klaviyo_l365_campaign_cadence",
      title: "Campaign Cadence Heatmap",
      family: "weekly_campaign_cadence",
      type: "column",
      data: campaignPerformance?.cadenceByWeek.length
        ? campaignPerformance.cadenceByWeek
        : [
            {
              weekStart: "no_dated_campaigns",
              campaignCount: 0,
              targetMin: 2,
              targetMax: 4,
            },
          ],
      encodings: {
        label: "weekStart",
        value: "campaignCount",
        targetMin: "targetMin",
        targetMax: "targetMax",
      },
      interaction: {
        labelKey: "weekStart",
        primaryMetric: "campaignCount",
        metricKeys: ["campaignCount", "targetMin", "targetMax"],
        defaultSort: "none",
        selectable: true,
      },
      diagnosis: campaignPerformance?.cadenceByWeek.length
        ? `Worklin found ${campaignPerformance.count} campaign rows in the Klaviyo L365 snapshot and grouped dated sends into weekly cadence bars.`
        : "Worklin could not build reliable weekly cadence because Klaviyo did not expose dated campaign sends in this safe snapshot.",
      recommendation:
        "Use 2-4 campaign sends per week as the first operating band, then diversify by education, product, proof, lifecycle, and sale posture.",
      caveats: [
        "Cadence uses campaign metadata returned by Klaviyo. It does not include revenue or segment response unless safe aggregate reads are added.",
      ],
    },
    {
      chartId: "klaviyo_l365_subject_word_bank",
      title: "Subject Line Word Bank",
      family: "subject_line_word_bank",
      type: "word_bank",
      data: campaignPerformance?.subjectWordBank.length
        ? campaignPerformance.subjectWordBank
        : [{ word: "not_available", count: 0 }],
      encodings: { label: "word", value: "count" },
      interaction: {
        labelKey: "word",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis: campaignPerformance?.subjectWordBank.length
        ? "Worklin extracted recurring language from campaign names and subject lines to start a reusable word bank."
        : "Subject-line metadata was unavailable or sparse in the current Klaviyo snapshot.",
      recommendation:
        "Separate overused promotion words from reusable brand/product education language before writing the next campaign calendar.",
      caveats: [
        "Word bank is lexical, not a performance ranking, until opens/clicks/revenue are safely joined.",
      ],
    },
    {
      chartId: "klaviyo_l365_campaign_theme_mix",
      title: "Theme Mix",
      family: "klaviyo_campaign_theme",
      type: "bar",
      data: countRecordRows(
        campaignPerformance?.byTheme,
        "theme",
        "not_available",
      ),
      encodings: { label: "theme", value: "count" },
      interaction: {
        labelKey: "theme",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin classified visible campaigns into practical retention themes from names and subject lines.",
      recommendation:
        "Use this mix to find over-reliance on sale language and underused education, product, proof, and lifecycle moments.",
      caveats: [
        "Theme classification is heuristic and should be reviewed by an operator before becoming strategy.",
      ],
    },
    {
      chartId: "klaviyo_l365_sale_non_sale",
      title: "Campaign Report: Sale vs Non-Sale Posture",
      family: "sale_non_sale_comparison",
      type: "comparison",
      data: countRecordRows(saleRows, "posture", "not_available"),
      encodings: { label: "posture", value: "count" },
      interaction: {
        labelKey: "posture",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin estimated whether visible campaigns lean promotional or non-promotional from campaign names and subject lines.",
      recommendation:
        "If sale posture dominates, add non-sale education, proof, routine, and product-use campaigns to protect list quality.",
      caveats: [
        "Sale/non-sale tagging is text-derived and does not inspect email bodies in this connector pass.",
      ],
    },
    {
      chartId: "klaviyo_l365_campaign_status",
      title: "Campaign Report: Status Breakdown",
      family: "klaviyo_inventory",
      type: "bar",
      data: countRecordRows(
        campaignPerformance?.byStatus,
        "status",
        "not_available",
      ),
      encodings: { label: "status", value: "count" },
      interaction: {
        labelKey: "status",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin counted visible campaign statuses so the audit can separate sent, draft, scheduled, and unavailable campaign posture.",
      recommendation:
        "Use status mix to verify the account has enough sent campaign history before judging cadence or creative strategy.",
      caveats: [
        "Campaign status is metadata, not engagement or revenue performance.",
      ],
    },
    {
      chartId: "klaviyo_l365_campaign_channel",
      title: "Campaign Report: Channel Breakdown",
      family: "klaviyo_inventory",
      type: "bar",
      data: countRecordRows(
        campaignPerformance?.byChannel,
        "channel",
        "not_available",
      ),
      encodings: { label: "channel", value: "count" },
      interaction: {
        labelKey: "channel",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin counted visible campaign channels to keep this audit focused on the email retention calendar first.",
      recommendation:
        "Run SMS separately if the account uses SMS heavily; this audit is optimized around Klaviyo email retention analysis.",
      caveats: [
        "Klaviyo campaign reads currently use the required email-channel filter.",
      ],
    },
    {
      chartId: "klaviyo_l365_flow_lifecycle_coverage",
      title: "Lifecycle Flow Backbone Map",
      family: "flow_stage_waterfall",
      type: "waterfall",
      data: lifecycleRows.length
        ? lifecycleRows
        : [{ lifecycleStage: "none_detected", status: "missing", coverage: 0 }],
      encodings: { label: "lifecycleStage", value: "coverage" },
      interaction: {
        labelKey: "lifecycleStage",
        primaryMetric: "coverage",
        metricKeys: ["coverage"],
        defaultSort: "none",
        selectable: true,
      },
      diagnosis: `${klaviyo?.flows.count ?? 0} flows are visible, with ${klaviyo?.flows.activeLikeCount ?? 0} active-like flows. Coverage is inferred from flow names and trigger metadata.`,
      recommendation:
        "Prioritize missing high-intent stages first: welcome, browse/cart/checkout, post-purchase, replenishment, winback, VIP, review, birthday, and sunset.",
      caveats: klaviyo?.lifecycleCoverage.caveats ?? [],
    },
    {
      chartId: "klaviyo_l365_flow_status",
      title: "Flow Report: Status and Trigger Inventory",
      family: "klaviyo_inventory",
      type: "bar",
      data: countRecordRows(
        flowPerformance?.byStatus,
        "status",
        "not_available",
      ),
      encodings: { label: "status", value: "count" },
      interaction: {
        labelKey: "status",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin mapped flow status to separate active lifecycle infrastructure from paused/draft/inactive flows.",
      recommendation:
        "Review paused or draft flows before adding net-new automation; some gaps may be hidden in inactive infrastructure.",
      caveats: [
        "No flow activation, edits, or message changes were attempted.",
      ],
    },
    {
      chartId: "klaviyo_l365_form_inventory",
      title: "Acquisition Report: Signup Forms and Popups",
      family: "klaviyo_form_inventory",
      type: "bar",
      data:
        Object.entries(forms?.byStatus ?? {}).length > 0
          ? Object.entries(forms?.byStatus ?? {}).map(([status, count]) => ({
              status,
              count,
            }))
          : [{ status: "none_returned", count: 0 }],
      encodings: { label: "status", value: "count" },
      interaction: {
        labelKey: "status",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis: forms?.count
        ? `${forms.count} signup form or popup resources were returned by Klaviyo.`
        : "No signup form or popup resources were returned by the safe Klaviyo read.",
      recommendation:
        "Audit the acquisition handoff: offer, consent, segmentation fields, welcome routing, quiz routing, and first-purchase follow-up.",
      caveats: [
        "Form conversion rate is not inferred without safe form analytics or event aggregates.",
      ],
    },
    {
      chartId: "klaviyo_l365_audience_inventory",
      title: "Audience Report: Lists and Segments Inventory",
      family: "klaviyo_audience_inventory",
      type: "bar",
      data: [
        { audienceType: "lists", count: klaviyo?.audiences.lists ?? 0 },
        { audienceType: "segments", count: klaviyo?.audiences.segments ?? 0 },
      ],
      encodings: { label: "audienceType", value: "count" },
      interaction: {
        labelKey: "audienceType",
        primaryMetric: "count",
        metricKeys: ["count"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin counted visible lists and segments to estimate whether audience infrastructure is available for future segment-response analysis.",
      recommendation:
        "Fetch segment definitions/profile counts next, but do not mutate segments in the audit workflow.",
      caveats: ["No Klaviyo segment mutation was attempted."],
    },
    {
      chartId: "klaviyo_l365_metric_readiness",
      title: "Performance Readiness: Important Metrics",
      family: "klaviyo_metric_readiness",
      type: "bar",
      data: metricRows.length ? metricRows : [{ metric: "none", readiness: 0 }],
      encodings: { label: "metric", value: "readiness" },
      interaction: {
        labelKey: "metric",
        primaryMetric: "readiness",
        metricKeys: ["readiness"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis: `Important metric readiness is ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}.`,
      recommendation:
        "Treat this as the gate for performance-grade scoring. Metric catalog visibility is not the same as campaign/flow aggregate performance.",
      caveats: [
        "Worklin did not run non-GET metric aggregate requests in this safety pass.",
      ],
    },
    {
      chartId: "klaviyo_l365_opportunity_priority",
      title: "The Priority Backlog Matrix",
      family: "opportunity_priority_matrix",
      type: "matrix",
      data: backlog.map((item) => ({
        opportunity: item.title,
        impact: item.impact,
        confidence: item.confidence,
        effort: item.effort,
      })),
      encodings: {
        label: "opportunity",
        x: "impact",
        y: "confidence",
        group: "effort",
      },
      interaction: {
        labelKey: "opportunity",
        primaryMetric: "impact",
        metricKeys: ["impact", "confidence"],
        defaultSort: "desc",
        selectable: true,
      },
      diagnosis:
        "Worklin ranked Klaviyo-only opportunities by impact, confidence, effort, and safety posture.",
      recommendation:
        "Use the top two backlog items as the next operator review queue before asking Worklin to draft any campaign package.",
      caveats: [
        "Backlog is artifact-only. Worklin did not create drafts, mutate segments, or change flows.",
      ],
    },
  ];
  const chartsById = (ids: string[]) =>
    charts.filter((chart) => ids.includes(chart.chartId));
  const modules = [
    {
      moduleId: "data_trust",
      title: "Data Trust and Klaviyo Scope",
      status: "complete",
      summary:
        "Confirms this is a Klaviyo-only L365 account audit and that Shopify is optional commerce enrichment, not a blocker.",
      charts: chartsById([
        "klaviyo_l365_data_readiness",
        "klaviyo_l365_metric_readiness",
      ]),
      insights: [
        `Source mode is klaviyo_l365.`,
        `Optional query caveats: ${klaviyo?.queryErrors?.length ?? 0}.`,
      ],
      recommendations: [
        "Add safe aggregate metric reads next if the account needs revenue/open/click scoring.",
      ],
    },
    {
      moduleId: "campaign_performance",
      title: "Campaign Cadence, Themes, and Word Bank",
      status: campaignPerformance?.count ? "complete" : "blocked",
      summary:
        "Builds the L365 campaign calendar, theme mix, sale posture, and subject-line language bank from Klaviyo campaign metadata.",
      charts: chartsById([
        "klaviyo_l365_campaign_cadence",
        "klaviyo_l365_campaign_status",
        "klaviyo_l365_campaign_channel",
        "klaviyo_l365_campaign_theme_mix",
        "klaviyo_l365_sale_non_sale",
        "klaviyo_l365_subject_word_bank",
      ]),
      insights: [
        `${campaignPerformance?.count ?? 0} campaigns available for L365 campaign analysis.`,
        `${campaignPerformance?.subjectWordBank.length ?? 0} subject/name words extracted.`,
      ],
      recommendations: [
        "Use cadence and theme mix to create the next campaign calendar before moving into draft creation.",
      ],
    },
    {
      moduleId: "lifecycle_flow",
      title: "Flow and Lifecycle Coverage",
      status: klaviyo?.flows.count ? "complete" : "blocked",
      summary:
        "Maps visible flow infrastructure and lifecycle coverage without activating or editing flows.",
      charts: chartsById([
        "klaviyo_l365_flow_lifecycle_coverage",
        "klaviyo_l365_flow_status",
      ]),
      insights: [
        `${klaviyo?.flows.count ?? 0} flows visible.`,
        `${klaviyo?.lifecycleCoverage.missing.length ?? 0} lifecycle stages missing or undetected.`,
      ],
      recommendations: [
        "Review missing lifecycle stages and inactive flows before creating net-new automation.",
      ],
    },
    {
      moduleId: "acquisition_tofu",
      title: "Signup Forms and Popup Capture",
      status: forms?.count ? "complete" : "blocked",
      summary:
        "Checks whether Klaviyo returned popup/signup form inventory for acquisition handoff analysis.",
      charts: chartsById(["klaviyo_l365_form_inventory"]),
      insights: [`${forms?.count ?? 0} forms/popups visible.`],
      recommendations: [
        "Connect form analytics or export form performance for conversion and offer testing.",
      ],
    },
    {
      moduleId: "audience_metric_readiness",
      title: "Audience, Lists, Segments, and Metrics",
      status:
        klaviyo?.metrics.importantMetrics.readiness === "performance_ready"
          ? "complete"
          : "blocked",
      summary:
        "Checks visible audiences and metric readiness before Worklin attempts segment-response or performance scoring.",
      charts: chartsById([
        "klaviyo_l365_audience_inventory",
        "klaviyo_l365_metric_readiness",
      ]),
      insights: [
        `${klaviyo?.audiences.lists ?? 0} lists visible.`,
        `${klaviyo?.audiences.segments ?? 0} segments visible.`,
        `Metric readiness: ${klaviyo?.metrics.importantMetrics.readiness ?? "not_available"}.`,
      ],
      recommendations: [
        "Fetch segment definitions, profile counts, and safe aggregate metrics before building segment-theme heatmaps.",
      ],
    },
    {
      moduleId: "opportunity_backlog",
      title: "Klaviyo Opportunity Backlog",
      status: "complete",
      summary:
        "Ranks Klaviyo-only next actions without Shopify, sends, schedules, segment mutation, profile mutation, or flow activation.",
      charts: chartsById(["klaviyo_l365_opportunity_priority"]),
      insights: backlog.map((item) => item.title),
      recommendations: backlog.slice(0, 3).map((item) => item.nextAction),
    },
  ];
  const safety = createRetentionSafetyMetadata(
    [
      "Klaviyo L365 account audit used only live read-only Klaviyo data.",
      "Shopify was not required for this Klaviyo-only audit and no fixture commerce data was used.",
      "No Klaviyo send, schedule, flow activation, profile mutation, segment mutation, or Shopify write was attempted.",
    ],
    "not_required",
  );
  const swarm = runKlaviyoL365AuditSwarm({
    generatedAt,
    windowLabel,
    dataset,
    modules,
    charts,
    backlog,
    safety,
  });
  const auditTrace = auditTraceFromSwarm(swarm, windowLabel);
  const title = "Klaviyo Retention Audit - Diagnostic Report";
  const contentMarkdown = markdownForKlaviyoL365Audit({
    title,
    brandName,
    generatedAt,
    windowLabel,
    dataset,
    charts,
    backlog,
    swarm,
    safety,
  });

  return {
    auditId: `klaviyo_l365_${generatedAt.replaceAll(/\W+/g, "_")}`,
    generatedAt,
    title,
    brandName,
    status: "complete",
    fullCommerceAudit: blockedFullAudit,
    modules,
    charts,
    swarm,
    auditTrace,
    backlog,
    artifact: {
      title,
      contentMarkdown,
      charts,
      generatedAt,
      exportReady: true,
    },
    safety,
    summary: {
      moduleCount: modules.length,
      chartCount: charts.length,
      recommendationCount: modules.reduce(
        (count, module) => count + module.recommendations.length,
        0,
      ),
      backlogCount: backlog.length,
      sourceMode: "klaviyo_l365",
      comparisonMode: "last_365_vs_previous_365",
      fullCommerceAuditBlocked: !blockedFullAudit.readiness.canRunFullAudit,
    },
  };
}

export function buildKlaviyoL365AuditForTest(
  input: Record<string, unknown>,
  dataset: RetentionDataset,
) {
  return buildKlaviyoL365Audit(
    input,
    dataset,
    blockedDeepAuditResult(input, dataset),
  );
}

function asJsonToolResult(value: unknown): ToolExecutionResult {
  return {
    content: JSON.stringify(value, null, 2),
    isError: false,
  };
}

function sendAuditProgressSurface(
  context: ToolContext,
  surfaceId: string,
  status: "in_progress" | "completed" | "blocked",
): void {
  const blocked = status === "blocked";
  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId,
    surfaceType: "card",
    display: "inline",
    title: "Deep Retention Audit",
    data: {
      title: "Deep Retention Audit",
      body: blocked
        ? "Worklin stopped before generating the audit because the connected sources are not sufficient for a real brand-specific deep audit. No fixture data was used as client data."
        : status === "in_progress"
          ? "Worklin is running the retention audit. Klaviyo-only L365 audits can run without Shopify; full commerce/product audits use Shopify as optional enrichment. This can take 15-45 minutes on real connected accounts. You can check back later; in this local test build, keep the Worklin tab open until the audit finishes."
          : "Worklin completed the deep retention audit and generated the visual artifact plus a PDF-ready document.",
      template: "task_progress",
      templateData: {
        title: "Deep Retention Audit",
        status,
        completed: status === "completed" ? 7 : blocked ? 2 : 1,
        total: 7,
        steps: [
          {
            id: "estimate",
            label: "Set expectations",
            status: "completed",
            detail:
              "Deep audits can take 15-45 minutes on real connected accounts. Keep this Worklin tab open during the local test run.",
          },
          {
            id: "sources",
            label: "Read Klaviyo and optional commerce posture",
            status: blocked
              ? "blocked"
              : status === "completed"
                ? "completed"
                : "in_progress",
            detail:
              "Use read-only source snapshots and never send, schedule, mutate segments/profiles, activate flows, or write Shopify data.",
          },
          {
            id: "swarm",
            label: "Run audit swarm",
            status: blocked
              ? "blocked"
              : status === "completed"
                ? "completed"
                : "waiting",
            detail:
              "Split the audit across section agents: data trust, cadence, creative, flows, forms, audience, opportunity, artifact, QA, and final editor.",
          },
          {
            id: "modules",
            label: "Merge section handoffs",
            status: blocked
              ? "blocked"
              : status === "completed"
                ? "completed"
                : "waiting",
            detail:
              "Combine agent findings, evidence, caveats, chart refs, and recommendations into one audit.",
          },
          {
            id: "charts",
            label: "Generate interactive chart artifact",
            status: status === "completed" ? "completed" : "waiting",
            detail:
              "Render cadence bars, product quadrants, word bank, heatmaps, waterfalls, trends, and priority matrix.",
          },
          {
            id: "document",
            label: "Create editable, PDF-ready audit document",
            status: status === "completed" ? "completed" : "waiting",
            detail:
              "Save a Worklin document with visual chart sections that can be edited and exported as PDF.",
          },
          {
            id: "safety",
            label: "Attach safety/provenance",
            status: status === "completed" ? "completed" : "waiting",
            detail:
              "Every result includes freshness, caveats, blocked capabilities, externalActionTaken:false, and canGoLiveNow:false.",
          },
        ],
      },
    },
  });
}

function showAuditBlockedSurface(
  result: ReturnType<typeof blockedDeepAuditResult>,
  context: ToolContext,
  progressSurfaceId: string,
): void {
  sendAuditProgressSurface(context, progressSurfaceId, "blocked");
  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `audit-blocked-${randomUUID()}`,
    surfaceType: "work_result",
    display: "inline",
    title: result.title,
    data: {
      eyebrow: "Worklin retention",
      status: "blocked",
      summary: result.reason,
      metrics: [
        {
          label: "Source mode",
          value: result.readiness.sourceMode,
          detail: "Full audits require live_readonly.",
          tone: "warning",
        },
        {
          label: "Blockers",
          value: result.readiness.blockers.length,
          detail: "Must be resolved before a real audit.",
          tone: "negative",
        },
        {
          label: "External action",
          value: "none",
          detail: "No writes, sends, schedules, or mutations.",
          tone: "positive",
        },
      ],
      sections: [
        {
          id: "blockers",
          title: "Why Worklin stopped",
          description:
            "These gaps prevent a real Dr. Rachael-style audit from being generated.",
          type: "warnings",
          items: result.readiness.blockers.map((blocker, index) => ({
            id: `blocker-${index + 1}`,
            title: blocker,
            description:
              "Worklin must resolve this source gap before creating product, revenue, segment, flow, or opportunity analysis for the client.",
            status: "blocked",
            tone: "negative",
          })),
        },
        {
          id: "available",
          title: "Available source data",
          description:
            result.readiness.availableSourceData.klaviyoInventory != null
              ? "A limited live Klaviyo inventory is available, but it is not enough for the full audit."
              : "No live retention source inventory is currently available.",
          type: "items",
          items: result.readiness.availableSourceData.connectors.map(
            (connector) => ({
              id: connector.id,
              title: connector.label,
              description: connector.caveats.join(" "),
              status: connector.status,
              tone:
                connector.status === "connected"
                  ? "positive"
                  : connector.status === "partial"
                    ? "warning"
                    : "negative",
              metadata: [
                {
                  label: "Read capabilities",
                  value: connector.readCapabilities.length,
                },
              ],
            }),
          ),
        },
        {
          id: "next",
          title: "Next steps",
          description:
            "Run the full audit only after these source coverage steps are complete.",
          type: "items",
          items: result.readiness.nextSteps.map((step, index) => ({
            id: `next-${index + 1}`,
            title: step,
            description: "",
            status: "needed",
            tone:
              index === result.readiness.nextSteps.length - 1
                ? "warning"
                : "neutral",
          })),
        },
        {
          id: "safety",
          title: "Safety boundary",
          description:
            "Worklin did not use fake client data and did not touch Shopify or Klaviyo externally.",
          type: "warnings",
          items: [
            {
              id: "external-action",
              title: "externalActionTaken:false",
              description: "No external action was taken.",
              status: "blocked",
              tone: "positive",
            },
            {
              id: "go-live",
              title: "canGoLiveNow:false",
              description: "This is not launch-ready and not a draft workflow.",
              status: "blocked",
              tone: "warning",
            },
          ],
        },
      ],
    },
  });
}

function showKlaviyoInventoryAuditSurfaces(
  audit: ReturnType<typeof buildKlaviyoInventoryAudit>,
  context: ToolContext,
  progressSurfaceId: string,
  documentSurfaceId?: string,
): void {
  sendAuditProgressSurface(context, progressSurfaceId, "completed");

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `klaviyo-inventory-audit-${audit.auditId}`,
    surfaceType: "retention_audit",
    display: "inline",
    title: audit.title,
    data: {
      title: audit.title,
      brandName: audit.brandName,
      generatedAt: audit.generatedAt,
      summary: audit.summary,
      charts: audit.charts,
      modules: audit.modules,
      backlog: audit.backlog,
      safety: audit.safety,
      documentSurfaceId,
      pdfReady: true,
    },
  });

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `klaviyo-inventory-result-${audit.auditId}`,
    surfaceType: "work_result",
    display: "inline",
    title: "Klaviyo Inventory Audit Ready",
    data: {
      eyebrow: "Worklin retention",
      status: "partial",
      summary:
        "Worklin generated a real Klaviyo inventory audit from the live read-only connection. The full Dr. Rachael-style product/revenue audit remains blocked until Shopify and deeper Klaviyo history are connected.",
      metrics: [
        {
          label: "Modules",
          value: audit.summary.moduleCount,
          detail: "Readiness and inventory sections",
          tone: "warning",
        },
        {
          label: "Charts",
          value: audit.summary.chartCount,
          detail: "Real inventory artifact specs",
          tone: "positive",
        },
        {
          label: "Full audit",
          value: "blocked",
          detail: "No fixture data used",
          tone: "warning",
        },
      ],
      sections: [
        {
          id: "document",
          title: "Audit Document",
          description:
            documentSurfaceId != null
              ? "Open the document preview, then use Export to download the Klaviyo inventory audit as a PDF."
              : "The Klaviyo inventory audit is export-ready; document creation did not return a surface id.",
          type: "artifacts",
          items: [
            {
              id: "klaviyo-inventory-document",
              title: `${audit.brandName} - ${audit.title}`,
              description:
                "Includes source readiness, live Klaviyo inventory, lifecycle coverage, audience/metric readiness, blockers, next data needed, and safety/provenance.",
              status: documentSurfaceId
                ? "PDF export available"
                : "export-ready",
              tone: "positive",
            },
          ],
        },
        {
          id: "full-audit-blockers",
          title: "Why the Full Audit Is Still Blocked",
          description:
            "These blockers prevent Worklin from producing product, revenue, segment-response, campaign-performance, or flow-performance claims.",
          type: "warnings",
          items: audit.blockedFullAudit.readiness.blockers.map(
            (blocker, index) => ({
              id: `blocker-${index + 1}`,
              title: blocker,
              description:
                "Resolve this before running the full Dr. Rachael-style audit.",
              status: "blocked",
              tone: "warning",
            }),
          ),
        },
      ],
    },
  });
}

function showKlaviyoL365AuditSurfaces(
  audit: ReturnType<typeof buildKlaviyoL365Audit>,
  context: ToolContext,
  progressSurfaceId: string,
  documentSurfaceId?: string,
): void {
  sendAuditProgressSurface(context, progressSurfaceId, "completed");

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `klaviyo-l365-audit-${audit.auditId}`,
    surfaceType: "retention_audit",
    display: "inline",
    title: audit.title,
    data: {
      title: audit.title,
      brandName: audit.brandName,
      generatedAt: audit.generatedAt,
      summary: audit.summary,
      charts: audit.charts,
      modules: audit.modules,
      swarm: audit.swarm,
      backlog: audit.backlog,
      safety: audit.safety,
      documentSurfaceId,
      pdfReady: true,
    },
  });

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `klaviyo-l365-result-${audit.auditId}`,
    surfaceType: "work_result",
    display: "inline",
    title: "Klaviyo L365 Account Audit Ready",
    data: {
      eyebrow: "Worklin retention",
      status: "completed",
      summary:
        "Worklin generated a Klaviyo-only L365 account audit from the live read-only connection. Shopify was not required; it remains optional commerce enrichment for product/order/LTV truth.",
      metrics: [
        {
          label: "Agents",
          value: audit.swarm.agentCount,
          detail: "Section swarm handoffs",
          tone: "positive",
        },
        {
          label: "Modules",
          value: audit.summary.moduleCount,
          detail: "Klaviyo account sections",
          tone: "positive",
        },
        {
          label: "Charts",
          value: audit.summary.chartCount,
          detail: "Clickable artifact specs",
          tone: "positive",
        },
        {
          label: "Shopify",
          value: "optional",
          detail: "Commerce enrichment, not a Klaviyo audit blocker",
          tone: "positive",
        },
      ],
      sections: [
        {
          id: "swarm",
          title: "Audit Swarm",
          description:
            "Each section agent produced findings, evidence, missing-data notes, chart references, recommendations, and a handoff for the final audit.",
          type: "items",
          items: audit.swarm.agents.map((agent) => ({
            id: agent.agentId,
            title: agent.title,
            description: agent.handoff,
            status: `${agent.status} / confidence ${agent.confidence}`,
            tone:
              agent.status === "complete"
                ? "positive"
                : agent.status === "partial"
                  ? "warning"
                  : "negative",
            metadata: [
              { label: "Charts", value: agent.chartIds.length },
              { label: "Evidence", value: agent.evidence.length },
              { label: "Missing data", value: agent.missingData.length },
            ],
          })),
        },
        {
          id: "document",
          title: "Audit Document",
          description:
            documentSurfaceId != null
              ? "Open the document preview, then use Export to download the Klaviyo L365 audit as a PDF."
              : "The Klaviyo L365 audit is export-ready; document creation did not return a surface id.",
          type: "artifacts",
          items: [
            {
              id: "klaviyo-l365-document",
              title: `${audit.brandName} - ${audit.title}`,
              description:
                "Includes campaign cadence, subject word bank, theme mix, flow coverage, forms/popups, metric readiness, backlog, caveats, and safety/provenance.",
              status: documentSurfaceId
                ? "PDF export available"
                : "export-ready",
              tone: "positive",
            },
          ],
        },
        {
          id: "backlog",
          title: "Top Klaviyo Opportunities",
          description:
            "Artifact-only next actions ranked without sending, scheduling, activating flows, or mutating audiences.",
          type: "items",
          items: audit.backlog.slice(0, 5).map((item, index) => ({
            id: item.backlogKey,
            title: `${index + 1}. ${item.title}`,
            description: item.nextAction,
            status: `impact ${item.impact} / confidence ${item.confidence}`,
            tone: item.impact >= 80 ? "positive" : "neutral",
          })),
        },
        {
          id: "commerce-enrichment",
          title: "What Shopify Adds Later",
          description:
            "Shopify is not required for this Klaviyo account audit. It becomes useful when you want product performance, order history, LTV, AOV, replenishment, and revenue reconciliation.",
          type: "warnings",
          items: [
            {
              id: "no-commerce-claims",
              title: "No commerce claims were invented",
              description:
                "This audit does not use fixture product, order, customer, revenue, or LTV data.",
              status: "safe",
              tone: "positive",
            },
          ],
        },
      ],
    },
  });

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `klaviyo-l365-reasoning-${audit.auditId}`,
    surfaceType: "card",
    display: "inline",
    title: "Audit Reasoning",
    data: {
      title: "Audit Swarm Reasoning",
      body: "Visible audit reasoning generated by Worklin.",
      template: "audit_reasoning",
      templateData: {
        title: "Audit Swarm Reasoning",
        status: "completed",
        swarm: audit.swarm,
        auditTrace: audit.auditTrace,
      },
    },
  });
}

interface CompactAuditResultInput {
  auditId: string;
  generatedAt: string;
  title: string;
  brandName: string;
  status?: string;
  summary?: Record<string, unknown>;
  modules?: Array<{
    title?: string;
    status?: string;
    summary?: string;
  }>;
  charts?: unknown[];
  backlog?: Array<{
    title?: string;
    impact?: number;
    confidence?: number;
    nextAction?: string;
  }>;
  swarm?: {
    agentCount?: number;
    finalSynthesis?: {
      headline?: string;
      strongestSignals?: string[];
      nextActions?: string[];
    };
  };
  safety?: {
    externalActionTaken?: boolean;
    canGoLiveNow?: boolean;
    blockedCapabilities?: string[];
    caveats?: string[];
    provenance?: string[];
  };
  fullCommerceAudit?: {
    readiness?: {
      canRunFullAudit?: boolean;
      blockers?: string[];
    };
  };
}

function compactAuditToolResult(
  audit: CompactAuditResultInput,
  documentSurfaceId: string | undefined,
  documentTitle: string,
): Record<string, unknown> {
  return {
    auditId: audit.auditId,
    title: audit.title,
    brandName: audit.brandName,
    generatedAt: audit.generatedAt,
    status: audit.status ?? "complete",
    summary: audit.summary,
    topSignals:
      audit.swarm?.finalSynthesis?.strongestSignals?.slice(0, 5) ?? [],
    nextActions:
      audit.swarm?.finalSynthesis?.nextActions?.slice(0, 5) ??
      audit.backlog
        ?.slice(0, 5)
        .map((item) => item.nextAction)
        .filter((action): action is string => Boolean(action)) ??
      [],
    topOpportunities:
      audit.backlog?.slice(0, 5).map((item) => ({
        title: item.title,
        impact: item.impact,
        confidence: item.confidence,
        nextAction: item.nextAction,
      })) ?? [],
    modulePreview:
      audit.modules?.slice(0, 6).map((module) => ({
        title: module.title,
        status: module.status,
        summary: module.summary,
      })) ?? [],
    chartCount: audit.charts?.length ?? 0,
    swarm: audit.swarm
      ? {
          agentCount: audit.swarm.agentCount,
          headline: audit.swarm.finalSynthesis?.headline,
        }
      : undefined,
    document: {
      surfaceId: documentSurfaceId,
      title: documentTitle,
      pdfExportAvailable: Boolean(documentSurfaceId),
      primaryAction:
        "Use the Worklin audit card to download the PDF or open the editable document.",
    },
    fullCommerceAudit: audit.fullCommerceAudit
      ? {
          canRunFullAudit:
            audit.fullCommerceAudit.readiness?.canRunFullAudit ?? false,
          blockers: audit.fullCommerceAudit.readiness?.blockers ?? [],
        }
      : undefined,
    safety: {
      externalActionTaken: audit.safety?.externalActionTaken ?? false,
      canGoLiveNow: audit.safety?.canGoLiveNow ?? false,
      blockedCapabilities: audit.safety?.blockedCapabilities ?? [],
      caveats: audit.safety?.caveats ?? [],
      provenance: audit.safety?.provenance ?? [],
    },
    responseGuidance:
      "Do not paste the full audit markdown into chat. Say the audit is ready, point the user to the Worklin audit card, and mention Download PDF / Open PDF / View full audit.",
  };
}

function workResultSections(audit: RetentionAuditRun) {
  return [
    {
      id: "modules",
      title: "Audit Modules",
      description:
        "The Dr. Rachael-style modules Worklin ran for this account.",
      type: "items",
      items: audit.modules.map((module) => ({
        id: module.moduleId,
        title: module.title,
        description: module.summary,
        status: module.status,
        tone:
          module.status === "complete"
            ? "positive"
            : module.status === "partial"
              ? "warning"
              : "negative",
        metadata: [
          { label: "Charts", value: module.charts.length },
          { label: "Insights", value: module.insights.length },
          { label: "Recommendations", value: module.recommendations.length },
        ],
      })),
    },
    {
      id: "backlog",
      title: "Prioritized Opportunity Backlog",
      description:
        "Artifact-only next actions ranked by impact, confidence, effort, and safety posture.",
      type: "items",
      items: audit.opportunityBacklog.map((item, index) => ({
        id: item.backlogKey,
        title: `${index + 1}. ${item.title}`,
        description: item.nextAction,
        status: `impact ${item.impact} / confidence ${item.confidence}`,
        tone: item.impact >= 80 ? "positive" : "neutral",
        metadata: [
          { label: "Type", value: item.type },
          { label: "Effort", value: item.effort },
          { label: "Live action", value: "blocked" },
        ],
      })),
    },
    {
      id: "safety",
      title: "Safety Boundary",
      description:
        "This audit is read-only and artifact-only. Worklin does not mutate Klaviyo or Shopify in v1.",
      type: "warnings",
      items: [
        {
          id: "external-action",
          title: "No external action taken",
          description: "externalActionTaken:false and canGoLiveNow:false",
          status: audit.safety.approvalStatus,
          tone: "positive",
        },
        {
          id: "blocked",
          title: "Blocked live capabilities",
          description: audit.safety.blockedCapabilities.join(", "),
          status: "blocked",
          tone: "warning",
        },
      ],
    },
  ];
}

function showAuditSurfaces(
  audit: RetentionAuditRun,
  context: ToolContext,
  progressSurfaceId: string,
  documentSurfaceId?: string,
): void {
  sendAuditProgressSurface(context, progressSurfaceId, "completed");

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `audit-artifact-${audit.auditId}`,
    surfaceType: "retention_audit",
    display: "inline",
    title: audit.title,
    data: {
      title: audit.title,
      brandName: audit.brandName,
      generatedAt: audit.generatedAt,
      window: audit.window,
      summary: audit.summary,
      charts: audit.artifact.charts,
      modules: audit.modules,
      backlog: audit.opportunityBacklog,
      safety: audit.safety,
      documentSurfaceId,
      pdfReady: true,
    },
  });

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `audit-result-${audit.auditId}`,
    surfaceType: "work_result",
    display: "inline",
    title: "Deep Retention Audit Ready",
    data: {
      eyebrow: "Worklin retention",
      status: "completed",
      summary:
        "The full audit artifact is ready, and the audit document can be opened and exported as PDF.",
      metrics: [
        {
          label: "Modules",
          value: audit.summary.moduleCount,
          detail: "Dr. Rachael-style audit sections",
          tone: "positive",
        },
        {
          label: "Charts",
          value: audit.summary.chartCount,
          detail: "Interactive artifact specs",
          tone: "positive",
        },
        {
          label: "Backlog",
          value: audit.summary.backlogCount,
          detail: "Prioritized next actions",
          tone: "positive",
        },
      ],
      sections: [
        {
          id: "download",
          title: "PDF Export",
          description:
            documentSurfaceId != null
              ? "Open the document preview, then use Export to download the audit as a PDF."
              : "The audit artifact is export-ready; document creation did not return a surface id.",
          type: "artifacts",
          items: [
            {
              id: "pdf-ready",
              title: documentSurfaceId
                ? "Deep Retention Audit document"
                : "PDF-ready artifact",
              description:
                "Includes the executive summary, reasoning trace, module sections, chart diagnoses, recommendations, backlog, and safety/provenance.",
              status: documentSurfaceId
                ? "PDF export available"
                : "export-ready",
              tone: "positive",
            },
          ],
        },
        ...workResultSections(audit),
      ],
    },
  });

  context.sendToClient?.({
    type: "ui_surface_show",
    conversationId: context.conversationId,
    surfaceId: `audit-reasoning-${audit.auditId}`,
    surfaceType: "card",
    display: "inline",
    title: "Audit Reasoning",
    data: {
      title: "Audit Reasoning",
      body: "Visible audit reasoning generated by Worklin.",
      template: "audit_reasoning",
      templateData: {
        title: "Audit Reasoning",
        status: "completed",
        auditTrace: audit.auditTrace,
      },
    },
  });
}

function retentionConnectionErrorToolResult(
  error: unknown,
): ToolExecutionResult {
  return {
    content: JSON.stringify(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load the requested Worklin retention connection.",
        safety: createRetentionSafetyMetadata([
          "No external action was taken.",
          "Klaviyo live-send, schedule, flow activation, segment mutation, and profile mutation remain blocked.",
        ]),
      },
      null,
      2,
    ),
    isError: true,
  };
}

function unsupportedExternalActionToolResult(
  action: string,
): ToolExecutionResult {
  return {
    content: JSON.stringify(
      {
        error: `${action} is intentionally unavailable until Worklin has an approved credential adapter and a passing retention QA result.`,
        safety: {
          readOnly: true,
          draftCreationAllowed: false,
          externalActionTaken: false,
          canGoLiveNow: false,
          approvalStatus: "blocked",
          blockedCapabilities: [
            "shopify_write",
            "klaviyo_send_campaign",
            "klaviyo_schedule_campaign",
            "klaviyo_activate_flow",
            "klaviyo_mutate_segment",
            "klaviyo_mutate_profile",
          ],
          caveats: [
            "Draft creation requires explicit user approval, Worklin-managed credentials, and passing QA.",
            "Send, schedule, flow activation, segment mutation, profile mutation, and Shopify writes are blocked.",
          ],
        },
      },
      null,
      2,
    ),
    isError: true,
  };
}

export async function executeRetentionSourceStatus(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    return asJsonToolResult(
      dataset ? getRetentionSourceStatus(dataset) : getRetentionSourceStatus(),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionBrandBrain(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    return asJsonToolResult(
      dataset
        ? getRetentionBrandBrain(dataset, retentionOptions(input))
        : getRetentionBrandBrain(undefined, retentionOptions(input)),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionShopifySnapshot(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(getRetentionShopifySnapshot(retentionOptions(input)));
}

export async function executeRetentionKlaviyoSnapshot(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    return asJsonToolResult(
      getRetentionKlaviyoSnapshot(retentionOptions(input), dataset),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionUnifiedCustomerView(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(buildUnifiedCustomerView(retentionOptions(input)));
}

export async function executeRetentionComputeCustomerFeatures(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(
    computeRetentionCustomerFeatures(retentionOptions(input)),
  );
}

export async function executeRetentionScoreCustomers(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(scoreRetentionCustomers(retentionOptions(input)));
}

export async function executeRetentionBuildMicroSegments(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(buildRetentionMicroSegments(retentionOptions(input)));
}

export async function executeRetentionFindMissingPieces(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(findRetentionMissingPieces(retentionOptions(input)));
}

export async function executeRetentionFindCampaignOpportunities(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(
    findRetentionCampaignOpportunities(retentionOptions(input)),
  );
}

export async function executeRetentionGenerateCampaignPackage(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(
    generateRetentionCampaignPackage(retentionOptions(input)),
  );
}

export async function executeRetentionGenerateMicroCampaignPackage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionGenerateCampaignPackage(input, context);
}

export async function executeRetentionRunQa(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(runRetentionQa(retentionOptions(input)));
}

export async function executeRetentionRunRetentionQa(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionRunQa(input, context);
}

export async function executeRetentionCreateKlaviyoDraft(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return unsupportedExternalActionToolResult("Klaviyo draft creation");
}

export async function executeRetentionContextPack(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    return asJsonToolResult(
      buildRetentionContextPack(retentionOptions(input), dataset),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionDeepAudit(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const progressSurfaceId = `audit-progress-${randomUUID()}`;
  sendAuditProgressSurface(context, progressSurfaceId, "in_progress");

  try {
    const dataset = await retentionDatasetForInput(input);
    const readiness = deepAuditReadiness(input, dataset);
    if (!readiness.canRunFullAudit) {
      const result = blockedDeepAuditResult(input, dataset);
      if (dataset?.klaviyoSnapshot?.depth === "l365") {
        const klaviyoAudit = await upgradeKlaviyoL365AuditWithLiveSwarm(
          buildKlaviyoL365Audit(input, dataset, result),
          input,
          dataset,
          context,
        );
        let documentSurfaceId: string | undefined;
        if (context.sendToClient) {
          const documentResult = executeDocumentCreate(
            {
              title: `${klaviyoAudit.brandName} - ${klaviyoAudit.title}`,
              initial_content: klaviyoAudit.artifact.contentMarkdown,
            },
            context,
          );
          try {
            const parsed = JSON.parse(documentResult.content) as {
              surface_id?: unknown;
            };
            if (typeof parsed.surface_id === "string") {
              documentSurfaceId = parsed.surface_id;
            }
          } catch {
            documentSurfaceId = undefined;
          }
        }
        showKlaviyoL365AuditSurfaces(
          klaviyoAudit,
          context,
          progressSurfaceId,
          documentSurfaceId,
        );
        return asJsonToolResult(
          compactAuditToolResult(
            klaviyoAudit,
            documentSurfaceId,
            `${klaviyoAudit.brandName} - ${klaviyoAudit.title}`,
          ),
        );
      }
      if (dataset?.klaviyoSnapshot) {
        const inventoryAudit = buildKlaviyoInventoryAudit(
          input,
          dataset,
          result,
        );
        let documentSurfaceId: string | undefined;
        if (context.sendToClient) {
          const documentResult = executeDocumentCreate(
            {
              title: `${inventoryAudit.brandName} - ${inventoryAudit.title}`,
              initial_content: inventoryAudit.artifact.contentMarkdown,
            },
            context,
          );
          try {
            const parsed = JSON.parse(documentResult.content) as {
              surface_id?: unknown;
            };
            if (typeof parsed.surface_id === "string") {
              documentSurfaceId = parsed.surface_id;
            }
          } catch {
            documentSurfaceId = undefined;
          }
        }
        showKlaviyoInventoryAuditSurfaces(
          inventoryAudit,
          context,
          progressSurfaceId,
          documentSurfaceId,
        );
        return asJsonToolResult(
          compactAuditToolResult(
            inventoryAudit,
            documentSurfaceId,
            `${inventoryAudit.brandName} - ${inventoryAudit.title}`,
          ),
        );
      }

      showAuditBlockedSurface(result, context, progressSurfaceId);
      return asJsonToolResult(result);
    }

    const audit = buildDeepRetentionAudit(retentionOptions(input), dataset);
    let documentSurfaceId: string | undefined;
    if (context.sendToClient) {
      const documentResult = executeDocumentCreate(
        {
          title: `${audit.brandName} - ${audit.title}`,
          initial_content: audit.artifact.contentMarkdown,
        },
        context,
      );
      try {
        const parsed = JSON.parse(documentResult.content) as {
          surface_id?: unknown;
        };
        if (typeof parsed.surface_id === "string") {
          documentSurfaceId = parsed.surface_id;
        }
      } catch {
        documentSurfaceId = undefined;
      }
    }

    showAuditSurfaces(audit, context, progressSurfaceId, documentSurfaceId);
    return asJsonToolResult(
      compactAuditToolResult(
        audit,
        documentSurfaceId,
        `${audit.brandName} - ${audit.title}`,
      ),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionAuditStatus(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    const readiness = deepAuditReadiness(input, dataset);
    const status = dataset
      ? getRetentionAuditStatus(dataset)
      : getRetentionAuditStatus();
    return asJsonToolResult(
      readiness.canRunFullAudit
        ? { ...status, canRunFullAudit: true, readiness }
        : dataset?.klaviyoSnapshot?.depth === "l365"
          ? {
              ...status,
              status: "partial",
              canRunFullAudit: false,
              canRunKlaviyoL365Audit: true,
              readiness,
              nextBestAudit:
                "Run retention_deep_audit to generate a Klaviyo-only L365 account audit. Shopify is optional commerce enrichment, not a blocker for this Klaviyo audit.",
            }
          : {
              ...status,
              status: "blocked",
              canRunFullAudit: false,
              readiness,
            },
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionScheduleAudit(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return asJsonToolResult(scheduleRetentionAudit());
}

export async function executeRetentionGenerateAuditArtifact(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const dataset = await retentionDatasetForInput(input);
    const readiness = deepAuditReadiness(input, dataset);
    if (!readiness.canRunFullAudit) {
      if (dataset?.klaviyoSnapshot?.depth === "l365") {
        return asJsonToolResult(
          buildKlaviyoL365Audit(
            input,
            dataset,
            blockedDeepAuditResult(input, dataset),
          ).artifact,
        );
      }
      return asJsonToolResult(blockedDeepAuditResult(input, dataset));
    }

    return asJsonToolResult(
      generateRetentionAuditArtifact(retentionOptions(input), dataset),
    );
  } catch (error) {
    return retentionConnectionErrorToolResult(error);
  }
}

export async function executeRetentionAudit(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionDeepAudit(input, _context);
}

export async function executeRetentionConnectKlaviyo(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionConnectKlaviyoConnection(input, context);
}

export async function executeRetentionListKlaviyoAccounts(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionListKlaviyoConnections();
}

export const retentionAuditTool = {
  name: "retention_audit",
  description:
    "Compatibility alias for Worklin's deep Shopify + Klaviyo retention audit. Real Klaviyo L365 audits run through Worklin's section-agent audit swarm, then merge data-trust, campaign, creative, flow, forms, audience, opportunity, artifact, QA, and final-editor handoffs into one artifact. It refuses to generate a real-client full commerce audit unless live source coverage is sufficient; fixture data is allowed only when allow_fixture_data:true is explicitly set for demos. Returns visual artifact chart specs, modules, swarm, visible auditTrace reasoning, opportunity backlog, freshness caveats, blocked capabilities, externalActionTaken:false, and canGoLiveNow:false.",
  category: "retention",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      timeframe_days: {
        type: "number",
        description: "Retention lookback window in days. Defaults to 365.",
      },
      limit: {
        type: "number",
        description: "Maximum customers to evaluate. Defaults to 200.",
      },
      klaviyo_account: {
        type: "string",
        description: "Optional saved Klaviyo account label to use.",
      },
      klaviyo_connection_id: {
        type: "string",
        description: "Optional saved Klaviyo credential ID to use.",
      },
      brand_name: {
        type: "string",
        description: "Optional brand name to apply to the audit.",
      },
      website_url: {
        type: "string",
        description:
          "Optional brand website URL to include in audit context and provenance.",
      },
      allow_fixture_data: {
        type: "boolean",
        description:
          "Internal demo/testing only. When true, Worklin may use fixture/sample data; never set this for a real client audit.",
      },
      demo_mode: {
        type: "boolean",
        description:
          "Alias for allow_fixture_data for explicit internal demo audits only.",
      },
    },
    required: [],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeRetentionAudit(input, context);
  },
} satisfies ToolDefinition;
