import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { VoiceTurnHandle } from "../calls/voice-session-bridge.js";
import { startVoiceTurn } from "../calls/voice-session-bridge.js";
import {
  getManagedVoiceSessionByProviderConversation,
  releaseManagedVoiceSession,
} from "./provider-session.js";

const ISSUER = "https://api.elevenlabs.io/convai/speech-engine";
const SUBJECT = "convai_speech_engine_upstream";

export function verifyElevenLabsSpeechEngineJwt(
  token: string,
  apiKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra) return false;
  try {
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as { alg?: unknown };
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as { iss?: unknown; sub?: unknown; exp?: unknown };
    if (
      header.alg !== "HS256" ||
      payload.iss !== ISSUER ||
      payload.sub !== SUBJECT ||
      typeof payload.exp !== "number" ||
      payload.exp + 60 < nowSeconds
    ) {
      return false;
    }
    const secret = createHash("sha256").update(apiKey).digest();
    const expected = createHmac("sha256", secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest();
    const actual = Buffer.from(signaturePart, "base64url");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

type SpeechEngineSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type TranscriptEntry = { role?: unknown; content?: unknown };

export class ElevenLabsSpeechEngineSession {
  private readonly socket: SpeechEngineSocket;
  private providerConversationId: string | null = null;
  private activeEventId: number | null = null;
  private activeTurn: VoiceTurnHandle | null = null;

  constructor(socket: SpeechEngineSocket) {
    this.socket = socket;
  }

  handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.socket.close(1003, "Invalid JSON");
      return;
    }
    if (
      message.type === "init" &&
      typeof message.conversation_id === "string"
    ) {
      this.providerConversationId = message.conversation_id;
      return;
    }
    if (message.type === "ping") {
      this.socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type === "user_transcript") {
      const eventId = message.event_id;
      if (typeof eventId !== "number") return;
      const content = lastUserContent(message.user_transcript);
      if (!content) return;
      this.startTurn(eventId, content);
      return;
    }
    if (message.type === "close") this.close();
  }

  close(): void {
    this.activeTurn?.abort();
    this.activeTurn = null;
    if (!this.providerConversationId) return;
    const binding = getManagedVoiceSessionByProviderConversation(
      this.providerConversationId,
    );
    if (binding) releaseManagedVoiceSession(binding.sessionId);
  }

  private startTurn(eventId: number, content: string): void {
    this.activeTurn?.abort();
    this.activeTurn = null;
    this.activeEventId = eventId;
    void this.runTurn(eventId, content);
  }

  private async runTurn(eventId: number, content: string): Promise<void> {
    const binding = await this.waitForBinding();
    if (!binding || this.activeEventId !== eventId) {
      this.finish(eventId);
      return;
    }
    try {
      const handle = await startVoiceTurn({
        conversationId: binding.conversationId,
        voiceSessionId: binding.sessionId,
        assistantId: binding.assistantId,
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
        userMessageInterface: "web",
        assistantMessageInterface: "web",
        voiceControlPrompt:
          "You are speaking in a live voice session. Keep replies concise and conversational. Approval-required actions must be confirmed in Worklin.",
        approvalMode: "local-live-voice",
        content,
        isInbound: true,
        callbacks: {
          assistant_text_delta: ({ text }) => {
            if (this.activeEventId !== eventId || !text) return;
            this.socket.send(
              JSON.stringify({
                type: "agent_response",
                event_id: eventId,
                content: text,
                is_final: false,
              }),
            );
          },
          message_complete: () => this.finish(eventId),
        },
        onError: () => this.finish(eventId),
      });
      if (this.activeEventId !== eventId) handle.abort();
      else this.activeTurn = handle;
    } catch {
      this.finish(eventId);
    }
  }

  private finish(eventId: number): void {
    if (this.activeEventId !== eventId) return;
    this.socket.send(
      JSON.stringify({
        type: "agent_response",
        event_id: eventId,
        content: "",
        is_final: true,
      }),
    );
    this.activeEventId = null;
    this.activeTurn = null;
  }

  private async waitForBinding() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.providerConversationId) {
        const binding = getManagedVoiceSessionByProviderConversation(
          this.providerConversationId,
        );
        if (binding) return binding;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }
}

function lastUserContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index] as TranscriptEntry;
    if (item?.role !== "user") continue;
    if (typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return null;
}
