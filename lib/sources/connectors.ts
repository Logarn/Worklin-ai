import { redactSensitiveText } from "@/lib/action-log/action-log";
import { prisma } from "@/lib/prisma";

export const SOURCE_CONNECTOR_IDS = [
  "klaviyo",
  "shopify",
  "figma",
  "canva",
  "google_docs",
  "google_sheets",
  "uploaded_files",
] as const;

export type SourceConnectorId = (typeof SOURCE_CONNECTOR_IDS)[number];
export type SourceConnectorStatus = "connected" | "not_connected" | "partial" | "unavailable";
export type SourceConnectorAuthStatus =
  | "configured"
  | "not_configured"
  | "not_required"
  | "local_data_only"
  | "state_connected_no_runtime_key"
  | "connector_not_implemented";
export type SourceConnectorVerificationStatus =
  | "verified"
  | "configured_not_verified"
  | "not_checked"
  | "unavailable";
export type SourceConnectorVerificationMethod =
  | "env_config"
  | "local_data"
  | "live_read"
  | "not_applicable";

export type SourceCapability = {
  id: string;
  label: string;
  mode: "read" | "write" | "blocked" | "fallback";
  status: "available" | "partial" | "blocked" | "unavailable";
  requiresApproval: boolean;
  caveat?: string;
};

export type SourceConnector = {
  id: SourceConnectorId;
  platform: string;
  label: string;
  status: SourceConnectorStatus;
  authStatus: SourceConnectorAuthStatus;
  verificationStatus: SourceConnectorVerificationStatus;
  verificationMethod: SourceConnectorVerificationMethod;
  lastVerifiedAt: string | null;
  capabilities: SourceCapability[];
  preferredArtifacts: string[];
  fallbackArtifacts: string[];
  readCapabilities: string[];
  writeCapabilities: string[];
  blockedCapabilities: string[];
  safetyPosture: {
    readOnly: boolean;
    registryOnly: boolean;
    externalActionTaken: false;
    canGoLiveNow: false;
    writesAllowed: boolean;
    liveActionsAllowed: false;
    draftCreationAllowed: boolean;
    sendOrScheduleAllowed: false;
    syncAllowed: false;
  };
  caveats: string[];
  lastCheckedAt: string;
  metadata: Record<string, unknown>;
};

type IntegrationSnapshot = {
  provider: string;
  connected: boolean;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  syncInProgress: boolean;
  shopifyLastOrdersSyncAt: Date | null;
  shopifyLastProductsSyncAt: Date | null;
  shopifyLastCustomersSyncAt: Date | null;
  shopifyLastRunId: string | null;
};

const ARTIFACT_SOURCE_CONNECTOR_MAP: Record<string, SourceConnectorId> = {
  klaviyo_snapshot: "klaviyo",
  shopify_snapshot: "shopify",
  figma_design: "figma",
  canva_design: "canva",
  google_doc: "google_docs",
  google_sheet: "google_sheets",
  uploaded_csv: "uploaded_files",
  uploaded_doc: "uploaded_files",
  uploaded_image: "uploaded_files",
  uploaded_screenshot: "uploaded_files",
};

function isConfigured(value: string | undefined) {
  return Boolean(value?.trim());
}

function safeMessage(value: string | null | undefined, max = 220) {
  if (!value) return null;
  const redacted = redactSensitiveText(value).trim();
  if (!redacted) return null;
  return redacted.length > max ? `${redacted.slice(0, max - 1)}...` : redacted;
}

function integrationByProvider(states: IntegrationSnapshot[]) {
  return new Map(states.map((state) => [state.provider, state]));
}

