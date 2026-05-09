import type { SourceConnector } from "@/lib/sources/connectors";
import {
  listSourceConnectors,
  sourceStatusForArtifactSource,
  summarizeConnectorForContext,
} from "@/lib/sources/connectors";
import {
  getKlaviyoCampaignConfig,
  KlaviyoCampaignApiError,
  listKlaviyoCampaigns,
  type KlaviyoCampaign,
} from "@/lib/klaviyo-campaigns";
import {
  getKlaviyoFlowConfig,
  KlaviyoFlowApiError,
  listKlaviyoFlows,
  type KlaviyoFlow,
} from "@/lib/klaviyo-flows";
import {
  getKlaviyoAudienceConfig,
  KlaviyoAudienceApiError,
  listKlaviyoAudiences,
  type KlaviyoAudience,
} from "@/lib/klaviyo-audiences";
import {
  getKlaviyoMetricConfig,
  KlaviyoMetricApiError,
  listKlaviyoMetrics,
  type KlaviyoMetric,
} from "@/lib/klaviyo-metrics";
import { prisma } from "@/lib/prisma";

export const KLAVIYO_SOURCE_SNAPSHOT_DEPTHS = ["compact", "standard", "full"] as const;

export type KlaviyoSourceSnapshotDepth = (typeof KLAVIYO_SOURCE_SNAPSHOT_DEPTHS)[number];

export type KlaviyoSourceSnapshotInput = {
  depth?: KlaviyoSourceSnapshotDepth | null;
};

type ParsedKlaviyoSourceSnapshotInput =
  | { ok: true; data: { depth: KlaviyoSourceSnapshotDepth } }
  | { ok: false; issues: string[] };

type SnapshotSectionStatus = "available" | "partial" | "not_configured" | "unavailable" | "local_only";

const DEPTH_LIMITS = {
  compact: {
    campaigns: 8,
    flows: 8,
    audiences: 8,
    metrics: 12,
    drafts: 8,
    sample: 3,
  },
  standard: {
    campaigns: 16,
    flows: 16,
    audiences: 16,
    metrics: 28,
    drafts: 16,
    sample: 5,
  },
  full: {
    campaigns: 30,
    flows: 30,
    audiences: 30,
    metrics: 60,
    drafts: 30,
    sample: 8,
  },
} as const;

function normalizeDepth(value: unknown): KlaviyoSourceSnapshotDepth | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return KLAVIYO_SOURCE_SNAPSHOT_DEPTHS.includes(normalized as KlaviyoSourceSnapshotDepth)
    ? (normalized as KlaviyoSourceSnapshotDepth)
    : null;
}

export function parseKlaviyoSourceSnapshotInput(input: KlaviyoSourceSnapshotInput = {}): ParsedKlaviyoSourceSnapshotInput {
  const issues: string[] = [];
  const depth = input.depth == null ? "compact" : normalizeDepth(input.depth);

  if (!depth) {
    issues.push("depth must be one of compact, standard, or full.");
  }

  return issues.length ? { ok: false, issues } : { ok: true, data: { depth: depth ?? "compact" } };
}

function compactText(value: string | null | undefined, max = 160) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function cleanCaveats(caveats: Array<string | null | undefined>) {
  return Array.from(new Set(caveats.filter((item): item is string => Boolean(item?.trim()))))
    .map((item) => compactText(item, 220))
    .filter((item): item is string => Boolean(item));
}

