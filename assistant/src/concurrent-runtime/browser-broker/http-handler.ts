import {
  BrowserBrokerConnectRequestSchema,
  BrowserBrokerHeartbeatRequestSchema,
  BrowserBrokerReceiptRequestSchema,
  BrowserBrokerResultRequestSchema,
} from "@vellumai/service-contracts/browser-broker";
import {
  createTenantExecutionContext,
  type TenantExecutionContext,
} from "@vellumai/service-contracts/tenant-context";

import type { ConcurrentProviderConfigResolver } from "../../providers/platform-proxy/concurrent-request-context.js";
import type { Scope } from "../../runtime/auth/types.js";
import {
  type ConcurrentAuthenticatedTenant,
  type ConcurrentAuthenticationResult,
} from "../auth.js";
import { ConcurrentModelKeyResolutionError } from "../model-key-capability.js";
import type { ConcurrentRuntimeStore } from "../store.js";
import { ConcurrentRuntimeStoreError } from "../store.js";
import { BrowserBrokerService, hashBrowserConnectionToken } from "./service.js";

const CONNECTION_TOKEN_HEADER = "x-worklin-browser-connection-token";

interface BrowserBrokerHttpLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface BrowserBrokerHttpHandlerOptions {
  store: ConcurrentRuntimeStore;
  service: BrowserBrokerService;
  authenticate: (
    request: Request,
    requiredScope: Scope,
  ) => ConcurrentAuthenticationResult;
  logger: BrowserBrokerHttpLogger;
  eventPollIntervalMs: number;
  heartbeatIntervalMs: number;
  resolveProviderConfig?: (
    request: Request,
  ) => ConcurrentProviderConfigResolver;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return json({ error: { code, message } }, status);
}

function authenticated(
  request: Request,
  requiredScope: Scope,
  authenticate: BrowserBrokerHttpHandlerOptions["authenticate"],
):
  | { ok: true; tenant: ConcurrentAuthenticatedTenant }
  | { ok: false; response: Response } {
  const result = authenticate(request, requiredScope);
  if (result.ok) return result;
  return {
    ok: false,
    response: errorResponse(
      result.status,
      result.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      "Invalid concurrent runtime authorization.",
    ),
  };
}

function context(
  tenant: ConcurrentAuthenticatedTenant,
  conversationId?: string,
): TenantExecutionContext {
  return createTenantExecutionContext({
    claim: tenant.claim,
    authorizationVersion: tenant.authorizationVersion,
    configVersion: 1,
    runtimeGeneration: 1,
    ...(conversationId ? { conversationId } : {}),
  });
}

function connectionToken(request: Request): string | null {
  const token = request.headers.get(CONNECTION_TOKEN_HEADER)?.trim();
  return token && token.length >= 32 && token.length <= 4096 ? token : null;
}

function storeError(error: unknown): Response {
  if (error instanceof ConcurrentModelKeyResolutionError) {
    return errorResponse(
      error.code === "key_missing" ? 409 : 503,
      error.code === "key_missing"
        ? "model_provider_key_missing"
        : "model_provider_unavailable",
      error.message,
    );
  }
  if (!(error instanceof ConcurrentRuntimeStoreError)) {
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Browser broker request failed.",
    );
  }
  if (error.code === "browser_access_denied") {
    return errorResponse(403, "BROWSER_ACCESS_DENIED", error.message);
  }
  if (error.code === "conversation_not_found") {
    return errorResponse(404, "NOT_FOUND", "Conversation not found.");
  }
  if (error.code === "stale_connection") {
    return errorResponse(409, "STALE_BROWSER_CONNECTION", error.message);
  }
  if (error.code === "action_conflict") {
    return errorResponse(409, "BROWSER_ACTION_CONFLICT", error.message);
  }
  return errorResponse(409, "BROWSER_BROKER_STATE", error.message);
}

function nonNegativeInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function decodePathPart(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function createBrowserBrokerHttpHandler(
  options: BrowserBrokerHttpHandlerOptions,
): (request: Request, pathname: string) => Promise<Response | null> {
  return async (request, pathname) => {
    if (
      request.method === "POST" &&
      pathname === "/v1/browser-broker/connections"
    ) {
      const auth = authenticated(request, "chat.write", options.authenticate);
      if (!auth.ok) return auth.response;
      const parsed = BrowserBrokerConnectRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Browser connection request is invalid.",
        );
      }
      try {
        return json(
          await options.service.connect(context(auth.tenant), parsed.data),
          201,
        );
      } catch (error) {
        return storeError(error);
      }
    }

    const connectionMatch = pathname.match(
      /^\/v1\/browser-broker\/connections\/([^/]+)\/(heartbeat|events)$/,
    );
    if (connectionMatch) {
      const auth = authenticated(request, "chat.write", options.authenticate);
      if (!auth.ok) return auth.response;
      const clientInstallationId = decodePathPart(connectionMatch[1]!);
      const token = connectionToken(request);
      if (!clientInstallationId || !token) {
        return errorResponse(
          401,
          "INVALID_BROWSER_CONNECTION",
          "Browser connection credential is required.",
        );
      }
      if (request.method === "POST" && connectionMatch[2] === "heartbeat") {
        const parsed = BrowserBrokerHeartbeatRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) {
          return errorResponse(
            400,
            "INVALID_REQUEST",
            "Browser heartbeat is invalid.",
          );
        }
        try {
          const connection = await options.service.heartbeat(
            context(auth.tenant),
            {
              clientInstallationId,
              connectionId: parsed.data.connectionId,
              connectionGeneration: parsed.data.connectionGeneration,
              connectionToken: token,
            },
          );
          return json({
            ok: true,
            cursor: connection.cursor,
            leaseExpiresAt: new Date(connection.leaseExpiresAt).toISOString(),
          });
        } catch (error) {
          return storeError(error);
        }
      }
      if (request.method === "GET" && connectionMatch[2] === "events") {
        const url = new URL(request.url);
        const connectionId = url.searchParams.get("connectionId")?.trim();
        const connectionGeneration = nonNegativeInteger(
          url.searchParams.get("connectionGeneration"),
        );
        const afterSeq =
          nonNegativeInteger(request.headers.get("last-event-id")) ??
          nonNegativeInteger(url.searchParams.get("afterSeq")) ??
          0;
        if (!connectionId || !connectionGeneration) {
          return errorResponse(
            400,
            "INVALID_REQUEST",
            "Browser event connection scope is invalid.",
          );
        }
        const executionContext = context(auth.tenant);
        const tokenHash = hashBrowserConnectionToken(token);
        const encoder = new TextEncoder();
        let closed = false;
        let cursor = afterSeq;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const cleanup = () => {
              if (closed) return;
              closed = true;
              if (pollTimer) clearTimeout(pollTimer);
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              try {
                controller.close();
              } catch {
                // The transport may already have closed the stream.
              }
            };
            const enqueue = (frame: string): boolean => {
              if (
                controller.desiredSize != null &&
                controller.desiredSize <= 0
              ) {
                cleanup();
                return false;
              }
              controller.enqueue(encoder.encode(frame));
              return true;
            };
            const poll = async () => {
              if (closed) return;
              try {
                const events = await options.store.listBrowserEvents(
                  executionContext,
                  {
                    clientInstallationId,
                    connectionId,
                    connectionGeneration,
                    connectionTokenHash: tokenHash,
                    afterSeq: cursor,
                    limit: 100,
                  },
                );
                for (const event of events) {
                  const frame = `id: ${event.seq}\nevent: browser_broker\ndata: ${JSON.stringify(event.event)}\n\n`;
                  if (!enqueue(frame)) return;
                  cursor = event.seq;
                }
              } catch (error) {
                options.logger.error(
                  { error, connectionId },
                  "Browser broker event polling failed",
                );
                cleanup();
                return;
              }
              pollTimer = setTimeout(poll, options.eventPollIntervalMs);
            };
            request.signal.addEventListener("abort", cleanup, { once: true });
            heartbeatTimer = setInterval(() => {
              enqueue(": heartbeat\n\n");
            }, options.heartbeatIntervalMs);
            void poll();
          },
          cancel() {
            closed = true;
            if (pollTimer) clearTimeout(pollTimer);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }
    }

    const actionMatch = pathname.match(
      /^\/v1\/browser-broker\/actions\/([^/]+)\/(receipt|result)$/,
    );
    if (request.method === "POST" && actionMatch) {
      const auth = authenticated(request, "chat.write", options.authenticate);
      if (!auth.ok) return auth.response;
      const actionId = decodePathPart(actionMatch[1]!);
      const token = connectionToken(request);
      if (!actionId || !token) {
        return errorResponse(
          401,
          "INVALID_BROWSER_CONNECTION",
          "Browser connection credential is required.",
        );
      }
      try {
        if (actionMatch[2] === "receipt") {
          const parsed = BrowserBrokerReceiptRequestSchema.safeParse(
            await request.json().catch(() => null),
          );
          if (!parsed.success || parsed.data.actionId !== actionId) {
            return errorResponse(
              400,
              "INVALID_REQUEST",
              "Browser action receipt is invalid.",
            );
          }
          const ack = await options.store.recordBrowserReceipt(
            context(auth.tenant),
            {
              ...parsed.data,
              connectionTokenHash: hashBrowserConnectionToken(token),
            },
          );
          return json(ack);
        }
        const parsed = BrowserBrokerResultRequestSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success || parsed.data.actionId !== actionId) {
          return errorResponse(
            400,
            "INVALID_REQUEST",
            "Browser action result is invalid.",
          );
        }
        return json(
          await options.service.recordResult(
            context(auth.tenant),
            parsed.data,
            token,
            options.resolveProviderConfig?.(request),
          ),
        );
      } catch (error) {
        return storeError(error);
      }
    }

    const grantMatch = pathname.match(
      /^\/v1\/conversations\/([^/]+)\/browser-access$/,
    );
    if (grantMatch) {
      const auth = authenticated(
        request,
        request.method === "GET" ? "chat.read" : "chat.write",
        options.authenticate,
      );
      if (!auth.ok) return auth.response;
      const conversationId = decodePathPart(grantMatch[1]!);
      if (!conversationId) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Conversation id is invalid.",
        );
      }
      try {
        if (request.method === "GET") {
          const grant = await options.store.getBrowserAccessGrant(
            context(auth.tenant, conversationId),
            conversationId,
          );
          return json({ grant });
        }
        if (request.method === "PUT") {
          const body = (await request.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
          if (
            !body ||
            typeof body.clientInstallationId !== "string" ||
            !body.clientInstallationId.trim() ||
            typeof body.enabled !== "boolean"
          ) {
            return errorResponse(
              400,
              "INVALID_REQUEST",
              "Browser access grant is invalid.",
            );
          }
          const grant = await options.store.setBrowserAccessGrant(
            context(auth.tenant, conversationId),
            {
              conversationId,
              clientInstallationId: body.clientInstallationId.trim(),
              enabled: body.enabled,
            },
          );
          return json({ grant });
        }
      } catch (error) {
        return storeError(error);
      }
    }

    return pathname.startsWith("/v1/browser-broker/") || grantMatch
      ? errorResponse(
          405,
          "METHOD_NOT_ALLOWED",
          "Browser broker method is not allowed.",
        )
      : null;
  };
}