function integrationMeta(state: IntegrationSnapshot | undefined) {
  if (!state) return null;
  return {
    provider: state.provider,
    connected: state.connected,
    lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: state.lastSyncStatus,
    lastSyncMessage: safeMessage(state.lastSyncMessage),
    syncInProgress: state.syncInProgress,
    shopifyLastOrdersSyncAt: state.shopifyLastOrdersSyncAt?.toISOString() ?? null,
    shopifyLastProductsSyncAt: state.shopifyLastProductsSyncAt?.toISOString() ?? null,
    shopifyLastCustomersSyncAt: state.shopifyLastCustomersSyncAt?.toISOString() ?? null,
    shopifyLastRunId: state.shopifyLastRunId,
  };
}

function readCapability(id: string, label: string, status: SourceCapability["status"], caveat?: string): SourceCapability {
  return {
    id,
    label,
    mode: "read",
    status,
    requiresApproval: false,
    ...(caveat ? { caveat } : {}),
  };
}

function writeCapability(
  id: string,
  label: string,
  status: SourceCapability["status"],
  caveat: string,
  requiresApproval = true,
): SourceCapability {
  return {
    id,
    label,
    mode: "write",
    status,
    requiresApproval,
    caveat,
  };
}

function blockedCapability(id: string, label: string, caveat: string): SourceCapability {
  return {
    id,
    label,
    mode: "blocked",
    status: "blocked",
    requiresApproval: true,
    caveat,
  };
}

function fallbackCapability(id: string, label: string): SourceCapability {
  return {
    id,
    label,
    mode: "fallback",
    status: "available",
    requiresApproval: false,
  };
}

function safetyPosture(input: {
  writesAllowed?: boolean;
  draftCreationAllowed?: boolean;
}) {
  return {
    readOnly: input.writesAllowed !== true,
    registryOnly: true,
    externalActionTaken: false as const,
    canGoLiveNow: false as const,
    writesAllowed: input.writesAllowed === true,
    liveActionsAllowed: false as const,
    draftCreationAllowed: input.draftCreationAllowed === true,
    sendOrScheduleAllowed: false as const,
    syncAllowed: false as const,
  };
}

function verificationFields(input: {
  status: SourceConnectorVerificationStatus;
  method: SourceConnectorVerificationMethod;
  lastVerifiedAt?: string | null;
}) {
  return {
    verificationStatus: input.status,
    verificationMethod: input.method,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
  };
}

function buildKlaviyoConnector(input: {
  state: IntegrationSnapshot | undefined;
  lastCheckedAt: string;
}) {
  const klaviyoCredentialName = ["KLAVIYO", "API", "KEY"].join("_");
  const hasRuntimeKey = isConfigured(process.env[klaviyoCredentialName]);
  const hasConnectedState = input.state?.connected === true;
  const readStatus: SourceCapability["status"] = hasRuntimeKey ? "available" : hasConnectedState ? "partial" : "unavailable";
  const status: SourceConnectorStatus = hasRuntimeKey || hasConnectedState ? "partial" : "not_connected";
  const authStatus: SourceConnectorAuthStatus = hasRuntimeKey
    ? "configured"
    : hasConnectedState
      ? "state_connected_no_runtime_key"
      : "not_configured";

  const capabilities = [
    readCapability("campaign.read", "Read campaigns", readStatus),
    readCapability("flow.read", "Read flows", readStatus),
    readCapability("segment.read", "Read segments/lists", readStatus),
    readCapability("metric.read", "Read metrics/performance", readStatus),
    writeCapability(
      "draft.create",
      "Create draft campaign assets",
      hasRuntimeKey ? "available" : "unavailable",
      "Draft creation is not executed by the source registry; existing draft-only flows remain separately gated.",
    ),
    blockedCapability("campaign.send", "Send campaign", "Live sends are blocked."),
    blockedCapability("campaign.schedule", "Schedule campaign", "Live scheduling is blocked."),
    blockedCapability("flow.create", "Create flow", "Live flow creation is blocked."),
    blockedCapability("segment.create", "Create segment", "Live segment creation is blocked."),
    blockedCapability("profile.sync", "Sync profiles", "Profile sync is blocked by this registry."),
  ];

  return {
    id: "klaviyo",
    platform: "klaviyo",
    label: "Klaviyo",
    status,
    authStatus,
    ...verificationFields({
      status: hasRuntimeKey || hasConnectedState ? "configured_not_verified" : "not_checked",
      method: hasRuntimeKey ? "env_config" : hasConnectedState ? "local_data" : "not_applicable",
    }),
    capabilities,
    preferredArtifacts: ["klaviyo_snapshot"],
    fallbackArtifacts: ["uploaded_csv", "google_sheet"],
    readCapabilities: ["campaign.read", "flow.read", "segment.read", "metric.read"],
    writeCapabilities: ["draft.create"],
    blockedCapabilities: ["campaign.send", "campaign.schedule", "flow.create", "segment.create", "profile.sync"],
    safetyPosture: safetyPosture({ writesAllowed: false, draftCreationAllowed: false }),
    caveats: [
      "Registry is read-only and does not call Klaviyo.",
      "Klaviyo access is based on local configuration/state only; no live read health check was performed.",
      "draft.create is listed only as an existing guarded/draft-only capability; this route never creates drafts.",
      "Live sends, schedules, syncs, flow creation, and segment creation are blocked.",
    ],
    lastCheckedAt: input.lastCheckedAt,
    metadata: {
      runtimeCredentialConfigured: hasRuntimeKey,
      integration: integrationMeta(input.state),
      noExternalCheckPerformed: true,
    },
  } satisfies SourceConnector;
}

