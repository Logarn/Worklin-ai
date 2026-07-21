import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { VoiceTurnHandle } from "../calls/voice-session-bridge.js";
import { startVoiceTurn } from "../calls/voice-session-bridge.js";
import {
  claimManagedVoiceProviderConversationEvent,
  getManagedVoiceSessionByProviderConversation,
  isManagedVoiceSessionBindingCurrent,
  releaseManagedVoiceSession,
} from "./provider-session.js";

const ISSUER = "https://api.elevenlabs.io/convai/speech-engine";
const SUBJECT = "convai_speech_engine_upstream";

export function verifyElevenLabsSpeechEngineJwt(
  token: string,
  apiKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  let normalizedToken = token.trim();
  if (normalizedToken.toLowerCase().startsWith("bearer ")) {
    normalizedToken = normalizedToken.slice(7).trim();
  }
  const [headerPart, payloadPart, signaturePart, extra] =
    normalizedToken.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra) return false;
  try {
    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as { alg?: unknown };
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as { iss?: unknown; sub?: unknown; exp?: unknown; iat?: unknown };
    if (
      header.alg !== "HS256" ||
      payload.iss !== ISSUER ||
      payload.sub !== SUBJECT ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      payload.exp + 60 < nowSeconds ||
      payload.iat - 60 > nowSeconds
    ) {
      return false;
    }
    const secret = createHash("sha256").update(apiKey.trim(), "utf8").digest();
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

export function isValidElevenLabsEventId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export class ElevenLabsSpeechEngineSession {
  private readonly socket: SpeechEngineSocket;
  private readonly startVoiceTurn: typeof startVoiceTurn;
  private providerConversationId: string | null = null;
  private activeEventId: number | null = null;
  private activeTurn: VoiceTurnHandle | null = null;
  private highestEventId = -1;

  constructor(
    socket: SpeechEngineSocket,
    startTurn: typeof startVoiceTurn = startVoiceTurn,
  ) {
    this.socket = socket;
    this.startVoiceTurn = startTurn;
  }

  handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.socket.close(1003, "Invalid JSON");
      return;
    }
    if (message.type === "init") {
      if (this.providerConversationId !== null) {
        this.socket.close(1008, "Conversation is already initialized");
        return;
      }
      if (typeof message.conversation_id !== "string") {
        this.socket.close(1008, "Invalid conversation");
        return;
      }
      const providerConversationId = message.conversation_id.trim();
      if (!providerConversationId || providerConversationId.length > 255) {
        this.socket.close(1008, "Invalid conversation");
        return;
      }
      this.providerConversationId = providerConversationId;
      return;
    }
    if (message.type === "ping") {
      this.socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type === "user_transcript") {
      const eventId = message.event_id;
      if (!isValidElevenLabsEventId(eventId)) return;
      const content = lastUserContent(message.user_transcript);
      if (!content) return;
      if (eventId <= this.highestEventId) return;
      this.highestEventId = eventId;
      this.startTurn(eventId, content);
      return;
    }
    if (message.type === "close") this.close(true);
  }

  /**
   * Abort work owned by this provider transport. A transient socket close
   * must not release the canonical Worklin session because ElevenLabs may
   * reconnect it; only an explicit provider/client end releases the lease.
   */
  close(releaseSession = false): void {
    this.activeTurn?.abort();
    this.activeTurn = null;
    this.activeEventId = null;
    if (!releaseSession) return;
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
    const claim = await this.waitForEventClaim(eventId);
    if (claim?.status !== "accepted" || this.activeEventId !== eventId) {
      this.finish(eventId);
      return;
    }
    const { binding } = claim;
    try {
      if (!isManagedVoiceSessionBindingCurrent(binding)) {
        this.finish(eventId);
        return;
      }
      const handle = await this.startVoiceTurn({
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
            const current = isManagedVoiceSessionBindingCurrent(binding);
            if (this.activeEventId !== eventId || !text || !current) {
              if (!current) {
                this.activeTurn?.abort();
                this.finish(eventId);
              }
              return;
            }
            this.socket.send(
              JSON.stringify({
                type: "agent_response",
                event_id: eventId,
                content: text,
                is_final: false,
              }),
            );
          },
          message_complete: () => {
            if (!isManagedVoiceSessionBindingCurrent(binding)) {
              this.activeTurn?.abort();
            }
            this.finish(eventId);
          },
        },
        onError: () => this.finish(eventId),
      });
      if (
        this.activeEventId !== eventId ||
        !isManagedVoiceSessionBindingCurrent(binding)
      ) {
        handle.abort();
        this.finish(eventId);
      } else this.activeTurn = handle;
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

  private async waitForEventClaim(eventId: number) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.providerConversationId) {
        const claim = claimManagedVoiceProviderConversationEvent(
          this.providerConversationId,
          eventId,
        );
        if (claim.status !== "invalid") return claim;
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
