import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type {
  RetentionProviderWebhookBinding,
  RetentionServicePrincipal,
} from "./retention-service-auth.js";
import type {
  EnabledRetentionServiceConfig,
  RetentionServiceConfig,
} from "./retention-service-config.js";
import {
  forwardRetentionProviderWebhook,
  normalizeRetentionServicePath,
  proxyAuthenticatedRetentionRequest,
  type RetentionServiceFetch,
} from "./retention-service-proxy.js";

const CONFIG: EnabledRetentionServiceConfig = {
  enabled: true,
  internalBaseUrl: "http://retention-service.internal/",
  serviceJwtSecret: "jwt-secret-".padEnd(40, "a"),
  providerWebhookSecret: "webhook-secret-".padEnd(40, "b"),
  tokenTtlSeconds: 30,
  requestTimeoutMs: 20,
  maxRequestBodyBytes: 64,
};
const PRINCIPAL: RetentionServicePrincipal = {
  organizationId: "org-trusted",
  userId: "user-trusted",
  assistantId: "assistant-trusted",
  roles: ["retention_marketer"],
};

function tokenClaims(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer\s+/u, "");
  const payload = token.split(".")[1]!;
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("retention service proxy", () => {
  test("normalizes only paths inside the retention boundary", () => {
    expect(normalizeRetentionServicePath("/v1/retention/")).toBe(
      "/v1/retention",
    );
    expect(normalizeRetentionServicePath("/v1/retention/%63ampaigns/123")).toBe(
      "/v1/retention/campaigns/123",
    );
    expect(() =>
      normalizeRetentionServicePath("/v1/retention//campaigns"),
    ).toThrow();
    expect(() =>
      normalizeRetentionServicePath("/v1/retention/%2e%2e/admin"),
    ).toThrow();
    expect(() =>
      normalizeRetentionServicePath("/v1/retention/%252e%252e/admin"),
    ).toThrow();
    expect(() =>
      normalizeRetentionServicePath("/v1/retention/a%2Fb"),
    ).toThrow();
    expect(() => normalizeRetentionServicePath("/v1/admin")).toThrow();
  });

  test("overwrites client authorization and tenant routing values", async () => {
    let capturedRequest: Request | undefined;
    const fetchImpl: RetentionServiceFetch = async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json({ ok: true });
    };
    const request = new Request(
      "https://worklin.example.com/v1/retention/campaigns?org_id=org-forged&view=summary",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "X-Worklin-Org-Id": "org-forged",
        },
        body: JSON.stringify({ name: "Campaign" }),
      },
    );

    const response = await proxyAuthenticatedRetentionRequest(
      CONFIG,
      request,
      PRINCIPAL,
      { fetch: fetchImpl, nowMs: () => 10_000 },
    );

    expect(response.status).toBe(200);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toBe(
      "http://retention-service.internal/v1/retention/campaigns?view=summary",
    );
    const authorization =
      capturedRequest!.headers.get("authorization") ?? "";
    expect(authorization).toStartWith("Bearer ");
    expect(authorization).not.toBe("Bearer client-token");
    expect(tokenClaims(authorization)).toMatchObject({
      organization_id: "org-trusted",
      user_id: "user-trusted",
      assistant_id: "assistant-trusted",
    });
    expect(capturedRequest!.headers.has("x-worklin-org-id")).toBe(false);
  });

  test("does not call upstream while disabled", async () => {
    let called = false;
    const disabled: RetentionServiceConfig = { enabled: false };
    const response = await proxyAuthenticatedRetentionRequest(
      disabled,
      new Request("https://worklin.example.com/v1/retention/customers"),
      PRINCIPAL,
      {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    );

    expect(response.status).toBe(503);
    expect(called).toBe(false);
    expect(await response.json()).toMatchObject({
      code: "retention_service_disabled",
    });
  });

  test("sanitizes upstream status, body, and headers", async () => {
    const response = await proxyAuthenticatedRetentionRequest(
      CONFIG,
      new Request("https://worklin.example.com/v1/retention/customers"),
      PRINCIPAL,
      {
        fetch: async () =>
          new Response("database password=upstream-secret", {
            status: 500,
            headers: {
              Server: "retention-internal",
              "X-Debug-Token": "upstream-secret",
            },
          }),
      },
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).toContain("retention_service_unavailable");
    expect(body).not.toContain("upstream-secret");
    expect(response.headers.has("server")).toBe(false);
    expect(response.headers.has("x-debug-token")).toBe(false);
  });

  test("enforces streamed body limits and request timeouts", async () => {
    let called = false;
    const oversized = await proxyAuthenticatedRetentionRequest(
      CONFIG,
      new Request("https://worklin.example.com/v1/retention/campaigns", {
        method: "POST",
        body: "x".repeat(65),
      }),
      PRINCIPAL,
      {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    );
    expect(oversized.status).toBe(413);
    expect(called).toBe(false);

    const timedOut = await proxyAuthenticatedRetentionRequest(
      CONFIG,
      new Request("https://worklin.example.com/v1/retention/customers"),
      PRINCIPAL,
      {
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      },
    );
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({
      code: "retention_service_timeout",
    });
  });

  test("forwards provider webhooks using only the trusted tenant binding", async () => {
    let capturedRequest: Request | undefined;
    const binding: RetentionProviderWebhookBinding = {
      organizationId: "org-trusted",
      userId: "user-trusted",
      assistantId: "assistant-trusted",
      integrationConnectionId: "connection-123",
      provider: "shopify",
    };
    const body = JSON.stringify({ topic: "orders/create" });
    const response = await forwardRetentionProviderWebhook(
      CONFIG,
      new Request(
      "https://worklin.example.com/hooks/shopify?ORGANIZATION_ID=org-forged&delivery=123",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer forged-token",
            "Content-Type": "application/json",
            "X-Shopify-Hmac-SHA256": "provider-signature",
            "X-Worklin-Organization-Id": "org-forged",
            "X-Worklin-Webhook-Signature": "v1=forged",
          },
          body,
        },
      ),
      binding,
      {
        nowMs: () => 20_000,
        fetch: async (input, init) => {
          capturedRequest = new Request(input, init);
          return Response.json({ accepted: true }, { status: 202 });
        },
      },
    );

    expect(response.status).toBe(202);
    expect(capturedRequest!.url).toBe(
      "http://retention-service.internal/v1/retention/integrations/shopify/webhooks/connection-123?delivery=123",
    );
    const authorization =
      capturedRequest!.headers.get("authorization") ?? "";
    expect(authorization).not.toBe("Bearer forged-token");
    expect(tokenClaims(authorization)).toMatchObject({
      token_use: "provider_webhook",
      organization_id: "org-trusted",
      user_id: "user-trusted",
      assistant_id: "assistant-trusted",
      integration_connection_id: "connection-123",
      provider: "shopify",
    });
    expect(
      capturedRequest!.headers.get("x-shopify-hmac-sha256"),
    ).toBe("provider-signature");
    expect(
      capturedRequest!.headers.get("x-worklin-organization-id"),
    ).toBeNull();

    const digest = capturedRequest!.headers.get(
      "x-worklin-webhook-content-sha256",
    )!;
    const expectedSignature = createHmac(
      "sha256",
      CONFIG.providerWebhookSecret,
    )
      .update(
        [
          "20",
          "shopify",
          "connection-123",
          "org-trusted",
          "user-trusted",
          "assistant-trusted",
          digest,
        ].join("\n"),
      )
      .digest("base64url");
    expect(
      capturedRequest!.headers.get("x-worklin-webhook-signature"),
    ).toBe(`v1=${expectedSignature}`);
  });
});
