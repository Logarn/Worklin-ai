export type ResearchProviderId =
  | "meld"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "youtube";

export type ResearchProviderStatus =
  | "connected"
  | "not_configured"
  | "unavailable"
  | "rate_limited";

export type ResearchProviderCapability =
  | "competitors"
  | "email_lifecycle"
  | "social";

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
  observedAt: string;
  title: string;
  finding: string;
  confidence: "high" | "medium" | "low";
  provenance: "public" | "provider";
}

export interface ResearchProviderResult {
  provider: ResearchProviderId;
  status: ResearchProviderStatus;
  observations: ResearchObservation[];
  coverageGaps: string[];
  caveats: string[];
  retryAfterSeconds?: number;
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
}

export interface ResearchProviderHttpOptions {
  baseUrl: string;
  credential?: string | null;
  fetchImpl?: typeof fetch;
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
        : "The provider did not return usable evidence; public research remains the fallback.",
    ],
  };
}

function capabilitiesFor(
  provider: ResearchProviderId,
  status: ResearchProviderStatus,
): ResearchProviderCapabilities {
  const capabilities: ResearchProviderCapability[] =
    provider === "meld"
      ? ["competitors", "email_lifecycle", "social"]
      : ["social"];
  return {
    provider,
    status,
    capabilities: status === "connected" ? capabilities : [],
    caveats: [
      "Provider results are kept separate from public evidence and never include credentials.",
      ...(provider === "meld"
        ? [
            "Meld coverage depends on the workspace plan and the competitor signals it exposes.",
          ]
        : [
            "Only data returned by the connected official provider is used; Worklin does not scrape authenticated systems.",
          ]),
    ],
  };
}

class HttpResearchProvider implements ResearchProvider {
  readonly id: ResearchProviderId;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly fetchImpl: typeof fetch;
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
  meld?: ResearchProviderHttpOptions;
  social?: Partial<
    Record<(typeof SOCIAL_PROVIDERS)[number], ResearchProviderHttpOptions>
  >;
}): ResearchProvider[] {
  const providers: ResearchProvider[] = [];
  if (options.meld) providers.push(createMeldProvider(options.meld));
  for (const id of SOCIAL_PROVIDERS) {
    const config = options.social?.[id];
    if (config) providers.push(createSocialProvider(id, config));
  }
  return providers;
}
