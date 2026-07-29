import { describe, expect, test } from "bun:test";

import {
  createRetentionProviderWebhookHandler,
  retentionProviderWebhookConfigFromEnv,
} from "./retention-provider-webhook.js";

const gatewayConfig = {
  maxWebhookPayloadBytes: 1024,
  runtimeTimeoutMs: 1_000,
};

describe("retention provider webhook gateway", () => {
  test("stays fail-closed until explicitly configured", async () => {
    const handler = createRetentionProviderWebhookHandler(
      gatewayConfig,
      retentionProviderWebhookConfigFromEnv({}),
    );
    const response = await handler(
      new Request("https://api.example/webhooks", {
        method: "POST",
        body: "{}",
      }),
      "shopify",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(503);
  });

  test("replaces authorization and removes forged tenant context", async () => {
    let forwarded: Request | null = null;
    const handler = createRetentionProviderWebhookHandler(
      gatewayConfig,
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: "gateway-ingress-secret-at-least-32-bytes",
      },
      {
        fetch: async (input, init) => {
          forwarded = new Request(input, init);
          return Response.json({ accepted: 1 }, { status: 202 });
        },
      },
    );
    const raw = '{"id":"provider-event"}';
    const response = await handler(
      new Request("https://api.example/webhooks", {
        method: "POST",
        headers: {
          authorization: "Bearer attacker",
          "x-org-id": "victim",
          "x-worklin-assistant-id": "victim-assistant",
          "x-shopify-hmac-sha256": "provider-signature",
        },
        body: raw,
      }),
      "shopify",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(202);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.get("authorization")).toBe(
      "Bearer gateway-ingress-secret-at-least-32-bytes",
    );
    expect(forwarded!.headers.get("x-org-id")).toBeNull();
    expect(forwarded!.headers.get("x-worklin-assistant-id")).toBeNull();
    expect(forwarded!.headers.get("x-shopify-hmac-sha256")).toBe(
      "provider-signature",
    );
    expect(await forwarded!.text()).toBe(raw);
  });

  test("rejects malformed connection identifiers", async () => {
    let called = false;
    const handler = createRetentionProviderWebhookHandler(
      gatewayConfig,
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: "gateway-ingress-secret-at-least-32-bytes",
      },
      {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    );
    const response = await handler(
      new Request("https://api.example/webhooks", {
        method: "POST",
        body: "{}",
      }),
      "shopify",
      "11111111-1111-1111-1111-111111111111-extra",
    );
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  test("bounds the internal control-plane response", async () => {
    const handler = createRetentionProviderWebhookHandler(
      gatewayConfig,
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: "gateway-ingress-secret-at-least-32-bytes",
      },
      {
        fetch: async () =>
          new Response("x", {
            headers: { "content-length": String(65 * 1024) },
          }),
      },
    );
    const response = await handler(
      new Request("https://api.example/webhooks", {
        method: "POST",
        body: "{}",
      }),
      "klaviyo",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "retention_webhook_unavailable" },
    });
  });

  test("rejects oversized payloads before forwarding", async () => {
    let called = false;
    const handler = createRetentionProviderWebhookHandler(
      { ...gatewayConfig, maxWebhookPayloadBytes: 4 },
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: "gateway-ingress-secret-at-least-32-bytes",
      },
      {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    );
    const response = await handler(
      new Request("https://api.example/webhooks", {
        method: "POST",
        body: "12345",
      }),
      "klaviyo",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(response.status).toBe(413);
    expect(called).toBe(false);
  });
});
