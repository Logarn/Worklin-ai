import { z } from "zod";

import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import type { IpcRoute } from "./server.js";

const MIN_SECRET_BYTES = 32;
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "x-request-id",
]);

const RetentionOperatorParamsSchema = z
  .object({
    organizationId: z.string().uuid(),
    userId: z.string().trim().min(1).max(512),
    assistantId: z.string().trim().min(1).max(256),
    method: z.enum(["GET", "POST"]),
    path: z.string().trim().min(1).max(512),
    body: z.unknown().optional(),
  })
  .strict();

const BrandIntelligenceArchiveParamsSchema = z
  .object({
    organizationId: z.string().uuid(),
    userId: z.string().trim().min(1).max(512),
    assistantId: z.string().trim().min(1).max(256),
    brandId: z.string().trim().min(1).max(256),
    snapshotId: z.string().regex(/^brand_research_[0-9a-f]{64}$/u),
    brandBrain: z.record(z.string(), z.unknown()),
    report: z.record(z.string(), z.unknown()),
    quality: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export interface RetentionOperatorBridgeConfig {
  enabled: boolean;
  brandIntelligenceArchiveEnabled?: boolean;
  controlPlaneBaseUrl?: string;
  gatewayIngressSecret?: string;
  platformOrganizationId?: string;
  platformAssistantId?: string;
}

export interface RetentionOperatorBridgeDependencies {
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export function retentionOperatorBridgeConfigFromEnv(
  env: Record<string, string | undefined>,
): RetentionOperatorBridgeConfig {
  const enabled = env.WORKLIN_RETENTION_ASSISTANT_BRIDGE_ENABLED === "true";
  const brandIntelligenceArchiveEnabled =
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_BRIDGE_ENABLED === "true";
  if (!enabled && !brandIntelligenceArchiveEnabled) {
    return { enabled: false, brandIntelligenceArchiveEnabled: false };
  }
  const baseUrl = parseOrigin(
    env.WORKLIN_CONTROL_PLANE_INTERNAL_URL,
    "WORKLIN_CONTROL_PLANE_INTERNAL_URL",
  );
  const gatewayIngressSecret =
    env.WORKLIN_RETENTION_GATEWAY_INGRESS_SECRET?.trim() ?? "";
  if (Buffer.byteLength(gatewayIngressSecret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(
      "WORKLIN_RETENTION_GATEWAY_INGRESS_SECRET must contain at least 32 bytes.",
    );
  }
  const platformOrganizationId = env.PLATFORM_ORGANIZATION_ID?.trim() ?? "";
  const platformAssistantId = env.WORKLIN_PLATFORM_ASSISTANT_ID?.trim() ?? "";
  if (!z.string().uuid().safeParse(platformOrganizationId).success) {
    throw new Error(
      "PLATFORM_ORGANIZATION_ID must be a UUID when the retention assistant bridge is enabled.",
    );
  }
  if (!platformAssistantId) {
    throw new Error(
      "WORKLIN_PLATFORM_ASSISTANT_ID is required when the retention assistant bridge is enabled.",
    );
  }
  return {
    enabled,
    brandIntelligenceArchiveEnabled,
    controlPlaneBaseUrl: baseUrl.origin,
    gatewayIngressSecret,
    platformOrganizationId,
    platformAssistantId,
  };
}

export function createRetentionOperatorRoutes(
  gatewayConfig: Pick<GatewayConfig, "runtimeTimeoutMs">,
  config: RetentionOperatorBridgeConfig,
  dependencies: RetentionOperatorBridgeDependencies = {},
): IpcRoute[] {
  return [
    {
      method: "retention_operator_request",
      schema: RetentionOperatorParamsSchema,
      handler: async (raw?: Record<string, unknown>) => {
        if (!config.enabled) {
          return errorResult(503, "retention_assistant_bridge_disabled");
        }
        const params = RetentionOperatorParamsSchema.parse(raw);
        if (
          params.organizationId !== config.platformOrganizationId ||
          params.assistantId !== config.platformAssistantId
        ) {
          return errorResult(403, "retention_tenant_mismatch");
        }
        if (!isAssistantOperatorRoute(params.method, params.path)) {
          return errorResult(403, "retention_route_not_allowed");
        }

        const target = new URL(
          "/internal/retention/operator",
          config.controlPlaneBaseUrl,
        );
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          gatewayConfig.runtimeTimeoutMs,
        );
        try {
          const response = await (dependencies.fetch ?? fetchImpl)(target, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.gatewayIngressSecret!}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(params),
            redirect: "manual",
            signal: controller.signal,
          });
          const headers: Record<string, string> = {};
          for (const [key, value] of response.headers) {
            if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
              headers[key.toLowerCase()] = value;
            }
          }
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("application/json")
            ? await response.json().catch(() => ({
                error: { code: "retention_invalid_response" },
              }))
            : await response.text();
          return { status: response.status, headers, body };
        } catch {
          return errorResult(503, "retention_control_plane_unavailable");
        } finally {
          clearTimeout(timeout);
        }
      },
    },
    {
      method: "brand_intelligence_archive_request",
      schema: BrandIntelligenceArchiveParamsSchema,
      handler: async (raw?: Record<string, unknown>) => {
        if (!config.brandIntelligenceArchiveEnabled) {
          return errorResult(503, "brand_intelligence_archive_disabled");
        }
        const params = BrandIntelligenceArchiveParamsSchema.parse(raw);
        if (
          params.organizationId !== config.platformOrganizationId ||
          params.assistantId !== config.platformAssistantId
        ) {
          return errorResult(403, "brand_intelligence_archive_tenant_mismatch");
        }

        const target = new URL(
          "/internal/brand-intelligence/archive",
          config.controlPlaneBaseUrl,
        );
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          gatewayConfig.runtimeTimeoutMs,
        );
        try {
          const response = await (dependencies.fetch ?? fetchImpl)(target, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.gatewayIngressSecret!}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(params),
            redirect: "manual",
            signal: controller.signal,
          });
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("application/json")
            ? await response.json().catch(() => ({
                error: { code: "brand_intelligence_archive_invalid_response" },
              }))
            : await response.text();
          return {
            status: response.status,
            headers: { "content-type": "application/json" },
            body,
          };
        } catch {
          return errorResult(503, "brand_intelligence_archive_unavailable");
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  ];
}

export function isAssistantOperatorRoute(
  method: "GET" | "POST",
  path: string,
): boolean {
  if (
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /%(?:2f|5c)/iu.test(path) ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }
  if (method === "GET") {
    return (
      path === "/v1/retention/status" ||
      /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/approval-preview$/iu.test(path)
    );
  }
  return (
    path === "/v1/retention/brands" ||
    path === "/v1/retention/programs" ||
    path === "/v1/retention/segments" ||
    path === "/v1/retention/reasoning/claim" ||
    path === "/v1/retention/decisions/complete" ||
    path === "/v1/retention/campaigns" ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/audience\/freeze$/iu.test(path) ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/generation\/prepare$/iu.test(
      path,
    ) ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/messages$/iu.test(path)
  );
}

function parseOrigin(value: string | undefined, label: string): URL {
  let url: URL;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return url;
}

function errorResult(status: number, code: string) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: {
      error: { code },
    },
  };
}
