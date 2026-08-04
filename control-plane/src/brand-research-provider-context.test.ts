import { describe, expect, test } from "bun:test";

import type {
  ResearchProvider,
  ResearchProviderResult,
} from "@vellumai/retention-domain";

import { collectBrandResearchProviderContext } from "./brand-research-provider-context.js";

function result(
  capability: "competitors" | "email_lifecycle" | "social",
  creditsUsed: number,
): ResearchProviderResult {
  return {
    provider: "trendtrack",
    status: "connected",
    observations: [
      {
        id: `${capability}-1`,
        provider: "trendtrack",
        capability,
        sourceUrl: "https://example.com/source",
        media: {
          type: "image",
          thumbnailUrl: "https://cdn.example.com/evidence/preview.png",
        },
        observedAt: "2026-07-29T00:00:00.000Z",
        title: `${capability} signal`,
        finding: "A public provider-backed signal.",
        confidence: "medium",
        provenance: "provider",
        data: { privateShapeNotForwarded: true },
      },
    ],
    coverageGaps: [],
    caveats: [],
    usage: {
      creditsUsed,
      creditsRemaining: 20 - creditsUsed,
      runCreditsUsed: creditsUsed,
      runCreditLimit: 10,
      requestId: `request-${capability}`,
    },
  };
}

describe("brand research provider context", () => {
  test("does not collect when the provider is disabled", async () => {
    let meteredCalls = 0;
    const provider: ResearchProvider = {
      id: "trendtrack",
      label: "Market Intelligence",
      getConnectionStatus: async () => "disabled",
      discoverCapabilities: async () => ({
        provider: "trendtrack",
        status: "disabled",
        capabilities: [],
        caveats: [],
      }),
      researchCompetitors: async () => {
        meteredCalls += 1;
        return result("competitors", 1);
      },
      lookupLifecycleSignals: async () => {
        meteredCalls += 1;
        return result("email_lifecycle", 1);
      },
      lookupSocialSignals: async () => {
        meteredCalls += 1;
        return result("social", 1);
      },
    };

    const context = await collectBrandResearchProviderContext(provider, {
      brandName: "Acme",
    });

    expect(context.status).toBe("disabled");
    expect(context.observations).toEqual([]);
    expect(context.usage.creditsUsed).toBe(0);
    expect(meteredCalls).toBe(0);
  });

  test("collects sequential provider evidence without forwarding raw data", async () => {
    const calls: string[] = [];
    const provider: ResearchProvider = {
      id: "trendtrack",
      label: "Market Intelligence",
      getConnectionStatus: async () => "connected",
      discoverCapabilities: async () => ({
        provider: "trendtrack",
        status: "connected",
        capabilities: ["competitors", "email_lifecycle", "social"],
        caveats: [],
      }),
      researchCompetitors: async () => {
        calls.push("competitors");
        return result("competitors", 2);
      },
      lookupLifecycleSignals: async () => {
        calls.push("email_lifecycle");
        return result("email_lifecycle", 1);
      },
      lookupSocialSignals: async () => {
        calls.push("social");
        return result("social", 1);
      },
    };

    const context = await collectBrandResearchProviderContext(provider, {
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    });

    expect(calls).toEqual(["competitors", "email_lifecycle", "social"]);
    expect(context.observations).toHaveLength(3);
    expect(context.observations[0]).not.toHaveProperty("data");
    expect(context.observations[0]?.media).toEqual({
      type: "image",
      thumbnailUrl: "https://cdn.example.com/evidence/preview.png",
    });
    expect(context.usage).toMatchObject({
      creditsUsed: 4,
      runCreditLimit: 10,
    });
    expect(context.usage.requestIds).toEqual([
      "request-competitors",
      "request-email_lifecycle",
      "request-social",
    ]);
  });
});
