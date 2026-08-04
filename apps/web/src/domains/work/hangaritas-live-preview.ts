import type {
  CompetitorIntelligenceReport,
  IntelligenceModule,
  IntelligenceModuleKey,
  IntelligenceVisual,
} from "./competitor-intelligence-model";

const generatedAt = "2026-07-30T09:56:53.504Z";

const sourceRows = [
  {
    id: "source-buddii",
    title: "+Buddii",
    url: "https://thanksbuddii.com",
    observedAt: "2025-09-23T02:40:46.000Z",
    finding:
      "A social-recovery product, current price, email, Meta ad, social presence, and store tools were checked.",
    thumbnailUrl:
      "https://medias.trendtrack.io/domain/51f9b52d-9be0-4ae1-b1d5-8fb77c92247e/17032026/head.jpg",
  },
  {
    id: "source-revive",
    title: "REVIVE+ LABS",
    url: "https://revivepluslabs.com",
    observedAt: "2025-09-25T19:05:45.000Z",
    finding:
      "A hangover-recovery product, current price, Meta ad linked to the brand's own website, and store tools were checked.",
    thumbnailUrl:
      "https://medias.trendtrack.io/domain/81794605-0cc5-487e-a7bd-e0f9df488c8e/17052026/head.jpg",
  },
  {
    id: "source-humans-against",
    title: "Humans Against Ltd",
    url: "https://bloodydominos.co.uk",
    observedAt: "2024-08-15T09:56:53.000Z",
    finding:
      "Meta and Google ads linked to the brand's own website plus the brand's TikTok account were checked.",
    thumbnailUrl:
      "https://medias.trendtrack.io/domain/3e872e3a-04b4-4555-be9e-f8231bc601aa/18062026/head.jpg",
  },
  {
    id: "source-email",
    title: "The self care nobody posts",
    url: "https://hangaritas.com",
    observedAt: "2026-07-25T09:00:50.588Z",
    finding:
      "A recent Hangaritas email used self-care as its lead idea.",
    thumbnailUrl:
      "https://medias.trendtrack.io/mails/ef37143201314539839617839f98de87_9621742.jpg",
  },
  {
    id: "source-brand",
    title: "Hangaritas website",
    url: "https://hangaritas.com",
    observedAt: "2025-05-07T09:32:54.000Z",
    finding: "A public snapshot of the Hangaritas website was found.",
    thumbnailUrl:
      "https://medias.trendtrack.io/domain/4c09b5cd-3848-4c34-823d-42418b4bca22/06052026/head.jpg",
  },
  {
    id: "source-meta-ad",
    title: "Hangaritas hydration ad",
    url: "https://hangaritas.com/products/post-social-hydration",
    observedAt: "2026-07-28T05:23:59.564Z",
    finding:
      "A recent Meta ad led to a product page for post-social hydration.",
    mediaUrl:
      "https://medias.trendtrack.io/facebook/image/45cdbc043ebacdf94236c3db4714b558b0bf03332f9d76fc099021ddb3748703.png",
  },
] as const;

const buddiiProducts = [
  {
    id: "visual-buddii-product",
    module: "competitors",
    kind: "product",
    title: "+Buddii",
    sourceUrl: "https://thanksbuddii.com",
    mediaUrl:
      "https://cdn.shopify.com/s/files/1/0946/2431/7739/files/BUDDI-15.png?v=1765195671",
    mediaType: "image",
    observedAt: "2025-09-22T22:40:50.000Z",
    provider: "Market research",
    platform: "Website",
    evidenceIds: ["source-buddii"],
    caption: "Best seller found at AUD 25.",
    caveats: ["The source returned one product in this store check."],
    data: { price: 25, currency: "AUD", rank: 1 },
  },
] satisfies IntelligenceVisual[];

const buddiiMetaAds = [
  {
    id: "visual-buddii-meta",
    module: "competitors",
    kind: "ad",
    title: "50% off storewide",
    sourceUrl: "https://thanksbuddii.com/products/buddii",
    mediaUrl:
      "https://medias.trendtrack.io/facebook/image/d30f520b1e88a3e0e3dacd15e781925d6f7b68e8ab85b11a8657442e2af947e3.png",
    mediaType: "image",
    observedAt: "2026-07-24T07:00:00.000Z",
    provider: "Market research",
    platform: "Meta",
    evidenceIds: ["source-buddii"],
    caption:
      "The ad offered 50% off storewide with code BUDDII50 and led to the +Buddii product page.",
    caveats: ["The ad was inactive when last observed."],
    data: {
      status: "inactive",
      callToAction: "Shop now",
      discountCode: "BUDDII50",
    },
  },
] satisfies IntelligenceVisual[];

