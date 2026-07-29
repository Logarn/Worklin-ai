import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";

const DROPPED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-assistant-id",
  "x-org-id",
  "x-organization-id",
  "x-tenant-id",
  "x-user-id",
  "x-worklin-assistant-id",
  "x-worklin-integration-connection-id",
  "x-worklin-org-id",
  "x-worklin-organization-id",
  "x-worklin-provider",
  "x-worklin-tenant-id",
  "x-worklin-user-id",
  "x-worklin-webhook-content-sha256",
  "x-worklin-webhook-signature",
  "x-worklin-webhook-timestamp",
]);

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "x-request-id",
]);
const MAX_CONTROL_PLANE_RESPONSE_BYTES = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RetentionProviderWebhookConfig {
  enabled: boolean;
  controlPlaneBaseUrl?: string;
  gatewayIngressSecret?: string;
}

export interface RetentionProviderWebhookDependencies {
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export function retentionProviderWebhookConfigFromEnv(
  env: Record<string, string | undefined>,
): RetentionProviderWebhookConfig {
  if (env.WORKLIN_RETENTION_WEBHOOKS_ENABLED !== "true") {
    return { enabled: false };
  }
  const baseUrlValue = env.WORKLIN_CONTROL_PLANE_INTERNAL_URL?.trim() ?? "";
  const gatewayIngressSecret =
    env.WORKLIN_RETENTION_GATEWAY_INGRESS_SECRET?.trim() ?? "";
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new Error("WORKLIN_CONTROL_PLANE_INTERNAL_URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  ) {
    throw new Error(
      "WORKLIN_CONTROL_PLANE_INTERNAL_URL must be an HTTP(S) origin.",
    );
  }
  if (Buffer.byteLength(gatewayIngressSecret, "utf8") < 32) {
    throw new Error(
      "WORKLIN_RETENTION_GATEWAY_INGRESS_SECRET must contain at least 32 bytes.",
    );
  }
  return {
    enabled: true,
    controlPlaneBaseUrl: baseUrl.origin,
    gatewayIngressSecret,
  };
}

export function createRetentionProviderWebhookHandler(
  gatewayConfig: Pick<
    GatewayConfig,
    "maxWebhookPayloadBytes" | "runtimeTimeoutMs"
  >,
  config: RetentionProviderWebhookConfig,
  dependencies: RetentionProviderWebhookDependencies = {},
) {
  return async (
    request: Request,
    provider: "shopify" | "klaviyo",
    connectionId: string,
  ): Promise<Response> => {
    if (!config.enabled) {
      return Response.json(
        { error: { code: "retention_webhooks_disabled" } },
        { status: 503 },
      );
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: { code: "method_not_allowed" } },
        { status: 405 },
      );
    }
    if (!UUID_PATTERN.test(connectionId)) {
      return Response.json(
        { error: { code: "integration_not_found" } },
        { status: 404 },
      );
    }
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength &&
      (!/^\d+$/u.test(declaredLength) ||
        Number(declaredLength) > gatewayConfig.maxWebhookPayloadBytes)
    ) {
      return Response.json(
        { error: { code: "payload_too_large" } },
        { status: 413 },
      );
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > gatewayConfig.maxWebhookPayloadBytes) {
      return Response.json(
        { error: { code: "payload_too_large" } },
        { status: 413 },
      );
    }

    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (!DROPPED_HEADERS.has(key.toLowerCase())) {
        headers.append(key, value);
      }
    }
    headers.set("authorization", `Bearer ${config.gatewayIngressSecret!}`);
    const target = new URL(config.controlPlaneBaseUrl!);
    target.pathname =
      `/internal/retention/webhooks/${provider}/` +
      encodeURIComponent(connectionId);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      gatewayConfig.runtimeTimeoutMs,
    );
    try {
      const response = await (dependencies.fetch ?? fetchImpl)(target, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      const responseBody = await readBoundedResponse(
        response,
        MAX_CONTROL_PLANE_RESPONSE_BYTES,
      );
      const responseHeaders = new Headers();
      for (const [key, value] of response.headers) {
        if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
          responseHeaders.set(key, value);
        }
      }
      return new Response(responseBody, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch {
      return Response.json(
        { error: { code: "retention_webhook_unavailable" } },
        { status: 503 },
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Retention webhook response exceeded its limit.");
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Retention webhook response exceeded its limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}
