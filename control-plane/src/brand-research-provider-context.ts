import type {
  ResearchObservation,
  ResearchProvider,
  ResearchProviderCapability,
  ResearchProviderStatus,
  ResearchQuery,
} from "@vellumai/retention-domain";

export interface BrandResearchProviderEvidence {
  id: string;
  provider: string;
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
}

export interface BrandResearchProviderContext {
  status: ResearchProviderStatus;
  capabilities: ResearchProviderCapability[];
  observations: BrandResearchProviderEvidence[];
  gaps: string[];
  usage: {
    creditsUsed: number;
    creditsRemaining?: number;
    runCreditLimit?: number;
    requestIds: string[];
  };
}

type ProviderOperation = {
  capability: ResearchProviderCapability;
  run: () => ReturnType<ResearchProvider["researchCompetitors"]>;
};

function sanitizeObservation(
  observation: ResearchObservation,
): BrandResearchProviderEvidence {
  return {
    id: `${observation.provider}:${observation.capability}:${observation.id}`,
    provider: observation.provider,
    capability: observation.capability,
    ...(observation.sourceUrl ? { sourceUrl: observation.sourceUrl } : {}),
    ...(observation.media ? { media: observation.media } : {}),
    observedAt: observation.observedAt,
    title: observation.title,
    finding: observation.finding,
    confidence: observation.confidence,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

export async function collectBrandResearchProviderContext(
  provider: ResearchProvider,
  query: ResearchQuery,
): Promise<BrandResearchProviderContext> {
  const discovered = await provider.discoverCapabilities();
  const context: BrandResearchProviderContext = {
    status: discovered.status,
    capabilities: discovered.capabilities,
    observations: [],
    gaps: [...discovered.caveats],
    usage: {
      creditsUsed: 0,
      requestIds: [],
    },
  };
  if (discovered.status !== "connected") {
    context.gaps.push(
      discovered.status === "disabled"
        ? "Live Market Intelligence collection is disabled."
        : `Market Intelligence collection is ${discovered.status}.`,
    );
    context.gaps = unique(context.gaps);
    return context;
  }

  const operations: ProviderOperation[] = [
    {
      capability: "competitors",
      run: () => provider.researchCompetitors(query),
    },
    {
      capability: "email_lifecycle",
      run: () => provider.lookupLifecycleSignals(query),
    },
    {
      capability: "social",
      run: () => provider.lookupSocialSignals(query),
    },
  ];
  if (provider.lookupPaidMediaSignals) {
    operations.push({
      capability: "paid_media",
      run: () => provider.lookupPaidMediaSignals!(query),
    });
  }
  if (provider.lookupProductSignals) {
    operations.push({
      capability: "products",
      run: () => provider.lookupProductSignals!(query),
    });
  }
  if (provider.lookupMarketSignals) {
    operations.push({
      capability: "market",
      run: () => provider.lookupMarketSignals!(query),
    });
  }
  const supportedOperations = operations.filter((operation) =>
    discovered.capabilities.includes(operation.capability),
  );

  for (const operation of supportedOperations) {
    const result = await operation.run();
    context.observations.push(...result.observations.map(sanitizeObservation));
    context.gaps.push(...result.coverageGaps, ...result.caveats);
    if (result.usage) {
      context.usage.creditsUsed += result.usage.creditsUsed;
      context.usage.creditsRemaining = result.usage.creditsRemaining;
      context.usage.runCreditLimit = result.usage.runCreditLimit;
      if (result.usage.requestId) {
        context.usage.requestIds.push(result.usage.requestId);
      }
    }
    if (
      result.status === "insufficient_credits" ||
      result.status === "rate_limited"
    ) {
      break;
    }
  }

  context.observations = [
    ...new Map(
      context.observations.map((observation) => [observation.id, observation]),
    ).values(),
  ];
  context.gaps = unique(context.gaps);
  context.usage.requestIds = unique(context.usage.requestIds);
  return context;
}
