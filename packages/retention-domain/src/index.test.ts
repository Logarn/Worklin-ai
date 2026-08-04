import { describe, expect, test } from "bun:test";

import {
  applyBrandBrainCorrection,
  buildDeepRetentionAudit,
  buildRetentionContextPack,
  buildRetentionMicroSegments,
  buildUnifiedCustomerView,
  buildUnifiedRetentionAudit,
  computeRetentionCustomerFeatures,
  createDraftBrandBrain,
  findRetentionCampaignOpportunities,
  findRetentionMissingPieces,
  generateRetentionAuditArtifact,
  getRetentionAuditStatus,
  generateRetentionCampaignPackage,
  getRetentionBrandBrain,
  getRetentionKlaviyoSnapshot,
  getRetentionShopifySnapshot,
  getRetentionSourceStatus,
  RETENTION_BLOCKED_CAPABILITIES,
  recordBrandBrainCampaignLearning,
  runRetentionQa,
  scheduleRetentionAudit,
  scoreRetentionCustomers,
} from "./index.js";
import {
  createMeldProvider,
  createSocialProvider,
  createTrendtrackProvider,
} from "./research-providers.js";

describe("retention-domain safety posture", () => {
  test("research providers stay explicit when credentials are absent", async () => {
    const meld = createMeldProvider({ baseUrl: "https://meld.invalid" });
    const social = createSocialProvider("youtube", {
      baseUrl: "https://youtube.invalid",
    });
    expect(await meld.getConnectionStatus()).toBe("not_configured");
    expect(
      (await meld.researchCompetitors({ brandName: "Acme" })).coverageGaps,
    ).toContain("competitors coverage is not_configured.");
    expect(
      (await social.lookupSocialSignals({ brandName: "Acme" })).status,
    ).toBe("not_configured");
  });

  test("Trendtrack makes no request unless live access and a budget are explicit", async () => {
    let requestCount = 0;
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      fetchImpl: async () => {
        requestCount += 1;
        return Response.json({});
      },
    });

    expect(await provider.getConnectionStatus()).toBe("disabled");
    expect(
      (await provider.lookupPaidMediaSignals!({ brandName: "Acme" })).status,
    ).toBe("disabled");
    expect(requestCount).toBe(0);
  });

  test("Trendtrack stops before a metered request when the reserve would be crossed", async () => {
    const requestedUrls: string[] = [];
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 10,
      minimumCreditReserve: 5,
      fetchImpl: async (input) => {
        requestedUrls.push(String(input));
        if (String(input).includes("/v1/lookup")) {
          return Response.json({
            data: [
              {
                type: "shop",
                matchType: "exact",
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
            ],
          });
        }
        return Response.json({ data: { total: { remaining: 5 } } });
      },
    });

    const result = await provider.researchCompetitors({
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    });

    expect(result.status).toBe("insufficient_credits");
    expect(requestedUrls).toEqual([
      "https://api.trendtrack.invalid/v1/lookup?q=https%3A%2F%2Facme.example&type=shop&limit=10",
      "https://api.trendtrack.invalid/v1/usage",
    ]);
  });

  test("Trendtrack normalizes mocked evidence and reports bounded credit use", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 3,
      maxGoogleAdsRowsPerRequest: 0,
      maxTikTokRowsPerRequest: 0,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/v1/usage")) {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        requestBodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            requestId: "request-1",
            data: [
              {
                id: "ad-1",
                status: "active",
                daysRunning: 12,
                content: {
                  title: "Summer offer",
                  body: "A public advertisement.",
                },
              },
              {
                id: "ad-2",
                status: "active",
                content: { title: "Product demonstration" },
              },
            ],
          },
          {
            headers: {
              "x-usage-cost": "2",
              "x-credits-remaining": "98",
              "x-request-id": "request-1",
            },
          },
        );
      },
    });

    const result = await provider.lookupPaidMediaSignals!({
      brandName: "Acme",
    });

    expect(requestBodies).toEqual([
      expect.objectContaining({ limit: 3, search: ["Acme"] }),
    ]);
    expect(result.status).toBe("connected");
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toMatchObject({
      provider: "trendtrack",
      capability: "paid_media",
      id: "ad-1",
    });
    expect(result.usage).toMatchObject({
      creditsUsed: 2,
      creditsRemaining: 98,
      runCreditsUsed: 2,
      runCreditLimit: 3,
    });
  });

  test("Trendtrack uses dedicated ad APIs and normalizes renderable media", async () => {
    const postBodies = new Map<string, Record<string, unknown>>();
    const requestedUrls: URL[] = [];
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveAccessApproved: true,
      maxCreditsPerRun: 8,
      maxRowsPerRequest: 1,
      maxGoogleAdsRowsPerRequest: 1,
      maxTikTokRowsPerRequest: 4,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requestedUrls.push(url);
        if (typeof init?.body === "string") {
          postBodies.set(
            url.pathname,
            JSON.parse(init.body) as Record<string, unknown>,
          );
        }
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                matchType: "exact",
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        if (url.pathname === "/v1/ads/query") {
          return Response.json(
            { data: [] },
            {
              headers: {
                "x-usage-cost": "0",
                "x-credits-remaining": "100",
              },
            },
          );
        }
        if (url.pathname === "/v1/google-ads/query") {
          return Response.json(
            {
              data: [
                {
                  id: "google-image",
                  googleAdId: "google-101",
                  status: "active",
                  media: {
                    type: "image",
                    url: "https://cdn.example.com/google/image.png",
                  },
                  advertiser: {
                    name: "Acme",
                    domain: "acme.example",
                  },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "1",
                "x-credits-remaining": "99",
              },
            },
          );
        }
        if (
          url.pathname ===
          "/v1/shops/shop-acme/tiktok/library"
        ) {
          return Response.json(
            {
              data: [
                {
                  id: "tiktok-video-url",
                  tiktokId: "741",
                  media: {
                    type: "video",
                    thumbnailUrl:
                      "https://cdn.example.com/tiktok/video-thumb.jpg",
                    videoUrl:
                      "https://cdn.example.com/tiktok/video.mp4",
                  },
                  content: { description: "A public TikTok video ad." },
                  links: {
                    tiktokUrl:
                      "https://www.tiktok.com/@acme/video/741",
                  },
                  profile: { handle: "acme", name: "Acme" },
                },
                {
                  id: "tiktok-media-url",
                  tiktokId: "742",
                  media: {
                    type: "video",
                    mediaUrl:
                      "https://cdn.example.com/tiktok/direct-video.mp4",
                  },
                  links: {
                    tiktokUrl:
                      "https://www.tiktok.com/@acme/video/742",
                  },
                },
                {
                  id: "tiktok-image-urls",
                  tiktokId: "743",
                  media: {
                    type: "image",
                    imageUrls: [
                      "https://cdn.example.com/tiktok/carousel-1.jpg",
                      "https://cdn.example.com/tiktok/carousel-2.jpg",
                    ],
                  },
                  links: {
                    tiktokUrl:
                      "https://www.tiktok.com/@acme/video/743",
                  },
                },
                {
                  id: "tiktok-medias",
                  tiktokId: "744",
                  media: {
                    medias: [
                      {
                        type: "image",
                        url: "https://cdn.example.com/tiktok/ordered-thumb.jpg",
                        order: 1,
                      },
                      {
                        type: "video",
                        url: "https://cdn.example.com/tiktok/ordered-video.mp4",
                        order: 0,
                      },
                    ],
                  },
                  links: {
                    tiktokUrl:
                      "https://www.tiktok.com/@acme/video/744",
                  },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "4",
                "x-credits-remaining": "95",
              },
            },
          );
        }
        throw new Error(`Unexpected Trendtrack route: ${url.pathname}`);
      },
    });

    const result = await provider.lookupPaidMediaSignals!({
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    });

    expect([...postBodies.keys()]).toEqual([
      "/v1/ads/query",
      "/v1/google-ads/query",
    ]);
    expect(postBodies.get("/v1/ads/query")).toMatchObject({
      search: ["acme.example"],
      searchType: "domain",
      limit: 1,
    });
    expect(postBodies.get("/v1/google-ads/query")).toMatchObject({
      search: ["acme.example"],
      limit: 1,
    });
    const tiktokRequest = requestedUrls.find(
      (url) =>
        url.pathname === "/v1/shops/shop-acme/tiktok/library",
    );
    expect(tiktokRequest?.searchParams.get("type")).toBe("all");
    expect(tiktokRequest?.searchParams.get("limit")).toBe("4");
    expect(result.observations).toHaveLength(5);
    expect(
      result.observations.find(
        (observation) => observation.id === "google-image",
      ),
    ).toMatchObject({
      sourceUrl: "https://acme.example",
      media: {
        type: "image",
        mediaUrl: "https://cdn.example.com/google/image.png",
      },
    });
    expect(
      result.observations.find(
        (observation) => observation.id === "tiktok-video-url",
      ),
    ).toMatchObject({
      sourceUrl: "https://www.tiktok.com/@acme/video/741",
      media: {
        type: "video",
        mediaUrl: "https://cdn.example.com/tiktok/video.mp4",
        thumbnailUrl:
          "https://cdn.example.com/tiktok/video-thumb.jpg",
      },
    });
    expect(
      result.observations.find(
        (observation) => observation.id === "tiktok-media-url",
      )?.media,
    ).toEqual({
      type: "video",
      mediaUrl: "https://cdn.example.com/tiktok/direct-video.mp4",
    });
    expect(
      result.observations.find(
        (observation) => observation.id === "tiktok-image-urls",
      )?.media,
    ).toEqual({
      type: "image",
      mediaUrl: "https://cdn.example.com/tiktok/carousel-1.jpg",
      thumbnailUrl: "https://cdn.example.com/tiktok/carousel-1.jpg",
    });
    expect(
      result.observations.find(
        (observation) => observation.id === "tiktok-medias",
      )?.media,
    ).toEqual({
      type: "video",
      mediaUrl: "https://cdn.example.com/tiktok/ordered-video.mp4",
      thumbnailUrl:
        "https://cdn.example.com/tiktok/ordered-thumb.jpg",
    });
    expect(
      result.observations.every(
        (observation) => observation.media && observation.sourceUrl,
      ),
    ).toBe(true);
    expect(result.usage).toMatchObject({
      creditsUsed: 5,
      creditsRemaining: 95,
      runCreditsUsed: 5,
      runCreditLimit: 8,
    });
  });

  test("Trendtrack rejects paid-media rows from look-alike brands", async () => {
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveAccessApproved: true,
      maxCreditsPerRun: 2,
      maxRowsPerRequest: 1,
      maxGoogleAdsRowsPerRequest: 1,
      maxTikTokRowsPerRequest: 0,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                matchType: "exact",
                shop: {
                  id: "shop-revive",
                  domain: "revivepluslabs.com",
                  name: "REVIVE+ LABS",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        if (url.pathname === "/v1/ads/query") {
          return Response.json(
            {
              data: [
                {
                  id: "meta-lookalike",
                  advertiser: { name: "BioRevive Labs" },
                  content: {
                    landingPageDomain: "biorevive.co.uk",
                  },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "1",
                "x-credits-remaining": "99",
              },
            },
          );
        }
        if (url.pathname === "/v1/google-ads/query") {
          return Response.json(
            {
              data: [
                {
                  id: "google-lookalike",
                  advertiser: {
                    name: "Revive Hydration",
                    domain: "revive-hydration.co",
                  },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "1",
                "x-credits-remaining": "98",
              },
            },
          );
        }
        throw new Error(`Unexpected Trendtrack route: ${url.pathname}`);
      },
    });

    const result = await provider.lookupPaidMediaSignals!({
      brandName: "REVIVE+ LABS",
      websiteUrl: "https://revivepluslabs.com",
    });

    expect(result.status).toBe("connected");
    expect(result.observations).toEqual([]);
    expect(result.usage).toMatchObject({
      creditsUsed: 2,
      runCreditsUsed: 2,
      runCreditLimit: 2,
    });
    expect(result.coverageGaps.join(" ")).toContain(
      "returned no observations",
    );
  });

  test("Trendtrack stops dedicated ad queries at the run credit ceiling", async () => {
    const meteredPaths: string[] = [];
    let usageChecks = 0;
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveAccessApproved: true,
      maxCreditsPerRun: 3,
      maxRowsPerRequest: 2,
      maxGoogleAdsRowsPerRequest: 2,
      maxTikTokRowsPerRequest: 2,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                matchType: "exact",
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          usageChecks += 1;
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        const body = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        meteredPaths.push(url.pathname);
        if (url.pathname === "/v1/ads/query") {
          expect(body.limit).toBe(2);
          return Response.json(
            {
              data: [
                {
                  id: "meta-1",
                  content: {
                    landingPageDomain: "acme.example",
                  },
                },
                {
                  id: "meta-2",
                  content: {
                    landingPageDomain: "acme.example",
                  },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "2",
                "x-credits-remaining": "98",
              },
            },
          );
        }
        if (url.pathname === "/v1/google-ads/query") {
          expect(body.limit).toBe(1);
          return Response.json(
            {
              data: [
                {
                  id: "google-1",
                  media: {
                    type: "image",
                    url: "https://cdn.example.com/google/one.png",
                  },
                  advertiser: { domain: "acme.example" },
                },
              ],
            },
            {
              headers: {
                "x-usage-cost": "1",
                "x-credits-remaining": "97",
              },
            },
          );
        }
        throw new Error(
          `A metered request crossed the run ceiling: ${url.pathname}`,
        );
      },
    });

    const result = await provider.lookupPaidMediaSignals!({
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    });

    expect(meteredPaths).toEqual([
      "/v1/ads/query",
      "/v1/google-ads/query",
    ]);
    expect(usageChecks).toBe(2);
    expect(result.observations).toHaveLength(3);
    expect(result.usage).toMatchObject({
      creditsUsed: 3,
      runCreditsUsed: 3,
      runCreditLimit: 3,
    });
    expect(result.coverageGaps.join(" ")).toContain(
      "TikTok Ads: skipped because the run credit ceiling was reached",
    );
    expect(result.caveats).toContain(
      "Worklin did not trigger a top-up or billing action.",
    );
  });

  test("Trendtrack falls back to returned-row cost when usage headers are absent", async () => {
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 2,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/v1/usage")) {
          return Response.json({ data: { total: { remaining: 10 } } });
        }
        return Response.json({
          data: [{ id: "shop-1", domain: "acme.example" }],
        });
      },
    });

    const result = await provider.researchCompetitors({
      brandName: "Acme",
    });

    expect(result.usage).toMatchObject({
      creditsUsed: 1,
      creditsRemaining: 9,
      runCreditsUsed: 1,
    });
  });

  test("Trendtrack caps competitor discovery at three rows", async () => {
    let similarRequest: URL | undefined;
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 6,
      maxRowsPerRequest: 10,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                matchType: "exact",
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        similarRequest = url;
        return Response.json(
          {
            data: ["One", "Two", "Three"].map((name, index) => ({
              shop: {
                id: `competitor-${index + 1}`,
                domain: `${name.toLowerCase()}.example`,
                name,
              },
            })),
          },
          {
            headers: {
              "x-usage-cost": "3",
              "x-credits-remaining": "97",
            },
          },
        );
      },
    });

    const result = await provider.researchCompetitors({
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    });

    expect(similarRequest?.searchParams.get("limit")).toBe("3");
    expect(result.observations).toHaveLength(3);
    expect(result.usage).toMatchObject({
      creditsUsed: 3,
      runCreditsUsed: 3,
      runCreditLimit: 6,
    });
  });

  test("Trendtrack excludes brand aliases returned as similar shops", async () => {
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 6,
      maxCompetitorsPerRun: 3,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                matchType: "exact",
                shop: {
                  id: "shop-happy-mammoth",
                  domain: "happymammoth.com",
                  name: "happymammoth.com",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        return Response.json(
          {
            data: [
              {
                shop: {
                  id: "shop-storefront",
                  domain: "happy-mammoth-llc.myshopify.com",
                  name: "Happy Mammoth",
                },
              },
              {
                shop: {
                  id: "shop-campaign",
                  domain: "tryhappymammoth.site",
                  name: "Happy Mammoth",
                },
              },
              {
                shop: {
                  id: "shop-global-glow",
                  domain: "fr.globalglow.com",
                  name: "Global Glow",
                },
              },
            ],
          },
          {
            headers: {
              "x-usage-cost": "3",
              "x-credits-remaining": "97",
            },
          },
        );
      },
    });

    const result = await provider.researchCompetitors({
      brandName: "Happy Mammoth",
      websiteUrl: "https://happymammoth.com",
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      title: "Global Glow",
      sourceUrl: "https://fr.globalglow.com",
    });
  });

  test("Trendtrack resolves a shop once and routes each track to shop-scoped evidence", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      search: string;
      body?: Record<string, unknown>;
    }> = [];
    const metered = (data: unknown, requestId: string) =>
      Response.json(
        { requestId, data },
        {
          headers: {
            "x-usage-cost": "1",
            "x-credits-remaining": "99",
            "x-request-id": requestId,
          },
        },
      );
    const provider = createTrendtrackProvider({
      baseUrl: "https://api.trendtrack.invalid",
      credential: "test-credential",
      liveRequestsEnabled: true,
      maxCreditsPerRun: 8,
      maxRowsPerRequest: 2,
      maxGoogleAdsRowsPerRequest: 0,
      maxTikTokRowsPerRequest: 0,
      maxCompetitorsPerRun: 2,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        requests.push({
          method: init?.method ?? "GET",
          pathname: url.pathname,
          search: url.search,
          ...(body ? { body } : {}),
        });
        if (url.pathname === "/v1/lookup") {
          return Response.json({
            data: [
              {
                type: "shop",
                matchType: "exact",
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
            ],
          });
        }
        if (url.pathname === "/v1/usage") {
          return Response.json({ data: { total: { remaining: 100 } } });
        }
        if (url.pathname === "/v1/shops/shop-acme/similar") {
          return metered(
            [
              {
                shop: {
                  id: "shop-acme",
                  domain: "acme.example",
                  name: "Acme",
                },
              },
              {
                shop: {
                  id: "shop-rival",
                  domain: "rival.example",
                  name: "Rival",
                  catalog: {
                    mainCategory: "Wellness",
                    productsCount: 24,
                  },
                  traffic: { monthlyVisits: 45_231, growth30d: 0.18 },
                  advertising: { activeAds: 12 },
                },
              },
            ],
            "similar-1",
          );
        }
        if (url.pathname === "/v1/shops/shop-acme/emails") {
          return metered(
            [
              {
                id: 101,
                sentAt: "2026-07-20T10:00:00.000Z",
                campaignType: "Newsletter",
                content: {
                  subject: "A better summer routine",
                  bodyPreview: "Three practical ideas for the week.",
                  screenshotUrl:
                    "https://cdn.example.com/emails/acme-summer.png",
                },
                shop: { domain: "acme.example", name: "Acme" },
              },
            ],
            "email-1",
          );
        }
        if (url.pathname === "/v1/shops/shop-acme/products") {
          return metered(
            [
              {
                id: "product-1",
                title: "Daily Reset",
                productUrl: "https://acme.example/products/daily-reset",
                imageUrl:
                  "https://cdn.example.com/products/daily-reset.png",
                price: 39,
                currency: "USD",
                rank: 1,
              },
            ],
            "product-1",
          );
        }
        if (url.pathname === "/v1/shops/shop-acme") {
          return metered(
            {
              id: "shop-acme",
              domain: "acme.example",
              name: "Acme",
              socials: {
                instagram: {
                  handle: "acme",
                  followers: 12_843,
                  growth30d: 0.042,
                },
                youtube: { handle: "acmevideo", followers: 2_100 },
              },
              catalog: {
                mainCategory: "Wellness",
                productsCount: 14,
              },
              traffic: { monthlyVisits: 125_000, growth30d: 0.12 },
              advertising: { activeAds: 9 },
              trustpilot: { rating: 4.7, reviewCount: 1_834 },
            },
            "shop-detail-1",
          );
        }
        if (url.pathname === "/v1/ads/query") {
          return metered(
            [
              {
                id: "ad-1",
                status: "active",
                daysRunning: 14,
                media: {
                  type: "video",
                  mediaUrl: "https://cdn.example.com/ads/ad-1.mp4",
                  thumbnailUrl:
                    "https://cdn.example.com/ads/ad-1-thumbnail.jpg",
                },
                content: {
                  body: "A clear product demonstration.",
                  landingPageDomain: "acme.example",
                },
              },
            ],
            "ad-1",
          );
        }
        throw new Error(`Unexpected Trendtrack route: ${url.pathname}`);
      },
    });
    const query = {
      brandName: "Acme",
      websiteUrl: "https://acme.example",
    };

    const competitors = await provider.researchCompetitors(query);
    const lifecycle = await provider.lookupLifecycleSignals(query);
    const social = await provider.lookupSocialSignals(query);
    const paidMedia = await provider.lookupPaidMediaSignals!(query);
    const products = await provider.lookupProductSignals!(query);
    const market = await provider.lookupMarketSignals!(query);

    expect(
      requests.filter((request) => request.pathname === "/v1/lookup"),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) => request.pathname === "/v1/shops/shop-acme",
      ),
    ).toHaveLength(1);
    expect(
      requests.find(
        (request) =>
          request.pathname === "/v1/shops/shop-acme/similar",
      )?.search,
    ).toContain("limit=2");
    expect(
      requests.find(
        (request) => request.pathname === "/v1/shops/shop-acme/products",
      )?.search,
    ).toContain("sortBy=popularity");
    expect(
      requests.find((request) => request.pathname === "/v1/ads/query")?.body,
    ).toMatchObject({
      search: ["acme.example"],
      searchType: "domain",
      limit: 2,
    });

    expect(competitors.observations).toHaveLength(1);
    expect(competitors.observations[0]).toMatchObject({
      title: "Rival",
      sourceUrl: "https://rival.example",
    });
    expect(competitors.observations[0]?.finding).toContain(
      "45,231 monthly visits",
    );
    expect(lifecycle.observations[0]?.finding).toContain(
      "A better summer routine",
    );
    expect(lifecycle.observations[0]?.media).toEqual({
      type: "image",
      thumbnailUrl: "https://cdn.example.com/emails/acme-summer.png",
    });
    expect(social.observations[0]?.finding).toContain(
      "instagram: @acme, 12,843 followers",
    );
    expect(paidMedia.observations[0]?.finding).toContain(
      "A clear product demonstration.",
    );
    expect(paidMedia.observations[0]?.media).toEqual({
      type: "video",
      mediaUrl: "https://cdn.example.com/ads/ad-1.mp4",
      thumbnailUrl: "https://cdn.example.com/ads/ad-1-thumbnail.jpg",
    });
    expect(products.observations[0]).toMatchObject({
      title: "Daily Reset",
      sourceUrl: "https://acme.example/products/daily-reset",
      media: {
        type: "image",
        mediaUrl: "https://cdn.example.com/products/daily-reset.png",
        thumbnailUrl: "https://cdn.example.com/products/daily-reset.png",
      },
    });
    expect(market.observations[0]?.finding).toContain(
      "125,000 monthly visits",
    );
    expect(market.usage).toMatchObject({
      creditsUsed: 0,
      runCreditsUsed: 5,
    });
  });

  test("source status never reports live external action", () => {
    const result = getRetentionSourceStatus();

    expect(result.safety.externalActionTaken).toBe(false);
    expect(result.safety.canGoLiveNow).toBe(false);
    expect(result.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
    expect(result.summary.readyForReadOnlyAudit).toBe(true);
  });

  test("blocked capabilities include every live Shopify/Klaviyo mutation", () => {
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("shopify_write");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_send_campaign");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain(
      "klaviyo_schedule_campaign",
    );
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_activate_flow");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_mutate_segment");
    expect(RETENTION_BLOCKED_CAPABILITIES).toContain("klaviyo_mutate_profile");
  });
});