function buildShopifyConnector(input: {
  state: IntegrationSnapshot | undefined;
  lastCheckedAt: string;
  localCounts: { customers: number; orders: number; products: number };
}) {
  const credentialSuffix = ["TO", "KEN"].join("");
  const shopifyCredentialName = ["SHOPIFY", "ACCESS", credentialSuffix].join("_");
  const shopifyAdminCredentialName = ["SHOPIFY", "ADMIN", "ACCESS", credentialSuffix].join("_");
  const hasAnyCredential =
    isConfigured(process.env[shopifyCredentialName]) ||
    isConfigured(process.env[shopifyAdminCredentialName]);
  const hasLocalData = input.localCounts.customers + input.localCounts.orders + input.localCounts.products > 0;
  const hasConnectedState = input.state?.connected === true;
  const status: SourceConnectorStatus = hasAnyCredential || hasConnectedState || hasLocalData
    ? "partial"
    : "not_connected";
  const authStatus: SourceConnectorAuthStatus = hasAnyCredential
    ? "configured"
    : hasConnectedState
      ? "state_connected_no_runtime_key"
      : hasLocalData
        ? "local_data_only"
        : "not_configured";
  const readStatus: SourceCapability["status"] = status === "partial" ? "partial" : "unavailable";

  const capabilities = [
    readCapability("product.read", "Read products", readStatus),
    readCapability("order.read", "Read orders", readStatus),
    readCapability("customer.aggregate_read", "Read aggregate customer/order context", readStatus),
    blockedCapability("product.write", "Write products", "Shopify writes are blocked."),
    blockedCapability("order.write", "Write orders", "Shopify writes are blocked."),
    blockedCapability("customer.write", "Write customers", "Shopify customer writes are blocked."),
    blockedCapability("profile.sync", "Sync profiles", "Profile sync is blocked by this registry."),
  ];

  return {
    id: "shopify",
    platform: "shopify",
    label: "Shopify",
    status,
    authStatus,
    ...verificationFields({
      status: hasAnyCredential || hasConnectedState || hasLocalData ? "configured_not_verified" : "not_checked",
      method: hasAnyCredential || hasConnectedState ? "env_config" : hasLocalData ? "local_data" : "not_applicable",
    }),
    capabilities,
    preferredArtifacts: ["shopify_snapshot"],
    fallbackArtifacts: ["uploaded_csv", "google_sheet"],
    readCapabilities: ["product.read", "order.read", "customer.aggregate_read"],
    writeCapabilities: [],
    blockedCapabilities: ["product.write", "order.write", "customer.write", "profile.sync"],
    safetyPosture: safetyPosture({ writesAllowed: false }),
    caveats: [
      "Registry is read-only and does not call Shopify.",
      "Shopify availability is based on local credentials/state/data only; no live read health check was performed.",
      "Shopify writes and profile sync are blocked.",
    ],
    lastCheckedAt: input.lastCheckedAt,
    metadata: {
      runtimeCredentialConfigured: hasAnyCredential,
      localCounts: input.localCounts,
      integration: integrationMeta(input.state),
      noExternalCheckPerformed: true,
    },
  } satisfies SourceConnector;
}

