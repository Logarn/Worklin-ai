import { createHash, createHmac } from "node:crypto";

import {
  assertRetentionProvider,
  mintRetentionProviderWebhookToken,
  mintRetentionServiceToken,
  type RetentionProviderWebhookBinding,
  type RetentionServicePrincipal,
} from "./retention-service-auth.js";
import type {
  EnabledRetentionServiceConfig,
  RetentionServiceConfig,
} from "./retention-service-config.js";

const RETENTION_ROUTE_PREFIX = "/v1/retention";
const TENANT_QUERY_KEYS = new Set([
  "assistant_id",
  "assistantid",
  "org_id",
  "orgid",
  "organization_id",
  "organizationid",
  "tenant_id",
  "tenantid",
  "user_id",
  "userid",
]);
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-assistant-id",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
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
const SAFE_UPSTREAM_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
  "x-request-id",
]);
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const RETENTION_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
]);

export type RetentionServiceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<globalThis.Response>;

export interface RetentionServiceProxyDependencies {
  fetch?: RetentionServiceFetch;
  nowMs?: () => number;
}

export async function proxyAuthenticatedRetentionRequest(
  config: RetentionServiceConfig,
  request: Request,
  principal: RetentionServicePrincipal,
  dependencies: RetentionServiceProxyDependencies = {},
): Promise<Response> {
  if (!config.enabled) return disabledResponse();
  if (!RETENTION_METHODS.has(request.method.toUpperCase())) {
    return jsonResponse(405, "retention_method_not_allowed");
  }

  let path: string;
  try {
    path = normalizeRetentionServicePath(new URL(request.url).pathname);
  } catch {
    return jsonResponse(404, "retention_route_not_found");
  }

  let body: Uint8Array | undefined;
  try {
    body = await readBoundedRequestBody(request, config.maxRequestBodyBytes);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  let token: string;
  try {
    token = mintRetentionServiceToken(
      config,
      principal,
      dependencies.nowMs?.() ?? Date.now(),
    ).token;
  } catch {
    return jsonResponse(403, "retention_access_denied");
  }

  const sourceUrl = new URL(request.url);
  const target = buildTarget(config, path, sourceUrl.searchParams);
  const headers = copyRequestHeaders(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return performUpstreamRequest(
    config,
    target,
    request.method,
    headers,
    body,
    request.signal,
    dependencies.fetch ?? fetch,
  );
}

export async function forwardRetentionProviderWebhook(
  config: RetentionServiceConfig,
  request: Request,
  trustedBinding: RetentionProviderWebhookBinding,
  dependencies: RetentionServiceProxyDependencies = {},
): Promise<Response> {
  if (!config.enabled) return disabledResponse();
  if (request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, "retention_webhook_method_not_allowed");
  }

  let body: Uint8Array | undefined;
  try {
    body = await readBoundedRequestBody(request, config.maxRequestBodyBytes);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  const nowMs = dependencies.nowMs?.() ?? Date.now();
  let token: string;
  let provider: "shopify" | "klaviyo";
  try {
    provider = assertRetentionProvider(trustedBinding.provider);
    token = mintRetentionProviderWebhookToken(
      config,
      trustedBinding,
      nowMs,
    ).token;
  } catch {
    return jsonResponse(403, "retention_webhook_binding_invalid");
  }

  const connectionId = encodeURIComponent(
    trustedBinding.integrationConnectionId,
  );
  const path = `${RETENTION_ROUTE_PREFIX}/integrations/${provider}/webhooks/${connectionId}`;
  const sourceUrl = new URL(request.url);
  const target = buildTarget(config, path, sourceUrl.searchParams);
  const headers = copyRequestHeaders(request.headers);
  const issuedAtSeconds = Math.floor(nowMs / 1_000);
  const bodyDigest = createHash("sha256")
    .update(body ?? new Uint8Array())
    .digest("base64url");
  const signatureInput = [
    issuedAtSeconds,
    provider,
    trustedBinding.integrationConnectionId,
    trustedBinding.organizationId,
    trustedBinding.userId,
    trustedBinding.assistantId,
    bodyDigest,
  ].join("\n");
  const signature = createHmac("sha256", config.providerWebhookSecret)
    .update(signatureInput)
    .digest("base64url");

  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Worklin-Provider", provider);
  headers.set(
    "X-Worklin-Integration-Connection-Id",
    trustedBinding.integrationConnectionId,
  );
  headers.set("X-Worklin-Webhook-Timestamp", String(issuedAtSeconds));
  headers.set("X-Worklin-Webhook-Content-SHA256", bodyDigest);
  headers.set("X-Worklin-Webhook-Signature", `v1=${signature}`);

  return performUpstreamRequest(
    config,
    target,
    "POST",
    headers,
    body,
    request.signal,
    dependencies.fetch ?? fetch,
  );
}

export function normalizeRetentionServicePath(pathname: string): string {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    /%(?:2f|5c)/iu.test(pathname)
  ) {
    throw new Error("Retention service path is invalid.");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error("Retention service path is invalid.");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(decoded) ||
    decoded.includes("?") ||
    decoded.includes("#")
  ) {
    throw new Error("Retention service path is invalid.");
  }

  const segments = decoded.split("/");
  if (segments[0] !== "") {
    throw new Error("Retention service path is invalid.");
  }
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.length < 3 ||
    segments[1] !== "v1" ||
    segments[2] !== "retention"
  ) {
    throw new Error("Retention service path is outside the retention boundary.");
  }
  if (
    segments.some(
      (segment, index) =>
        index > 0 && (segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new Error("Retention service path is invalid.");
  }

  return `/${segments.slice(1).map(encodeURIComponent).join("/")}`;
}

function buildTarget(
  config: EnabledRetentionServiceConfig,
  path: string,
  sourceSearchParams: URLSearchParams,
): URL {
  const target = new URL(config.internalBaseUrl);
  target.pathname = path;
  const search = new URLSearchParams(sourceSearchParams);
  for (const key of [...search.keys()]) {
    if (TENANT_QUERY_KEYS.has(key.toLowerCase())) search.delete(key);
  }
  target.search = search.toString();
  return target;
}

function copyRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const normalized = key.toLowerCase();
    if (
      DROPPED_REQUEST_HEADERS.has(normalized) ||
      normalized.startsWith("x-worklin-retention-")
    ) {
      continue;
    }
    headers.append(key, value);
  }
  return headers;
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (METHODS_WITHOUT_BODY.has(request.method.toUpperCase())) return undefined;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new RetentionBodyError(
        400,
        "retention_request_content_length_invalid",
      );
    }
    if (Number(declaredLength) > maxBytes) {
      throw new RetentionBodyError(413, "retention_request_body_too_large");
    }
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RetentionBodyError(
          413,
          "retention_request_body_too_large",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function performUpstreamRequest(
  config: EnabledRetentionServiceConfig,
  target: URL,
  method: string,
  headers: Headers,
  body: Uint8Array | undefined,
  downstreamSignal: AbortSignal,
  fetchImpl: RetentionServiceFetch,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = AbortSignal.any([downstreamSignal, timeoutSignal]);

  let response: globalThis.Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers,
      body:
        METHODS_WITHOUT_BODY.has(method.toUpperCase()) || body === undefined
          ? undefined
          : (body.slice().buffer as ArrayBuffer),
      redirect: "manual",
      signal,
    });
  } catch {
    return timeoutSignal.aborted
      ? jsonResponse(504, "retention_service_timeout")
      : jsonResponse(502, "retention_service_unavailable");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) {
      const sanitized = jsonResponse(429, "retention_service_rate_limited");
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter && /^\d+$/u.test(retryAfter)) {
        sanitized.headers.set("Retry-After", retryAfter);
      }
      return sanitized;
    }
    if (response.status >= 400 && response.status < 500) {
      return jsonResponse(
        response.status === 401 || response.status === 403
          ? 502
          : response.status,
        response.status === 401 || response.status === 403
          ? "retention_service_unavailable"
          : "retention_service_rejected_request",
      );
    }
    return jsonResponse(502, "retention_service_unavailable");
  }

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) {
    if (SAFE_UPSTREAM_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.append(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, "retention_service_disabled");
}

function bodyErrorResponse(error: unknown): Response {
  if (error instanceof RetentionBodyError) {
    return jsonResponse(error.status, error.code);
  }
  return jsonResponse(400, "retention_request_body_invalid");
}

function jsonResponse(status: number, code: string): Response {
  return Response.json(
    {
      code,
      detail: "The retention service could not complete this request.",
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

class RetentionBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
