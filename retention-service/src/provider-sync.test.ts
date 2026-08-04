import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  KLAVIYO_API_REVISION,
  SHOPIFY_ADMIN_API_VERSION,
  KlaviyoProviderSyncClient,
  ProviderSyncError,
  ShopifyProviderSyncClient,
  isAllowlistedKlaviyoTraitKey,
} from "./provider-sync.js";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CapturedRequest {
  url: URL;
  init: RequestInit | undefined;
}

const integrationId = randomUUID();
const now = () => new Date("2026-07-28T12:00:00.000Z");

function jsonResponse(
  value: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

function captureFetch(responses: readonly Response[]): {
  fetch: FetchImplementation;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({
        url: new URL(input instanceof Request ? input.url : input),
        init,
      });
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error("Unexpected test request");
      }
      return response;
    },
  };
}

function shopifyCustomer(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "gid://shopify/Customer/1001",
    firstName: "Alice",
    lastName: "Example",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    numberOfOrders: 2,
    amountSpent: {
      amount: "145.50",
      currencyCode: "USD",
    },
    defaultEmailAddress: {
      emailAddress: "alice@example.com",
    },
    defaultPhoneNumber: {
      phoneNumber: "+1-202-555-0100",
    },
    emailMarketingConsent: {
      marketingState: "SUBSCRIBED",
      consentUpdatedAt: "2026-07-01T10:00:00.000Z",
    },
    ...overrides,
  };
}

