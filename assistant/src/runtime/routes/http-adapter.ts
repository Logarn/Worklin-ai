/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import { isPooledWorkerRuntime } from "../../config/env.js";
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import { normalizedRouteHeaders } from "../auth/runtime-tenant-context.js";
import type { HttpErrorCode } from "../http-errors.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { RouteError } from "./errors.js";
import type { ResponseHeaderArgs, RouteDefinition } from "./types.js";
import { RouteResponse } from "./types.js";

/**
 * A pooled interactive turn may legitimately pause for a normal approval
 * prompt (the configured prompt timeout is five minutes). Keep a small,
 * explicit margin for the final model/title work, but never leave a pooled
 * request or lease open indefinitely.
 */
export const POOLED_MESSAGE_REQUEST_TIMEOUT_MS = 6 * 60_000;
export const POOLED_MESSAGE_HEARTBEAT_INTERVAL_MS = 15_000;
const POOLED_MESSAGE_HEARTBEAT_CHUNK = " ".repeat(2_048);

interface PooledMessageResponseOptions {
  execute: (signal: AbortSignal) => Promise<unknown>;
  requestSignal?: AbortSignal;
  status: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
}

function pooledMessageErrorBody(err: unknown): Record<string, unknown> {
  if (err instanceof RouteError) {
    return {
      accepted: false,
      status: err.statusCode,
      error: {
        code: err.code,
        detail: err.message,
      },
    };
  }
  return {
    accepted: false,
    status: 500,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      detail: "The assistant could not complete this message request.",
    },
  };
}

async function normalizePooledMessageResult(result: unknown): Promise<unknown> {
  if (!(result instanceof RouteResponse)) return result;
  if (result.body === null) return null;
  if (typeof result.body === "string") {
    try {
      return JSON.parse(result.body) as unknown;
    } catch {
      return pooledMessageErrorBody(
        new RouteError(
          "The assistant returned an invalid message response.",
          "INTERNAL_SERVER_ERROR",
          500,
        ),
      );
    }
  }
  if (result.body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(result.body)) as unknown;
    } catch {
      return pooledMessageErrorBody(
        new RouteError(
          "The assistant returned an invalid message response.",
          "INTERNAL_SERVER_ERROR",
          500,
        ),
      );
    }
  }
  return pooledMessageErrorBody(
    new RouteError(
      "The assistant returned an unsupported message response.",
      "INTERNAL_SERVER_ERROR",
      500,
    ),
  );
}

/**
 * Returns headers and whitespace immediately, then keeps the response valid
 * JSON by writing only whitespace until the final result object. This lets the
 * browser, control plane, and gateway preserve one request-bound pooled lease
 * while an approval is pending. Cancellation and the hard deadline abort the
 * handler signal and clear every timer.
 */
export function createPooledMessageHeartbeatResponse({
  execute,
  requestSignal,
  status,
  headers,
  timeoutMs = POOLED_MESSAGE_REQUEST_TIMEOUT_MS,
  heartbeatIntervalMs = POOLED_MESSAGE_HEARTBEAT_INTERVAL_MS,
}: PooledMessageResponseOptions): Response {
  const encoder = new TextEncoder();
  const executionAbort = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let finishRequestAbort: (() => void) | undefined;

  const responseHeaders = new Headers(headers);
  // A route-level header callback must not impose buffered-body metadata on
  // this dynamically sized stream. Retaining any of these can truncate,
  // transform, or validate only the initial whitespace rather than the final
  // JSON payload.
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("etag");
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-cache, no-store, no-transform");
  responseHeaders.set("x-accel-buffering", "no");

  const relayRequestAbort = () => {
    if (!executionAbort.signal.aborted) {
      executionAbort.abort(requestSignal?.reason);
    }
    finishRequestAbort?.();
  };
  requestSignal?.addEventListener("abort", relayRequestAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        heartbeatTimer = undefined;
        deadlineTimer = undefined;
        finishRequestAbort = undefined;
        requestSignal?.removeEventListener("abort", relayRequestAbort);
      };
      const finish = (value: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        const serialized = JSON.stringify(value ?? null);
        controller.enqueue(encoder.encode(serialized));
        controller.close();
      };
      finishRequestAbort = () =>
        finish({
          accepted: false,
          status: 499,
          error: {
            code: "REQUEST_ABORTED",
            detail: "The pooled message request was cancelled.",
          },
        });

      controller.enqueue(encoder.encode(POOLED_MESSAGE_HEARTBEAT_CHUNK));
      if (requestSignal?.aborted) {
        relayRequestAbort();
        return;
      }
      heartbeatTimer = setInterval(() => {
        if (!finished) {
          controller.enqueue(encoder.encode(POOLED_MESSAGE_HEARTBEAT_CHUNK));
        }
      }, heartbeatIntervalMs);
      deadlineTimer = setTimeout(() => {
        if (!executionAbort.signal.aborted) {
          executionAbort.abort(
            new Error("Pooled message request exceeded its bounded deadline."),
          );
        }
        finish({
          accepted: false,
          status: 504,
          error: {
            code: "POOLED_TURN_TIMEOUT",
            detail:
              "The assistant turn exceeded the six-minute interactive limit.",
          },
        });
      }, timeoutMs);

      void execute(executionAbort.signal)
        .then(normalizePooledMessageResult)
        .then(
          (result) => finish(result),
          (err) => finish(pooledMessageErrorBody(err)),
        );
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      heartbeatTimer = undefined;
      deadlineTimer = undefined;
      finishRequestAbort = undefined;
      requestSignal?.removeEventListener("abort", relayRequestAbort);
      if (!executionAbort.signal.aborted) executionAbort.abort(reason);
    },
  });

  return new Response(body, { status, headers: responseHeaders });
}