const buddiiEmails = [
  {
    id: "visual-buddii-email",
    module: "competitors",
    kind: "email",
    title: "Complete your Purchase",
    sourceUrl: "https://thanksbuddii.com",
    thumbnailUrl:
      "https://medias.trendtrack.io/mails/6fd884a3283c453db13d57d6120d3c6d_8022199.jpg",
    mediaType: "image",
    observedAt: "2026-05-29T22:16:02.595Z",
    provider: "Market research",
    platform: "Email",
    evidenceIds: ["source-buddii"],
    caption:
      "An abandoned-cart email reminded shoppers that an item was still waiting.",
    caveats: [
      "This proves the email exists, not how many people opened or bought.",
    ],
    data: { campaignType: "Abandoned cart", promotion: "No promotion" },
  },
] satisfies IntelligenceVisual[];

const reviveProducts = [
  {
    id: "visual-revive-product",
    module: "competitors",
    kind: "product",
    title: "NIGHTCAP",
    sourceUrl: "https://revivepluslabs.com",
    mediaUrl:
      "https://cdn.shopify.com/s/files/1/0929/7949/5298/files/upscaledhero_textimproved_1.png?v=1773359748",
    mediaType: "image",
    observedAt: "2026-04-26T17:21:21.000Z",
    provider: "Market research",
    platform: "Website",
    evidenceIds: ["source-revive"],
    caption: "Best seller found at USD 49.95.",
    caveats: ["The source returned one product in this store check."],
    data: { price: 49.95, currency: "USD", rank: 1 },
  },
] satisfies IntelligenceVisual[];

const reviveMetaAds = [
  {
    id: "visual-revive-meta",
    module: "competitors",
    kind: "ad",
    title: "Why hangovers get worse after 45",
    sourceUrl: "https://revivepluslabs.com",
    mediaUrl:
      "https://medias.trendtrack.io/image/facebook/1154653300120435.jpg",
    mediaType: "image",
    observedAt: "2026-05-08T07:00:00.000Z",
    provider: "Market research",
    platform: "Meta",
    evidenceIds: ["source-revive"],
    caption:
      "A long educational ad framed worsening hangovers after age 45 as the problem and NIGHTCAP as the solution.",
    caveats: [
      "The landing page matched revivepluslabs.com. The ad was inactive when last observed.",
    ],
    data: {
      status: "inactive",
      daysRunning: 2,
      audience: "Men over 45",
      callToAction: "Shop now",
    },
  },
] satisfies IntelligenceVisual[];

const humansMetaAds = [
  {
    id: "visual-humans-meta",
    module: "competitors",
    kind: "ad",
    title: "Humans Against Meta ad",
    sourceUrl:
      "https://humansagainst.com/products/humans-against?variant=50354801672499",
    mediaUrl:
      "https://medias.trendtrack.io/facebook/image/028666b8dac4219b131184f52d0f92df2f6f6b9639d191b267c33a96d5414087.jpg",
    mediaType: "image",
    observedAt: "2026-07-18T16:24:05.931Z",
    provider: "Market research",
    platform: "Meta",
    evidenceIds: ["source-humans-against"],
    caption:
      "An active UK Meta ad led directly to the Humans Against product page.",
    caveats: [
      "The advertiser account showed five live ads; the individual example had low measured reach.",
    ],
    data: {
      status: "active",
      daysRunning: 12,
      advertiserLiveAds: 5,
      advertiserReach30d: 47_691,
      callToAction: "Order now",
    },
  },
] satisfies IntelligenceVisual[];

const humansTikTok = [
  {
    id: "visual-humans-tiktok",
    module: "competitors",
    kind: "social",
    title: "We can't fix hangxiety",
    sourceUrl: "https://www.tiktok.com/@humansagainst_",
    mediaUrl:
      "https://medias.trendtrack.io/tiktok/videos/f36fe6084c8cb402f2145e70087fc203.mp4",
    thumbnailUrl:
      "https://medias.trendtrack.io/tiktok/thumbnails/f36fe6084c8cb402f2145e70087fc203.jpg",
    mediaType: "video",
    observedAt: "2026-07-22T19:00:00.000Z",
    provider: "Market research",
    platform: "TikTok",
    evidenceIds: ["source-humans-against"],
    caption:
      "An organic post used careful claims language around hangxiety, focus, hydration, and energy.",
    caveats: ["The engagement rate is the research provider's calculation."],
    data: {
      type: "Organic post",
      views: 710,
      likes: 2,
      shares: 1,
      engagementRate: 13.56,
    },
  },
] satisfies IntelligenceVisual[];

const humansGoogleAds = [
  {
    id: "visual-humans-google",
    module: "competitors",
    kind: "ad",
    title: "Humans Against Google ad",
    sourceUrl: "https://humansagainst.com",
    mediaUrl:
      "https://medias.trendtrack.io/google/CR13009751278715142145.png",
    mediaType: "image",
    observedAt: "2025-12-05T00:00:00.000Z",
    provider: "Market research",
    platform: "Google",
    evidenceIds: ["source-humans-against"],
    caption:
      "A Google search ad from the exact Humans Against domain ran for 303 days.",
    caveats: ["The ad was inactive when last observed."],
    data: {
      status: "inactive",
      network: "Search",
      daysRunning: 303,
      targetCountry: "GB",
    },
  },
] satisfies IntelligenceVisual[];

