export type ResearchProviderId =
  | "trendtrack"
  | "meld"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "youtube";

export type ResearchProviderStatus =
  | "connected"
  | "not_configured"
  | "disabled"
  | "insufficient_credits"
  | "unavailable"
  | "rate_limited";

export type ResearchProviderCapability =
  | "competitors"
  | "email_lifecycle"
  | "social"
  | "paid_media"
  | "products"
  | "seo"
  | "market";

export interface ResearchQuery {
  brandName: string;
  websiteUrl?: string;
  competitorNames?: string[];
}

export interface ResearchObservation {
  id: string;
  provider: ResearchProviderId;
  capability: ResearchProviderCapability;
  sourceUrl?: string;
  media?: {
    type: "image" | "video" | "page";
    mediaUrl?: string;
    thumbnailUrl?: string;
  };
  observedAt: string;
  title: string;
  finding: string;
  confidence: "high" | "medium" | "low";
  provenance: "public" | "provider";
  data?: Record<string, unknown>;
}

export interface ResearchProviderUsage {
  creditsUsed: number;
  creditsRemaining?: number;
  runCreditsUsed: number;
  runCreditLimit: number;
  requestId?: string;
}

export interface ResearchProviderResult {
  provider: ResearchProviderId;
  status: ResearchProviderStatus;
  observations: ResearchObservation[];
  coverageGaps: string[];
  caveats: string[];
  retryAfterSeconds?: number;
  usage?: ResearchProviderUsage;
}

export interface ResearchProviderCapabilities {
  provider: ResearchProviderId;
  status: ResearchProviderStatus;
  capabilities: ResearchProviderCapability[];
  caveats: string[];
}

export interface ResearchProvider {
  readonly id: ResearchProviderId;
  readonly label: string;
  getConnectionStatus(): Promise<ResearchProviderStatus>;
  discoverCapabilities(): Promise<ResearchProviderCapabilities>;
  researchCompetitors(query: ResearchQuery): Promise<ResearchProviderResult>;
  lookupLifecycleSignals(query: ResearchQuery): Promise<ResearchProviderResult>;
  lookupSocialSignals(query: ResearchQuery): Promise<ResearchProviderResult>;
  lookupPaidMediaSignals?(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult>;
  lookupProductSignals?(query: ResearchQuery): Promise<ResearchProviderResult>;
  lookupSeoSignals?(query: ResearchQuery): Promise<ResearchProviderResult>;
  lookupMarketSignals?(query: ResearchQuery): Promise<ResearchProviderResult>;
}

export interface ResearchProviderHttpOptions {
  baseUrl: string;
  credential?: string | null;
  fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface TrendtrackResearchProviderOptions extends ResearchProviderHttpOptions {
  liveAccessApproved?: boolean;
  liveRequestsEnabled?: boolean;
  maxCreditsPerRun?: number;
  maxRowsPerRequest?: number;
  maxGoogleAdsRowsPerRequest?: number;
  maxTikTokRowsPerRequest?: number;
  maxCompetitorsPerRun?: number;
  minimumCreditReserve?: number;
  now?: () => Date;
}

const SOCIAL_PROVIDERS = [
  "instagram",
  "facebook",
  "linkedin",
  "youtube",
] as const satisfies readonly ResearchProviderId[];

function unavailableResult(
  provider: ResearchProviderId,
  capability: ResearchProviderCapability,
  status: ResearchProviderStatus,
): ResearchProviderResult {
  return {
    provider,
    status,
    observations: [],
    coverageGaps: [`${capability} coverage is ${status}.`],
    caveats: [
      status === "not_configured"
        ? "No provider credentials were supplied; public research remains the fallback."
        : status === "disabled"
          ? "Live provider requests are disabled; public research remains the fallback."
          : status === "insufficient_credits"
            ? "The provider credit guard stopped this request before any metered call."
            : "The provider did not return usable evidence; public research remains the fallback.",
    ],
  };
}

function capabilitiesFor(
  provider: ResearchProviderId,
  status: ResearchProviderStatus,
): ResearchProviderCapabilities {
  const capabilities: ResearchProviderCapability[] =
    provider === "trendtrack"
      ? [
          "competitors",
          "email_lifecycle",
          "social",
          "paid_media",
          "products",
          "market",
        ]
      : provider === "meld"
        ? ["competitors", "email_lifecycle", "social"]
        : ["social"];
  return {
    provider,
    status,
    capabilities: status === "connected" ? capabilities : [],
    caveats: [
      "Provider results are kept separate from public evidence and never include credentials.",
      ...(provider === "trendtrack"
        ? [
            "Trendtrack observations are provider-sourced signals, not verified performance results.",
            "Email observations do not include opens, clicks, conversions, or revenue.",
            "No automatic credit top-up or billing action is available through this provider.",
          ]
        : provider === "meld"
          ? [
              "Meld coverage depends on the workspace plan and the competitor signals it exposes.",
            ]
          : [
              "Only data returned by the connected official provider is used; Worklin does not scrape authenticated systems.",
            ]),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : undefined;
}

function firstText(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function recordAt(
  value: Record<string, unknown>,
  path: string[],
): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function textAt(
  value: Record<string, unknown>,
  path: string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.trim()
    ? current.trim()
    : undefined;
}

function numberAt(
  value: Record<string, unknown>,
  path: string[],
): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current)
    ? current
    : undefined;
}

function firstPathText(
  value: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    const candidate = textAt(value, path);
    if (candidate) return candidate;
  }
  return undefined;
}

function firstPathNumber(
  value: Record<string, unknown>,
  paths: string[][],
): number | undefined {
  for (const path of paths) {
    const candidate = numberAt(value, path);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function arrayAt(
  value: Record<string, unknown>,
  path: string[],
): unknown[] | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return Array.isArray(current) ? current : undefined;
}

function firstPathArray(
  value: Record<string, unknown>,
  paths: string[][],
): unknown[] | undefined {
  for (const path of paths) {
    const candidate = arrayAt(value, path);
    if (candidate) return candidate;
  }
  return undefined;
}

function asIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function firstIdentifier(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const identifier = asIdentifier(value[key]);
    if (identifier) return identifier;
  }
  return undefined;
}

function canonicalDomain(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function normalizedBrandIdentity(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const domain = canonicalDomain(value);
  const source = domain ? domain.split(".")[0] : value;
  const normalized = source.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.length >= 4 ? normalized : undefined;
}

function brandIdentityVariants(value?: string): string[] {
  if (!value?.trim()) return [];
  const domain = canonicalDomain(value);
  const source = domain ? domain.split(".")[0] : value;
  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const legalSuffixes = new Set([
    "co",
    "company",
    "corp",
    "corporation",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "ltd",
    "plc",
    "pty",
  ]);
  const withoutLegalSuffix = [...words];
  while (
    withoutLegalSuffix.length > 1 &&
    legalSuffixes.has(withoutLegalSuffix.at(-1) ?? "")
  ) {
    withoutLegalSuffix.pop();
  }
  return [
    normalizedBrandIdentity(value),
    normalizedBrandIdentity(withoutLegalSuffix.join(" ")),
  ].filter((item, index, values): item is string => {
    return Boolean(item) && values.indexOf(item) === index;
  });
}

function paidMediaMatchesSubject(
  item: Record<string, unknown>,
  query: ResearchQuery,
  subject: TrendtrackResolvedShop | null,
): boolean {
  const expectedValues = [
    query.brandName,
    query.websiteUrl,
    subject?.name,
    subject?.domain,
  ];
  const expectedDomains = new Set(
    expectedValues
      .map(canonicalDomain)
      .filter((value): value is string => Boolean(value)),
  );
  const expectedIdentities = new Set(
    expectedValues.flatMap(brandIdentityVariants),
  );
  const candidateValues = [
    ...["name", "title", "domain", "websiteUrl", "sourceUrl"].map((key) =>
      firstText(item, [key]),
    ),
    ...[
      ["content", "landingPageDomain"],
      ["content", "landingPageUrl"],
      ["advertiser", "domain"],
      ["advertiser", "name"],
      ["advertiser", "shopName"],
      ["shop", "domain"],
      ["shop", "name"],
      ["profile", "handle"],
      ["profile", "name"],
      ["profile", "bioUrl"],
    ].map((path) => textAt(item, path)),
  ].filter((value): value is string => Boolean(value));
  const candidateDomains = new Set(
    candidateValues
      .map(canonicalDomain)
      .filter((value): value is string => Boolean(value)),
  );
  if (
    [...candidateDomains].some((domain) => expectedDomains.has(domain))
  ) {
    return true;
  }
  const candidateIdentities = new Set(
    candidateValues.flatMap(brandIdentityVariants),
  );
  return [...candidateIdentities].some((identity) =>
    expectedIdentities.has(identity),
  );
}

function asSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return value.includes(".") ? `https://${value}` : undefined;
}

function publicAssetUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

type ObservationMediaType = NonNullable<
  ResearchObservation["media"]
>["type"];

function normalizedMediaType(value?: string): ObservationMediaType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "image" || normalized === "video" || normalized === "page") {
    return normalized;
  }
  return undefined;
}