function shopifyOrder(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "gid://shopify/Order/2001",
    name: "#2001",
    createdAt: "2026-07-27T09:00:00.000Z",
    updatedAt: "2026-07-28T11:00:00.000Z",
    processedAt: "2026-07-27T09:01:00.000Z",
    cancelledAt: null,
    email: "alice@example.com",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    subtotalLineItemsQuantity: 2,
    currentTotalPriceSet: {
      shopMoney: {
        amount: "75.00",
        currencyCode: "USD",
      },
    },
    customer: {
      id: "gid://shopify/Customer/1001",
      firstName: "Alice",
      lastName: "Example",
      defaultEmailAddress: {
        emailAddress: "alice@example.com",
      },
      defaultPhoneNumber: {
        phoneNumber: "+1-202-555-0100",
      },
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/3001",
          name: "Example product",
          quantity: 2,
          sku: "EXAMPLE-1",
          variant: {
            id: "gid://shopify/ProductVariant/4001",
            product: {
              id: "gid://shopify/Product/5001",
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function shopifyDocument(
  resource: "customers" | "orders",
  nodes: unknown[],
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  } = {
    hasNextPage: false,
    endCursor: null,
  },
): Record<string, unknown> {
  return {
    data: {
      [resource]: {
        nodes,
        pageInfo,
      },
    },
    extensions: {
      cost: {
        requestedQueryCost: 12,
        actualQueryCost: 7,
        throttleStatus: {
          maximumAvailable: 1_000,
          currentlyAvailable: 993,
          restoreRate: 50,
        },
      },
    },
  };
}

function klaviyoProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "profile",
    id: "profile-1",
    attributes: {
      email: "alice@example.com",
      phone_number: "+12025550100",
      first_name: "Alice",
      last_name: "Example",
      created: "2026-01-01T10:00:00.000Z",
      updated: "2026-07-28T10:30:00.000Z",
      properties: {
        "Favorite category": "Skin care",
        "Approved score": 8,
        "Unapproved secret": "must not leave the adapter",
      },
      subscriptions: {
        email: {
          marketing: {
            consent: "SUBSCRIBED",
            suppression: [],
          },
        },
      },
    },
    ...overrides,
  };
}

function klaviyoDocument(
  data: unknown[],
  options: {
    next?: string | null;
    included?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    data,
    included: options.included ?? [],
    links: {
      next: options.next ?? null,
      prev: null,
      self: "https://a.klaviyo.com/api/profiles",
    },
  };
}

describe("ShopifyProviderSyncClient", () => {
  test("rejects non-Shopify, credentialed, port, and path-based origins", () => {
    const invalidDomains = [
      "shop.myshopify.com.evil.example",
      "https://shop.myshopify.com@evil.example",
      "https://shop.myshopify.com:444",
      "https://shop.myshopify.com/admin",
      "http://shop.myshopify.com",
      "myshopify.com",
    ];

    for (const shopDomain of invalidDomains) {
      expect(
        () =>
          new ShopifyProviderSyncClient({
            shopDomain,
            accessToken: "shopify-token",
          }),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_configuration",
        }),
      );
    }
  });

  test("uses only the pinned Admin GraphQL endpoint and normalizes customers", async () => {
    const mock = captureFetch([
      jsonResponse(shopifyDocument("customers", [shopifyCustomer()])),
    ]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: "shopify-token",
      fetch: mock.fetch,
      now,
    });

    const page = await client.historicalBackfillPage({
      integrationId,
      resource: "customers",
      pageSize: 25,
    });

    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.url.toString()).toBe(
      `https://example-shop.myshopify.com/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    );
    expect(request.init?.method).toBe("POST");
    expect(
      new Headers(request.init?.headers).get("x-shopify-access-token"),
    ).toBe("shopify-token");
    expect(new Headers(request.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    const body = JSON.parse(String(request.init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("query WorklinRetentionCustomers");
    expect(body.query).not.toContain("mutation");
    expect(request.url.pathname).not.toContain("/customers");
    expect(request.url.pathname).not.toContain("/orders");
    expect(body.variables).toEqual({
      first: 25,
      after: null,
      query: null,
    });
    expect(page).toMatchObject({
      provider: "shopify",
      lifecycle: "historical_backfill",
      resource: "customers",
      hasMore: false,
      checkpoint: {
        cursor: null,
        watermark: "2026-07-28T10:00:00.000Z",
      },
      rateLimit: {
        shopifyCost: {
          requested: 12,
          actual: 7,
          maximumAvailable: 1_000,
          currentlyAvailable: 993,
          restoreRate: 50,
        },
      },
    });
    expect(page.events).toEqual([
      expect.objectContaining({
        integrationId,
        provider: "shopify",
        externalEventId:
          "shopify.customer:gid://shopify/Customer/1001:2026-07-28T10:00:00.000Z",
        eventType: "shopify.customer.snapshot",
        occurredAt: "2026-07-28T10:00:00.000Z",
        customerExternalId: "gid://shopify/Customer/1001",
        signatureVerified: false,
        payload: expect.objectContaining({
          customer: {
            externalId: "gid://shopify/Customer/1001",
            email: "alice@example.com",
            phone: "+1-202-555-0100",
            displayName: "Alice Example",
          },
          consent: {
            channel: "email",
            state: "subscribed",
          },
        }),
      }),
    ]);
  });

  test("resumes an incremental customer page from a validated cursor", async () => {
    const nextCursor = "eyJsYXN0X2lkIjoxMDAxfQ==";
    const mock = captureFetch([
      jsonResponse(
        shopifyDocument("customers", [shopifyCustomer()], {
          hasNextPage: true,
          endCursor: nextCursor,
        }),
      ),
    ]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: "shopify-token",
      fetch: mock.fetch,
      now,
    });

    const page = await client.incrementalPollPage({
      integrationId,
      resource: "customers",
      checkpoint: {
        cursor: "eyJwYWdlIjoxfQ==",
        watermark: "2026-07-28T09:00:00Z",
      },
    });

    const body = JSON.parse(String(mock.requests[0]?.init?.body)) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables.after).toBe("eyJwYWdlIjoxfQ==");
    expect(body.variables.query).toBe(
      "updated_at:>='2026-07-28T09:00:00.000Z'",
    );
    expect(page.lifecycle).toBe("incremental_poll");
    expect(page.hasMore).toBe(true);
    expect(page.checkpoint).toEqual({
      cursor: nextCursor,
      watermark: "2026-07-28T09:00:00.000Z",
      pendingWatermark: "2026-07-28T10:00:00.000Z",
    });
  });

  test("normalizes orders and never regresses a watermark for old records", async () => {
    const mock = captureFetch([
      jsonResponse(shopifyDocument("orders", [shopifyOrder()])),
    ]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: "shopify-token",
      fetch: mock.fetch,
      now,
    });

    const page = await client.reconciliationPage({
      integrationId,
      resource: "orders",
      checkpoint: {
        watermark: "2026-07-28T11:30:00.000Z",
      },
    });

    expect(page.checkpoint.watermark).toBe("2026-07-28T11:30:00.000Z");
    expect(page.events[0]).toMatchObject({
      customerExternalId: "gid://shopify/Customer/1001",
      eventType: "shopify.order.snapshot",
      payload: {
        commerce: {
          orderId: "gid://shopify/Order/2001",
          name: "#2001",
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
          lineItemQuantity: 2,
          total: {
            amount: "75.00",
            currencyCode: "USD",
          },
          lineItems: [
            {
              id: "gid://shopify/LineItem/3001",
              quantity: 2,
              productId: "gid://shopify/Product/5001",
            },
          ],
        },
      },
    });
  });

  test("rejects URL-shaped cursors before making a request", async () => {
    const mock = captureFetch([]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: "shopify-token",
      fetch: mock.fetch,
    });

    await expect(
      client.incrementalPollPage({
        integrationId,
        resource: "customers",
        checkpoint: {
          cursor: "https://attacker.example/next",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_checkpoint",
    });
    expect(mock.requests).toHaveLength(0);
  });

  test("surfaces rate limits without exposing response bodies or credentials", async () => {
    const secret = "shopify-secret-that-must-not-appear";
    const mock = captureFetch([
      new Response(`Invalid token: ${secret}`, {
        status: 429,
        headers: {
          "retry-after": "3.5",
        },
      }),
    ]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: secret,
      fetch: mock.fetch,
      now,
    });

    try {
      await client.historicalBackfillPage({
        integrationId,
        resource: "customers",
      });
      throw new Error("Expected the provider request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSyncError);
      expect(error).toMatchObject({
        code: "provider_rate_limited",
        status: 429,
        rateLimit: {
          retryAfterMs: 3_500,
        },
      });
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("Invalid token");
    }
  });

  test("rejects malformed and oversized GraphQL responses", async () => {
    const mock = captureFetch([
      jsonResponse({
        data: {
          customers: {
            nodes: "not-an-array",
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }),
      new Response("{}", {
        headers: {
          "content-length": String(4 * 1024 * 1024 + 1),
        },
      }),
    ]);
    const client = new ShopifyProviderSyncClient({
      shopDomain: "example-shop.myshopify.com",
      accessToken: "shopify-token",
      fetch: mock.fetch,
    });

    await expect(
      client.historicalBackfillPage({
        integrationId,
        resource: "customers",
      }),
    ).rejects.toMatchObject({
      code: "malformed_provider_response",
    });
    await expect(
      client.historicalBackfillPage({
        integrationId,
        resource: "customers",
      }),
    ).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
  });
});

describe("KlaviyoProviderSyncClient", () => {
  test("matches stored prefixed traits to raw approved property names", () => {
    expect(
      isAllowlistedKlaviyoTraitKey("klaviyo.Customer stage", [
        "Customer stage",
      ]),
    ).toBe(true);
    expect(
      isAllowlistedKlaviyoTraitKey("klaviyo.Unapproved property", [
        "Customer stage",
      ]),
    ).toBe(false);
    expect(
      isAllowlistedKlaviyoTraitKey("Customer stage", ["Customer stage"]),
    ).toBe(false);
  });
  test("uses pinned read-only profile requests and applies the property allowlist", async () => {
    const nextCursor = "bmV4dDo6cHJvZmlsZS0x";
    const mock = captureFetch([
      jsonResponse(
        klaviyoDocument([klaviyoProfile()], {
          next: `https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=${nextCursor}`,
        }),
        {
          headers: {
            "ratelimit-limit": "750",
            "ratelimit-remaining": "749",
            "ratelimit-reset": "2",
          },
        },
      ),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: ["Favorite category", "Approved score"],
      fetch: mock.fetch,
      now,
    });

    const page = await client.historicalBackfillPage({
      integrationId,
      resource: "profiles",
      pageSize: 50,
    });

    const request = mock.requests[0]!;
    expect(request.url.origin).toBe("https://a.klaviyo.com");
    expect(request.url.pathname).toBe("/api/profiles");
    expect(request.url.searchParams.get("page[size]")).toBe("50");
    expect(request.url.searchParams.get("sort")).toBe("updated");
    expect(request.init?.method).toBe("GET");
    expect(request.init?.body).toBeUndefined();
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe(
      "Klaviyo-API-Key klaviyo-private-key",
    );
    expect(headers.get("revision")).toBe(KLAVIYO_API_REVISION);
    expect(headers.get("accept")).toBe("application/vnd.api+json");
    expect(page).toMatchObject({
      provider: "klaviyo",
      lifecycle: "historical_backfill",
      resource: "profiles",
      hasMore: true,
      checkpoint: {
        cursor: nextCursor,
        watermark: null,
        pendingWatermark: "2026-07-28T10:30:00.000Z",
      },
      rateLimit: {
        limit: 750,
        remaining: 749,
        resetAfterMs: 2_000,
      },
    });
    expect(page.events[0]).toMatchObject({
      eventType: "klaviyo.profile.snapshot",
      customerExternalId: "profile-1",
      signatureVerified: false,
      payload: {
        customer: {
          externalId: "profile-1",
          email: "alice@example.com",
          phone: "+12025550100",
          displayName: "Alice Example",
        },
        consent: {
          channel: "email",
          state: "subscribed",
        },
        traits: [
          {
            key: "klaviyo.Favorite category",
            value: "Skin care",
            evidenceKind: "imported",
            sensitivity: "personal",
            confidence: 1,
          },
          {
            key: "klaviyo.Approved score",
            value: 8,
          },
        ],
      },
    });
    expect(JSON.stringify(page.events)).not.toContain("Unapproved secret");
    expect(JSON.stringify(page.events)).not.toContain(
      "must not leave the adapter",
    );
  });

  test("rebuilds cursor requests locally and ignores all other next-link query state", async () => {
    const firstCursor = "bmV4dDo6cHJvZmlsZS0x";
    const mock = captureFetch([
      jsonResponse(
        klaviyoDocument([], {
          next: `https://a.klaviyo.com/api/profiles?filter=evil&page%5Bcursor%5D=${firstCursor}&include=segments`,
        }),
      ),
      jsonResponse(klaviyoDocument([])),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: [],
      fetch: mock.fetch,
      now,
    });

    const first = await client.incrementalPollPage({
      integrationId,
      resource: "profiles",
      checkpoint: {
        watermark: "2026-07-28T09:00:00Z",
      },
    });
    await client.incrementalPollPage({
      integrationId,
      resource: "profiles",
      checkpoint: first.checkpoint,
    });

    const resumed = mock.requests[1]!.url;
    expect(resumed.origin).toBe("https://a.klaviyo.com");
    expect(resumed.pathname).toBe("/api/profiles");
    expect(resumed.searchParams.get("page[cursor]")).toBe(firstCursor);
    expect(resumed.searchParams.get("include")).toBeNull();
    expect(resumed.searchParams.get("filter")).toBe(
      "greater-or-equal(updated,2026-07-28T09:00:00.000Z)",
    );
  });

  test("rejects cross-origin, credentialed, wrong-path, and malformed next links", async () => {
    const nextLinks = [
      "https://attacker.example/api/profiles?page%5Bcursor%5D=abc",
      "https://user:pass@a.klaviyo.com/api/profiles?page%5Bcursor%5D=abc",
      "https://a.klaviyo.com/api/segments?page%5Bcursor%5D=abc",
      "https://a.klaviyo.com/api/profiles",
      "not-a-url",
    ];

    for (const next of nextLinks) {
      const mock = captureFetch([jsonResponse(klaviyoDocument([], { next }))]);
      const client = new KlaviyoProviderSyncClient({
        privateApiKey: "klaviyo-private-key",
        propertyAllowlist: [],
        fetch: mock.fetch,
      });
      await expect(
        client.historicalBackfillPage({
          integrationId,
          resource: "profiles",
        }),
      ).rejects.toMatchObject({
        code: "malformed_provider_response",
      });
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("normalizes events with included profile and metric data", async () => {
    const data = [
      {
        type: "event",
        id: "event-2",
        attributes: {
          uuid: "event-uuid-2",
          datetime: "2026-07-28T11:00:00.000Z",
          timestamp: 1_753_703_200,
          event_properties: {
            "Campaign name": "Example campaign",
            "Private note": "not approved",
          },
        },
        relationships: {
          profile: {
            data: {
              type: "profile",
              id: "profile-1",
            },
          },
          metric: {
            data: {
              type: "metric",
              id: "metric-1",
            },
          },
        },
      },
      {
        type: "event",
        id: "event-1",
        attributes: {
          uuid: "event-uuid-1",
          datetime: "2026-07-28T10:00:00.000Z",
          timestamp: 1_753_699_600,
          event_properties: {},
        },
        relationships: {},
      },
    ];
    const included = [
      {
        type: "profile",
        id: "profile-1",
        attributes: {
          email: "alice@example.com",
          phone_number: null,
          first_name: "Alice",
          last_name: "Example",
          properties: {},
        },
      },
      {
        type: "metric",
        id: "metric-1",
        attributes: {
          name: "Clicked Email",
        },
      },
    ];
    const mock = captureFetch([
      jsonResponse(klaviyoDocument(data, { included })),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: ["Campaign name"],
      fetch: mock.fetch,
      now,
    });

    const page = await client.reconciliationPage({
      integrationId,
      resource: "events",
      checkpoint: {
        watermark: "2026-07-28T10:30:00.000Z",
      },
    });

    expect(page.checkpoint.watermark).toBe("2026-07-28T11:00:00.000Z");
    expect(page.events[0]).toMatchObject({
      externalEventId: "klaviyo.event:event-uuid-2",
      eventType: "klaviyo.event",
      occurredAt: "2026-07-28T11:00:00.000Z",
      customerExternalId: "profile-1",
      payload: {
        customer: {
          externalId: "profile-1",
          email: "alice@example.com",
          displayName: "Alice Example",
        },
        delivery: {
          eventId: "event-2",
          metricId: "metric-1",
          metricName: "Clicked Email",
          approvedProperties: {
            "Campaign name": "Example campaign",
          },
        },
      },
    });
    expect(JSON.stringify(page.events)).not.toContain("Private note");
    expect(page.events[1]?.occurredAt).toBe("2026-07-28T10:00:00.000Z");
  });

  test("keeps an existing watermark when every returned event is older", async () => {
    const mock = captureFetch([
      jsonResponse(
        klaviyoDocument([
          klaviyoProfile({
            attributes: {
              ...(klaviyoProfile().attributes as Record<string, unknown>),
              updated: "2026-07-27T10:00:00.000Z",
            },
          }),
        ]),
      ),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: [],
      fetch: mock.fetch,
    });

    const page = await client.incrementalPollPage({
      integrationId,
      resource: "profiles",
      checkpoint: {
        watermark: "2026-07-28T12:00:00.000Z",
      },
    });

    expect(page.checkpoint.watermark).toBe("2026-07-28T12:00:00.000Z");
  });

  test("never issues Klaviyo segment requests or mutation methods", async () => {
    const responses = [
      jsonResponse(klaviyoDocument([])),
      jsonResponse(klaviyoDocument([])),
      jsonResponse(klaviyoDocument([])),
      jsonResponse(klaviyoDocument([])),
      jsonResponse(klaviyoDocument([])),
      jsonResponse(klaviyoDocument([])),
    ];
    const mock = captureFetch(responses);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: [],
      fetch: mock.fetch,
      now,
    });

    for (const resource of ["profiles", "events"] as const) {
      await client.historicalBackfillPage({
        integrationId,
        resource,
      });
      await client.incrementalPollPage({
        integrationId,
        resource,
        checkpoint: {
          watermark: "2026-07-28T09:00:00.000Z",
        },
      });
      await client.reconciliationPage({
        integrationId,
        resource,
        checkpoint: {
          watermark: "2026-07-28T09:00:00.000Z",
        },
      });
    }

    expect(mock.requests).toHaveLength(6);
    for (const request of mock.requests) {
      expect(request.url.origin).toBe("https://a.klaviyo.com");
      expect(["/api/profiles", "/api/events"]).toContain(request.url.pathname);
      expect(request.url.pathname).not.toContain("segment");
      expect(request.init?.method).toBe("GET");
      expect(request.init?.body).toBeUndefined();
    }
  });

  test("rejects malformed JSON:API resources and invalid property allowlists", async () => {
    expect(
      () =>
        new KlaviyoProviderSyncClient({
          privateApiKey: "klaviyo-private-key",
          propertyAllowlist: ["__proto__"],
        }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_configuration",
      }),
    );

    const mock = captureFetch([
      jsonResponse({
        data: {
          type: "profile",
        },
        links: {
          next: null,
        },
      }),
      jsonResponse(
        klaviyoDocument([
          {
            type: "segment",
            id: "segment-1",
            attributes: {},
          },
        ]),
      ),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: [],
      fetch: mock.fetch,
    });

    await expect(
      client.historicalBackfillPage({
        integrationId,
        resource: "profiles",
      }),
    ).rejects.toMatchObject({
      code: "malformed_provider_response",
    });
    await expect(
      client.historicalBackfillPage({
        integrationId,
        resource: "profiles",
      }),
    ).rejects.toMatchObject({
      code: "malformed_provider_response",
    });
  });

  test("surfaces Retry-After metadata and keeps the private key out of errors", async () => {
    const privateApiKey = "klaviyo-secret-that-must-not-appear";
    const mock = captureFetch([
      new Response(`Rejected ${privateApiKey}`, {
        status: 429,
        headers: {
          "retry-after": "Tue, 28 Jul 2026 12:00:05 GMT",
          "ratelimit-limit": "750",
          "ratelimit-remaining": "0",
        },
      }),
    ]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey,
      propertyAllowlist: [],
      fetch: mock.fetch,
      now,
    });

    try {
      await client.historicalBackfillPage({
        integrationId,
        resource: "events",
      });
      throw new Error("Expected the provider request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSyncError);
      expect(error).toMatchObject({
        code: "provider_rate_limited",
        rateLimit: {
          retryAfterMs: 5_000,
          limit: 750,
          remaining: 0,
        },
      });
      expect(String(error)).not.toContain(privateApiKey);
      expect(String(error)).not.toContain("Rejected");
    }
  });

  test("rejects invalid cursors before any provider call", async () => {
    const mock = captureFetch([]);
    const client = new KlaviyoProviderSyncClient({
      privateApiKey: "klaviyo-private-key",
      propertyAllowlist: [],
      fetch: mock.fetch,
    });

    await expect(
      client.incrementalPollPage({
        integrationId,
        resource: "events",
        checkpoint: {
          cursor: "cursor with spaces",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_checkpoint",
    });
    expect(mock.requests).toHaveLength(0);
  });
});
