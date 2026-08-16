import * as Sentry from "@sentry/node";
import {
  createTenantExecutionContext,
  type TenantExecutionContext,
} from "@vellumai/service-contracts/tenant-context";
import {
  type AssistantEvent,
  formatSseFrame,
  formatSseHeartbeat,
} from "@vellumai/skill-host-contracts";

import {
  type ConcurrentManagedProviderConfig,
  getConcurrentManagedProviderConfig,
} from "../providers/platform-proxy/concurrent-provider-config.js";
import type { Scope } from "../runtime/auth/types.js";
import { APP_VERSION } from "../version.js";
import {
  authenticateConcurrentRuntimeRequest,
  type ConcurrentAuthenticatedTenant,
  type ConcurrentAuthenticationResult,
} from "./auth.js";
import { ConcurrentRuntimeService } from "./service.js";
import type { ConcurrentRuntimeStore } from "./store.js";
import type { ConcurrentConversation } from "./types.js";

const DEFAULT_EVENT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 7_000;
const MAX_CONTENT_LENGTH = 1_000_000;
const CONCURRENT_MANAGED_PROFILE_NAME = "worklin-managed";

export interface ConcurrentHttpLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const defaultLogger: ConcurrentHttpLogger = {
  info(fields, message) {
    console.info(message, fields);
  },
  warn(fields, message) {
    console.warn(message, fields);
  },
  error(fields, message) {
    console.error(message, fields);
  },
};

export interface ConcurrentRuntimeHttpHandlerOptions {
  store: ConcurrentRuntimeStore;
  service: ConcurrentRuntimeService;
  logger?: ConcurrentHttpLogger;
  eventPollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  authenticate?: (
    request: Request,
    requiredScope: Scope,
  ) => ConcurrentAuthenticationResult;
  getManagedProviderConfig?: () => ConcurrentManagedProviderConfig | null;
}

