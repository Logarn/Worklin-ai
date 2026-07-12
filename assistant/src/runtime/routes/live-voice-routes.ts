import { z } from "zod";

import { VoiceEngineIdSchema } from "../../config/schemas/voice.js";
import {
  bootstrapVoiceSession,
  VoiceBootstrapError,
} from "../../live-voice/provider-bootstrap.js";
import { handleProviderChatCompletions } from "../../live-voice/provider-chat-completions.js";
import {
  bindManagedVoiceProviderConversation,
  releaseManagedVoiceSession,
} from "../../live-voice/provider-session.js";
import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const BootstrapBodySchema = z.object({
  assistantId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
});

const ConnectionSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("native") }),
  z.object({
    transport: z.literal("hume"),
    websocketUrl: z.string(),
    sessionToken: z.string(),
    voiceId: z.string().optional(),
  }),
  z.object({
    transport: z.literal("elevenlabs"),
    conversationToken: z.string(),
    sessionToken: z.string(),
    voiceId: z.string().optional(),
  }),
]);

const BootstrapResponseSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string(),
  engine: VoiceEngineIdSchema,
  expiresAt: z.string(),
  connection: ConnectionSchema,
});

const ProviderConversationBodySchema = z.object({
  providerConversationId: z.string().min(1),
  sessionToken: z.string().min(1),
});

async function handleBootstrap(args: RouteHandlerArgs) {
  const parsed = BootstrapBodySchema.safeParse(args.body);
  if (!parsed.success) {
    throw new BadRequestError(
      "assistantId and a valid voice engine are required",
    );
  }
  const actorId =
    args.headers?.["x-vellum-actor-principal-id"] ??
    (args.headers?.["x-vellum-principal-type"] === "local"
      ? "local"
      : undefined);
  if (!actorId) throw new ForbiddenError("Voice session actor is unavailable");

  try {
    return await bootstrapVoiceSession({
      ...parsed.data,
      actorId,
      organizationId: args.headers?.["x-vellum-org-id"],
    });
  } catch (error) {
    if (!(error instanceof VoiceBootstrapError)) throw error;
    if (error.code === "busy") {
      throw new ConflictError(error.message, {
        activeSessionId: error.activeSessionId,
      });
    }
    if (error.code === "forbidden" || error.code === "disabled") {
      throw new ForbiddenError(error.message);
    }
    if (error.code === "not_configured") {
      throw new ServiceUnavailableError(error.message);
    }
    throw new BadGatewayError(error.message);
  }
}

function handleRelease(args: RouteHandlerArgs) {
  const sessionId = args.pathParams?.sessionId;
  if (!sessionId) throw new BadRequestError("sessionId is required");
  const actorId = args.headers?.["x-vellum-actor-principal-id"];
  return { released: releaseManagedVoiceSession(sessionId, actorId) };
}

function handleProviderConversationBinding(args: RouteHandlerArgs) {
  const sessionId = args.pathParams?.sessionId;
  const parsed = ProviderConversationBodySchema.safeParse(args.body);
  const actorId = args.headers?.["x-vellum-actor-principal-id"];
  if (!sessionId || !parsed.success || !actorId) {
    throw new BadRequestError("Invalid provider conversation binding");
  }
  const bound = bindManagedVoiceProviderConversation({
    sessionId,
    actorId,
    providerConversationId: parsed.data.providerConversationId,
    token: parsed.data.sessionToken,
  });
  if (!bound) throw new ForbiddenError("Invalid voice session binding");
  return { bound: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "live_voice_provider_conversation_bind",
    endpoint: "live-voice/sessions/:sessionId/provider-conversation",
    method: "POST",
    policy: {
      requiredScopes: ["calls.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "sessionId", type: "uuid" }],
    handler: handleProviderConversationBinding,
    requestBody: ProviderConversationBodySchema,
    responseBody: z.object({ bound: z.literal(true) }),
    tags: ["Live Voice"],
    summary: "Bind a managed provider conversation to a Worklin session",
  },
  {
    operationId: "live_voice_session_bootstrap",
    endpoint: "live-voice/sessions",
    method: "POST",
    policy: {
      requiredScopes: ["calls.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBootstrap,
    requestBody: BootstrapBodySchema,
    responseBody: BootstrapResponseSchema,
    tags: ["Live Voice"],
    summary: "Create a provider-neutral live voice session",
  },
  {
    operationId: "live_voice_session_release",
    endpoint: "live-voice/sessions/:sessionId",
    method: "DELETE",
    policy: {
      requiredScopes: ["calls.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "sessionId", type: "uuid" }],
    handler: handleRelease,
    responseBody: z.object({ released: z.boolean() }),
    tags: ["Live Voice"],
    summary: "Release a managed live voice session",
  },
  {
    operationId: "live_voice_provider_chat_completions",
    endpoint: "live-voice/providers/chat/completions",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    handler: handleProviderChatCompletions,
    tags: ["Live Voice"],
    summary: "Stream Worklin turns to a managed voice provider",
  },
];