const competitorMedia = [
  ...buddiiProducts,
  ...buddiiMetaAds,
  ...buddiiEmails,
  ...reviveProducts,
  ...reviveMetaAds,
  ...humansMetaAds,
  ...humansTikTok,
  ...humansGoogleAds,
];

const moduleNotes: Record<
  IntelligenceModuleKey,
  Pick<
    IntelligenceModule,
    "status" | "implications" | "gaps" | "nextValidationSteps" | "confidence"
  >
> = {
  company_operating_model: {
    status: "partial",
    implications: [
      "Hangaritas has a live website, at least one product page, and active marketing.",
    ],
    gaps: [
      "We do not yet know the team, sales model, distribution, or business size.",
    ],
    nextValidationSteps: [
      "Review the full website, company records, retail listings, and interviews.",
    ],
    confidence: {
      score: 42,
      band: "low",
      rationale: "Only public website and marketing examples were checked.",
    },
  },
  market_category: {
    status: "partial",
    implications: [
      "The product language points toward hydration and recovery after social occasions.",
    ],
    gaps: [
      "Market size, growth, demand, geography, and category boundaries are not confirmed.",
    ],
    nextValidationSteps: [
      "Check category reports, search demand, retailers, and customer language.",
    ],
    confidence: {
      score: 35,
      band: "low",
      rationale: "The category reading comes from one product page.",
    },
  },
  customers_demand: {
    status: "partial",
    implications: [
      "The current message appears aimed at people who want recovery and self-care after going out.",
    ],
    gaps: [
      "Customer groups, pains, objections, purchase reasons, and repeat behaviour are unknown.",
    ],
    nextValidationSteps: [
      "Review customer comments, reviews, search questions, and support themes.",
    ],
    confidence: {
      score: 34,
      band: "low",
      rationale: "The audience reading is based on one ad and one email.",
    },
  },
  offers_pricing_portfolio: {
    status: "partial",
    implications: [
      "A post-social hydration product is being promoted through paid marketing.",
    ],
    gaps: [
      "The full product range, prices, bundles, subscriptions, and best sellers were not collected.",
    ],
    nextValidationSteps: [
      "Collect all product pages, current prices, bundles, and offer changes.",
    ],
    confidence: {
      score: 50,
      band: "medium",
      rationale: "The product page is direct evidence, but coverage is incomplete.",
    },
  },
  brand_positioning_creative: {
    status: "partial",
    implications: [
      "The brand connects hydration with social recovery and private self-care.",
    ],
    gaps: [
      "The full voice, proof, visual rules, claims, and repeated creative themes need more examples.",
    ],
    nextValidationSteps: [
      "Review more ads, emails, landing pages, packaging, and social posts.",
    ],
    confidence: {
      score: 52,
      band: "medium",
      rationale: "Two recent marketing examples support the initial reading.",
    },
  },
  customer_journey: {
    status: "partial",
    implications: [
      "At least one paid ad sends people directly to a product page.",
    ],
    gaps: [
      "We do not yet know the full path from first discovery to repeat purchase.",
    ],
    nextValidationSteps: [
      "Review landing pages, checkout, email follow-up, retargeting, and repeat-purchase prompts.",
    ],
    confidence: {
      score: 46,
      band: "medium",
      rationale: "One direct ad-to-product path was observed.",
    },
  },
  growth_channels_lifecycle: {
    status: "partial",
    implications: [
      "Meta ads and email are both active.",
    ],
    gaps: [
      "Search, unpaid social posts, creators, partnerships, text messages, and results are unknown.",
    ],
    nextValidationSteps: [
      "Collect a larger ad and email history, then check every public place where the brand appears.",
    ],
    confidence: {
      score: 55,
      band: "medium",
      rationale: "Recent examples confirm activity in two places.",
    },
  },
  economics_financial: {
    status: "unavailable",
    implications: [],
    gaps: [
      "Revenue, margins, customer value, acquisition cost, funding, and valuation are not public in this sample.",
    ],
    nextValidationSteps: [
      "Check company records, investor sources, pricing, traffic, and retailer signals.",
    ],
    confidence: {
      score: 10,
      band: "low",
      rationale: "No reliable financial evidence was collected.",
    },
  },
  culture_trends: {
    status: "partial",
    implications: [
      "The message links a functional hydration product with self-care and social culture.",
    ],
    gaps: [
      "The size, durability, and direction of this cultural signal are not known.",
    ],
    nextValidationSteps: [
      "Compare search, social, news, creator, and category language over time.",
    ],
    confidence: {
      score: 28,
      band: "low",
      rationale: "The signal appears in limited brand material.",
    },
  },
  reputation_risk: {
    status: "unavailable",
    implications: [],
    gaps: [
      "Customer praise, complaints, trust concerns, product claims, and reputation risks were not collected.",
    ],
    nextValidationSteps: [
      "Review ratings, customer comments, returns, complaints, claims, and policy pages.",
    ],
    confidence: {
      score: 10,
      band: "low",
      rationale: "No reliable customer or risk evidence was collected.",
    },
  },
  competitors: {
    status: "partial",
    implications: [
      "Three close competitors now have checked products, prices, ads, social activity, emails, or store evidence.",
    ],
    gaps: [
      "This three-brand set is useful but not an exhaustive map of the market.",
    ],
    nextValidationSteps: [
      "Add customer reviews, retailer evidence, and more creative history before making a final market ranking.",
    ],
    confidence: {
      score: 78,
      band: "high",
      rationale:
        "Products and marketing linked to each brand's own website confirm meaningful overlap.",
    },
  },
  strategic_synthesis: {
    status: "partial",
    implications: [
      "The next research pass should deepen customer, product, market, and competitor evidence before major decisions are made.",
    ],
    gaps: [
      "The number of examples checked is too small for a complete brand strategy.",
    ],
    nextValidationSteps: [
      "Run the full public website and approved research-service plan, then review the report again.",
    ],
    confidence: {
      score: 38,
      band: "low",
      rationale: "The actions below are research priorities, not final strategy.",
    },
  },
};