interface SendMessageBody {
  conversationId?: string | null;
  conversationKey?: string | null;
  content?: unknown;
  clientMessageId?: string;
  attachments?: unknown[];
  attachmentIds?: string[];
  slashCommand?: string;
  onboarding?: unknown;
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

function integerQuery(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function authenticated(
  request: Request,
  requiredScope: Scope,
  authenticate: (
    request: Request,
    requiredScope: Scope,
  ) => ConcurrentAuthenticationResult,
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

function executionContext(
  tenant: ConcurrentAuthenticatedTenant,
  input?: {
    conversationId?: string;
    idempotencyKey?: string;
  },
): TenantExecutionContext {
  return createTenantExecutionContext({
    claim: tenant.claim,
    authorizationVersion: tenant.authorizationVersion,
    configVersion: 1,
    runtimeGeneration: 1,
    ...(input?.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input?.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

function unsupportedMessageCapability(body: SendMessageBody): string | null {
  if (body.attachments?.length || body.attachmentIds?.length) {
    return "attachments";
  }
  if (body.slashCommand) return "slash_commands";
  if (body.onboarding !== undefined) return "onboarding_bootstrap";
  if (body.conversationKey && !body.conversationId) {
    return "legacy_conversation_keys";
  }
  return null;
}

function wireMessage(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  clientMessageId?: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.createdAt,
    attachments: [],
    textSegments: [message.content],
    thinkingSegments: [],
    contentOrder: ["text:0"],
    contentBlocks: [{ type: "text", text: message.content }],
    ...(message.clientMessageId
      ? { clientMessageId: message.clientMessageId }
      : {}),
  };
}

function epoch(value: string): number {
  return Date.parse(value);
}

function wireConversation(
  conversation: ConcurrentConversation,
): Record<string, unknown> {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: epoch(conversation.createdAt),
    updatedAt: epoch(conversation.updatedAt),
    lastMessageAt: conversation.lastMessageAt
      ? epoch(conversation.lastMessageAt)
      : null,
    conversationType: "standard",
    source: "vellum",
    conversationOriginChannel: "vellum",
    groupId: null,
    isProcessing: conversation.isProcessing,
  };
}

function eventEnvelope(event: {
  id: string;
  conversationId: string;
  seq: number;
  emittedAt: string;
  message: Record<string, unknown>;
}): AssistantEvent<Record<string, unknown>> {
  return {
    id: event.id,
    conversationId: event.conversationId,
    seq: event.seq,
    emittedAt: event.emittedAt,
    message: event.message,
  };
}

export function createConcurrentRuntimeHttpHandler(
  options: ConcurrentRuntimeHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const logger = options.logger ?? defaultLogger;
  const eventPollIntervalMs =
    options.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const authenticate =
    options.authenticate ?? authenticateConcurrentRuntimeRequest;
  const getManagedProviderConfig =
    options.getManagedProviderConfig ?? getConcurrentManagedProviderConfig;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (
      request.method === "GET" &&
      (pathname === "/health" ||
        pathname === "/healthz" ||
        pathname === "/readyz")
    ) {
      return json({
        status: "ok",
        mode: "concurrent_service",
        capabilities: ["interactive_chat", "conversation_history"],
      });
    }

    if (request.method === "GET" && pathname === "/v1/healthz") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      const memoryMb = process.memoryUsage().rss / 1024 / 1024;
      return json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: APP_VERSION,
        disk: null,
        memory: { currentMb: memoryMb, maxMb: memoryMb },
        cpu: { currentPercent: 0, maxCores: 1 },
        migrations: { dbVersion: 1, lastWorkspaceMigrationId: null },
        ces: { connected: false },
        capabilities: { memoryOptOut: true },
      });
    }

    if (request.method === "GET" && pathname === "/v1/identity") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      return json({
        name: "Worklin",
        role: "Assistant",
        personality: "Helpful, direct, and collaborative",
        emoji: "🌱",
        home: "/data/workspace",
        version: APP_VERSION,
      });
    }

    if (request.method === "GET" && pathname === "/v1/auth/info") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      return json({
        platformUrl: null,
        assistantId: auth.tenant.claim.assistant_id,
        organizationId: auth.tenant.claim.organization_id,
        userId: auth.tenant.claim.user_id,
        authenticated: true,
      });
    }

    if (request.method === "GET" && pathname === "/v1/config") {
      const auth = authenticated(request, "settings.read", authenticate);
      if (!auth.ok) return auth.response;
      const provider = getManagedProviderConfig();
      return json({
        llm: provider
          ? {
              default: {
                provider: provider.provider,
                model: provider.model,
              },
              profiles: {
                [CONCURRENT_MANAGED_PROFILE_NAME]: {
                  provider: provider.provider,
                  model: provider.model,
                  source: "managed",
                  label: "Worklin managed model",
                  description:
                    "Managed by Worklin for fast, always-ready conversations.",
                  status: "active",
                },
              },
              profileOrder: [CONCURRENT_MANAGED_PROFILE_NAME],
              activeProfile: CONCURRENT_MANAGED_PROFILE_NAME,
            }
          : undefined,
        services: provider
          ? {
              inference: {
                mode: "managed",
              },
            }
          : undefined,
      });
    }

    if (
      request.method === "GET" &&
      pathname === "/v1/inference/provider-connections"
    ) {
      const auth = authenticated(request, "settings.read", authenticate);
      if (!auth.ok) return auth.response;
      return json({ connections: [] });
    }

    if (request.method === "GET" && pathname === "/v1/disk-pressure/status") {
      const auth = authenticated(request, "settings.read", authenticate);
      if (!auth.ok) return auth.response;
      return json({
        status: {
          enabled: false,
          state: "disabled",
          locked: false,
          acknowledged: false,
          overrideActive: false,
          effectivelyLocked: false,
          lockId: null,
          usagePercent: null,
          thresholdPercent: 100,
          path: null,
          lastCheckedAt: null,
          blockedCapabilities: [],
          error: null,
        },
      });
    }

