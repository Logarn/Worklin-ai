import {
  createFixtureRetentionDataset,
  createRetentionSafetyMetadata,
  type KlaviyoSourceSnapshot,
  type RetentionConnectorSnapshot,
  type RetentionDataset,
} from "@vellumai/retention-domain";

import { credentialKey } from "../../security/credential-key.js";
import {
  getSecureKeyResultAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import type { CredentialMetadata } from "../credentials/metadata-store.js";
import {
  assertMetadataWritable,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "../credentials/metadata-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export const KLAVIYO_SERVICE = "klaviyo";
export const KLAVIYO_FIELD_PREFIX = "api_key_";
export const KLAVIYO_MANUAL_KEY_FIELD = "private_api_key";
export const KLAVIYO_API_BASE_URL = "https://a.klaviyo.com/api";
export const KLAVIYO_DEFAULT_REVISION = "2026-04-15";

const KLAVIYO_ALLOWED_TOOLS = [
  "retention_source_status",
  "retention_klaviyo_snapshot",
  "retention_deep_audit",
  "retention_audit",
  "retention_audit_status",
  "retention_generate_audit_artifact",
  "retention_context_pack",
];

const KLAVIYO_ALLOWED_DOMAINS = ["a.klaviyo.com"];

const KLAVIYO_BLOCKED_CAPABILITIES = [
  "klaviyo_send_campaign",
  "klaviyo_schedule_campaign",
  "klaviyo_activate_flow",
  "klaviyo_mutate_segment",
  "klaviyo_mutate_profile",
];

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

type KlaviyoSnapshotDepth = "inventory" | "l365";

interface KlaviyoQueryError {
  path: string;
  status: number;
  detail?: string;
}

interface KlaviyoApiSnapshot {
  accountId: string | null;
  accountLabel: string;
  generatedAt: string;
  depth: KlaviyoSnapshotDepth;
  analysisWindow: {
    days: number;
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
    comparisonMode: "last_365_vs_previous_365";
  };
  campaigns: JsonApiResource[];
  flows: JsonApiResource[];
  forms: JsonApiResource[];
  lists: JsonApiResource[];
  segments: JsonApiResource[];
  metrics: JsonApiResource[];
  queryErrors: KlaviyoQueryError[];
}

export interface StoredKlaviyoConnection {
  credentialId: string;
  field: string;
  accountLabel: string;
  accountSlug: string;
  updatedAt: number;
  createdAt: number;
  usageDescription?: string;
  hasSecret?: boolean;
}

export interface KlaviyoConnectionSelector {
  klaviyoAccount?: string;
  klaviyoConnectionId?: string;
  account?: string;
  connectionId?: string;
}

export interface BuildKlaviyoDatasetInput {
  apiKey: string;
  revision?: string;
  depth?: KlaviyoSnapshotDepth;
  fetchImpl?: FetchLike;
}

export interface ValidateAndStoreKlaviyoApiKeyInput {
  apiKey: string;
  accountLabel?: string;
  revision?: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function nestedString(
  source: Record<string, unknown> | undefined,
  path: string[],
): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return asString(current);
}

function nestedIsoDate(
  source: Record<string, unknown> | undefined,
  path: string[],
): string | null {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return asIsoDate(current);
}

function analysisWindowFor(days = 365) {
  const currentEnd = new Date();
  const currentStart = new Date(currentEnd);
  currentStart.setUTCDate(currentStart.getUTCDate() - days);
  const previousEnd = new Date(currentStart);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - days);

  return {
    days,
    currentStart: currentStart.toISOString(),
    currentEnd: currentEnd.toISOString(),
    previousStart: previousStart.toISOString(),
    previousEnd: previousEnd.toISOString(),
    comparisonMode: "last_365_vs_previous_365" as const,
  };
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function startOfWeekIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  date.setUTCHours(0, 0, 0, 0);
  return dateOnly(date.toISOString());
}

function resourceArray(payload: unknown): JsonApiResource[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (Array.isArray(data)) return data as JsonApiResource[];
  if (data && typeof data === "object") return [data as JsonApiResource];
  return [];
}

function resourceName(resource: JsonApiResource, fallback: string): string {
  return (
    asString(resource.attributes?.name) ??
    asString(resource.attributes?.label) ??
    asString(resource.id) ??
    fallback
  );
}

function resourceStatus(resource: JsonApiResource): string {
  return (
    asString(resource.attributes?.status) ??
    asString(resource.attributes?.state) ??
    "unknown"
  ).toLowerCase();
}

function resourceDate(resource: JsonApiResource): string | null {
  return (
    asIsoDate(resource.attributes?.sent_at) ??
    asIsoDate(resource.attributes?.send_time) ??
    asIsoDate(resource.attributes?.scheduled_at) ??
    asIsoDate(resource.attributes?.created_at) ??
    asIsoDate(resource.attributes?.updated_at) ??
    asIsoDate(resource.attributes?.datetime) ??
    nestedIsoDate(resource.attributes, ["send_options", "send_time"]) ??
    nestedIsoDate(resource.attributes, ["send_options", "scheduled_at"])
  );
}

function campaignSubject(resource: JsonApiResource): string | null {
  return (
    asString(resource.attributes?.subject_line) ??
    asString(resource.attributes?.subject) ??
    nestedString(resource.attributes, ["send_options", "subject"]) ??
    nestedString(resource.attributes, ["message", "subject"])
  );
}

function classifyCampaignTheme(name: string, subject: string | null): string {
  const text = `${name} ${subject ?? ""}`.toLowerCase();
  const checks: Array<{ theme: string; patterns: string[] }> = [
    {
      theme: "sale_or_promo",
      patterns: [
        "sale",
        "discount",
        "% off",
        "off",
        "save",
        "deal",
        "bfcm",
        "black friday",
        "cyber",
      ],
    },
    {
      theme: "education",
      patterns: [
        "guide",
        "how to",
        "why",
        "lesson",
        "learn",
        "science",
        "tips",
        "routine",
      ],
    },
    {
      theme: "product_spotlight",
      patterns: [
        "product",
        "collection",
        "bundle",
        "serum",
        "cream",
        "formula",
        "launch",
        "new",
      ],
    },
    {
      theme: "social_proof",
      patterns: [
        "review",
        "results",
        "before",
        "after",
        "testimonial",
        "loved",
      ],
    },
    {
      theme: "urgency",
      patterns: ["last chance", "final", "ending", "tonight", "hours left"],
    },
    {
      theme: "winback",
      patterns: ["miss you", "come back", "winback", "still interested"],
    },
    {
      theme: "brand_story",
      patterns: ["founder", "story", "mission", "behind", "community"],
    },
  ];
  return (
    checks.find((check) =>
      check.patterns.some((pattern) => text.includes(pattern)),
    )?.theme ?? "general_retention"
  );
}

function salePostureFor(name: string, subject: string | null) {
  const text = `${name} ${subject ?? ""}`.toLowerCase();
  if (
    [
      "sale",
      "discount",
      "% off",
      " off",
      "save",
      "deal",
      "coupon",
      "black friday",
      "cyber",
    ].some((pattern) => text.includes(pattern))
  ) {
    return "sale" as const;
  }
  return text.trim() ? ("non_sale" as const) : ("unknown" as const);
}

function subjectWordBank(campaigns: JsonApiResource[]) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "you",
    "your",
    "with",
    "this",
    "that",
    "from",
    "our",
    "are",
    "can",
    "now",
    "get",
    "new",
    "all",
    "just",
  ]);
  const counts: Record<string, number> = {};
  for (const campaign of campaigns) {
    const text = `${resourceName(campaign, "")} ${campaignSubject(campaign) ?? ""}`;
    for (const word of text.toLowerCase().match(/[a-z][a-z0-9']{2,}/g) ?? []) {
      if (stopWords.has(word)) continue;
      counts[word] = (counts[word] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }));
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function inferAccountLabel(accounts: JsonApiResource[]): string {
  const account = accounts[0];
  if (!account) return "Klaviyo Account";
  return (
    nestedString(account.attributes, [
      "contact_information",
      "organization_name",
    ]) ??
    asString(account.attributes?.name) ??
    asString(account.attributes?.company) ??
    asString(account.id) ??
    "Klaviyo Account"
  );
}

function klaviyoUrl(pathOrUrl: string): string {
  return pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${KLAVIYO_API_BASE_URL}${pathOrUrl}`;
}

function klaviyoPath(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith("http")) return pathOrUrl;
  try {
    const url = new URL(pathOrUrl);
    return `${url.pathname.replace(/^\/api/, "")}${url.search}`;
  } catch {
    return pathOrUrl;
  }
}

function nextPageLink(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const links = (payload as { links?: unknown }).links;
  if (!links || typeof links !== "object") return null;
  return asString((links as Record<string, unknown>).next);
}

async function safeResponseDetail(
  response: Response,
): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as {
        errors?: Array<{ detail?: unknown }>;
      };
      const details = parsed.errors
        ?.map((error) => asString(error.detail))
        .filter((detail): detail is string => Boolean(detail));
      if (details?.length) {
        return details.join(" ").slice(0, 320);
      }
    } catch {
      // Fall back to the raw response text below.
    }
    return trimmed.slice(0, 320);
  } catch {
    return undefined;
  }
}

async function klaviyoGet(
  pathOrUrl: string,
  apiKey: string,
  revision: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(klaviyoUrl(pathOrUrl), {
    method: "GET",
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision,
    },
  });

  if (!response.ok) {
    return {
      data: [],
      __worklin_error: {
        status: response.status,
        path: klaviyoPath(pathOrUrl),
        detail: await safeResponseDetail(response),
      },
    };
  }

  return response.json();
}

function queryErrorFromPayload(payload: unknown): KlaviyoQueryError | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { __worklin_error?: unknown }).__worklin_error;
  if (!error || typeof error !== "object") return null;
  const detail = error as Record<string, unknown>;
  const path = asString(detail.path) ?? "unknown";
  const status =
    typeof detail.status === "number" && Number.isFinite(detail.status)
      ? detail.status
      : 0;
  return {
    path,
    status,
    detail: asString(detail.detail) ?? undefined,
  };
}

async function klaviyoGetAll(
  path: string,
  apiKey: string,
  revision: string,
  fetchImpl: FetchLike,
  queryErrors: KlaviyoQueryError[],
  maxPages: number,
): Promise<JsonApiResource[]> {
  const resources: JsonApiResource[] = [];
  let next: string | null = path;
  let pages = 0;

  while (next && pages < maxPages) {
    const payload = await klaviyoGet(next, apiKey, revision, fetchImpl);
    const error = queryErrorFromPayload(payload);
    if (error) {
      queryErrors.push(error);
      break;
    }
    resources.push(...resourceArray(payload));
    next = nextPageLink(payload);
    pages += 1;
  }

  if (next && pages >= maxPages) {
    queryErrors.push({
      path,
      status: 206,
      detail: `Stopped pagination after ${maxPages} pages to keep the local audit bounded.`,
    });
  }

  return resources;
}

function classifyLifecycleCoverage(flows: JsonApiResource[]) {
  const lifecycleChecks = [
    {
      id: "welcome",
      label: "Welcome/new subscriber",
      patterns: ["welcome", "new subscriber", "lead"],
    },
    {
      id: "abandoned_checkout",
      label: "Abandoned checkout",
      patterns: ["checkout", "cart", "abandon"],
    },
    {
      id: "browse_abandonment",
      label: "Browse abandonment",
      patterns: ["browse", "viewed product"],
    },
    {
      id: "post_purchase",
      label: "Post-purchase",
      patterns: ["post purchase", "post-purchase", "thank you", "placed order"],
    },
    {
      id: "winback",
      label: "Winback/reactivation",
      patterns: ["winback", "reactivation", "lapsed"],
    },
    {
      id: "sunset",
      label: "Sunset/suppression",
      patterns: ["sunset", "suppression", "unengaged"],
    },
  ];
  const flowText = flows
    .map((flow) => `${resourceName(flow, "")} ${resourceStatus(flow)}`)
    .join(" ")
    .toLowerCase();
  const presentIds = new Set(
    lifecycleChecks
      .filter((check) =>
        check.patterns.some((pattern) => flowText.includes(pattern)),
      )
      .map((check) => check.id),
  );

  return {
    present: lifecycleChecks
      .filter((check) => presentIds.has(check.id))
      .map(({ id, label }) => ({ id, label })),
    missing: lifecycleChecks
      .filter((check) => !presentIds.has(check.id))
      .map(({ id, label }) => ({ id, label })),
  };
}

function importantMetricSummary(metrics: JsonApiResource[]) {
  const checks = [
    { id: "placed_order", label: "Placed Order", patterns: ["placed order"] },
    {
      id: "received_email",
      label: "Received Email",
      patterns: ["received email"],
    },
    { id: "opened_email", label: "Opened Email", patterns: ["opened email"] },
    {
      id: "clicked_email",
      label: "Clicked Email",
      patterns: ["clicked email"],
    },
    { id: "unsubscribe", label: "Unsubscribe", patterns: ["unsubscribe"] },
    {
      id: "spam_complaint",
      label: "Spam Complaint",
      patterns: ["spam complaint"],
    },
  ];
  const metricNames = metrics.map((metric) => resourceName(metric, ""));
  const normalized = metricNames.join(" ").toLowerCase();
  const found = checks
    .filter((check) =>
      check.patterns.some((pattern) => normalized.includes(pattern)),
    )
    .map((check) => check.id);
  const missing = checks
    .filter((check) => !found.includes(check.id))
    .map((check) => check.id);

  return {
    found,
    missing,
    readiness:
      found.includes("placed_order") &&
      found.includes("opened_email") &&
      found.includes("clicked_email")
        ? "performance_ready"
        : found.length > 0
          ? "partial"
          : "not_available",
  } satisfies KlaviyoSourceSnapshot["metrics"]["importantMetrics"];
}

function campaignPerformanceSummary(
  campaigns: JsonApiResource[],
  analysisWindow: KlaviyoApiSnapshot["analysisWindow"],
): NonNullable<KlaviyoSourceSnapshot["campaignPerformance"]> {
  const currentStart = new Date(analysisWindow.currentStart).getTime();
  const currentEnd = new Date(analysisWindow.currentEnd).getTime();
  const currentWindowCampaigns = campaigns.filter((campaign) => {
    const date = resourceDate(campaign);
    if (!date) return true;
    const time = new Date(date).getTime();
    return time >= currentStart && time <= currentEnd;
  });
  const recent = currentWindowCampaigns.map((campaign, index) => {
    const name = resourceName(campaign, `Campaign ${index + 1}`);
    const subject = campaignSubject(campaign);
    return {
      id: asString(campaign.id) ?? `campaign_${index + 1}`,
      name,
      status: resourceStatus(campaign),
      channel:
        asString(campaign.attributes?.channel) ??
        asString(campaign.attributes?.message_type) ??
        "email",
      subject,
      sentAt: resourceDate(campaign),
      theme: classifyCampaignTheme(name, subject),
      salePosture: salePostureFor(name, subject),
    };
  });
  const cadenceCounts = recent.reduce<Record<string, number>>(
    (counts, campaign) => {
      const weekStart = campaign.sentAt
        ? startOfWeekIso(campaign.sentAt)
        : "undated";
      counts[weekStart] = (counts[weekStart] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return {
    count: recent.length,
    byStatus: countBy(recent.map((campaign) => campaign.status)),
    byChannel: countBy(recent.map((campaign) => campaign.channel)),
    byTheme: countBy(recent.map((campaign) => campaign.theme)),
    cadenceByWeek: Object.entries(cadenceCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, campaignCount]) => ({
        weekStart,
        campaignCount,
        targetMin: 2,
        targetMax: 4,
      })),
    subjectWordBank: subjectWordBank(currentWindowCampaigns),
    recent: recent.slice(0, 100),
  };
}

function flowPerformanceSummary(
  flows: JsonApiResource[],
  lifecycleCoverage: KlaviyoSourceSnapshot["lifecycleCoverage"],
): NonNullable<KlaviyoSourceSnapshot["flowPerformance"]> {
  return {
    count: flows.length,
    activeLikeCount: flows.filter((flow) =>
      ["live", "active", "enabled"].includes(resourceStatus(flow)),
    ).length,
    byStatus: countBy(flows.map(resourceStatus)),
    byTriggerType: countBy(
      flows.map(
        (flow) =>
          asString(flow.attributes?.trigger_type) ??
          nestedString(flow.attributes, ["trigger", "type"]) ??
          "unknown",
      ),
    ),
    lifecycleCoverage,
  };
}

function formInventorySummary(
  forms: JsonApiResource[],
): NonNullable<KlaviyoSourceSnapshot["forms"]> {
  return {
    count: forms.length,
    byStatus: countBy(forms.map(resourceStatus)),
    recent: forms.slice(0, 50).map((form, index) => ({
      id: asString(form.id) ?? `form_${index + 1}`,
      name: resourceName(form, `Form ${index + 1}`),
      status: resourceStatus(form),
      type:
        asString(form.attributes?.form_type) ??
        asString(form.attributes?.display_type) ??
        asString(form.attributes?.type) ??
        "unknown",
    })),
  };
}

function buildKlaviyoSourceSnapshot(
  apiSnapshot: KlaviyoApiSnapshot,
): KlaviyoSourceSnapshot {
  const connector: RetentionConnectorSnapshot = {
    id: "klaviyo",
    label: `Klaviyo (${apiSnapshot.accountLabel})`,
    status: "connected",
    lastSyncedAt: apiSnapshot.generatedAt,
    readCapabilities: [
      "accounts_read",
      "campaigns_read",
      "flows_read",
      "forms_read",
      "lists_read",
      "segments_read",
      "metrics_read",
    ],
    writeCapabilities: [],
    blockedCapabilities: KLAVIYO_BLOCKED_CAPABILITIES,
    caveats: [
      "Live Klaviyo snapshot was collected through Worklin-managed read-only API-key access.",
      "Campaign send, schedule, flow activation, segment mutation, and profile mutation remain blocked.",
    ],
  };
  const lifecycleCoverage = classifyLifecycleCoverage(apiSnapshot.flows);
  const lifecycleSnapshot = {
    ...lifecycleCoverage,
    status: "derived_from_snapshot" as const,
    caveats: [
      apiSnapshot.depth === "l365"
        ? "Lifecycle coverage is inferred from live Klaviyo flow names, statuses, and trigger metadata. Revenue/drop-off analysis requires deeper metric aggregation."
        : "Lifecycle coverage is inferred from live Klaviyo flow names and statuses; deeper message-level analysis comes in the next connector pass.",
    ],
  };
  const campaignPerformance =
    apiSnapshot.depth === "l365"
      ? campaignPerformanceSummary(
          apiSnapshot.campaigns,
          apiSnapshot.analysisWindow,
        )
      : undefined;
  const flowPerformance =
    apiSnapshot.depth === "l365"
      ? flowPerformanceSummary(apiSnapshot.flows, lifecycleSnapshot)
      : undefined;
  const forms =
    apiSnapshot.depth === "l365"
      ? formInventorySummary(apiSnapshot.forms)
      : undefined;

  return {
    platform: "klaviyo",
    generatedAt: apiSnapshot.generatedAt,
    depth: apiSnapshot.depth === "l365" ? "l365" : "standard",
    analysisWindow: apiSnapshot.analysisWindow,
    connector,
    campaigns: {
      count: apiSnapshot.campaigns.length,
      byStatus: countBy(apiSnapshot.campaigns.map(resourceStatus)),
      recent: apiSnapshot.campaigns.slice(0, 20).map((campaign, index) => ({
        id: asString(campaign.id) ?? `campaign_${index + 1}`,
        name: resourceName(campaign, `Campaign ${index + 1}`),
        status: resourceStatus(campaign),
        channel:
          asString(campaign.attributes?.channel) ??
          asString(campaign.attributes?.message_type) ??
          "email",
        subject: campaignSubject(campaign),
      })),
    },
    campaignPerformance,
    flows: {
      count: apiSnapshot.flows.length,
      activeLikeCount: apiSnapshot.flows.filter((flow) =>
        ["live", "active", "enabled"].includes(resourceStatus(flow)),
      ).length,
      recent: apiSnapshot.flows.slice(0, 20).map((flow, index) => ({
        id: asString(flow.id) ?? `flow_${index + 1}`,
        name: resourceName(flow, `Flow ${index + 1}`),
        status: resourceStatus(flow),
        triggerType:
          asString(flow.attributes?.trigger_type) ??
          nestedString(flow.attributes, ["trigger", "type"]) ??
          "unknown",
      })),
    },
    flowPerformance,
    forms,
    audiences: {
      lists: apiSnapshot.lists.length,
      segments: apiSnapshot.segments.length,
      top: [
        ...apiSnapshot.lists.slice(0, 10).map((list, index) => ({
          id: asString(list.id) ?? `list_${index + 1}`,
          name: resourceName(list, `List ${index + 1}`),
          type: "list" as const,
          profileCount: asNumber(list.attributes?.profile_count),
        })),
        ...apiSnapshot.segments.slice(0, 10).map((segment, index) => ({
          id: asString(segment.id) ?? `segment_${index + 1}`,
          name: resourceName(segment, `Segment ${index + 1}`),
          type: "segment" as const,
          profileCount: asNumber(segment.attributes?.profile_count),
        })),
      ],
    },
    metrics: {
      count: apiSnapshot.metrics.length,
      importantMetrics: importantMetricSummary(apiSnapshot.metrics),
    },
    lifecycleCoverage: lifecycleSnapshot,
    freshness: {
      lastSyncedAt: apiSnapshot.generatedAt,
      status: "fresh",
    },
    caveats: [
      "Read-only live Klaviyo snapshot; no external writes were attempted.",
      apiSnapshot.depth === "l365"
        ? "Klaviyo L365 audit uses account/campaign/flow/form/audience/metric inventory via GET-only API reads. Revenue attribution and event aggregates are not inferred unless returned by the safe snapshot."
        : "Message body, revenue attribution, and profile-level engagement are not fetched in this first safe connector pass.",
      ...(apiSnapshot.queryErrors.length > 0
        ? [
            `${apiSnapshot.queryErrors.length} optional Klaviyo read(s) were unavailable and are shown as audit caveats, not silently filled with sample data.`,
          ]
        : []),
    ],
    queryErrors: apiSnapshot.queryErrors,
    safety: createRetentionSafetyMetadata([
      "Klaviyo snapshot is live read-only.",
      "No Klaviyo send, schedule, flow activation, profile mutation, or segment mutation tool is registered for this connector.",
    ]),
  };
}

async function readKlaviyoApiSnapshot(
  input: BuildKlaviyoDatasetInput,
): Promise<KlaviyoApiSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const revision = input.revision ?? KLAVIYO_DEFAULT_REVISION;
  const depth = input.depth ?? "l365";
  const analysisWindow = analysisWindowFor(365);
  const queryErrors: KlaviyoQueryError[] = [];
  const accountsPayload = await klaviyoGet(
    "/accounts/",
    input.apiKey,
    revision,
    fetchImpl,
  );
  const accountError = queryErrorFromPayload(accountsPayload);
  if (accountError) queryErrors.push(accountError);
  const accounts = resourceArray(accountsPayload);

  if (accounts.length === 0) {
    throw new Error("Klaviyo key validation failed: no account was readable.");
  }
  const maxPages = depth === "l365" ? 20 : 1;
  const campaignFilter = encodeURIComponent("equals(messages.channel,'email')");
  const campaignPageSize = depth === "l365" ? 50 : 20;
  const flowPageSize = depth === "l365" ? 50 : 20;
  const audiencePageSize = depth === "l365" ? 10 : 10;
  const formsPageSize = depth === "l365" ? 100 : 20;
  const [campaigns, flows, lists, segments, metrics, forms] = await Promise.all(
    [
      klaviyoGetAll(
        `/campaigns/?filter=${campaignFilter}&page[size]=${campaignPageSize}`,
        input.apiKey,
        revision,
        fetchImpl,
        queryErrors,
        maxPages,
      ),
      klaviyoGetAll(
        `/flows/?page[size]=${flowPageSize}`,
        input.apiKey,
        revision,
        fetchImpl,
        queryErrors,
        maxPages,
      ),
      klaviyoGetAll(
        `/lists/?page[size]=${audiencePageSize}`,
        input.apiKey,
        revision,
        fetchImpl,
        queryErrors,
        maxPages,
      ),
      klaviyoGetAll(
        `/segments/?page[size]=${audiencePageSize}`,
        input.apiKey,
        revision,
        fetchImpl,
        queryErrors,
        maxPages,
      ),
      klaviyoGetAll(
        `/metrics/`,
        input.apiKey,
        revision,
        fetchImpl,
        queryErrors,
        maxPages,
      ),
      depth === "l365"
        ? klaviyoGetAll(
            `/forms/?page[size]=${formsPageSize}`,
            input.apiKey,
            revision,
            fetchImpl,
            queryErrors,
            4,
          )
        : Promise.resolve([]),
    ],
  );

  return {
    accountId: asString(accounts[0]?.id),
    accountLabel: inferAccountLabel(accounts),
    generatedAt: new Date().toISOString(),
    depth,
    analysisWindow,
    campaigns,
    flows,
    forms,
    lists,
    segments,
    metrics,
    queryErrors,
  };
}

export async function buildLiveReadonlyKlaviyoDatasetFromApiKey(
  input: BuildKlaviyoDatasetInput,
): Promise<RetentionDataset> {
  const apiSnapshot = await readKlaviyoApiSnapshot(input);
  const klaviyoSnapshot = buildKlaviyoSourceSnapshot(apiSnapshot);
  const fixture = createFixtureRetentionDataset();
  const shopifyConnector: RetentionConnectorSnapshot = {
    id: "shopify",
    label: "Shopify",
    status: "not_connected",
    lastSyncedAt: null,
    readCapabilities: [],
    writeCapabilities: [],
    blockedCapabilities: ["shopify_write"],
    caveats: [
      "No live Shopify connector is connected for this account yet.",
      "Worklin did not load fixture Shopify customers, orders, products, revenue, or product-performance data into this live Klaviyo snapshot.",
    ],
  };

  return {
    ...fixture,
    generatedAt: apiSnapshot.generatedAt,
    brandName: apiSnapshot.accountLabel,
    sourceMode:
      klaviyoSnapshot.depth === "l365" ? "klaviyo_l365" : "klaviyo_inventory",
    connectors: fixture.connectors.map((connector) =>
      connector.id === "klaviyo"
        ? klaviyoSnapshot.connector
        : connector.id === "shopify"
          ? shopifyConnector
          : connector,
    ),
    brandBrain: {
      ...fixture.brandBrain,
      brandName: apiSnapshot.accountLabel,
      industry: "Unknown until Brand Brain setup is completed",
      positioning: {
        tagline: "Brand Brain not configured for this Klaviyo account yet.",
        story:
          "Worklin has only validated the live read-only Klaviyo connection. Brand positioning, product rules, offers, voice, and approved language still need to be imported or entered for this account.",
        uniqueSellingProposition:
          "Unavailable until Worklin has real brand context for this account.",
      },
      voice: {
        ...fixture.brandBrain.voice,
        summary:
          "Brand voice is not configured for this Klaviyo account yet. Do not infer voice from fixture data.",
      },
      audienceNotes: [],
      offers: [],
      products: [],
      rules: [
        {
          type: "do",
          rule: "Use only live read-only Klaviyo inventory data until Brand Brain and Shopify are connected.",
        },
        {
          type: "dont",
          rule: "Do not infer product performance, revenue, offers, or brand voice from fixture data for this account.",
        },
      ],
      ctas: [],
      phrases: [],
      compliance: {
        requiredDisclaimers: [],
        forbiddenClaims: [
          "Do not invent product claims, clinical claims, offers, or guarantees before Brand Brain setup is completed.",
        ],
        cautionAreas: [
          "Unverified brand voice",
          "Unverified offers",
          "Unverified product claims",
          "Campaign recommendations without approved brand documents",
        ],
      },
      documentSources: [],
      sourceProvenance: [
        {
          sourceType: "source_snapshot",
          label: apiSnapshot.accountLabel,
          status: "live_readonly",
          observedAt: apiSnapshot.generatedAt,
        },
      ],
      readiness: {
        status: "missing",
        score: 18,
        completed: [
          "Live read-only Klaviyo account identity validated",
          "Klaviyo inventory/source posture captured",
        ],
        missing: [
          "Approved brand profile and positioning",
          "Voice and tone rules",
          "Offer policy and CTA library",
          "Product rules and claim constraints",
          "Brand documents and prior audit learnings",
          "Campaign outcome memory",
        ],
        nextActions: [
          "Complete Brand Brain onboarding before campaign-package generation.",
          "Upload brand documents, prior audits, offer rules, product notes, and approved/forbidden phrases.",
          "Approve the Brand Brain before creating any Klaviyo draft.",
        ],
      },
      campaignMemory: [],
      caveats: [
        "Klaviyo account metadata is live read-only; brand voice, offers, and product rules remain Brand Brain setup data until persisted for this account.",
        "Fixture Brand Brain values were intentionally removed from this live Klaviyo snapshot to avoid misattributing sample data to the connected brand.",
      ],
    },
    customers: [],
    klaviyoSnapshot,
  };
}

function metadataToConnection(
  metadata: CredentialMetadata,
): StoredKlaviyoConnection {
  const alias = metadata.alias?.trim();
  const slugFromField =
    metadata.field === KLAVIYO_MANUAL_KEY_FIELD
      ? "manual_readonly"
      : metadata.field.replace(KLAVIYO_FIELD_PREFIX, "");
  return {
    credentialId: metadata.credentialId,
    field: metadata.field,
    accountLabel: alias || slugFromField.replaceAll("_", " "),
    accountSlug: slugFromField,
    updatedAt: metadata.updatedAt,
    createdAt: metadata.createdAt,
    usageDescription: metadata.usageDescription,
  };
}

export function listStoredKlaviyoConnections(): StoredKlaviyoConnection[] {
  return listCredentialMetadata()
    .filter(
      (metadata) =>
        metadata.service === KLAVIYO_SERVICE &&
        (metadata.field.startsWith(KLAVIYO_FIELD_PREFIX) ||
          metadata.field === KLAVIYO_MANUAL_KEY_FIELD),
    )
    .map(metadataToConnection)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listUsableStoredKlaviyoConnections(): Promise<
  StoredKlaviyoConnection[]
> {
  const connections = listStoredKlaviyoConnections();
  const checked = await Promise.all(
    connections.map(async (connection) => {
      const result = await getSecureKeyResultAsync(
        credentialKey(KLAVIYO_SERVICE, connection.field),
      );
      return {
        ...connection,
        hasSecret: Boolean(result.value),
      };
    }),
  );
  return checked.filter((connection) => connection.hasSecret);
}

function selectorValue(
  selector: KlaviyoConnectionSelector,
): string | undefined {
  return (
    selector.klaviyoConnectionId ??
    selector.connectionId ??
    selector.klaviyoAccount ??
    selector.account
  );
}

function selectKlaviyoConnection(
  selector: KlaviyoConnectionSelector = {},
): StoredKlaviyoConnection | undefined {
  const connections = listStoredKlaviyoConnections();
  const value = selectorValue(selector);
  if (!value) return connections[0];
  const normalized = slugify(value);
  return connections.find(
    (connection) =>
      connection.credentialId === value ||
      connection.field === value ||
      connection.accountSlug === normalized ||
      slugify(connection.accountLabel) === normalized,
  );
}

export async function buildLiveReadonlyKlaviyoDatasetFromStoredConnection(
  selector: KlaviyoConnectionSelector = {},
): Promise<RetentionDataset | undefined> {
  const connection = selectKlaviyoConnection(selector);
  if (!connection) return undefined;

  const result = await getSecureKeyResultAsync(
    credentialKey(KLAVIYO_SERVICE, connection.field),
  );
  if (!result.value) {
    const requested = Boolean(selectorValue(selector));
    if (requested) {
      throw new Error(
        result.unreachable
          ? "Klaviyo credential store is unreachable."
          : "Selected Klaviyo connection has no stored secret.",
      );
    }
    return undefined;
  }

  return buildLiveReadonlyKlaviyoDatasetFromApiKey({ apiKey: result.value });
}

function fieldForAccount(
  accountLabel: string,
  accountId: string | null,
): string {
  const labelSlug = slugify(accountLabel) || "account";
  const idSlug = accountId ? slugify(accountId) : "";
  return `${KLAVIYO_FIELD_PREFIX}${[labelSlug, idSlug]
    .filter(Boolean)
    .join("_")}`;
}

function accountLabelInput(input: Record<string, unknown>): string | undefined {
  return (
    asString(input.account_label) ??
    asString(input.accountLabel) ??
    asString(input.klaviyo_account) ??
    asString(input.account) ??
    undefined
  );
}

function revisionInput(input: Record<string, unknown>): string | undefined {
  return asString(input.revision) ?? undefined;
}

export async function validateAndStoreKlaviyoApiKey(
  input: ValidateAndStoreKlaviyoApiKeyInput,
): Promise<ToolExecutionResult> {
  const apiKey = asString(input.apiKey);
  if (!apiKey) {
    return {
      content: JSON.stringify(
        {
          error: "A Klaviyo API key is required.",
          status: "not_connected",
          externalActionTaken: false,
          canGoLiveNow: false,
        },
        null,
        2,
      ),
      isError: true,
    };
  }

  try {
    assertMetadataWritable();
  } catch {
    return {
      content:
        "Klaviyo connection could not be saved because credential metadata storage is not writable.",
      isError: true,
    };
  }

  try {
    const dataset = await buildLiveReadonlyKlaviyoDatasetFromApiKey({
      apiKey,
      revision: input.revision,
      depth: "inventory",
    });
    const snapshot = dataset.klaviyoSnapshot;
    const accountLabel = input.accountLabel ?? dataset.brandName;
    const field = fieldForAccount(accountLabel, null);
    const stored = await setSecureKeyAsync(
      credentialKey(KLAVIYO_SERVICE, field),
      apiKey,
    );

    if (!stored) {
      return {
        content:
          "Klaviyo key validated, but Worklin could not store it securely. No connection was saved.",
        isError: true,
      };
    }

    const metadata = upsertCredentialMetadata(KLAVIYO_SERVICE, field, {
      alias: accountLabel,
      allowedTools: KLAVIYO_ALLOWED_TOOLS,
      allowedDomains: KLAVIYO_ALLOWED_DOMAINS,
      usageDescription:
        "Read-only Klaviyo data access for Worklin deep retention audits and recurring opportunity scans.",
    });

    return {
      content: JSON.stringify(
        {
          status: "connected",
          service: KLAVIYO_SERVICE,
          credential_id: metadata.credentialId,
          account_label: accountLabel,
          field,
          sourceMode: dataset.sourceMode,
          snapshot: snapshot
            ? {
                campaigns: snapshot.campaigns.count,
                flows: snapshot.flows.count,
                lists: snapshot.audiences.lists,
                segments: snapshot.audiences.segments,
                metrics: snapshot.metrics.count,
                freshness: snapshot.freshness,
              }
            : null,
          safety: createRetentionSafetyMetadata([
            "Klaviyo key was validated with GET-only API requests and stored in Worklin's secure credential store.",
            "No Klaviyo sends, schedules, flow activations, profile mutations, or segment mutations were attempted.",
          ]),
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (error) {
    return {
      content: JSON.stringify(
        {
          error:
            error instanceof Error
              ? error.message
              : "Klaviyo key validation failed.",
          status: "not_connected",
          externalActionTaken: false,
          canGoLiveNow: false,
        },
        null,
        2,
      ),
      isError: true,
    };
  }
}

export async function executeRetentionConnectKlaviyoConnection(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.requestSecret) {
    return {
      content:
        "Secure Klaviyo key entry is not available in this channel. Open Worklin in the desktop app and run this connection step there.",
      isError: true,
    };
  }

  try {
    assertMetadataWritable();
  } catch {
    return {
      content:
        "Klaviyo connection could not be saved because credential metadata storage is not writable.",
      isError: true,
    };
  }

  const requestedLabel = accountLabelInput(input);
  const promptField = `${KLAVIYO_FIELD_PREFIX}${
    slugify(requestedLabel ?? "new_account") || "new_account"
  }`;
  const result = await context.requestSecret({
    service: KLAVIYO_SERVICE,
    field: promptField,
    label: "Klaviyo Private API Key",
    description:
      "Read-only key for Worklin retention audits. Worklin will validate it with GET-only Klaviyo API calls and store it securely for recurring audits.",
    placeholder: "pk_...",
    purpose:
      "Read-only Klaviyo data access for Worklin deep retention audits and recurring opportunity scans.",
    allowedTools: KLAVIYO_ALLOWED_TOOLS,
    allowedDomains: KLAVIYO_ALLOWED_DOMAINS,
  });

  if (!result.value) {
    if (result.error === "unsupported_channel") {
      return {
        content:
          "Secure Klaviyo key entry cannot be opened over this channel. Please complete this from the Worklin desktop app.",
        isError: true,
      };
    }
    return {
      content: "Klaviyo connection cancelled. No key was stored.",
      isError: false,
    };
  }

  if (result.delivery !== "store") {
    return {
      content:
        "Recurring Worklin audits need a stored Klaviyo connection. Please choose the store option in the secure key prompt.",
      isError: true,
    };
  }

  return validateAndStoreKlaviyoApiKey({
    apiKey: result.value,
    accountLabel: requestedLabel,
    revision: revisionInput(input),
  });
}

export function executeRetentionListKlaviyoConnections(): ToolExecutionResult {
  return {
    content: JSON.stringify(
      {
        service: KLAVIYO_SERVICE,
        connections: listStoredKlaviyoConnections().map((connection) => ({
          credential_id: connection.credentialId,
          account_label: connection.accountLabel,
          field: connection.field,
          updated_at: new Date(connection.updatedAt).toISOString(),
          created_at: new Date(connection.createdAt).toISOString(),
          usage: connection.usageDescription,
        })),
        safety: createRetentionSafetyMetadata([
          "Returned Klaviyo connection metadata only. Secrets are never displayed.",
        ]),
      },
      null,
      2,
    ),
    isError: false,
  };
}