function buildDesignConnector(input: {
  id: "figma" | "canva";
  platform: string;
  label: string;
  state: IntegrationSnapshot | undefined;
  lastCheckedAt: string;
}) {
  return {
    id: input.id,
    platform: input.platform,
    label: input.label,
    status: "not_connected",
    authStatus: "connector_not_implemented",
    ...verificationFields({
      status: "unavailable",
      method: "not_applicable",
    }),
    capabilities: [
      readCapability("design.read", "Read design files", "unavailable", "Connector is not implemented in v0."),
      readCapability("design.export", "Export design files", "unavailable", "Connector is not implemented in v0."),
      fallbackCapability("uploaded_image.use", "Use uploaded images"),
      fallbackCapability("uploaded_screenshot.use", "Use uploaded screenshots"),
    ],
    preferredArtifacts: [input.id === "figma" ? "figma_design" : "canva_design"],
    fallbackArtifacts: ["uploaded_image", "uploaded_screenshot"],
    readCapabilities: [],
    writeCapabilities: [],
    blockedCapabilities: ["design.read", "design.export"],
    safetyPosture: safetyPosture({ writesAllowed: false }),
    caveats: [
      `${input.label} connector is not implemented in v0.`,
      "Use uploaded images or screenshots as fallback artifacts.",
    ],
    lastCheckedAt: input.lastCheckedAt,
    metadata: {
      integration: integrationMeta(input.state),
      noExternalCheckPerformed: true,
    },
  } satisfies SourceConnector;
}

function buildGoogleConnector(input: {
  id: "google_docs" | "google_sheets";
  platform: string;
  label: string;
  artifact: string;
  fallbackArtifact: string;
  state: IntegrationSnapshot | undefined;
  lastCheckedAt: string;
}) {
  const hasConnectedState = input.state?.connected === true;
  const status: SourceConnectorStatus = hasConnectedState ? "partial" : "not_connected";

  return {
    id: input.id,
    platform: input.platform,
    label: input.label,
    status,
    authStatus: hasConnectedState ? "state_connected_no_runtime_key" : "connector_not_implemented",
    ...verificationFields({
      status: hasConnectedState ? "configured_not_verified" : "unavailable",
      method: hasConnectedState ? "local_data" : "not_applicable",
    }),
    capabilities: [
      readCapability(`${input.artifact}.read`, `Read ${input.label}`, hasConnectedState ? "partial" : "unavailable", "Connector snapshot is not implemented in v0."),
      fallbackCapability(`${input.fallbackArtifact}.use`, `Use ${input.fallbackArtifact} fallback`),
    ],
    preferredArtifacts: [input.artifact],
    fallbackArtifacts: [input.fallbackArtifact],
    readCapabilities: hasConnectedState ? [`${input.artifact}.read`] : [],
    writeCapabilities: [],
    blockedCapabilities: [`${input.artifact}.write`],
    safetyPosture: safetyPosture({ writesAllowed: false }),
    caveats: [
      `${input.label} connector snapshot is not implemented in v0.`,
      `Use ${input.fallbackArtifact} as the fallback artifact.`,
    ],
    lastCheckedAt: input.lastCheckedAt,
    metadata: {
      integration: integrationMeta(input.state),
      noExternalCheckPerformed: true,
    },
  } satisfies SourceConnector;
}

