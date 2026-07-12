import type {
  LiveVoiceClientEventHandler,
  LiveVoiceClientEventMap,
  LiveVoiceClientEventName,
  LiveVoiceConnectArgs,
} from "@/domains/chat/voice/live-voice/live-voice-client";
import type { VoiceSessionBootstrap } from "@/domains/chat/voice/live-voice/bootstrap";
import { bindVoiceProviderConversation } from "@/domains/chat/voice/live-voice/bootstrap";
import { Conversation, type VoiceConversation } from "@elevenlabs/client";

type Listener = (payload: never) => void;

export class ManagedVoiceChannelClient {
  readonly naturalTurnTaking = true;
  readonly ownsAudio: boolean;
  private readonly bootstrap: VoiceSessionBootstrap;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly assistantId: string;
  private socket: WebSocket | null = null;
  private seq = 0;
  private closed = false;
  private activeElevenLabsEventId: string | null = null;
  private readonly interruptedElevenLabsEventIds = new Set<string>();
  private elevenLabsAudioEndTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private elevenConversation: VoiceConversation | null = null;
  private amplitudeTimer: ReturnType<typeof setInterval> | null = null;
  private elevenWasSpeaking = false;
  private readonly listeners = new Map<
    LiveVoiceClientEventName,
    Set<Listener>
  >();