function resolveResponseHeaders(
  spec: RouteDefinition["responseHeaders"],
  args: ResponseHeaderArgs,
): Record<string, string> | undefined {
  if (!spec) return undefined;
  if (typeof spec === "function") return spec(args);
  return spec;
}

function resolveResponseStatus(
  spec: RouteDefinition["responseStatus"],
  args: ResponseHeaderArgs,
): number {
  if (!spec) return 200;
  if (typeof spec === "function") return Number(spec(args));
  return Number(spec);
}

export function routeDefinitionsToHTTPRoutes(
  routes: RouteDefinition[],
  options: {
    isPooledRuntime?: () => boolean;
  } = {},
): HTTPRouteDefinition[] {
  return routes.map((r) => ({
    endpoint: r.endpoint,
    method: r.method,
    operationId: r.operationId,
    policy: r.policy,
    pathParams: r.pathParams,
    summary: r.summary,
    description: r.description,
    tags: r.tags,
    queryParams: r.queryParams,
    requestBody: r.requestBody,
    responseBody: r.responseBody,
    responseStatus:
      typeof r.responseStatus === "string" ? r.responseStatus : undefined,
    additionalResponses: r.additionalResponses,
    logging: r.logging,
    handler: async ({ req, url, params, authContext }) => {
      try {
        if (r.requireGuardian) {
          const guardianError = requireBoundGuardian(authContext);
          if (guardianError) return guardianError;
        }

        const pathParams: Record<string, string> = {};
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            pathParams[key] = String(value);
          }
        }

        const queryParams: Record<string, string> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryParams[key] = value;
        }

        const contentType = req.headers.get("content-type") ?? "";
        let body: Record<string, unknown> | undefined;
        let rawBody: Uint8Array | undefined;
        if (
          r.method === "POST" ||
          r.method === "PUT" ||
          r.method === "PATCH" ||
          r.method === "DELETE"
        ) {
          if (contentType.includes("application/json") || contentType === "") {
            try {
              const parsed = (await req.json()) as Record<string, unknown>;
              if (parsed && typeof parsed === "object") {
                body = parsed;
              }
            } catch {
              // No body or invalid JSON — handler will validate
            }
          } else {
            // Binary body (e.g. application/zip, application/octet-stream)
            rawBody = new Uint8Array(await req.arrayBuffer());
          }
        }

        const headers = normalizedRouteHeaders(req.headers, authContext);

        const headerArgs: ResponseHeaderArgs = {
          pathParams,
          queryParams,
          headers,
        };

        const responseHeaders = resolveResponseHeaders(
          r.responseHeaders,
          headerArgs,
        );

        const status = resolveResponseStatus(r.responseStatus, headerArgs);

        const invokeHandler = (abortSignal: AbortSignal) =>
          Promise.resolve(
            r.handler({
              pathParams,
              queryParams,
              body,
              rawBody,
              headers,
              authContext,
              abortSignal,
            }),
          );

        if (
          r.operationId === "messages_post" &&
          (options.isPooledRuntime?.() ?? isPooledWorkerRuntime())
        ) {
          return createPooledMessageHeartbeatResponse({
            execute: invokeHandler,
            requestSignal: req.signal,
            status,
            headers: responseHeaders,
          });
        }

        const result = await invokeHandler(req.signal);

        // 204 No Content — discard handler result, return empty body
        if (status === 204) {
          return new Response(null, { status: 204, headers: responseHeaders });
        }

        // RouteResponse — handler-supplied body + headers (e.g. binary
        // content with dynamic Content-Type / Content-Range).
        if (result instanceof RouteResponse) {
          return new Response(result.body, {
            status: result.status ?? status,
            headers: { ...responseHeaders, ...result.headers },
          });
        }

        // Non-JSON responses: handler returned string, Uint8Array, or ReadableStream
        if (
          typeof result === "string" ||
          result instanceof Uint8Array ||
          result instanceof ReadableStream
        ) {
          return new Response(result as BodyInit, {
            status,
            headers: responseHeaders,
          });
        }

        // JSON responses: use responseHeaders if specified, otherwise default
        return Response.json(result, {
          status,
          headers: responseHeaders,
        });
      } catch (err) {
        if (err instanceof RouteError) {
          return httpError(
            err.code as HttpErrorCode,
            err.message,
            err.statusCode,
            err.details,
          );
        }
        throw err;
      }
    },
  }));
}