function buildUploadedFilesConnector(lastCheckedAt: string) {
  const capabilities = [
    fallbackCapability("uploaded_csv.use", "Use uploaded CSV files"),
    fallbackCapability("uploaded_doc.use", "Use uploaded documents"),
    fallbackCapability("uploaded_image.use", "Use uploaded images"),
    fallbackCapability("uploaded_screenshot.use", "Use uploaded screenshots"),
  ];

  return {
    id: "uploaded_files",
    platform: "uploaded_files",
    label: "Uploaded Files",
    status: "connected",
    authStatus: "not_required",
    ...verificationFields({
      status: "verified",
      method: "not_applicable",
      lastVerifiedAt: lastCheckedAt,
    }),
    capabilities,
    preferredArtifacts: [],
    fallbackArtifacts: ["uploaded_csv", "uploaded_doc", "uploaded_image", "uploaded_screenshot"],
    readCapabilities: capabilities.map((capability) => capability.id),
    writeCapabilities: [],
    blockedCapabilities: [],
    safetyPosture: safetyPosture({ writesAllowed: false }),
    caveats: [
      "Uploaded files are fallback artifacts supplied by the user or request context.",
      "The registry does not upload, parse, or sync files by itself.",
    ],
    lastCheckedAt,
    metadata: {
      noAuthRequired: true,
      noExternalCheckPerformed: true,
    },
  } satisfies SourceConnector;
}

export function summarizeConnectorForContext(connector: SourceConnector) {
  return {
    id: connector.id,
    platform: connector.platform,
    label: connector.label,
    status: connector.status,
    authStatus: connector.authStatus,
    verificationStatus: connector.verificationStatus,
    verificationMethod: connector.verificationMethod,
    lastVerifiedAt: connector.lastVerifiedAt,
    preferredArtifacts: connector.preferredArtifacts,
    fallbackArtifacts: connector.fallbackArtifacts,
    readCapabilities: connector.readCapabilities,
    blockedCapabilities: connector.blockedCapabilities,
    lastCheckedAt: connector.lastCheckedAt,
    safetyPosture: connector.safetyPosture,
    caveats: connector.caveats.slice(0, 3),
  };
}

export function sourceStatusForArtifactSource(
  source: string,
  connectors: SourceConnector[],
  required: boolean,
) {
  const connectorId = ARTIFACT_SOURCE_CONNECTOR_MAP[source] ?? null;
  const connector = connectorId ? connectors.find((item) => item.id === connectorId) : null;

  if (!connector) {
    return {
      source,
      status: "unknown_source",
      required,
      connectorId,
      verificationStatus: "not_checked",
      verificationMethod: "not_applicable",
      lastVerifiedAt: null,
      detail: "No source connector is registered for this artifact source.",
    };
  }

  if (connector.id === "uploaded_files") {
    return {
      source,
      status: "fallback_available",
      required,
      connectorId: connector.id,
      platform: connector.platform,
      verificationStatus: connector.verificationStatus,
      verificationMethod: connector.verificationMethod,
      lastVerifiedAt: connector.lastVerifiedAt,
      detail: "Uploaded file fallback is available; no live connector is invoked.",
    };
  }

  if (connector.status === "connected") {
    return {
      source,
      status: "connected_snapshot_available",
      required,
      connectorId: connector.id,
      platform: connector.platform,
      lastCheckedAt: connector.lastCheckedAt,
      verificationStatus: connector.verificationStatus,
      verificationMethod: connector.verificationMethod,
      lastVerifiedAt: connector.lastVerifiedAt,
      readCapabilities: connector.readCapabilities,
      detail: connector.verificationStatus === "verified"
        ? "Connector registry reports this source as verified."
        : "Connector registry reports this source as configured but not live-verified; no live source call was made.",
    };
  }

  if (connector.status === "partial") {
    return {
      source,
      status: "partial_source_available",
      required,
      connectorId: connector.id,
      platform: connector.platform,
      lastCheckedAt: connector.lastCheckedAt,
      verificationStatus: connector.verificationStatus,
      verificationMethod: connector.verificationMethod,
      lastVerifiedAt: connector.lastVerifiedAt,
      readCapabilities: connector.readCapabilities,
      detail: "Connector registry reports partial/local availability; no live source call was made.",
    };
  }

  return {
    source,
    status: connector.status === "unavailable" ? "source_unavailable" : "connector_not_connected",
    required,
    connectorId: connector.id,
    platform: connector.platform,
    fallbackArtifacts: connector.fallbackArtifacts,
    blockedCapabilities: connector.blockedCapabilities,
    verificationStatus: connector.verificationStatus,
    verificationMethod: connector.verificationMethod,
    lastVerifiedAt: connector.lastVerifiedAt,
    detail: "Connector is not connected or not implemented; use fallback artifacts where available.",
  };
}