    if (request.method === "GET" && pathname === "/v1/pending-interactions") {
      const auth = authenticated(request, "approval.read", authenticate);
      if (!auth.ok) return auth.response;
      return json({ interactions: [] });
    }

    if (request.method === "GET" && pathname === "/v1/home/feed") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      const now = new Date().toISOString();
      return json({
        items: [],
        updatedAt: now,
        contextBanner: {
          greeting: "What should we work on?",
          timeAwayLabel: "",
          newCount: 0,
        },
        suggestedPrompts: [],
      });
    }

    if (request.method === "GET" && pathname === "/v1/conversations") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      const rawLimit = integerQuery(url, "limit", 50);
      const offset = integerQuery(url, "offset", 0);
      if (rawLimit === null || rawLimit < 1 || offset === null) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Conversation pagination is invalid.",
        );
      }
      const limit = Math.min(rawLimit, 100);
      const excludedBucket =
        url.searchParams.has("conversationType") ||
        url.searchParams.get("archiveStatus") === "archived";
      const rows = excludedBucket
        ? []
        : await options.store.listConversations(executionContext(auth.tenant), {
            limit: limit + 1,
            offset,
          });
      const conversations = rows.slice(0, limit);
      return json({
        conversations: conversations.map(wireConversation),
        nextOffset: offset + conversations.length,
        hasMore: rows.length > limit,
      });
    }

    const conversationMatch = pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    if (request.method === "GET" && conversationMatch) {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      let conversationId: string;
      try {
        conversationId = decodeURIComponent(conversationMatch[1]!);
      } catch {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Conversation id is invalid.",
        );
      }
      const conversation = await options.store.getConversation(
        executionContext(auth.tenant, { conversationId }),
        conversationId,
      );
      return conversation
        ? json({ conversation: wireConversation(conversation) })
        : errorResponse(404, "NOT_FOUND", "Conversation not found.");
    }

    if (request.method === "POST" && pathname === "/v1/messages") {
      const auth = authenticated(request, "chat.write", authenticate);
      if (!auth.ok) return auth.response;

      let body: SendMessageBody;
      try {
        body = (await request.json()) as SendMessageBody;
      } catch {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Request body is invalid.",
        );
      }
      if (
        typeof body.content !== "string" ||
        body.content.trim().length === 0 ||
        body.content.length > MAX_CONTENT_LENGTH
      ) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Message content must be a non-empty bounded string.",
        );
      }
      const unsupported = unsupportedMessageCapability(body);
      if (unsupported) {
        return errorResponse(
          409,
          "requires_dedicated_runtime",
          `The ${unsupported} capability requires a dedicated assistant.`,
        );
      }

      const conversationId = body.conversationId?.trim() || undefined;
      const idempotencyKey =
        body.clientMessageId?.trim() || auth.tenant.claim.request_id;
      const context = executionContext(auth.tenant, {
        conversationId,
        idempotencyKey,
      });
      const accepted = await options.service.submitMessage(context, {
        conversationId,
        content: body.content,
        clientMessageId: body.clientMessageId?.trim() || undefined,
      });
      return json(
        {
          accepted: true,
          conversationId: accepted.conversationId,
          messageId: accepted.userMessage.id,
          requestId: accepted.run.requestId,
          queued: accepted.run.status === "queued",
        },
        202,
      );
    }

    if (request.method === "GET" && pathname === "/v1/messages") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      const conversationId = url.searchParams.get("conversationId")?.trim();
      if (!conversationId) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "conversationId is required.",
        );
      }
      const context = executionContext(auth.tenant, { conversationId });
      const messages = await options.store.listMessages(
        context,
        conversationId,
      );
      const isProcessing = await options.store.hasActiveRun(
        context,
        conversationId,
      );
      return json({
        messages: messages.map(wireMessage),
        conversationId,
        hasMore: false,
        oldestTimestamp: messages[0] ? Date.parse(messages[0].createdAt) : null,
        oldestMessageId: messages[0]?.id ?? null,
        seq: null,
        isProcessing,
      });
    }

    if (request.method === "GET" && pathname === "/v1/events") {
      const auth = authenticated(request, "chat.read", authenticate);
      if (!auth.ok) return auth.response;
      const conversationId =
        url.searchParams.get("conversationId")?.trim() || undefined;
      const cursor =
        integerQuery(url, "lastSeenSeq", 0) ?? integerQuery(url, "since", 0);
      if (cursor === null) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Event cursor must be a non-negative integer.",
        );
      }
      const context = executionContext(auth.tenant, { conversationId });
      const encoder = new TextEncoder();
      let closed = false;
      let lastSeq = cursor;
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
              // The stream may already be closed by the transport.
            }
          };
          const shed = (reason: string) => {
            const error = new Error(
              `Concurrent runtime SSE subscriber shed: ${reason}`,
            );
            logger.warn(
              {
                reason,
                organizationId: context.organizationId,
                assistantId: context.assistantId,
                conversationId,
                lastSeq,
              },
              "Concurrent runtime SSE subscriber shed",
            );
            Sentry.captureException(error, {
              tags: {
                module: "concurrent-runtime-events",
                reason,
              },
            });
            cleanup();
          };
          const enqueue = (value: string, reason: string): boolean => {
            if (controller.desiredSize != null && controller.desiredSize <= 0) {
              shed(reason);
              return false;
            }
            controller.enqueue(encoder.encode(value));
            return true;
          };
          const poll = async () => {
            if (closed) return;
            try {
              const events = await options.store.listEvents(context, {
                afterSeq: lastSeq,
                conversationId,
                limit: 250,
              });
              for (const event of events) {
                if (!enqueue(formatSseFrame(eventEnvelope(event)), "event")) {
                  return;
                }
                lastSeq = Math.max(lastSeq, event.seq);
              }
            } catch (error) {
              logger.error(
                {
                  error,
                  organizationId: context.organizationId,
                  assistantId: context.assistantId,
                  conversationId,
                },
                "Concurrent runtime event polling failed",
              );
              Sentry.captureException(error, {
                tags: { module: "concurrent-runtime-events" },
              });
              cleanup();
              return;
            }
            pollTimer = setTimeout(poll, eventPollIntervalMs);
          };

          request.signal.addEventListener("abort", cleanup, { once: true });
          heartbeatTimer = setInterval(() => {
            enqueue(formatSseHeartbeat(), "heartbeat");
          }, heartbeatIntervalMs);
          void poll();
        },
        cancel() {
          closed = true;
          if (pollTimer) clearTimeout(pollTimer);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const cancelMatch = pathname.match(
      /^\/v1\/conversations\/([^/]+)\/cancel$/,
    );
    if (request.method === "POST" && cancelMatch) {
      const auth = authenticated(request, "chat.write", authenticate);
      if (!auth.ok) return auth.response;
      let conversationId: string;
      try {
        conversationId = decodeURIComponent(cancelMatch[1]!);
      } catch {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Conversation id is invalid.",
        );
      }
      if (!conversationId.trim()) {
        return errorResponse(
          400,
          "INVALID_REQUEST",
          "Conversation id is required.",
        );
      }
      const context = executionContext(auth.tenant, { conversationId });
      const cancelled = await options.service.cancelConversation(
        context,
        conversationId,
      );
      return json({ ok: true, cancelled, conversationId }, 202);
    }

    if (pathname.startsWith("/v1/")) {
      return errorResponse(
        409,
        "requires_dedicated_runtime",
        "This capability is not enabled on the concurrent assistant service.",
      );
    }
    return errorResponse(404, "NOT_FOUND", "Route not found.");
  };
}
