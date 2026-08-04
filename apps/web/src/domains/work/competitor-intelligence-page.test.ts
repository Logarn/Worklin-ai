import { describe, expect, test } from "bun:test";

import { parseCompetitorIntelligence } from "./competitor-intelligence-model";
import { hangaritasLivePreview } from "./hangaritas-live-preview";

describe("competitor intelligence artifact", () => {
  test("parses bounded visual evidence and rejects unsafe media URLs", () => {
    const report = parseCompetitorIntelligence({
      generatedAt: "2026-07-29T00:00:00.000Z",
      query: {
        brandName: "Example Brand",
        websiteUrl: "https://example.com",
      },
      identity: {},
      channelFindings: {},
      evidence: [
        {
          id: "evidence-1",
          url: "https://example.com/ad",
          title: "Public ad",
          sourceType: "competitor_site",
          observedAt: "2026-07-29T00:00:00.000Z",
          finding: "A public creative was visible.",
          confidence: "high",
        },
      ],
      visualEvidence: [
        {
          id: "visual-1",
          kind: "ad",
          title: "Public ad",
          sourceUrl: "https://example.com/ad",
          thumbnailUrl: "https://cdn.example.com/ad.png",
          observedAt: "2026-07-29T00:00:00.000Z",
          evidenceIds: ["evidence-1"],
          caveats: [],
        },
        {
          id: "visual-2",
          kind: "email",
          title: "Unsafe preview",
          sourceUrl: "https://example.com/email",
          thumbnailUrl: "data:image/png;base64,secret",
          observedAt: "2026-07-29T00:00:00.000Z",
          evidenceIds: [],
          caveats: [],
        },
      ],
    });

    expect(report?.query.brandName).toBe("Example Brand");
    expect(report?.visualEvidence).toHaveLength(2);
    expect(report?.visualEvidence[0]?.thumbnailUrl).toBe(
      "https://cdn.example.com/ad.png",
    );
    expect(report?.visualEvidence[1]?.thumbnailUrl).toBeUndefined();
  });

  test("requires a structured report with a brand identity", () => {
    expect(parseCompetitorIntelligence(null)).toBeNull();
    expect(parseCompetitorIntelligence({ query: {} })).toBeNull();
  });

  test("keeps every competitor evidence area explicit", () => {
    expect(hangaritasLivePreview.competitorLandscape).toHaveLength(3);

    for (const competitor of hangaritasLivePreview.competitorLandscape) {
      expect(competitor.details).toBeDefined();
      expect(Object.keys(competitor.details?.coverage ?? {}).sort()).toEqual([
        "emails",
        "google",
        "meta",
        "overview",
        "products",
        "social",
        "tiktok",
        "tools",
      ]);
    }

    const buddii = hangaritasLivePreview.competitorLandscape[0];
    const revive = hangaritasLivePreview.competitorLandscape[1];
    const humans = hangaritasLivePreview.competitorLandscape[2];

    expect(buddii?.details?.products).toHaveLength(1);
    expect(buddii?.details?.emails).toHaveLength(1);
    expect(revive?.details?.metaAds).toHaveLength(1);
    expect(revive?.details?.googleAds).toHaveLength(0);
    expect(humans?.details?.metaAds).toHaveLength(1);
    expect(humans?.details?.tiktok).toHaveLength(1);
    expect(humans?.details?.googleAds).toHaveLength(1);
  });
});