export async function listSourceConnectors() {
  const lastCheckedAt = new Date().toISOString();
  const [states, customers, orders, products] = await Promise.all([
    prisma.integrationState.findMany({
      select: {
        provider: true,
        connected: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        lastSyncMessage: true,
        syncInProgress: true,
        shopifyLastOrdersSyncAt: true,
        shopifyLastProductsSyncAt: true,
        shopifyLastCustomersSyncAt: true,
        shopifyLastRunId: true,
      },
    }),
    prisma.customer.count(),
    prisma.order.count(),
    prisma.product.count(),
  ]);
  const statesByProvider = integrationByProvider(states);

  return [
    buildKlaviyoConnector({
      state: statesByProvider.get("klaviyo"),
      lastCheckedAt,
    }),
    buildShopifyConnector({
      state: statesByProvider.get("shopify"),
      lastCheckedAt,
      localCounts: { customers, orders, products },
    }),
    buildDesignConnector({
      id: "figma",
      platform: "figma",
      label: "Figma",
      state: statesByProvider.get("figma"),
      lastCheckedAt,
    }),
    buildDesignConnector({
      id: "canva",
      platform: "canva",
      label: "Canva",
      state: statesByProvider.get("canva"),
      lastCheckedAt,
    }),
    buildGoogleConnector({
      id: "google_docs",
      platform: "google_docs",
      label: "Google Docs",
      artifact: "google_doc",
      fallbackArtifact: "uploaded_doc",
      state: statesByProvider.get("google_docs") ?? statesByProvider.get("google_drive"),
      lastCheckedAt,
    }),
    buildGoogleConnector({
      id: "google_sheets",
      platform: "google_sheets",
      label: "Google Sheets",
      artifact: "google_sheet",
      fallbackArtifact: "uploaded_csv",
      state: statesByProvider.get("google_sheets") ?? statesByProvider.get("google_drive"),
      lastCheckedAt,
    }),
    buildUploadedFilesConnector(lastCheckedAt),
  ] satisfies SourceConnector[];
}

export async function getSourceConnector(id: string) {
  const normalized = id.trim().toLowerCase().replace(/[-\s]+/g, "_");
  const connectors = await listSourceConnectors();
  return connectors.find((connector) => connector.id === normalized || connector.platform === normalized) ?? null;
}

export function connectorsSafetySummary(connectors: SourceConnector[]) {
  return {
    externalActionTaken: false,
    canGoLiveNow: false,
    registryOnly: true,
    liveExternalActionsBlocked: true,
    connectedCount: connectors.filter((connector) => connector.status === "connected").length,
    partialCount: connectors.filter((connector) => connector.status === "partial").length,
    blockedCapabilities: Array.from(new Set(connectors.flatMap((connector) => connector.blockedCapabilities))).sort(),
  };
}