  constructor(
    bootstrap: VoiceSessionBootstrap,
    options: {
      assistantId: string;
      webSocketFactory?: (url: string) => WebSocket;
    },
  ) {
    this.bootstrap = bootstrap;
    this.assistantId = options.assistantId;
    this.ownsAudio = bootstrap.connection.transport === "elevenlabs";
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  on<E extends LiveVoiceClientEventName>(
    event: E,
    handler: LiveVoiceClientEventHandler<E>,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(handler as Listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(handler as Listener);
  }

  async connect(_args: LiveVoiceConnectArgs): Promise<void> {
    this.closed = false;
    if (this.bootstrap.connection.transport === "elevenlabs") {
      await this.connectElevenLabs();
      return;
    }
    this.openSocket();
  }

  setMuted(muted: boolean): void {
    this.elevenConversation?.setMicMuted(muted);
  }

  private openSocket(): void {
    const connection = this.bootstrap.connection;
    if (connection.transport === "native") {
      this.emit("error", {
        reason: "protocol-error",
        message: "Managed voice client received a native connection",
      });
      return;
    }
    if (connection.transport !== "hume") return;
    const socket = this.webSocketFactory(connection.websocketUrl);
    this.socket = socket;
    socket.onopen = () => {
      this.sendJson({
        type: "session_settings",
        custom_session_id: connection.sessionToken,
      });
      this.emitReady();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      this.handleMessage(event.data);
    };
    // A close event follows connection errors in browser WebSocket
    // implementations. Let the close path attempt a bounded reconnect before
    // surfacing a terminal error.
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.closed) return;
      if (this.reconnectAttempts < 2) {
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.closed) this.openSocket();
        }, this.reconnectAttempts * 300);
        return;
      }
      this.emit("error", {
        reason: "connection-failed",
        message: `${this.bootstrap.engine} voice connection disconnected`,
      });
    };
  }

  sendAudio(pcm: ArrayBuffer): void {
    const connection = this.bootstrap.connection;
    if (connection.transport === "native") return;
    const data = arrayBufferToBase64(pcm);
    this.sendJson({ type: "audio_input", data });
  }

  pttRelease(): void {
    // Managed engines own end-of-turn detection.
  }

  interrupt(): void {
    if (this.bootstrap.connection.transport === "hume") {
      this.sendJson({ type: "pause_assistant_message" });
    }
  }

  end(): void {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearElevenLabsAudioEndTimer();
    if (this.amplitudeTimer !== null) {
      clearInterval(this.amplitudeTimer);
      this.amplitudeTimer = null;
    }
    const conversation = this.elevenConversation;
    this.elevenConversation = null;
    if (conversation) void conversation.endSession();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
    this.emit("closed", undefined);
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.bootstrap.engine === "hume") {
      this.handleHume(message);
    } else {
      this.handleElevenLabs(message);
    }
  }

  private async connectElevenLabs(): Promise<void> {
    const connection = this.bootstrap.connection;
    if (connection.transport !== "elevenlabs") return;
    const conversation = await Conversation.startSession({
      conversationToken: connection.conversationToken,
      connectionType: "webrtc",
      textOnly: false,
      ...(connection.voiceId
        ? { overrides: { tts: { voiceId: connection.voiceId } } }
        : {}),
      onConnect: ({ conversationId }) => {
        void bindVoiceProviderConversation({
          assistantId: this.assistantId,
          sessionId: this.bootstrap.sessionId,
          providerConversationId: conversationId,
          sessionToken: connection.sessionToken,
        });
        this.emitReady();
      },
      onMessage: ({ message, role, event_id: eventId }) => {
        if (role === "user") {
          this.emit("sttFinal", {
            type: "stt_final",
            seq: this.nextSeq(),
            text: message,
          });
          this.emit("thinking", {
            type: "thinking",
            seq: this.nextSeq(),
            turnId: String(eventId ?? crypto.randomUUID()),
          });
        } else if (message) {
          this.emit("assistantTextDelta", {
            type: "assistant_text_delta",
            seq: this.nextSeq(),
            text: message,
          });
        }
      },
      onModeChange: ({ mode }) => {
        if (mode === "speaking") {
          this.elevenWasSpeaking = true;
          this.emit("providerSpeaking", {});
          return;
        }
        if (this.elevenWasSpeaking) {
          this.elevenWasSpeaking = false;
          this.emit("ttsDone", {
            type: "tts_done",
            seq: this.nextSeq(),
            turnId: crypto.randomUUID(),
          });
        }
        this.emit("listening", { type: "listening", seq: this.nextSeq() });
      },
      onInterruption: () => {
        this.emit("interrupted", { type: "interrupted", seq: this.nextSeq() });
      },
      onError: (message) => {
        this.emit("error", {
          reason: "protocol-error",
          message,
        });
      },
      onDisconnect: () => {
        if (!this.closed) this.emit("closed", undefined);
      },
    });
    this.elevenConversation = conversation;
    this.amplitudeTimer = setInterval(() => {
      this.emit("inputAmplitude", {
        amplitude: conversation.getInputVolume(),
      });
      this.emit("outputAmplitude", {
        amplitude: conversation.getOutputVolume(),
      });
    }, 50);
  }

  private handleHume(message: Record<string, unknown>): void {
    const type = message.type;
    if (type === "chat_metadata") return;
    if (type === "user_interruption") {
      this.emit("interrupted", { type: "interrupted", seq: this.nextSeq() });
      return;
    }
    if (type === "user_message") {
      const text = messageText(message);
      if (!text) return;
      const interim = message.interim === true;
      this.emit(interim ? "sttPartial" : "sttFinal", {
        type: interim ? "stt_partial" : "stt_final",
        seq: this.nextSeq(),
        text,
      } as LiveVoiceClientEventMap["sttPartial"] &
        LiveVoiceClientEventMap["sttFinal"]);
      if (!interim) {
        this.emit("thinking", {
          type: "thinking",
          seq: this.nextSeq(),
          turnId: crypto.randomUUID(),
        });
      }
      return;
    }
    if (type === "assistant_message") {
      const text = messageText(message);
      if (text) {
        this.emit("assistantTextDelta", {
          type: "assistant_text_delta",
          seq: this.nextSeq(),
          text,
        });
      }
      return;
    }
    if (type === "audio_output" && typeof message.data === "string") {
      this.emit("ttsAudio", {
        type: "tts_audio",
        seq: this.nextSeq(),
        mimeType: "audio/wav",
        sampleRate: 48_000,
        dataBase64: message.data,
      });
      return;
    }
    if (type === "assistant_end") {
      this.emit("ttsDone", {
        type: "tts_done",
        seq: this.nextSeq(),
        turnId: crypto.randomUUID(),
      });
      return;
    }
    if (type === "error") {
      this.emit("error", {
        reason: "protocol-error",
        message:
          typeof message.message === "string"
            ? message.message
            : "Hume voice session failed",
      });
    }
  }

  private handleElevenLabs(message: Record<string, unknown>): void {
    const type = message.type;
    if (type === "ping") {
      const event = message.ping_event as Record<string, unknown> | undefined;
      this.sendJson({
        type: "pong",
        event_id: event?.event_id,
      });
      return;
    }
    if (type === "interruption") {
      if (this.activeElevenLabsEventId) {
        this.interruptedElevenLabsEventIds.add(this.activeElevenLabsEventId);
      }
      this.clearElevenLabsAudioEndTimer();
      this.emit("interrupted", { type: "interrupted", seq: this.nextSeq() });
      return;
    }
    if (type === "user_transcript") {
      const event = message.user_transcription_event as
        | Record<string, unknown>
        | undefined;
      const text = event?.user_transcript;
      if (typeof text !== "string" || !text.trim()) return;
      this.emit("sttFinal", {
        type: "stt_final",
        seq: this.nextSeq(),
        text: text.trim(),
      });
      this.emit("thinking", {
        type: "thinking",
        seq: this.nextSeq(),
        turnId: String(event?.event_id ?? crypto.randomUUID()),
      });
      return;
    }
    if (type === "agent_response") {
      const event = message.agent_response_event as
        | Record<string, unknown>
        | undefined;
      const text = event?.agent_response;
      const eventId = event?.event_id;
      if (typeof eventId === "string" || typeof eventId === "number") {
        this.activeElevenLabsEventId = String(eventId);
      }
      if (typeof text === "string" && text) {
        this.emit("assistantTextDelta", {
          type: "assistant_text_delta",
          seq: this.nextSeq(),
          text,
        });
      }
      return;
    }
    if (type === "audio") {
      const event = message.audio_event as Record<string, unknown> | undefined;
      const data = event?.audio_base_64;
      const eventId = event?.event_id;
      const eventKey =
        typeof eventId === "string" || typeof eventId === "number"
          ? String(eventId)
          : this.activeElevenLabsEventId;
      if (eventKey && this.interruptedElevenLabsEventIds.has(eventKey)) return;
      if (eventKey) this.activeElevenLabsEventId = eventKey;
      if (typeof data === "string") {
        this.emit("ttsAudio", {
          type: "tts_audio",
          seq: this.nextSeq(),
          mimeType: "audio/pcm",
          sampleRate: 16_000,
          dataBase64: data,
        });
        this.scheduleElevenLabsAudioEnd(eventKey);
      }
    }
  }

  private scheduleElevenLabsAudioEnd(eventId: string | null): void {
    this.clearElevenLabsAudioEndTimer();
    this.elevenLabsAudioEndTimer = setTimeout(() => {
      this.elevenLabsAudioEndTimer = null;
      if (eventId && this.interruptedElevenLabsEventIds.has(eventId)) return;
      this.emit("ttsDone", {
        type: "tts_done",
        seq: this.nextSeq(),
        turnId: eventId ?? crypto.randomUUID(),
      });
    }, 500);
  }

  private clearElevenLabsAudioEndTimer(): void {
    if (this.elevenLabsAudioEndTimer === null) return;
    clearTimeout(this.elevenLabsAudioEndTimer);
    this.elevenLabsAudioEndTimer = null;
  }

  private emitReady(): void {
    this.emit("ready", {
      type: "ready",
      seq: this.nextSeq(),
      sessionId: this.bootstrap.sessionId,
      conversationId: this.bootstrap.conversationId,
    });
  }

  private sendJson(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit<E extends LiveVoiceClientEventName>(
    event: E,
    payload: LiveVoiceClientEventMap[E],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload as never);
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function messageText(message: Record<string, unknown>): string | null {
  const nested = message.message;
  if (!nested || typeof nested !== "object") return null;
  const content = (nested as Record<string, unknown>).content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}
