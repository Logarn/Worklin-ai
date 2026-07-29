import {
  createHmac,
  randomUUID,
} from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  KlaviyoRetentionConnector,
  ShopifyRetentionConnector,
} from "./connectors.js";

const integrationId = randomUUID();

describe("Shopify retention connector", () => {
  test("verifies raw bytes and normalizes commerce evidence", () => {
    const secret = "shopify-webhook-secret";
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 10,
        updated_at: "2026-07-28T10:00:00.000Z",
        customer: {
          id: 44,
          email: "buyer@example.com",
          first_name: "Ada",
        },
      }),
    );
    const headers = new Headers({
      "x-shopify-topic": "orders/create",
      "x-shopify-webhook-id": "event-1",
      "x-shopify-hmac-sha256": createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64"),
    });
    const connector = new ShopifyRetentionConnector();
    const input = { integrationId, headers, rawBody, secret };
    expect(connector.verifyWebhook(input)).toBe(true);
    const [event] = connector.normalizeWebhook(input);
    expect(event?.externalEventId).toBe("event-1");
    expect(event?.customerExternalId).toBe("44");
    expect(event?.payload).toMatchObject({
      customer: { email: "buyer@example.com", externalId: "44" },
    });
  });

  test("rejects forged signatures", () => {
    const connector = new ShopifyRetentionConnector();
    expect(
      connector.verifyWebhook({
        integrationId,
        headers: new Headers({
          "x-shopify-hmac-sha256": Buffer.alloc(32).toString("base64"),
        }),
        rawBody: Buffer.from("{}"),
        secret: "correct-secret",
      }),
    ).toBe(false);
  });
});

describe("Klaviyo retention connector", () => {
  test("rejects delayed signed deliveries", () => {
    const connector = new KlaviyoRetentionConnector();
    const secret = "klaviyo-webhook-secret";
    const rawBody = Buffer.from('{"data":[]}');
    const timestamp = "2026-07-28T10:00:00.000Z";
    const headers = new Headers({
      "klaviyo-timestamp": timestamp,
      "klaviyo-signature": createHmac("sha256", secret)
        .update(rawBody)
        .update(timestamp)
        .digest("hex"),
    });
    expect(
      connector.verifyWebhook({
        integrationId,
        headers,
        rawBody,
        secret,
        now: new Date("2026-07-28T10:06:00.000Z"),
      }),
    ).toBe(false);
  });
});