describe("Worklin Retention Brain", () => {
  test("onboarding drafts never persist demo fixture facts", () => {
    const result = createDraftBrandBrain({
      brandName: "Acme Studio",
      websiteUrl: "https://acme.example",
      storefront: {
        status: "fetched",
        title: "Acme Studio",
        description: "Practical tools for independent design teams.",
        productHints: ["Design operations toolkit"],
      },
    });

    expect(result.brandName).toBe("Acme Studio");
    expect(result.positioning.story).toContain("Practical tools");
    expect(result.products).toEqual([]);
    expect(result.offers).toEqual([]);
    expect(
      result.sourceProvenance.some((source) => source.status === "fixture"),
    ).toBe(false);
    expect(result.caveats.join(" ")).not.toContain("Fixture brand brain");
  });

  test("approved corrections and verified outcomes update structured context", () => {
    const draft = createDraftBrandBrain({ brandName: "Acme Studio" });
    const corrected = applyBrandBrainCorrection(draft, {
      field: "rule_dont",
      operation: "add",
      value: "Do not use manufactured urgency.",
    });
    const learned = recordBrandBrainCampaignLearning(corrected, {
      campaignType: "welcome_email",
      insight: "A product demonstration drove more qualified replies.",
      outcome: "winning",
    });

    expect(corrected.rules).toContainEqual({
      type: "dont",
      rule: "Do not use manufactured urgency.",
    });
    expect(
      corrected.sourceProvenance.some((source) => source.status === "approved"),
    ).toBe(true);
    expect(learned.campaignMemory).toContainEqual({
      campaignType: "welcome_email",
      insight: "A product demonstration drove more qualified replies.",
      outcome: "winning",
    });
  });

  test("Brand Brain exposes voice, rules, and safety metadata", () => {
    const result = getRetentionBrandBrain();

    expect(result.brandName).toContain("Worklin");
    expect(result.websiteUrl).toContain("example.worklin.ai");
    expect(result.voice.summary).toBeTruthy();
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.audienceNotes.length).toBeGreaterThan(0);
    expect(result.compliance.forbiddenClaims.length).toBeGreaterThan(0);
    expect(result.documentSources.length).toBeGreaterThan(0);
    expect(result.sourceProvenance.length).toBeGreaterThan(0);
    expect(result.readiness.status).toBe("partial");
    expect(result.readiness.score).toBeGreaterThan(0);
    expect(result.safety.externalActionTaken).toBe(false);
  });

  test("Brand Brain and context pack honor conversational onboarding brand inputs", () => {
    const context = buildRetentionContextPack({
      brandName: "Dr. Rachael Institute",
      websiteUrl: "https://drrachaelinstitute.com",
    });

    expect(context.brandSummary.brandName).toBe("Dr. Rachael Institute");
    expect(context.title).toContain("Dr. Rachael Institute");
    expect(context.brandSummary.readiness.completed).toContain(
      "Brand website/domain provided in onboarding conversation",
    );
    expect(context.brandSummary.readiness.nextActions[0]).toContain(
      "Research the public site",
    );
  });

  test("Shopify and Klaviyo snapshots are read-only fixture-backed sources", () => {
    const shopify = getRetentionShopifySnapshot();
    const klaviyo = getRetentionKlaviyoSnapshot();

    expect(shopify.platform).toBe("shopify");
    expect(shopify.summary.customers).toBeGreaterThan(0);
    expect(shopify.safety.blockedCapabilities).toContain("shopify_write");
    expect(klaviyo.platform).toBe("klaviyo");
    expect(klaviyo.lifecycleCoverage.missing.length).toBeGreaterThan(0);
    expect(klaviyo.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
  });

  test("unified identity joins Shopify and Klaviyo coverage with caveats", () => {
    const result = buildUnifiedCustomerView();

    expect(result.summary.totalIdentities).toBeGreaterThan(0);
    expect(result.summary.matchedAcrossSources).toBeGreaterThan(0);
    expect(result.summary.shopifyOnly).toBeGreaterThan(0);
  });

  test("feature snapshots preserve Worklin-style retention labels", () => {
    const result = computeRetentionCustomerFeatures();

    expect(result.summary.evaluatedCustomers).toBeGreaterThan(0);
    expect(result.summary.highPriorityCustomers).toBeGreaterThan(0);
    expect(
      result.features.some((feature) =>
        feature.derivedLabels.includes("replenishment_ready"),
      ),
    ).toBe(true);
  });

  test("scoring and micro-segments expose action-ready but definition-only output", () => {
    const scores = scoreRetentionCustomers();
    const segments = buildRetentionMicroSegments();

    expect(scores.summary.readyToBuyAgain).toBeGreaterThan(0);
    expect(scores.summary.suppressionRisk).toBeGreaterThan(0);
    expect(segments.summary.activationStatus).toBe("definition_only");
    expect(
      segments.definitions.every(
        (definition) => !definition.klaviyoNativePossible,
      ),
    ).toBe(true);
  });

  test("missing pieces detect Klaviyo lifecycle gaps", () => {
    const result = findRetentionMissingPieces();

    expect(result.summary.total).toBeGreaterThan(0);
    expect(
      result.missingPieces.some((piece) => piece.id === "missing_winback"),
    ).toBe(true);
    expect(result.safety.externalActionTaken).toBe(false);
  });

  test("campaign opportunities are draft-only and blocked from live action", () => {
    const result = findRetentionCampaignOpportunities();

    expect(result.summary.draftOnly).toBe(true);
    expect(result.safety.canGoLiveNow).toBe(false);
    expect(result.opportunities.length).toBeGreaterThan(0);
    for (const opportunity of result.opportunities) {
      expect(opportunity.blockedByMissingCapabilities).toContain(
        "shopify_write",
      );
    }
  });

  test("campaign package requires approval and QA blocks live readiness", () => {
    const campaignPackage = generateRetentionCampaignPackage();
    const qa = runRetentionQa();

    expect(campaignPackage.status).toBe("package_only");
    expect(campaignPackage.approvalStatus).toBe("required");
    expect(campaignPackage.safety.externalActionTaken).toBe(false);
    expect(qa.approvalStatus).toBe("required");
    expect(qa.safety.canGoLiveNow).toBe(false);
    expect(
      qa.checks.some((check) => check.id === "send_schedule_blocked"),
    ).toBe(true);
  });

  test("context pack and unified audit are compact safe assistant inputs", () => {
    const context = buildRetentionContextPack();
    const audit = buildUnifiedRetentionAudit();

    expect(context.title).toContain("retention context");
    expect(context.topOpportunities.length).toBeGreaterThan(0);
    expect(context.brandSummary.readiness.status).toBe("partial");
    expect(context.brandSummary.avoidPhrases.length).toBeGreaterThan(0);
    expect(
      context.brandSummary.compliance.forbiddenClaims.length,
    ).toBeGreaterThan(0);
    expect(context.safety.externalActionTaken).toBe(false);
    expect(audit.title).toBe("Retention Audit");
    expect(audit.document.title).toBe("Retention Audit");
    expect(audit.document.contentMarkdown).toContain("Brand Brain Readiness");
    expect(audit.document.contentMarkdown).toContain("## Source Summary");
    expect(audit.safety.canGoLiveNow).toBe(false);
    expect(audit.actionLog.externalActionTaken).toBe(false);
  });

  test("deep audit produces the full Dr Rachel-style module and chart shape", () => {
    const audit = buildDeepRetentionAudit();
    const moduleIds = audit.modules.map((module) => module.moduleId);
    const chartFamilies = new Set(
      audit.artifact.charts.map((chart) => chart.family),
    );

    expect(audit.title).toBe("Deep Retention Audit");
    expect(audit.window.currentWindowDays).toBe(365);
    expect(audit.window.previousWindowDays).toBe(365);
    expect(moduleIds).toEqual([
      "data_trust",
      "brand_context",
      "product_performance",
      "campaign_performance",
      "segment_analysis",
      "lifecycle_flow",
      "acquisition_tofu",
      "quiz_funnel",
      "opportunity_backlog",
    ]);
    expect(chartFamilies).toEqual(
      new Set([
        "period_trend",
        "product_funnel",
        "product_quadrant",
        "weekly_campaign_cadence",
        "sale_non_sale_comparison",
        "subject_line_word_bank",
        "segment_theme_heatmap",
        "flow_stage_waterfall",
        "opportunity_priority_matrix",
      ]),
    );
    expect(audit.artifact.contentMarkdown).toContain(
      "Product Performance Report",
    );
    expect(audit.artifact.contentMarkdown).toContain("Campaign Report");
    expect(audit.artifact.contentMarkdown).toContain("Segment Report");
    expect(audit.artifact.contentMarkdown).toContain(
      "Flow and Lifecycle Report",
    );
    expect(audit.artifact.contentMarkdown).toContain(
      "Prioritized Opportunity Backlog",
    );
    expect(audit.auditTrace).toHaveLength(audit.modules.length);
    expect(audit.auditTrace[0]?.dataRead.length).toBeGreaterThan(0);
    expect(audit.auditTrace[0]?.ruleApplied.length).toBeGreaterThan(0);
    expect(audit.artifact.contentMarkdown).toContain("Audit Reasoning Trace");
    expect(audit.artifact.contentMarkdown).toContain(
      "not private model scratchpad",
    );
  });

  test("deep audit applies requested brand metadata and emits unique chart specs", () => {
    const audit = buildDeepRetentionAudit({
      brandName: "Dr. Rachael Institute",
      websiteUrl: "https://drrachaelinstitute.com",
    });
    const chartIds = audit.artifact.charts.map((chart) => chart.chartId);

    expect(audit.brandName).toBe("Dr. Rachael Institute");
    expect(audit.artifact.contentMarkdown).toContain(
      "Brand: Dr. Rachael Institute",
    );
    expect(new Set(chartIds).size).toBe(chartIds.length);
  });

  test("deep audit is artifact-only and never authorizes live action", () => {
    const audit = buildDeepRetentionAudit({ cadence: "monthly" });

    expect(audit.cadence).toBe("monthly");
    expect(audit.summary.backlogCount).toBeGreaterThan(0);
    expect(audit.safety.externalActionTaken).toBe(false);
    expect(audit.safety.canGoLiveNow).toBe(false);
    expect(audit.actionLog.externalActionTaken).toBe(false);
    expect(
      audit.opportunityBacklog.every(
        (item) =>
          item.artifactOnly && !item.externalActionTaken && !item.canGoLiveNow,
      ),
    ).toBe(true);
    expect(audit.safety.blockedCapabilities).toContain("shopify_write");
    expect(audit.safety.blockedCapabilities).toContain("klaviyo_send_campaign");
  });

  test("audit status, schedule, and artifact helpers expose production interfaces", () => {
    const status = getRetentionAuditStatus();
    const schedule = scheduleRetentionAudit();
    const artifact = generateRetentionAuditArtifact();

    expect(status.status).toBe("ready");
    expect(schedule.schedules.map((item) => item.cadence)).toEqual([
      "weekly",
      "monthly",
      "quarterly",
    ]);
    expect(schedule.safety.externalActionTaken).toBe(false);
    expect(artifact.title).toBe("Deep Retention Audit");
    expect(artifact.charts.length).toBeGreaterThanOrEqual(9);
    expect(
      artifact.charts.every(
        (chart) =>
          chart.diagnosis.length > 0 && chart.recommendation.length > 0,
      ),
    ).toBe(true);
  });
});