function inferredMediaType(url?: string): ObservationMediaType | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\.(mp4|mov|m4v|webm|m3u8)$/.test(pathname)) return "video";
    if (/\.(avif|gif|jpe?g|png|webp)$/.test(pathname)) return "image";
  } catch {
    return undefined;
  }
  return undefined;
}

function firstPublicArrayUrl(
  value: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    const values = arrayAt(value, path);
    const candidate = values
      ?.filter((item): item is string => typeof item === "string")
      .map(publicAssetUrl)
      .find((item): item is string => Boolean(item));
    if (candidate) return candidate;
  }
  return undefined;
}

interface RenderableMediaEntry {
  type?: ObservationMediaType;
  url: string;
  order: number;
}

function renderableMediaEntries(
  value: Record<string, unknown>,
): RenderableMediaEntry[] {
  const entries: RenderableMediaEntry[] = [];
  for (const candidate of firstPathArray(value, [
    ["media", "medias"],
    ["medias"],
  ]) ?? []) {
    if (!isRecord(candidate)) continue;
    const url = publicAssetUrl(
      firstText(candidate, ["url", "mediaUrl", "videoUrl", "imageUrl"]),
    );
    if (!url) continue;
    const type =
      normalizedMediaType(firstText(candidate, ["type", "mediaType"])) ??
      inferredMediaType(url);
    entries.push({
      ...(type ? { type } : {}),
      url,
      order: numberAt(candidate, ["order"]) ?? entries.length,
    });
  }
  return entries.sort((left, right) => left.order - right.order);
}