function countBy(values: Array<string | null | undefined>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value?.trim() || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function topKeys(counts: Record<string, number>, limit: number) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function sectionNotConfigured(caveat: string) {
  return {
    status: "not_configured" as SnapshotSectionStatus,
    count: 0,
    caveats: [caveat],
  };
}

function sectionUnavailable(caveat: string) {
  return {
    status: "unavailable" as SnapshotSectionStatus,
    count: 0,
    caveats: [caveat],
  };
}

function apiReadCaveat(error: unknown, fallback: string) {
  if (
    error instanceof KlaviyoCampaignApiError ||
    error instanceof KlaviyoFlowApiError ||
    error instanceof KlaviyoAudienceApiError ||
    error instanceof KlaviyoMetricApiError
  ) {
    return `${fallback} Provider returned status ${error.status}; snapshot kept this section unavailable.`;
  }

  return fallback;
}

function compactCampaign(campaign: KlaviyoCampaign) {
  return {
    id: campaign.id,
    name: compactText(campaign.name, 120),
    status: campaign.status,
    channel: campaign.channel,
    subject: compactText(campaign.subject, 120),
    sendTime: campaign.sendTime,
    scheduledAt: campaign.scheduledAt,
    created: campaign.created,
    updated: campaign.updated,
    draft: campaign.draft,
    audienceRefs: {
      lists: campaign.listIds.length,
      segments: campaign.segmentIds.length,
      tags: campaign.tagIds.length,
    },
  };
}

function compactFlow(flow: KlaviyoFlow) {
  return {
    id: flow.id,
    name: compactText(flow.name, 120),
    status: flow.status,
    triggerType: compactText(flow.triggerType, 80),
    actionCount: flow.actionCount,
    archived: flow.archived,
    created: flow.created,
    updated: flow.updated,
  };
}

function compactAudience(audience: KlaviyoAudience) {
  return {
    id: audience.id,
    name: compactText(audience.name, 120),
    type: audience.type,
    created: audience.created,
    updated: audience.updated,
    profileCount: audience.profileCount,
    memberCount: audience.memberCount,
    archived: audience.archived,
    definitionAvailable: audience.metadata.definitionAvailable,
  };
}

function compactMetric(metric: KlaviyoMetric) {
  return {
    id: metric.id,
    name: compactText(metric.name, 120),
    integration: compactText(metric.integration, 80),
    source: compactText(metric.source, 80),
    created: metric.created,
    updated: metric.updated,
  };
}

function lowerJoin(values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function lifecycleCoverage(input: {
  campaigns: KlaviyoCampaign[];
  flows: KlaviyoFlow[];
  audiences: KlaviyoAudience[];
}) {
  const flowText = lowerJoin(input.flows.map((flow) => `${flow.name} ${flow.triggerType ?? ""}`));
  const audienceText = lowerJoin(input.audiences.map((audience) => audience.name));
  const campaignText = lowerJoin(input.campaigns.map((campaign) => `${campaign.name} ${campaign.subject ?? ""}`));
  const combined = `${flowText} ${audienceText} ${campaignText}`;
  const checks = [
    { id: "welcome", label: "Welcome/new subscriber", terms: ["welcome", "new subscriber", "newsletter"] },
    { id: "abandoned_checkout", label: "Abandoned checkout", terms: ["abandoned checkout", "checkout abandonment", "started checkout"] },
    { id: "browse_abandonment", label: "Browse abandonment", terms: ["browse", "viewed product"] },
    { id: "post_purchase", label: "Post-purchase", terms: ["post purchase", "post-purchase", "thank you", "replenishment"] },
    { id: "winback", label: "Winback/reactivation", terms: ["winback", "reactivation", "lapsed"] },
    { id: "sunset", label: "Sunset/suppression", terms: ["sunset", "suppression", "unengaged"] },
  ];

  const present = checks
    .filter((check) => check.terms.some((term) => combined.includes(term)))
    .map((check) => ({ id: check.id, label: check.label }));
  const missing = checks
    .filter((check) => !check.terms.some((term) => combined.includes(term)))
    .map((check) => ({ id: check.id, label: check.label }));

  return {
    status: input.flows.length || input.audiences.length || input.campaigns.length ? "derived_from_snapshot" : "insufficient_source_data",
    present,
    missing,
    caveats: [
      "Lifecycle coverage is inferred from compact names, trigger labels, and audience titles only.",
      "Coverage is a readiness signal, not proof that automations are complete or healthy.",
    ],
  };
}

function importantMetricSignals(metrics: KlaviyoMetric[]) {
  const metricText = lowerJoin(metrics.map((metric) => metric.name));
  const checks = [
    { id: "placed_order", label: "Placed Order", terms: ["placed order", "ordered product"] },
    { id: "started_checkout", label: "Started Checkout", terms: ["started checkout", "checkout"] },
    { id: "received_email", label: "Received Email", terms: ["received email"] },
    { id: "opened_email", label: "Opened Email", terms: ["opened email", "open email"] },
    { id: "clicked_email", label: "Clicked Email", terms: ["clicked email", "click email"] },
    { id: "unsubscribe", label: "Unsubscribe", terms: ["unsubscribe", "unsubscribed"] },
    { id: "spam_complaint", label: "Spam complaint", terms: ["spam", "complaint"] },
  ];

  const found = checks.filter((check) => check.terms.some((term) => metricText.includes(term)));
  const missing = checks.filter((check) => !check.terms.some((term) => metricText.includes(term)));

  return {
    found: found.map((check) => check.id),
    missing: missing.map((check) => check.id),
    readiness: found.some((check) => check.id === "placed_order") && found.some((check) => check.id === "clicked_email")
      ? "performance_ready"
      : metrics.length
        ? "partial"
        : "not_available",
  };
}

async function readCampaignSection(limits: (typeof DEPTH_LIMITS)[KlaviyoSourceSnapshotDepth]) {
  const config = getKlaviyoCampaignConfig();
  if (!config.ok) {
    return {
      ...sectionNotConfigured("Campaign snapshot needs Klaviyo read configuration before live read checks can run."),
      byStatus: {},
      byChannel: {},
      recent: [],
      campaigns: [] as KlaviyoCampaign[],
    };
  }

  try {
    const result = await listKlaviyoCampaigns(config.config, {
      limit: limits.campaigns,
      includeDrafts: true,
      includeMessages: false,
    });
    const caveats = cleanCaveats(result.caveats);
    return {
      status: caveats.length ? "partial" as SnapshotSectionStatus : "available" as SnapshotSectionStatus,
      count: result.count,
      byStatus: countBy(result.campaigns.map((campaign) => campaign.status)),
      byChannel: countBy(result.campaigns.map((campaign) => campaign.channel)),
      recent: result.campaigns.slice(0, limits.sample).map(compactCampaign),
      caveats,
      campaigns: result.campaigns,
    };
  } catch (error) {
    console.warn("Klaviyo campaign snapshot read failed", error);
    return {
      ...sectionUnavailable(apiReadCaveat(error, "Campaign snapshot read failed.")),
      byStatus: {},
      byChannel: {},
      recent: [],
      campaigns: [] as KlaviyoCampaign[],
    };
  }
}

async function readFlowSection(limits: (typeof DEPTH_LIMITS)[KlaviyoSourceSnapshotDepth]) {
  const config = getKlaviyoFlowConfig();
  if (!config.ok) {
    return {
      ...sectionNotConfigured("Flow snapshot needs Klaviyo read configuration before live read checks can run."),
      byStatus: {},
      triggerTypes: [],
      activeLikeCount: 0,
      recent: [],
      flows: [] as KlaviyoFlow[],
    };
  }

  try {
    const flows = (await listKlaviyoFlows(config.config)).slice(0, limits.flows);
    const triggerCounts = countBy(flows.map((flow) => flow.triggerType));
    return {
      status: "available" as SnapshotSectionStatus,
      count: flows.length,
      byStatus: countBy(flows.map((flow) => flow.status)),
      triggerTypes: topKeys(triggerCounts, limits.sample),
      activeLikeCount: flows.filter((flow) => {
        const status = flow.status?.toLowerCase() ?? "";
        return status.includes("live") || status.includes("active");
      }).length,
      recent: flows.slice(0, limits.sample).map(compactFlow),
      caveats: [] as string[],
      flows,
    };
  } catch (error) {
    console.warn("Klaviyo flow snapshot read failed", error);
    return {
      ...sectionUnavailable(apiReadCaveat(error, "Flow snapshot read failed.")),
      byStatus: {},
      triggerTypes: [],
      activeLikeCount: 0,
      recent: [],
      flows: [] as KlaviyoFlow[],
    };
  }
}

async function readAudienceSection(limits: (typeof DEPTH_LIMITS)[KlaviyoSourceSnapshotDepth]) {
  const config = getKlaviyoAudienceConfig();
  if (!config.ok) {
    return {
      ...sectionNotConfigured("Audience snapshot needs Klaviyo read configuration before live read checks can run."),
      lists: { count: 0, top: [] },
      segments: { count: 0, top: [] },
      audiences: [] as KlaviyoAudience[],
    };
  }

  try {
    const result = await listKlaviyoAudiences(config.config, { limit: limits.audiences });
    const caveats = cleanCaveats(result.caveats);
    return {
      status: caveats.length ? "partial" as SnapshotSectionStatus : "available" as SnapshotSectionStatus,
      count: result.count,
      lists: {
        count: result.lists.length,
        top: result.lists.slice(0, limits.sample).map(compactAudience),
      },
      segments: {
        count: result.segments.length,
        top: result.segments.slice(0, limits.sample).map(compactAudience),
      },
      caveats,
      audiences: result.audiences,
    };
  } catch (error) {
    console.warn("Klaviyo audience snapshot read failed", error);
    return {
      ...sectionUnavailable(apiReadCaveat(error, "Audience snapshot read failed.")),
      lists: { count: 0, top: [] },
      segments: { count: 0, top: [] },
      audiences: [] as KlaviyoAudience[],
    };
  }
}

async function readMetricSection(limits: (typeof DEPTH_LIMITS)[KlaviyoSourceSnapshotDepth]) {
  const config = getKlaviyoMetricConfig();
  if (!config.ok) {
    return {
      ...sectionNotConfigured("Metric snapshot needs Klaviyo read configuration before live read checks can run."),
      integrations: [],
      importantMetrics: { found: [], missing: [], readiness: "not_available" },
      top: [],
      metrics: [] as KlaviyoMetric[],
    };
  }

  try {
    const result = await listKlaviyoMetrics(config.config, { limit: limits.metrics });
    const caveats = cleanCaveats(result.caveats);
    const integrationCounts = countBy(result.metrics.map((metric) => metric.integration ?? metric.source));
    return {
      status: caveats.length ? "partial" as SnapshotSectionStatus : "available" as SnapshotSectionStatus,
      count: result.count,
      integrations: topKeys(integrationCounts, limits.sample),
      importantMetrics: importantMetricSignals(result.metrics),
      top: result.metrics.slice(0, limits.sample).map(compactMetric),
      caveats,
      metrics: result.metrics,
    };
  } catch (error) {
    console.warn("Klaviyo metric snapshot read failed", error);
    return {
      ...sectionUnavailable(apiReadCaveat(error, "Metric snapshot read failed.")),
      integrations: [],
      importantMetrics: { found: [], missing: [], readiness: "not_available" },
      top: [],
      metrics: [] as KlaviyoMetric[],
    };
  }
}

async function readDraftSection(limits: (typeof DEPTH_LIMITS)[KlaviyoSourceSnapshotDepth]) {
  const [count, drafts] = await Promise.all([
    prisma.klaviyoDraft.count(),
    prisma.klaviyoDraft.findMany({
      orderBy: { createdAt: "desc" },
      take: limits.drafts,
      select: {
        id: true,
        briefId: true,
        klaviyoCampaignId: true,
        klaviyoTemplateId: true,
        klaviyoMessageId: true,
        campaignName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    status: "local_only" as SnapshotSectionStatus,
    count,
    byStatus: countBy(drafts.map((draft) => draft.status)),
    recent: drafts.slice(0, limits.sample).map((draft) => ({
      id: draft.id,
      briefId: draft.briefId,
      klaviyoCampaignId: draft.klaviyoCampaignId,
      klaviyoTemplateId: draft.klaviyoTemplateId,
      klaviyoMessageId: draft.klaviyoMessageId,
      campaignName: compactText(draft.campaignName, 140),
      status: draft.status,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    })),
    caveats: ["Draft summary is read from local Worklin draft records only; no draft is created by this snapshot."],
  };
}

function snapshotSourceStatuses(input: {
  connectors: SourceConnector[];
  generatedAt: string;
  liveReadAttempted: boolean;
  liveReadStatus: "not_checked" | "partial" | "complete";
  verifiedSections: string[];
  caveatedSections: string[];
}) {
  const statuses = [
    sourceStatusForArtifactSource("klaviyo_snapshot", input.connectors, true),
    sourceStatusForArtifactSource("uploaded_csv", input.connectors, false),
    sourceStatusForArtifactSource("google_sheet", input.connectors, false),
  ];

  return statuses.map((status) => {
    if (status.source !== "klaviyo_snapshot") return status;
    return {
      ...status,
      snapshotRoute: "GET /api/sources/klaviyo/snapshot",
      snapshotAvailability: input.liveReadStatus === "complete"
        ? "snapshot_live_read_complete"
        : input.liveReadStatus === "partial"
          ? "snapshot_partial_live_read"
          : input.liveReadAttempted
            ? "snapshot_live_read_attempted_with_caveats"
            : "snapshot_not_checked",
      snapshotReadStatus: input.liveReadStatus,
      verifiedSections: input.verifiedSections,
      caveatedSections: input.caveatedSections,
      lastSnapshotReadAt: input.liveReadStatus === "not_checked" ? null : input.generatedAt,
      verificationStatus: status.verificationStatus,
      verificationMethod: status.verificationMethod,
      lastVerifiedAt: status.lastVerifiedAt,
      detail: input.liveReadStatus === "complete"
        ? "Klaviyo snapshot completed read-only checks for all requested live-read sections."
        : input.liveReadStatus === "partial"
          ? "Klaviyo snapshot completed some read-only checks, with caveats on other sections."
        : input.liveReadAttempted
            ? "Klaviyo snapshot attempted read-only checks but could not verify requested live-read sections."
            : status.detail,
    };
  });
}

export async function buildKlaviyoSourceSnapshot(input: KlaviyoSourceSnapshotInput = {}) {
  const parsed = parseKlaviyoSourceSnapshotInput(input);
  if (!parsed.ok) return parsed;

  const generatedAt = new Date().toISOString();
  const depth = parsed.data.depth;
  const limits = DEPTH_LIMITS[depth];
  const connectors = await listSourceConnectors();
  const klaviyoConnector = connectors.find((connector) => connector.id === "klaviyo") ?? null;

  const [campaigns, flows, audiences, metrics, drafts] = await Promise.all([
    readCampaignSection(limits),
    readFlowSection(limits),
    readAudienceSection(limits),
    readMetricSection(limits),
    readDraftSection(limits),
  ]);

  const liveSections = [
    { key: "campaigns", section: campaigns },
    { key: "flows", section: flows },
    { key: "audiences", section: audiences },
    { key: "metrics", section: metrics },
  ];
  const liveReadAttempted = liveSections.some(({ section }) => section.status !== "not_configured");
  const verifiedSections = liveSections
    .filter(({ section }) => section.status === "available" && section.caveats.length === 0)
    .map(({ key }) => key);
  const readableSections = liveSections
    .filter(({ section }) => section.status === "available" || section.status === "partial")
    .map(({ key }) => key);
  const caveatedSections = liveSections
    .filter(({ section }) => section.status !== "available" || section.caveats.length > 0)
    .map(({ key }) => key);
  const liveReadStatus = verifiedSections.length === liveSections.length
    ? "complete"
    : readableSections.length > 0
      ? "partial"
      : "not_checked";
  const allCaveats = cleanCaveats([
    ...(klaviyoConnector?.caveats ?? []),
    ...campaigns.caveats,
    ...flows.caveats,
    ...audiences.caveats,
    ...metrics.caveats,
    ...drafts.caveats,
    "Snapshot is read-only and normalized for skills/workflows; it omits full source payloads and raw workflow data.",
  ]);

  const response = {
    ok: true as const,
    platform: "klaviyo",
    generatedAt,
    depth,
    snapshot: {
      connector: klaviyoConnector ? summarizeConnectorForContext(klaviyoConnector) : null,
      campaigns: {
        status: campaigns.status,
        count: campaigns.count,
        byStatus: campaigns.byStatus,
        byChannel: campaigns.byChannel,
        recent: campaigns.recent,
        caveats: campaigns.caveats,
      },
      flows: {
        status: flows.status,
        count: flows.count,
        byStatus: flows.byStatus,
        triggerTypes: flows.triggerTypes,
        activeLikeCount: flows.activeLikeCount,
        recent: flows.recent,
        caveats: flows.caveats,
      },
      audiences: {
        status: audiences.status,
        count: audiences.count,
        lists: audiences.lists,
        segments: audiences.segments,
        caveats: audiences.caveats,
      },
      metrics: {
        status: metrics.status,
        count: metrics.count,
        integrations: metrics.integrations,
        importantMetrics: metrics.importantMetrics,
        top: metrics.top,
        caveats: metrics.caveats,
      },
      drafts: {
        status: drafts.status,
        count: drafts.count,
        byStatus: drafts.byStatus,
        recent: drafts.recent,
        caveats: drafts.caveats,
      },
      lifecycleCoverage: lifecycleCoverage({
        campaigns: campaigns.campaigns,
        flows: flows.flows,
        audiences: audiences.audiences,
      }),
      safetyPosture: {
        readOnly: true,
        externalActionTaken: false,
        canGoLiveNow: false,
        writesAllowed: false,
        draftCreationAttempted: false,
        sendOrScheduleAllowed: false,
        flowOrSegmentCreationAllowed: false,
        profileSyncAllowed: false,
        liveExternalActionsBlocked: true,
      },
    },
    sourceStatuses: snapshotSourceStatuses({
      connectors,
      generatedAt,
      liveReadAttempted,
      liveReadStatus,
      verifiedSections,
      caveatedSections,
    }),
    caveats: allCaveats,
    metadata: {
      route: "GET /api/sources/klaviyo/snapshot",
      depth,
      effectiveLimits: limits,
      sizeBytes: 0,
      helpersUsed: [
        "listSourceConnectors",
        "listKlaviyoCampaigns",
        "listKlaviyoFlows",
        "listKlaviyoAudiences",
        "listKlaviyoMetrics",
        "prisma.klaviyoDraft",
      ],
      liveReadAttempted,
      liveReadStatus,
      verifiedSections,
      caveatedSections,
      liveWriteAttempted: false,
      schemaChanged: false,
      omittedDataClasses: [
        "source relationship maps",
        "message bodies",
        "flow configuration details",
        "audience attribute inventories",
        "metric attribute inventories",
        "workflow request bodies",
        "workflow result bodies",
      ],
    },
  };

  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");

  return { ok: true as const, data: response };
}

export function klaviyoSnapshotContextStatus(input: {
  connectorStatus: ReturnType<typeof sourceStatusForArtifactSource>;
}) {
  return {
    ...input.connectorStatus,
    snapshotRoute: "GET /api/sources/klaviyo/snapshot",
    snapshotDepths: KLAVIYO_SOURCE_SNAPSHOT_DEPTHS,
    snapshotAvailability: input.connectorStatus.status === "partial_source_available" ||
      input.connectorStatus.status === "connected_snapshot_available"
      ? "snapshot_route_available_read_check_on_request"
      : "snapshot_route_available_source_not_connected",
    detail: `${input.connectorStatus.detail} Use the Klaviyo snapshot route for compact read-only source summaries when needed.`,
  };
}
