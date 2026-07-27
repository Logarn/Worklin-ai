import { createHash } from "node:crypto";

import { startVoiceTurn } from "../calls/voice-session-bridge.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { RouteResponse } from "../runtime/routes/types.js";
import {
  claimManagedVoiceProviderTurn,
  isManagedVoiceSessionBindingCurrent,
} from "./provider-session.js";

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function sessionTokenFrom(args: RouteHandlerArgs): string | null {
  const queryToken = args.queryParams?.custom_session_id;
  if (queryToken) return queryToken;
  const direct = args.body?.worklin_session_token;
  if (typeof direct === "string") return direct;
  const extra = args.body?.elevenlabs_extra_body;
  if (extra && typeof extra === "object") {
    const token = (extra as Record<string, unknown>).worklin_session_token;
    if (typeof token === "string") return token;
  }
  return null;
}

function lastUserText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = value[index] as ChatMessage;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

export function handleProviderChatCompletions(
  args: RouteHandlerArgs,
): RouteResponse {
  const token = sessionTokenFrom(args);
  const content = lastUserText(args.body?.messages);
  if (!token || !content) {
    return new RouteResponse(
      JSON.stringify({ error: { message: "Invalid voice session" } }),
      { "Content-Type": "application/json" },
      401,
    );
  }
  const requestKey = createHash("sha256")
    .update(JSON.stringify(args.body?.messages ?? []))
    .digest("base64url");
  const claimed = claimManagedVoiceProviderTurn(token, requestKey);
  if (claimed.status !== "accepted") {
    return new RouteResponse(
      JSON.stringify({
        error: {
          message:
            claimed.status === "replayed"
              ? "Voice provider turn already processed"
              : claimed.status === "limit_exceeded"
                ? "Voice session turn limit reached"
                : "Invalid voice session",
        },
      }),
      { "Content-Type": "application/json" },
      claimed.status === "replayed"
        ? 409
        : claimed.status === "limit_exceeded"
          ? 429
          : 401,
    );
  }
  const { binding } = claimed;

  const encoder = new TextEncoder();
  let handle: Awaited<ReturnType<typeof startVoiceTurn>> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false;
      const send = (value: unknown) => {
        if (finished) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
        );
      };
      const finish = (reason: "stop" | "cancelled" = "stop") => {
        if (finished) return;
        send({
          id: binding.sessionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "worklin-voice",
          choices: [{ index: 0, delta: {}, finish_reason: reason }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finished = true;
        controller.close();
      };
      const requireCurrentLease = () => {
        if (isManagedVoiceSessionBindingCurrent(binding)) return true;
        handle?.abort();
        finish("cancelled");
        return false;
      };
      try {
        if (!requireCurrentLease()) return;
        handle = await startVoiceTurn({
          conversationId: binding.conversationId,
          voiceSessionId: binding.sessionId,
          assistantId: binding.assistantId,
          userMessageChannel: "vellum",
          assistantMessageChannel: "vellum",
          userMessageInterface: "web",
          assistantMessageInterface: "web",
          voiceControlPrompt:
            "You are speaking in a live voice session. Keep replies concise and conversational. If an action requires confirmation, ask the user to confirm it in Worklin.",
          approvalMode: "local-live-voice",
          content,
          isInbound: true,
          signal: args.abortSignal,
          callbacks: {
            assistant_text_delta: (message) => {
              if (!message.text || !requireCurrentLease()) return;
              send({
                id: binding.sessionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "worklin-voice",
                choices: [
                  {
                    index: 0,
                    delta: { content: message.text },
                    finish_reason: null,
                  },
                ],
              });
            },
            message_complete: (message) => {
              if (!requireCurrentLease()) return;
              finish(
                message.type === "generation_cancelled" ? "cancelled" : "stop",
              );
            },
          },
          onError: (message) => {
            if (!requireCurrentLease()) return;
            send({ error: { message } });
            finish("cancelled");
          },
        });
        if (!requireCurrentLease()) return;
      } catch (error) {
        send({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Worklin voice turn failed",
          },
        });
        finish("cancelled");
      }
    },
    cancel() {
      handle?.abort();
    },
  });

  return new RouteResponse(stream, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