function observationMedia(
  value: Record<string, unknown>,
): ResearchObservation["media"] {
  const directMediaUrl = publicAssetUrl(
    firstPathText(value, [
      ["media", "mediaUrl"],
      ["media", "url"],
      ["mediaUrl"],
    ]),
  );
  const videoUrl = publicAssetUrl(
    firstPathText(value, [
      ["media", "videoUrl"],
      ["videoUrl"],
    ]),
  );
  const imageUrl = publicAssetUrl(
    firstPathText(value, [
      ["imageUrl"],
      ["content", "imageUrl"],
    ]),
  );
  const imageArrayUrl = firstPublicArrayUrl(value, [
    ["media", "imageUrls"],
    ["imageUrls"],
  ]);
  const mediaEntries = renderableMediaEntries(value);
  const selectedEntry = mediaEntries[0];
  const mediaUrl =
    directMediaUrl ??
    videoUrl ??
    selectedEntry?.url ??
    imageArrayUrl ??
    imageUrl;
  const directThumbnailUrl = publicAssetUrl(
    firstPathText(value, [
      ["media", "thumbnailUrl"],
      ["thumbnailUrl"],
      ["content", "screenshotUrl"],
      ["screenshotUrl"],
    ]),
  );
  const mediaEntryThumbnail = mediaEntries.find(
    (entry) => entry.type === "image",
  )?.url;
  const thumbnailUrl =
    directThumbnailUrl ?? imageArrayUrl ?? mediaEntryThumbnail ?? imageUrl;
  if (!mediaUrl && !thumbnailUrl) return undefined;
  const type =
    normalizedMediaType(
      firstPathText(value, [
        ["media", "type"],
        ["mediaType"],
        ["type"],
      ]),
    ) ??
    (videoUrl && mediaUrl === videoUrl ? "video" : undefined) ??
    selectedEntry?.type ??
    inferredMediaType(mediaUrl) ??
    "image";
  return {
    type,
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function observationSourceUrl(
  value: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  const direct = firstPathText(value, [
    ["sourceUrl"],
    ["shareUrl"],
    ["url"],
    ["links", "tiktokUrl"],
    ["links", "profileUrl"],
    ["websiteUrl"],
    ["productUrl"],
    ["landingPageUrl"],
    ["domain"],
    ["content", "landingPageUrl"],
    ["advertiser", "websiteUrl"],
    ["advertiser", "domain"],
    ["profile", "bioUrl"],
    ["shop", "websiteUrl"],
    ["shop", "domain"],
  ]);
  return asSourceUrl(direct) ?? asSourceUrl(fallback);
}

function observationFinding(
  value: Record<string, unknown>,
  title: string,
  capability: ResearchProviderCapability,
): string {
  const content = isRecord(value.content) ? value.content : {};
  const profile = isRecord(value.profile) ? value.profile : {};
  const catalog = recordAt(value, ["catalog"]) ?? {};
  const traffic = recordAt(value, ["traffic"]) ?? {};
  const advertising = recordAt(value, ["advertising"]) ?? {};
  const trustpilot = recordAt(value, ["trustpilot"]) ?? {};
  const classification = recordAt(value, ["classification"]) ?? {};
  const event = recordAt(classification, ["event"]) ?? {};

  const formatCount = (count: number, label: string) =>
    `${new Intl.NumberFormat("en-US").format(count)} ${label}`;
  const formatPercent = (ratio: number, label: string) =>
    `${new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(ratio)} ${label}`;

  let details: Array<string | undefined>;
  if (capability === "competitors" || capability === "market") {
    const monthlyVisits =
      firstPathNumber(value, [["monthlyVisits"], ["traffic", "monthlyVisits"]]) ??
      numberAt(traffic, ["monthlyVisits"]);
    const growth30d =
      firstPathNumber(value, [["growth30d"], ["traffic", "growth30d"]]) ??
      numberAt(traffic, ["growth30d"]);
    const productsCount =
      firstPathNumber(value, [
        ["productsCount"],
        ["catalog", "productsCount"],
      ]) ?? numberAt(catalog, ["productsCount"]);
    const activeAds =
      firstPathNumber(value, [
        ["activeAds"],
        ["advertising", "activeAds"],
      ]) ?? numberAt(advertising, ["activeAds"]);
    const rating = numberAt(trustpilot, ["rating"]);
    const reviewCount = numberAt(trustpilot, ["reviewCount"]);
    details = [
      firstText(catalog, ["mainCategory"]),
      monthlyVisits === undefined
        ? undefined
        : formatCount(monthlyVisits, "monthly visits"),
      growth30d === undefined
        ? undefined
        : formatPercent(growth30d, "30-day traffic growth"),
      productsCount === undefined
        ? undefined
        : formatCount(productsCount, "products"),
      activeAds === undefined ? undefined : formatCount(activeAds, "active ads"),
      rating === undefined
        ? undefined
        : `${rating}/5 Trustpilot rating${
            reviewCount === undefined
              ? ""
              : ` from ${new Intl.NumberFormat("en-US").format(reviewCount)} reviews`
          }`,
      firstText(profile, ["countryCode"]),
    ];
  } else if (capability === "products") {
    const price = numberAt(value, ["price"]);
    const currency = firstText(value, ["currency"]);
    const rank = numberAt(value, ["rank"]);
    details = [
      title,
      price === undefined
        ? undefined
        : `${currency ? `${currency} ` : ""}${price}`,
      rank === undefined ? undefined : `best-seller rank ${rank}`,
      firstText(value, ["publishedAt", "createdAt"]),
    ];
  } else if (capability === "email_lifecycle") {
    details = [
      firstText(content, ["subject", "preheader", "bodyPreview"]),
      firstText(value, ["campaignType"]),
      firstText(classification, ["promotionType", "category"]),
      firstText(event, ["name", "category"]),
    ];
  } else if (capability === "social") {
    const socialDetails: string[] = [];
    for (const network of [
      "facebook",
      "instagram",
      "tiktok",
      "youtube",
      "linkedin",
    ]) {
      const networkValue = value[network];
      if (Array.isArray(networkValue)) {
        const latest = [...networkValue].reverse().find(isRecord);
        const followers = latest ? numberAt(latest, ["value"]) : undefined;
        if (followers !== undefined) {
          socialDetails.push(
            `${network}: ${formatCount(followers, "followers")}`,
          );
        }
        continue;
      }
      const networkRecord =
        recordAt(value, ["socials", network]) ??
        (isRecord(networkValue) ? networkValue : undefined);
      if (!networkRecord) continue;
      const handle = firstText(networkRecord, ["handle"]);
      const followers = numberAt(networkRecord, ["followers"]);
      if (handle || followers !== undefined) {
        socialDetails.push(
          `${network}: ${[
            handle ? `@${handle.replace(/^@/, "")}` : undefined,
            followers === undefined
              ? undefined
              : formatCount(followers, "followers"),
          ]
            .filter(Boolean)
            .join(", ")}`,
        );
      }
    }
    details = socialDetails;
  } else {
    details = [
      firstText(content, [
        "title",
        "subject",
        "description",
        "body",
        "bodyPreview",
        "transcript",
      ]),
      firstText(value, [
        "copy",
        "text",
        "status",
        "platform",
        "category",
        "campaignType",
      ]),
      typeof value.daysRunning === "number"
        ? `${value.daysRunning} days running`
        : undefined,
    ];
  }

  const usableDetails = details.filter(
    (item): item is string => Boolean(item?.trim()),
  );
  return usableDetails.length > 0
    ? [...new Set(usableDetails)].join(" | ").slice(0, 2_000)
    : `${title} was returned by Trendtrack for this research query.`;
}

function payloadRecords(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  return isRecord(payload.data) ? [payload.data] : [];
}

function boundedOptionalRowLimit(
  value: number | undefined,
  fallback: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(0, Math.min(5, Math.floor(candidate)));
}

function googleAdObservation(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const advertiser = recordAt(item, ["advertiser"]) ?? {};
  const name =
    firstText(item, ["name", "title", "subject"]) ??
    firstText(advertiser, ["name", "shopName", "domain"]);
  const id =
    firstIdentifier(item, ["id", "googleAdId"]) ??
    firstIdentifier(advertiser, ["id"]);
  const sourceUrl = observationSourceUrl(item);
  return {
    ...item,
    platform: "google",
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function tiktokObservation(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const content = recordAt(item, ["content"]) ?? {};
  const profile = recordAt(item, ["profile"]) ?? {};
  const publicVideoId = firstIdentifier(item, ["tiktokId", "videoId"]);
  const id = firstIdentifier(item, ["id"]) ?? publicVideoId;
  const handle = firstText(profile, ["handle"])?.replace(/^@/, "");
  const directSourceUrl = observationSourceUrl(item);
  const derivedSourceUrl =
    handle && publicVideoId
      ? `https://www.tiktok.com/@${encodeURIComponent(
          handle,
        )}/video/${encodeURIComponent(publicVideoId)}`
      : undefined;
  const title =
    firstText(content, ["title", "description"]) ??
    firstText(profile, ["name", "handle"]);
  return {
    ...item,
    platform: "tiktok",
    ...(id ? { id } : {}),
    ...(title ? { name: title.slice(0, 240) } : {}),
    ...(directSourceUrl || derivedSourceUrl
      ? { sourceUrl: directSourceUrl ?? derivedSourceUrl }
      : {}),
  };
}

interface TrendtrackResolvedShop {
  id?: string;
  domain?: string;
  name?: string;
}

interface TrendtrackCollectionOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  includeLimit?: boolean;
  requestedRows?: number;
  cacheKey?: string;
  fallbackTitle?: string;
  fallbackSourceUrl?: string;
  transformItem?: (
    item: Record<string, unknown>,
  ) => Record<string, unknown>;
  includeItem?: (item: Record<string, unknown>) => boolean;
}

interface TrendtrackCachedResponse {
  payload: unknown;
  creditsRemaining?: number;
}

class TrendtrackResearchProvider implements ResearchProvider {
  readonly id = "trendtrack" as const;
  readonly label = "Market Intelligence";
  private readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly fetchImpl: NonNullable<
    ResearchProviderHttpOptions["fetchImpl"]
  >;
  private readonly liveAccessApproved: boolean;
  private readonly maxCreditsPerRun: number;
  private readonly maxRowsPerRequest: number;
  private readonly maxGoogleAdsRowsPerRequest: number;
  private readonly maxTikTokRowsPerRequest: number;
  private readonly maxCompetitorsPerRun: number;
  private readonly minimumCreditReserve: number;
  private readonly now: () => Date;
  private runCreditsUsed = 0;
  private readonly shopResolutionCache = new Map<
    string,
    Promise<TrendtrackResolvedShop | null>
  >();
  private readonly responseCache = new Map<
    string,
    TrendtrackCachedResponse
  >();

  constructor(options: TrendtrackResearchProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.liveAccessApproved =
      options.liveAccessApproved ??
      (options.liveRequestsEnabled === true);
    this.maxCreditsPerRun = Math.max(
      0,
      Math.floor(options.maxCreditsPerRun ?? 0),
    );
    this.maxRowsPerRequest = Math.max(
      1,
      Math.min(25, Math.floor(options.maxRowsPerRequest ?? 5)),
    );
    this.maxGoogleAdsRowsPerRequest = boundedOptionalRowLimit(
      options.maxGoogleAdsRowsPerRequest,
      2,
    );
    this.maxTikTokRowsPerRequest = boundedOptionalRowLimit(
      options.maxTikTokRowsPerRequest,
      2,
    );
    this.maxCompetitorsPerRun = Math.max(
      1,
      Math.min(3, Math.floor(options.maxCompetitorsPerRun ?? 3)),
    );
    this.minimumCreditReserve = Math.max(
      0,
      Math.floor(options.minimumCreditReserve ?? 0),
    );
    this.now = options.now ?? (() => new Date());
  }

  private requestHeaders(): HeadersInit {
    return {
      authorization: `Bearer ${this.credential ?? ""}`,
      "content-type": "application/json",
    };
  }

  private preflightStatus(): ResearchProviderStatus {
    if (!this.credential) return "not_configured";
    if (!this.liveAccessApproved || this.maxCreditsPerRun <= 0) {
      return "disabled";
    }
    return "connected";
  }

  async getConnectionStatus(): Promise<ResearchProviderStatus> {
    const preflight = this.preflightStatus();
    if (preflight !== "connected") return preflight;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/me`, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 429) return "rate_limited";
      if (response.status === 402) return "insufficient_credits";
      return response.ok ? "connected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async discoverCapabilities(): Promise<ResearchProviderCapabilities> {
    return capabilitiesFor(this.id, await this.getConnectionStatus());
  }

  private async readCreditBalance(): Promise<
    | { status: "connected"; remaining: number }
    | { status: Exclude<ResearchProviderStatus, "connected"> }
  > {
    const status = this.preflightStatus();
    if (status !== "connected") return { status };
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/usage`, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 429) return { status: "rate_limited" };
      if (response.status === 402) return { status: "insufficient_credits" };
      if (!response.ok) return { status: "unavailable" };
      const body = (await response.json()) as unknown;
      const remainingHeader = response.headers.get("x-credits-remaining");
      const headerRemaining =
        remainingHeader === null ? undefined : Number(remainingHeader);
      const remaining =
        nestedNumber(body, ["data", "total", "remaining"]) ??
        nestedNumber(body, ["billing", "credits", "remaining"]) ??
        headerRemaining;
      return typeof remaining === "number" && Number.isFinite(remaining)
        ? { status: "connected", remaining }
        : { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }

  private async resolveShop(
    query: ResearchQuery,
  ): Promise<TrendtrackResolvedShop | null> {
    if (this.preflightStatus() !== "connected") return null;
    const seed = query.websiteUrl?.trim() || query.brandName.trim();
    if (!seed) return null;
    const cacheKey = seed.toLowerCase();
    const cached = this.shopResolutionCache.get(cacheKey);
    if (cached) return cached;

    const resolution = (async () => {
      try {
        const url = new URL(`${this.baseUrl}/v1/lookup`);
        url.searchParams.set("q", seed);
        url.searchParams.set("type", "shop");
        url.searchParams.set("limit", "10");
        const response = await this.fetchImpl(url, {
          headers: this.requestHeaders(),
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as unknown;
        const records = payloadRecords(payload);
        const targetDomain = canonicalDomain(query.websiteUrl);
        const targetName = query.brandName.trim().toLowerCase();
        const candidates = records
          .map((record) => {
            const shop = isRecord(record.shop) ? record.shop : record;
            return {
              id: firstIdentifier(shop, ["id", "uuid"]),
              domain: firstText(shop, ["domain", "websiteUrl"]),
              name: firstText(shop, ["name", "title"]),
              matchType: firstText(record, ["matchType"]),
            };
          })
          .filter(
            (candidate) =>
              candidate.id || candidate.domain || candidate.name,
          );
        const exactDomain = targetDomain
          ? candidates.find(
              (candidate) =>
                canonicalDomain(candidate.domain) === targetDomain,
            )
          : undefined;
        const exactName = candidates.find(
          (candidate) => candidate.name?.trim().toLowerCase() === targetName,
        );
        const exactMatch = candidates.find(
          (candidate) => candidate.matchType === "exact",
        );
        const selected = exactDomain ?? exactName ?? exactMatch ?? candidates[0];
        return selected
          ? {
              ...(selected.id ? { id: selected.id } : {}),
              ...(selected.domain ? { domain: selected.domain } : {}),
              ...(selected.name ? { name: selected.name } : {}),
            }
          : null;
      } catch {
        return null;
      }
    })();
    this.shopResolutionCache.set(cacheKey, resolution);
    return resolution;
  }

  private unresolvedShopResult(
    capability: ResearchProviderCapability,
  ): ResearchProviderResult {
    return {
      ...unavailableResult(this.id, capability, "unavailable"),
      coverageGaps: [
        `Trendtrack could not resolve the brand to a shop for ${capability} research.`,
      ],
    };
  }

  private buildCollectionResult(
    capability: ResearchProviderCapability,
    payload: unknown,
    options: TrendtrackCollectionOptions,
    usage: {
      creditsUsed: number;
      creditsRemaining?: number;
      requestId?: string;
    },
  ): ResearchProviderResult {
    const transformItem = options.transformItem ?? ((item) => item);
    const items = payloadRecords(payload)
      .map(transformItem)
      .filter((item) => options.includeItem?.(item) ?? true);
    const observations = items.map((item, index) => {
      const content = isRecord(item.content) ? item.content : {};
      const shop = isRecord(item.shop) ? item.shop : {};
      const title =
        firstText(item, ["name", "title", "subject", "domain"]) ??
        firstText(content, ["title", "subject"]) ??
        firstText(shop, ["name", "domain"]) ??
        firstIdentifier(item, ["id", "uuid"]) ??
        options.fallbackTitle ??
        `Trendtrack observation ${index + 1}`;
      const media = observationMedia(item);
      return {
        id:
          firstIdentifier(item, ["id", "uuid"]) ??
          `trendtrack-${capability}-${index + 1}`,
        provider: this.id,
        capability,
        sourceUrl: observationSourceUrl(
          item,
          options.fallbackSourceUrl,
        ),
        ...(media ? { media } : {}),
        observedAt:
          firstPathText(item, [
            ["observedAt"],
            ["lastSeenAt"],
            ["lastSeen"],
            ["sentAt"],
            ["updatedAt"],
            ["createdAt"],
            ["publishedAt"],
          ]) ?? this.now().toISOString(),
        title,
        finding: observationFinding(item, title, capability),
        confidence: "medium" as const,
        provenance: "provider" as const,
        data: item,
      };
    });

    return {
      provider: this.id,
      status: "connected",
      observations,
      coverageGaps:
        observations.length === 0
          ? ["Trendtrack returned no observations for this query."]
          : [],
      caveats: [
        "Trendtrack observations are unapproved provider signals.",
        "Worklin did not trigger a top-up or billing action.",
      ],
      usage: {
        creditsUsed: usage.creditsUsed,
        creditsRemaining: usage.creditsRemaining,
        runCreditsUsed: this.runCreditsUsed,
        runCreditLimit: this.maxCreditsPerRun,
        requestId: usage.requestId,
      },
    };
  }

  private async queryCollection(
    capability: ResearchProviderCapability,
    endpoint: string,
    options: TrendtrackCollectionOptions = {},
  ): Promise<ResearchProviderResult> {
    const cached = options.cacheKey
      ? this.responseCache.get(options.cacheKey)
      : undefined;
    if (cached) {
      return this.buildCollectionResult(capability, cached.payload, options, {
        creditsUsed: 0,
        creditsRemaining: cached.creditsRemaining,
      });
    }

    const balance = await this.readCreditBalance();
    if (balance.status !== "connected") {
      return unavailableResult(this.id, capability, balance.status);
    }

    const runCreditsRemaining = this.maxCreditsPerRun - this.runCreditsUsed;
    const accountCreditsAvailable =
      balance.remaining - this.minimumCreditReserve;
    const limit = Math.floor(
      Math.min(
        options.requestedRows ?? this.maxRowsPerRequest,
        runCreditsRemaining,
        accountCreditsAvailable,
      ),
    );
    if (limit <= 0) {
      return unavailableResult(this.id, capability, "insufficient_credits");
    }

    try {
      const method = options.method ?? "POST";
      const url = new URL(`${this.baseUrl}${endpoint}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      if (method === "GET" && options.includeLimit !== false) {
        url.searchParams.set("limit", String(limit));
      }
      const response = await this.fetchImpl(url, {
        method,
        headers: this.requestHeaders(),
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                ...(options.body ?? {}),
                ...(options.includeLimit === false ? {} : { limit }),
              }),
            }
          : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        return {
          ...unavailableResult(this.id, capability, "rate_limited"),
          retryAfterSeconds: Number.isFinite(retryAfter)
            ? retryAfter
            : undefined,
        };
      }
      if (response.status === 402) {
        return unavailableResult(this.id, capability, "insufficient_credits");
      }
      if (!response.ok) {
        return unavailableResult(this.id, capability, "unavailable");
      }

      const payload = (await response.json()) as unknown;
      const costHeader = response.headers.get("x-usage-cost");
      const headerCost = costHeader === null ? undefined : Number(costHeader);
      const creditsUsed =
        typeof headerCost === "number" && Number.isFinite(headerCost)
          ? Math.max(0, headerCost)
          : payloadRecords(payload).length;
      this.runCreditsUsed += creditsUsed;
      const creditsRemainingValue = response.headers.get("x-credits-remaining");
      const creditsRemainingHeader =
        creditsRemainingValue === null
          ? undefined
          : Number(creditsRemainingValue);
      const creditsRemaining =
        typeof creditsRemainingHeader === "number" &&
        Number.isFinite(creditsRemainingHeader)
          ? creditsRemainingHeader
          : balance.remaining - creditsUsed;
      if (options.cacheKey) {
        this.responseCache.set(options.cacheKey, {
          payload,
          creditsRemaining,
        });
      }
      return this.buildCollectionResult(capability, payload, options, {
        creditsUsed,
        creditsRemaining,
        requestId:
          response.headers.get("x-request-id") ??
          (isRecord(payload) && typeof payload.requestId === "string"
            ? payload.requestId
            : undefined),
      });
    } catch {
      return unavailableResult(this.id, capability, "unavailable");
    }
  }

  async researchCompetitors(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const subject = await this.resolveShop(query);
    const identifier =
      subject?.id ?? subject?.domain ?? canonicalDomain(query.websiteUrl);
    if (!identifier) return this.unresolvedShopResult("competitors");
    const subjectId = subject?.id;
    const subjectDomain =
      canonicalDomain(subject?.domain) ?? canonicalDomain(query.websiteUrl);
    const subjectIdentities = new Set(
      [
        query.brandName,
        query.websiteUrl,
        subject?.name,
        subject?.domain,
      ]
        .map(normalizedBrandIdentity)
        .filter((value): value is string => Boolean(value)),
    );

    return this.queryCollection(
      "competitors",
      `/v1/shops/${encodeURIComponent(identifier)}/similar`,
      {
        method: "GET",
        query: {
          sortBy: "relevance",
          order: "desc",
          offset: 0,
        },
        requestedRows: this.maxCompetitorsPerRun,
        fallbackTitle: `${query.brandName} competitor`,
        transformItem: (item) => {
          if (!isRecord(item.shop)) return item;
          const { shop, ...relationship } = item;
          return { ...shop, relationship };
        },
        includeItem: (item) => {
          const itemDomain = canonicalDomain(
            firstText(item, ["domain", "websiteUrl"]),
          );
          const itemName = firstText(item, ["name", "title"])
            ?.trim()
            .toLowerCase();
          const itemId = firstIdentifier(item, ["id", "uuid"]);
          const itemIdentities = [
            itemName,
            firstText(item, ["domain", "websiteUrl"]),
          ]
            .map(normalizedBrandIdentity)
            .filter((value): value is string => Boolean(value));
          return !(
            (subjectId && itemId === subjectId) ||
            (subjectDomain && itemDomain === subjectDomain) ||
            itemIdentities.some((identity) =>
              subjectIdentities.has(identity),
            )
          );
        },
      },
    );
  }

  async lookupLifecycleSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const subject = await this.resolveShop(query);
    if (!subject?.id) return this.unresolvedShopResult("email_lifecycle");
    return this.queryCollection(
      "email_lifecycle",
      `/v1/shops/${encodeURIComponent(subject.id)}/emails`,
      {
        method: "GET",
        query: { sortBy: "newest", page: 1 },
        fallbackTitle: `${subject.name ?? query.brandName} email`,
        fallbackSourceUrl: subject.domain,
      },
    );
  }

  async lookupSocialSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const subject = await this.resolveShop(query);
    if (!subject?.id) return this.unresolvedShopResult("social");
    return this.queryCollection(
      "social",
      `/v1/shops/${encodeURIComponent(subject.id)}`,
      {
        method: "GET",
        includeLimit: false,
        cacheKey: `shop-detail:${subject.id}`,
        fallbackTitle: `${subject.name ?? query.brandName} social footprint`,
        fallbackSourceUrl: subject.domain,
      },
    );
  }

  async lookupPaidMediaSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const preflight = this.preflightStatus();
    if (preflight !== "connected") {
      return unavailableResult(this.id, "paid_media", preflight);
    }
    const subject = await this.resolveShop(query);
    const brandName = subject?.name ?? query.brandName;
    const subjectDomain =
      canonicalDomain(subject?.domain) ?? canonicalDomain(query.websiteUrl);
    const fallbackSourceUrl = subject?.domain ?? query.websiteUrl;
    const shouldValidateIdentity = Boolean(subject || query.websiteUrl);
    const sources: Array<{
      label: string;
      endpoint: string;
      requestedRows: number;
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
      query?: Record<string, string | number | boolean | undefined>;
      transformItem?: (
        item: Record<string, unknown>,
      ) => Record<string, unknown>;
      includeItem?: (item: Record<string, unknown>) => boolean;
    }> = [
      {
        label: "Meta Ads",
        endpoint: "/v1/ads/query",
        requestedRows: this.maxRowsPerRequest,
        body: {
          search: [subjectDomain ?? brandName],
          searchType: subjectDomain ? "domain" : "brand",
          sortBy: "newest",
          order: "desc",
        },
        ...(shouldValidateIdentity
          ? {
              includeItem: (item: Record<string, unknown>) =>
                paidMediaMatchesSubject(item, query, subject),
            }
          : {}),
      },
      {
        label: "Google Ads",
        endpoint: "/v1/google-ads/query",
        requestedRows: this.maxGoogleAdsRowsPerRequest,
        body: {
          search: [subjectDomain ?? brandName],
          status: "all",
          sortBy: "newest",
          order: "desc",
          page: 1,
        },
        transformItem: googleAdObservation,
        ...(shouldValidateIdentity
          ? {
              includeItem: (item: Record<string, unknown>) =>
                paidMediaMatchesSubject(item, query, subject),
            }
          : {}),
      },
      ...(subject?.id
        ? [
            {
              label: "TikTok Ads",
              endpoint: `/v1/shops/${encodeURIComponent(
                subject.id,
              )}/tiktok/library`,
              requestedRows: this.maxTikTokRowsPerRequest,
              method: "GET" as const,
              query: {
                type: "all",
              },
              transformItem: tiktokObservation,
            },
          ]
        : []),
    ];
    const results: Array<{
      label: string;
      result: ResearchProviderResult;
    }> = [];
    const coverageGaps: string[] = [];

    for (const source of sources) {
      if (source.requestedRows <= 0) {
        coverageGaps.push(
          `${source.label}: collection is disabled by its zero row limit.`,
        );
        continue;
      }
      if (this.runCreditsUsed >= this.maxCreditsPerRun) {
        coverageGaps.push(
          `${source.label}: skipped because the run credit ceiling was reached before any metered request or top-up.`,
        );
        break;
      }
      const result = await this.queryCollection(
        "paid_media",
        source.endpoint,
        {
          method: source.method,
          body: source.body,
          query: source.query,
          requestedRows: source.requestedRows,
          fallbackTitle: `${brandName} advertisement`,
          fallbackSourceUrl,
          transformItem: source.transformItem,
          includeItem: source.includeItem,
        },
      );
      results.push({ label: source.label, result });
      if (
        result.status === "insufficient_credits" ||
        result.status === "rate_limited"
      ) {
        break;
      }
    }

    const observations = results.flatMap(
      ({ result }) => result.observations,
    );
    const hasConnectedResult = results.some(
      ({ result }) => result.status === "connected",
    );
    const statusPriority: ResearchProviderStatus[] = [
      "rate_limited",
      "insufficient_credits",
      "unavailable",
      "disabled",
      "not_configured",
    ];
    const status: ResearchProviderStatus = hasConnectedResult
      ? "connected"
      : (statusPriority.find((candidate) =>
          results.some(({ result }) => result.status === candidate),
        ) ?? "unavailable");
    const usageEntries = results
      .map(({ result }) => result.usage)
      .filter((usage): usage is ResearchProviderUsage => Boolean(usage));
    const latestBalance = [...usageEntries]
      .reverse()
      .find((usage) => usage.creditsRemaining !== undefined);
    const requestIds = usageEntries
      .map((usage) => usage.requestId)
      .filter((requestId): requestId is string => Boolean(requestId));
    const retryAfterSeconds = results
      .map(({ result }) => result.retryAfterSeconds)
      .filter((seconds): seconds is number => seconds !== undefined)
      .reduce<number | undefined>(
        (largest, seconds) =>
          largest === undefined ? seconds : Math.max(largest, seconds),
        undefined,
      );

    return {
      provider: this.id,
      status,
      observations,
      coverageGaps: [
        ...coverageGaps,
        ...results.flatMap(({ label, result }) =>
          result.coverageGaps.map((gap) => `${label}: ${gap}`),
        ),
      ],
      caveats: [
        ...new Set([
          ...results.flatMap(({ result }) => result.caveats),
          "Worklin did not trigger a top-up or billing action.",
        ]),
      ],
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(usageEntries.length > 0
        ? {
            usage: {
              creditsUsed: usageEntries.reduce(
                (sum, usage) => sum + usage.creditsUsed,
                0,
              ),
              ...(latestBalance?.creditsRemaining !== undefined
                ? { creditsRemaining: latestBalance.creditsRemaining }
                : {}),
              runCreditsUsed: this.runCreditsUsed,
              runCreditLimit: this.maxCreditsPerRun,
              ...(requestIds.length > 0
                ? { requestId: requestIds.join(",") }
                : {}),
            },
          }
        : {}),
    };
  }

  async lookupProductSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const subject = await this.resolveShop(query);
    if (!subject?.id) return this.unresolvedShopResult("products");
    return this.queryCollection(
      "products",
      `/v1/shops/${encodeURIComponent(subject.id)}/products`,
      {
        method: "GET",
        query: {
          offset: 0,
          sortBy: "popularity",
          order: "asc",
        },
        fallbackTitle: `${subject.name ?? query.brandName} product`,
        fallbackSourceUrl: subject.domain,
      },
    );
  }

  lookupSeoSignals(): Promise<ResearchProviderResult> {
    return Promise.resolve({
      ...unavailableResult(this.id, "seo", "unavailable"),
      coverageGaps: [
        "Trendtrack does not provide authoritative keyword rankings, search volumes, or backlink data.",
      ],
    });
  }

  async lookupMarketSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    const subject = await this.resolveShop(query);
    if (!subject?.id) return this.unresolvedShopResult("market");
    return this.queryCollection(
      "market",
      `/v1/shops/${encodeURIComponent(subject.id)}`,
      {
        method: "GET",
        includeLimit: false,
        cacheKey: `shop-detail:${subject.id}`,
        fallbackTitle: subject.name ?? query.brandName,
        fallbackSourceUrl: subject.domain,
      },
    );
  }
}

class HttpResearchProvider implements ResearchProvider {
  readonly id: ResearchProviderId;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly fetchImpl: NonNullable<
    ResearchProviderHttpOptions["fetchImpl"]
  >;
  private readonly capability: ResearchProviderCapability;
  private readonly endpoint: string;

  constructor(
    id: ResearchProviderId,
    label: string,
    capability: ResearchProviderCapability,
    options: ResearchProviderHttpOptions,
    endpoint: string,
  ) {
    this.id = id;
    this.label = label;
    this.capability = capability;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = endpoint;
  }

  async getConnectionStatus(): Promise<ResearchProviderStatus> {
    if (!this.credential) return "not_configured";
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: { authorization: `Bearer ${this.credential}` },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 429) return "rate_limited";
      return response.ok ? "connected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async discoverCapabilities(): Promise<ResearchProviderCapabilities> {
    return capabilitiesFor(this.id, await this.getConnectionStatus());
  }

  private async request(query: ResearchQuery): Promise<ResearchProviderResult> {
    if (!this.credential)
      return unavailableResult(this.id, this.capability, "not_configured");
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${this.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        return {
          ...unavailableResult(this.id, this.capability, "rate_limited"),
          retryAfterSeconds: Number.isFinite(retryAfter)
            ? retryAfter
            : undefined,
        };
      }
      if (!response.ok)
        return unavailableResult(this.id, this.capability, "unavailable");
      const body = (await response.json()) as { observations?: unknown };
      const observations = Array.isArray(body.observations)
        ? body.observations
            .filter((item): item is ResearchObservation => {
              if (!item || typeof item !== "object") return false;
              const value = item as Record<string, unknown>;
              return (
                typeof value.title === "string" &&
                typeof value.finding === "string"
              );
            })
            .map((item, index) => ({
              ...item,
              id: item.id || `${this.id}-${index + 1}`,
              provider: this.id,
              capability: this.capability,
              observedAt: item.observedAt || new Date().toISOString(),
              confidence: item.confidence || "low",
              provenance: "provider" as const,
            }))
        : [];
      return {
        provider: this.id,
        status: "connected",
        observations,
        coverageGaps:
          observations.length === 0
            ? [`${this.label} returned no observations.`]
            : [],
        caveats: [
          "Provider-sourced observations are not approved brand claims.",
        ],
      };
    } catch {
      return unavailableResult(this.id, this.capability, "unavailable");
    }
  }

  researchCompetitors(query: ResearchQuery): Promise<ResearchProviderResult> {
    return this.request(query);
  }

  lookupLifecycleSignals(
    query: ResearchQuery,
  ): Promise<ResearchProviderResult> {
    return this.request(query);
  }

  lookupSocialSignals(query: ResearchQuery): Promise<ResearchProviderResult> {
    return this.request(query);
  }
}

export function createTrendtrackProvider(
  options: TrendtrackResearchProviderOptions,
): ResearchProvider {
  return new TrendtrackResearchProvider(options);
}

export function createMeldProvider(
  options: ResearchProviderHttpOptions,
): ResearchProvider {
  return new HttpResearchProvider(
    "meld",
    "Meld",
    "competitors",
    options,
    "/research/competitors",
  );
}

export function createSocialProvider(
  id: (typeof SOCIAL_PROVIDERS)[number],
  options: ResearchProviderHttpOptions,
): ResearchProvider {
  const labels: Record<(typeof SOCIAL_PROVIDERS)[number], string> = {
    instagram: "Instagram official API",
    facebook: "Facebook official API",
    linkedin: "LinkedIn official API",
    youtube: "YouTube Data API",
  };
  return new HttpResearchProvider(
    id,
    labels[id],
    "social",
    options,
    "/public/account",
  );
}

export function createResearchProviderRegistry(options: {
  trendtrack?: TrendtrackResearchProviderOptions;
  meld?: ResearchProviderHttpOptions;
  social?: Partial<
    Record<(typeof SOCIAL_PROVIDERS)[number], ResearchProviderHttpOptions>
  >;
}): ResearchProvider[] {
  const providers: ResearchProvider[] = [];
  if (options.trendtrack) {
    providers.push(createTrendtrackProvider(options.trendtrack));
  }
  if (options.meld) providers.push(createMeldProvider(options.meld));
  for (const id of SOCIAL_PROVIDERS) {
    const config = options.social?.[id];
    if (config) providers.push(createSocialProvider(id, config));
  }
  return providers;
}
