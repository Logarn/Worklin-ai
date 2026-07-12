import type { VoiceEngineId } from "../config/schemas/voice.js";

export type VoiceEngineState =
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "ended"
  | "error";

export type VoiceEngineEvent =
  | { type: "state"; state: VoiceEngineState }
  | { type: "transcript_partial"; text: string }
  | { type: "transcript_final"; text: string }
  | { type: "assistant_text_delta"; text: string }
  | { type: "input_amplitude"; amplitude: number }
  | { type: "output_amplitude"; amplitude: number }
  | { type: "interruption" }
  | { type: "reconnecting"; attempt: number }
  | { type: "ended"; reason?: string }
  | { type: "error"; message: string };

export interface VoiceEngineSession {
  readonly id: string;
  readonly engine: VoiceEngineId;
  start(): Promise<void>;
  mute(muted: boolean): void;
  interrupt(): void;
  end(): Promise<void>;
  subscribe(listener: (event: VoiceEngineEvent) => void): () => void;
}

export interface VoiceEngine {
  readonly id: VoiceEngineId;
  createSession(options: {
    assistantId: string;
    conversationId?: string;
  }): Promise<VoiceEngineSession>;
}
