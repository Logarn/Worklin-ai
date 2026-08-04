import { describe, expect, test } from "bun:test";

import {
  createRetentionOperatorRoutes,
  isAssistantOperatorRoute,
  retentionOperatorBridgeConfigFromEnv,
} from "./retention-operator-handlers.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_ID = "assistant-1";
const SECRET = "retention-gateway-ingress-secret-2026";

describe("retention operator IPC bridge", () => {
  test("fails closed on incomplete enabled configuration", () => {
    expect(() =>
      retentionOperatorBridgeConfigFromEnv({
        WORKLIN_RETENTION_ASSISTANT_BRIDGE_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      retentionOperatorBridgeConfigFromEnv({
        WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_BRIDGE_ENABLED: "true",
      }),
    ).toThrow();
  });

  test("allows preparation routes but never approval, integrations, or send", () => {
    expect(isAssistantOperatorRoute("GET", "/v1/retention/status")).toBe(true);
    expect(
      isAssistantOperatorRoute("POST", "/v1/retention/reasoning/claim"),
    ).toBe(true);
    expect(
      isAssistantOperatorRoute(
        "POST",
        "/v1/retention/campaigns/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/messages",
      ),
    ).toBe(true);
    expect(
      isAssistantOperatorRoute(
        "POST",
        "/v1/retention/campaigns/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/approve",
      ),
    ).toBe(false);
    expect(
      isAssistantOperatorRoute(
        "POST",
        "/v1/retention/campaigns/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/release",
      ),
    ).toBe(false);
    expect(isAssistantOperatorRoute("POST", "/v1/retention/integrations")).toBe(
      false,
    );
    expect(
      isAssistantOperatorRoute("GET", "/v1/retention/status?org_id=forged"),
    ).toBe(false);
  });

  test("rejects a tenant mismatch before making a network request", async () => {
    let called = false;
    const route = createRetentionOperatorRoutes(
      { runtimeTimeoutMs: 1_000 },
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: SECRET,
        platformOrganizationId: ORG_ID,
        platformAssistantId: ASSISTANT_ID,
      },
      {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    )[0]!;
    const result = await route.handler({
      organizationId: "22222222-2222-4222-8222-222222222222",
      userId: "user-1",
      assistantId: ASSISTANT_ID,
      method: "GET",
      path: "/v1/retention/status",
    });
    expect(called).toBe(false);
    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "retention_tenant_mismatch" } },
    });
  });

  test("replaces authorization and forwards only to the fixed internal route", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const route = createRetentionOperatorRoutes(
      { runtimeTimeoutMs: 1_000 },
      {
        enabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: SECRET,
        platformOrganizationId: ORG_ID,
        platformAssistantId: ASSISTANT_ID,
      },
      {
        fetch: async (input, init) => {
          captured = { url: String(input), init };
          return Response.json({ ok: true }, { status: 200 });
        },
      },
    )[0]!;
    const result = await route.handler({
      organizationId: ORG_ID,
      userId: "user-1",
      assistantId: ASSISTANT_ID,
      method: "GET",
      path: "/v1/retention/status",
    });
    expect(captured?.url).toBe(
      "http://control-plane.internal/internal/retention/operator",
    );
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
  });

  test("archives only the configured tenant through the fixed archive route", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const routes = createRetentionOperatorRoutes(
      { runtimeTimeoutMs: 1_000 },
      {
        enabled: false,
        brandIntelligenceArchiveEnabled: true,
        controlPlaneBaseUrl: "http://control-plane.internal",
        gatewayIngressSecret: SECRET,
        platformOrganizationId: ORG_ID,
        platformAssistantId: ASSISTANT_ID,
      },
      {
        fetch: async (input, init) => {
          captured = { url: String(input), init };
          return Response.json(
            {
              archive: {
                status: "queued",
                jobId: "job-1",
                snapshotId: `brand_research_${"a".repeat(64)}`,
                idempotent: false,
              },
              usage: { warning: false },
            },
            { status: 202 },
          );
        },
      },
    );
    const route = routes.find(
      (candidate) => candidate.method === "brand_intelligence_archive_request",
    )!;
    const payload = {
      organizationId: ORG_ID,
      userId: "user-1",
      assistantId: ASSISTANT_ID,
      brandId: "brand-1",
      snapshotId: `brand_research_${"a".repeat(64)}`,
      brandBrain: { brandId: "brand-1", profile: { name: "Acme" } },
      report: { query: { brandName: "Acme" } },
      quality: null,
    };
    const result = await route.handler(payload);
    expect(captured?.url).toBe(
      "http://control-plane.internal/internal/brand-intelligence/archive",
    );
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    expect(result).toMatchObject({ status: 202 });

    captured = undefined;
    const rejected = await route.handler({
      ...payload,
      assistantId: "another-assistant",
    });
    expect(captured).toBeUndefined();
    expect(rejected).toMatchObject({
      status: 403,
      body: {
        error: { code: "brand_intelligence_archive_tenant_mismatch" },
      },
    });
  });
});