const modules: IntelligenceModule[] = Object.entries(moduleNotes).map(
  ([key, notes]) => ({
    key: key as IntelligenceModuleKey,
    status: notes.status,
    decisionQuestions: [],
    implications: notes.implications,
    gaps: notes.gaps,
    nextValidationSteps: notes.nextValidationSteps,
    findingIds: [],
    evidenceIds:
      key === "competitors"
        ? ["source-buddii", "source-revive", "source-humans-against"]
        : key === "growth_channels_lifecycle"
          ? ["source-email", "source-meta-ad"]
          : [],
    visualizationIds:
      key === "competitors"
        ? ["chart-possible-competitors"]
        : key === "growth_channels_lifecycle"
          ? ["chart-channel-examples"]
          : [],
    confidence: notes.confidence,
  }),
);

export const hangaritasLivePreview: CompetitorIntelligenceReport = {
  generatedAt,
  query: {
    brandName: "Hangaritas",
    websiteUrl: "https://hangaritas.com",
  },
  executiveSummary: [
    "Hangaritas is actively promoting a post-social hydration product.",
    "Meta ads and email were both visible in the latest examples.",
    "Three close competitors now have checked products, prices, ads, emails, social activity, or store tools.",
    "The competitor view is evidence-backed, but the wider customer, market, financial, and reputation research is still incomplete.",
  ],
  identity: {
    category: "Hydration and recovery products",
    positioning:
      "A hydration and self-care offer connected to recovery after social occasions.",
    offers: ["Post-social hydration product"],
    audienceSignals: [
      "People seeking hydration or recovery after social occasions",
      "People drawn to practical self-care messages",
    ],
  },
  competitorLandscape: [
    {
      name: "+Buddii",
      websiteUrl: "https://thanksbuddii.com",
      classification: "direct",
      rationale:
        "It sells a social-recovery blend for the same after-going-out occasion and actively uses Meta and email.",
      positioning:
        "A social-recovery blend for people who want an active social life without losing health or productivity.",
      offers: ["+Buddii social-recovery blend at AUD 25"],
      pricingPosture: "Single-product, accessible entry price",
      channelSignals: {
        paidMedia: ["Meta sale ad"],
        social: ["Facebook, Instagram, and TikTok profiles"],
        seoAndContent: [],
        emailAndLifecycle: ["Abandoned-cart email"],
      },
      differentiators: ["22-ingredient multi-pathway blend"],
      notableMoves: ["Used a 50% storewide sale with code BUDDII50"],
      gaps: [
        "Website-visit volume was not measured",
        "Only one product, one ad, and one email were collected",
      ],
      evidenceIds: ["source-buddii"],
      confidence: "high",
      details: {
        countryCode: "AU",
        currency: "AUD",
        category: "Food & Drink",
        storeCreatedAt: "2025-09-23T02:40:46.000Z",
        productCount: 1,
        monthlyVisits: null,
        activeAds: 0,
        averageActiveAds30d: 15,
        trafficHistory: [],
        adHistory: [
          { period: "2026-03-16", value: 20 },
          { period: "2026-03-23", value: 20 },
          { period: "2026-03-30", value: 12 },
          { period: "2026-04-06", value: 24 },
          { period: "2026-04-13", value: 25 },
          { period: "2026-04-20", value: 19 },
          { period: "2026-04-27", value: 21 },
          { period: "2026-05-04", value: 26 },
          { period: "2026-05-11", value: 28 },
          { period: "2026-05-18", value: 28 },
          { period: "2026-05-25", value: 28 },
          { period: "2026-06-01", value: 23 },
          { period: "2026-06-08", value: 17 },
          { period: "2026-06-15", value: 18 },
          { period: "2026-06-22", value: 18 },
          { period: "2026-06-29", value: 18 },
          { period: "2026-07-06", value: 18 },
          { period: "2026-07-13", value: 18 },
          { period: "2026-07-20", value: 10 },
          { period: "2026-07-27", value: 4 },
        ],
        products: buddiiProducts,
        metaAds: buddiiMetaAds,
        tiktok: [],
        googleAds: [],
        emails: buddiiEmails,
        socialAccounts: [
          {
            platform: "Instagram",
            handle: "thanksbuddii",
            followers: 351,
          },
          {
            platform: "Facebook",
            handle: "thanksbuddii",
            followers: 33,
          },
          {
            platform: "TikTok",
            handle: "thanksbuddii",
            followers: 9,
            posts: 11,
            views: 3_602,
            likes: 49,
          },
        ],
        tools: [
          "Judge.me Product Reviews",
          "Klaviyo Email and SMS",
          "Triple Whale Analytics",
          "XO Insert Code",
        ],
        tracking: [
          "Meta",
          "Google Ads",
          "Google Analytics",
          "Google Tag Manager",
          "TikTok",
        ],
        coverage: {
          overview: {
            status: "found",
            note: "Store, product, social, advertising, and tool information found.",
          },
          products: {
            status: "found",
            note: "One product and current price found.",
          },
          meta: {
            status: "found",
            note: "One Meta ad linked to the brand's own website was collected.",
          },
          tiktok: {
            status: "not_found",
            note: "The account exists, but no TikTok post or ad was returned in this check.",
          },
          google: {
            status: "not_found",
            note: "No Google ad was returned in this check.",
          },
          emails: {
            status: "found",
            note: "One abandoned-cart email collected.",
          },
          social: {
            status: "found",
            note: "Facebook, Instagram, and TikTok account signals found.",
          },
          tools: {
            status: "found",
            note: "Store and measurement tools found.",
          },
        },
      },
    },
    {
      name: "REVIVE+ LABS",
      websiteUrl: "https://revivepluslabs.com",
      classification: "direct",
      rationale:
        "NIGHTCAP competes for the same hangover-recovery occasion and targets an older, high-performing customer.",
      positioning:
        "An overnight hangover-recovery drink framed around waking clear after drinking.",
      offers: ["NIGHTCAP at USD 49.95"],
      pricingPosture: "Premium single-product offer",
      channelSignals: {
        paidMedia: ["Meta campaign linked to the brand's own website"],
        social: [],
        seoAndContent: [],
        emailAndLifecycle: [],
      },
      differentiators: [
        "Long-form education aimed at men over 45",
        "Clinical-style ingredient and mechanism story",
      ],
      notableMoves: [
        "Used age-specific advertorial copy and a first-time-customer offer",
      ],
      gaps: [
        "Website-visit volume was not measured",
        "No Google ads, TikTok posts, or emails were returned",
      ],
      evidenceIds: ["source-revive"],
      confidence: "high",
      details: {
        countryCode: "NL",
        currency: "USD",
        category: "Food & Drink",
        storeCreatedAt: "2025-09-25T19:05:45.000Z",
        isShopifyPlus: true,
        productCount: 1,
        monthlyVisits: null,
        activeAds: 0,
        averageActiveAds30d: 0,
        trafficHistory: [],
        adHistory: [
          { period: "2026-05-04", value: 5 },
          { period: "2026-05-11", value: 0 },
          { period: "2026-05-18", value: 0 },
          { period: "2026-05-25", value: 0 },
          { period: "2026-06-01", value: 0 },
          { period: "2026-06-08", value: 0 },
          { period: "2026-06-15", value: 0 },
          { period: "2026-06-22", value: 0 },
          { period: "2026-06-29", value: 0 },
          { period: "2026-07-06", value: 0 },
          { period: "2026-07-13", value: 0 },
          { period: "2026-07-20", value: 0 },
          { period: "2026-07-27", value: 0 },
        ],
        products: reviveProducts,
        metaAds: reviveMetaAds,
        tiktok: [],
        googleAds: [],
        emails: [],
        socialAccounts: [],
        tools: [
          "GemPages Landing Pages",
          "Judge.me Product Reviews",
          "Kaching Bundles",
          "Klaviyo Email and SMS",
        ],
        tracking: [
          "Meta",
          "Google Analytics",
          "Google Tag Manager",
        ],
        coverage: {
          overview: {
            status: "found",
            note: "Store, product, advertising, and tool information found.",
          },
          products: {
            status: "found",
            note: "One product and current price found.",
          },
          meta: {
            status: "found",
            note: "One Meta ad linked to the brand's own website was collected.",
          },
          tiktok: {
            status: "not_found",
            note: "The brand account check returned no TikTok posts or ads.",
          },
          google: {
            status: "not_found",
            note: "The brand website check returned no Google ads.",
          },
          emails: {
            status: "not_found",
            note: "No email was returned in this check.",
          },
          social: {
            status: "not_found",
            note: "No reliable public social account statistics were returned.",
          },
          tools: {
            status: "found",
            note: "Store and measurement tools found.",
          },
        },
      },
    },
    {
      name: "Humans Against Ltd",
      websiteUrl: "https://humansagainst.com",
      classification: "direct",
      rationale:
        "The brand explicitly sells detoxification, energy, and hydration for late nights and hangovers.",
      positioning:
        "A UK recovery brand helping people detoxify, energise, and hydrate after late nights.",
      offers: ["Humans Against recovery product"],
      pricingPosture: "Price was not returned in this check",
      channelSignals: {
        paidMedia: ["Active Meta ad", "Long-running Google search ad"],
        social: ["Active TikTok account and organic posts"],
        seoAndContent: [],
        emailAndLifecycle: [],
      },
      differentiators: [
        "Careful claims language around hangxiety",
        "Strong TikTok activity",
      ],
      notableMoves: [
        "Used Meta, Google search, and TikTok around the same recovery occasion",
      ],
      gaps: [
        "Current product catalogue and prices were not returned",
        "No email was returned in this check",
      ],
      evidenceIds: ["source-humans-against"],
      confidence: "high",
      details: {
        countryCode: "GB",
        currency: "GBP",
        category: "Food & Drink",
        storeCreatedAt: "2024-08-15T09:56:53.000Z",
        productCount: null,
        monthlyVisits: null,
        activeAds: 5,
        averageActiveAds30d: null,
        trafficHistory: [],
        adHistory: [],
        products: [],
        metaAds: humansMetaAds,
        tiktok: humansTikTok,
        googleAds: humansGoogleAds,
        emails: [],
        socialAccounts: [
          {
            platform: "Instagram",
            handle: "humansagainst_",
            followers: 2_122,
          },
          {
            platform: "TikTok",
            handle: "humansagainst_",
            followers: 1_229,
            posts: 244,
            views: 318_014,
            likes: 8_130,
          },
          {
            platform: "Facebook",
            handle: "humansagainsthangovers",
          },
        ],
        tools: [
          "Shoppable Videos",
          "Microsoft Clarity",
          "Klaviyo Email and SMS",
          "Shipping tools",
          "Affiliate Marketing",
        ],
        tracking: [
          "Meta",
          "Google Ads",
          "Google Analytics",
          "Google Tag Manager",
          "Microsoft Advertising",
          "Snap",
          "TikTok",
        ],
        coverage: {
          overview: {
            status: "found",
            note: "Store, advertising, social, and tool information found.",
          },
          products: {
            status: "not_found",
            note: "The product check returned no current product row or price.",
          },
          meta: {
            status: "found",
            note: "One Meta ad linked to the brand's own website was collected.",
          },
          tiktok: {
            status: "found",
            note: "One post from the brand's TikTok account plus account totals was collected.",
          },
          google: {
            status: "found",
            note: "One Google search ad linked to the brand's own website was collected.",
          },
          emails: {
            status: "not_found",
            note: "No email was returned in this check.",
          },
          social: {
            status: "found",
            note: "Instagram, TikTok, and Facebook account signals found.",
          },
          tools: {
            status: "found",
            note: "Store and measurement tools found.",
          },
        },
      },
    },
  ],
  channelFindings: {
    seoAndContent: [],
    social: ["A recent Meta ad promoted post-social hydration."],
    emailAndLifecycle: [
      "A recent email led with the idea: The self care nobody posts.",
    ],
    sms: [],
    productAndLaunches: [
      "A post-social hydration product page was linked from paid marketing.",
    ],
  },
  marketSignals: [
    "The brand is connecting functional hydration with social recovery and self-care.",
  ],
  customerSignals: [
    "The limited sample points toward people seeking recovery after social occasions.",
  ],
  trendSignals: [
    "Self-care language appears alongside a practical hydration use case.",
  ],
  evidence: sourceRows.map((source) => ({
    id: source.id,
    url: source.url,
    title: source.title,
    sourceType:
      source.id === "source-email"
        ? "email"
        : source.id === "source-meta-ad"
          ? "ad"
          : "public website",
    observedAt: source.observedAt,
    finding: source.finding,
    confidence:
      source.id === "source-email" || source.id === "source-meta-ad"
        ? "high"
        : "medium",
    provider: "Market research",
  })),
  visualEvidence: [
    ...sourceRows.map((source, index) => ({
      id: `visual-${source.id}`,
      module:
        index < 3
          ? ("competitors" as const)
          : source.id === "source-meta-ad" || source.id === "source-email"
            ? ("growth_channels_lifecycle" as const)
            : ("brand_positioning_creative" as const),
      kind:
        index < 3
          ? ("competitor" as const)
          : source.id === "source-email"
            ? ("email" as const)
            : source.id === "source-meta-ad"
              ? ("ad" as const)
              : ("brand" as const),
      title: source.title,
      sourceUrl: source.url,
      ...("mediaUrl" in source ? { mediaUrl: source.mediaUrl } : {}),
      ...("thumbnailUrl" in source
        ? { thumbnailUrl: source.thumbnailUrl }
        : {}),
      mediaType: "image" as const,
      observedAt: source.observedAt,
      provider: "Market research",
      platform:
        source.id === "source-email"
          ? "Email"
          : source.id === "source-meta-ad"
            ? "Meta"
            : "Website",
      evidenceIds: [source.id],
      caption: source.finding,
      caveats: [],
      data: {},
    })),
    ...competitorMedia,
  ],
  gaps: [
    "Hangaritas' full product range and current prices are not collected.",
    "Customer reviews, demand, objections, and repeat behaviour are not collected.",
    "Market size, growth, geography, and search demand are not confirmed.",
    "Three competitor profiles were checked, but this is not yet a complete view of the market.",
    "No competitor email was found for REVIVE+ LABS or Humans Against, and no current product price was found for Humans Against.",
    "No matching Google or TikTok example was found for REVIVE+ LABS, and no matching TikTok example was found for +Buddii.",
    "Financial, investor, and company operating information is not available in this sample.",
    "Text messages, unpaid social posts, search, creators, partnerships, and retail activity are not covered yet.",
  ],
  recommendations: [
    {
      priority: "now",
      action:
        "Expand the market view beyond the first three checked competitors.",
      rationale:
        "The current profiles have enough brand-owned product and marketing evidence for comparison, but three brands cannot represent the whole market.",
      evidenceIds: ["source-buddii", "source-revive", "source-humans-against"],
    },
    {
      priority: "next",
      action:
        "Collect the full product, price, customer, and marketing picture.",
      rationale:
        "One product page, one ad, and one email cannot support a complete brand strategy.",
      evidenceIds: ["source-email", "source-meta-ad", "source-brand"],
    },
  ],
  safety: {
    caveats: [
      "The research service shows market activity, not proven sales results.",
      "Email examples do not reveal opens, clicks, sales, or revenue.",
      "A zero visit value is shown as not measured because it does not prove that a website had no visitors.",
      "No payment, top-up, or billing action was taken.",
    ],
  },
  intelligence: {
    contractVersion: "brand_intelligence_v1",
    brandId: "hangaritas-live-preview",
    researchMode: "deep",
    scope: {
      businessQuestions: [
        "What does the brand sell?",
        "Who is it for?",
        "How does it reach people?",
        "Which brands truly compete for the same customer?",
      ],
      geographies: [],
      languages: ["English"],
      periodStart: "2024-08-15T09:56:53.000Z",
      periodEnd: generatedAt,
    },
    modules,
    claims: [
      {
        id: "claim-product",
        module: "offers_pricing_portfolio",
        statement:
          "Hangaritas promoted a post-social hydration product through a recent Meta ad.",
        type: "fact",
        material: true,
        evidenceIds: ["source-meta-ad"],
        confidence: {
          score: 90,
          band: "high",
          rationale: "The ad and destination page were observed directly.",
        },
      },
      {
        id: "claim-channels",
        module: "growth_channels_lifecycle",
        statement:
          "Meta ads and email were both active in the examples checked.",
        type: "fact",
        material: true,
        evidenceIds: ["source-email", "source-meta-ad"],
        confidence: {
          score: 88,
          band: "high",
          rationale: "One recent Meta ad and one recent email were found.",
        },
      },
      {
        id: "claim-competitors",
        module: "competitors",
        statement:
          "Three close competitors have brand-owned product or marketing evidence that can be compared with Hangaritas.",
        type: "fact",
        material: true,
        evidenceIds: [
          "source-buddii",
          "source-revive",
          "source-humans-against",
        ],
        confidence: {
          score: 82,
          band: "high",
          rationale:
            "Each profile was checked against the brand's own website, advertising account, social account, or store data.",
        },
      },
    ],
    metrics: [
      {
        id: "metric-examples",
        module: "growth_channels_lifecycle",
        label: "Real examples found",
        kind: "observed",
        value: 14,
        unit: "examples",
        period: "All available",
        geography: "",
        denominator: "Examples returned by the research service",
        method: "Count of saved visual examples",
        evidenceIds: sourceRows.map((source) => source.id),
        confidence: {
          score: 100,
          band: "high",
          rationale:
            "Six Hangaritas and competitor profile examples plus eight competitor product and marketing examples were saved directly.",
        },
      },
      {
        id: "metric-possible-competitors",
        module: "competitors",
        label: "Competitors with checked profiles",
        kind: "observed",
        value: 3,
        unit: "brands",
        period: "Examples checked",
        geography: "",
        denominator: "Results returned by the research service",
        method: "Count of competitor profiles checked against brand-owned evidence",
        evidenceIds: [
          "source-buddii",
          "source-revive",
          "source-humans-against",
        ],
        confidence: {
          score: 82,
          band: "high",
          rationale:
            "The count is exact and each profile has product or marketing evidence tied to the brand.",
        },
      },
    ],
    visualizations: [
      {
        id: "chart-channel-examples",
        module: "growth_channels_lifecycle",
        type: "channel_map",
        title: "Examples found by place",
        businessQuestion: "Where is the brand visibly active?",
        evidenceIds: ["source-email", "source-meta-ad", "source-brand"],
        assetIds: [
          "visual-source-email",
          "visual-source-meta-ad",
          "visual-source-brand",
        ],
        caveats: [
          "This counts saved examples, not results or spending.",
        ],
        data: {
          rows: [
            { label: "Meta ads", value: 1 },
            { label: "Emails", value: 1 },
            { label: "Website snapshots", value: 1 },
          ],
        },
      },
      {
        id: "chart-possible-competitors",
        module: "competitors",
        type: "comparison_matrix",
        title: "Competitors checked so far",
        businessQuestion: "What has Worklin found for each close competitor?",
        evidenceIds: [
          "source-buddii",
          "source-revive",
          "source-humans-against",
        ],
        assetIds: [
          "visual-source-buddii",
          "visual-source-revive",
          "visual-source-humans-against",
        ],
        caveats: [
          "This first group is useful for comparison but does not cover the whole market.",
        ],
        data: {
          rows: [
            { label: "+Buddii", value: 1 },
            { label: "REVIVE+ LABS", value: 1 },
            { label: "Humans Against Ltd", value: 1 },
          ],
        },
      },
    ],
    recommendations: [
      {
        id: "recommendation-verify-competitors",
        priority: "now",
        decision: "Which other brands should be added to the market view?",
        action:
          "Expand the competitor set and deepen the missing areas in these three profiles.",
        rationale:
          "The first three profiles are useful, but the wider market and several missing channels still matter.",
        mechanism:
          "Worklin can keep the checked profiles, find more close alternatives, and fill each clearly marked gap.",
        expectedImpact: {
          low: null,
          high: null,
          unit: "",
          timeframe: "",
        },
        effort: "medium",
        risks: ["A narrow search may miss less obvious substitutes."],
        dependencies: ["Public website and market evidence"],
        alternatives: ["Ask the brand team for known competitors"],
        suggestedOwner: "Worklin",
        timing: "Before strategy work",
        kpi: "Every selected competitor has checked product, customer, or marketing evidence",
        firstTest: "Find the next three close competitors and fill the missing channels",
        scaleCriterion: "The competitor set covers the main price and positioning choices",
        stopCriterion: "Remove any brand with no meaningful product or customer overlap",
        evidenceIds: [
          "source-buddii",
          "source-revive",
          "source-humans-against",
        ],
        confidence: {
          score: 82,
          band: "high",
          rationale: "The current evidence and the remaining gaps are both visible.",
        },
      },
      {
        id: "recommendation-deepen-research",
        priority: "next",
        decision: "What must Worklin learn before making a full strategy?",
        action:
          "Complete customer, product, market, reputation, and marketing research.",
        rationale:
          "These real examples show that Worklin can receive and display the information, but they do not support a complete brand strategy.",
        mechanism:
          "More independent sources turn early clues into decisions supported by reliable information.",
        expectedImpact: {
          low: null,
          high: null,
          unit: "",
          timeframe: "",
        },
        effort: "high",
        risks: ["Some information may remain private or unavailable."],
        dependencies: ["Public website research and approved research services"],
        alternatives: ["Mark unavailable areas clearly"],
        suggestedOwner: "Worklin",
        timing: "Next research run",
        kpi: "Every research area has findings or a clear unavailable result",
        firstTest: "Run the full public-web research plan",
        scaleCriterion: "The report passes Worklin's evidence checks",
        stopCriterion: "Do not call the report complete while key areas are missing",
        evidenceIds: ["source-email", "source-meta-ad", "source-brand"],
        confidence: {
          score: 90,
          band: "high",
          rationale: "The missing areas are explicit in this report.",
        },
      },
    ],
    limitations: [
      "This preview uses 14 real visual examples from a bounded 16-credit research run.",
      "It does not pretend that this small sample is a finished brand strategy.",
      "Three competitors have checked profiles, but the wider market has not been mapped yet.",
      "Missing results are shown as unavailable or not found rather than filled with guesses.",
    ],
  },
  quality: {
    accepted: false,
    score: 48,
    categoryScores: {
      sources: 58,
      coverage: 32,
      competitorQuality: 78,
      decisionReadiness: 38,
    },
    blockingFailures: [
      "Important customer, market, financial, and reputation evidence is still missing.",
    ],
    warnings: [
      "The three-brand competitor view is useful but not yet a complete market map.",
    ],
    triangulatedMaterialClaimRatio: 0.33,
  },
};
