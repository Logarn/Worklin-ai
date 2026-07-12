import { ExternalLink, Mic, MicOff, X } from "lucide-react";
import { useMemo } from "react";

import type { LiveVoiceSessionState } from "./live-voice-store";

export interface VoiceConversationPanelProps {
  state: LiveVoiceSessionState;
  partialTranscript?: string;
  finalTranscript?: string;
  assistantTranscript?: string;
  inputAmplitude?: number;
  outputAmplitude?: number;
  error?: string | null;
  muted?: boolean;
  variant?: "inline" | "overlay";
  onToggleMute?: () => void;
  onClose?: () => void;
  onOpenInWorklin?: () => void;
}

const STATE_LABELS: Record<LiveVoiceSessionState, string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  transcribing: "Listening",
  thinking: "Thinking",
  speaking: "Worklin is speaking",
  interrupted: "Interrupted — listening",
  ending: "Ending",
  failed: "Voice unavailable",
};

function VoiceOrb({
  state,
  inputAmplitude,
  outputAmplitude,
}: Pick<
  VoiceConversationPanelProps,
  "state" | "inputAmplitude" | "outputAmplitude"
>) {
  const amplitude =
    state === "speaking" ? (outputAmplitude ?? 0) : (inputAmplitude ?? 0);
  const bars = useMemo(
    () => Array.from({ length: 36 }, (_, index) => index),
    [],
  );
  const active =
    state === "listening" || state === "speaking" || state === "interrupted";

  return (
    <div className="relative h-24 w-24 shrink-0" aria-hidden="true">
      <div
        className={`absolute inset-[19px] rounded-full border border-[#9ab2ff]/65 bg-[radial-gradient(circle_at_35%_30%,#e9efff,#4169e1_48%,#142f8f)] shadow-[0_0_30px_rgba(65,105,225,.58)] motion-reduce:transition-none ${
          state === "thinking" ? "animate-pulse motion-reduce:animate-none" : ""
        }`}
        style={{ transform: `scale(${1 + Math.min(amplitude, 1) * 0.12})` }}
      />
      {bars.map((index) => {
        const phase = Math.sin(index * 1.71) * 0.16 + 0.84;
        const height = active ? 5 + Math.min(amplitude, 1) * 19 * phase : 4;
        return (
          <span
            key={index}
            className={`absolute left-1/2 top-1/2 block w-[2px] origin-[50%_48px] rounded-full bg-gradient-to-t from-[#4169e1] to-[#9ab2ff] transition-[height,opacity] duration-75 motion-reduce:transition-none ${
              state === "thinking" ? "opacity-45" : "opacity-90"
            }`}
            style={{
              height: `${height}px`,
              transform: `translate(-50%, -48px) rotate(${index * 10}deg)`,
            }}
          />
        );
      })}
    </div>
  );
}

/** Shared in-composer and Electron-overlay voice surface. */
export function VoiceConversationPanel({
  state,
  partialTranscript = "",
  finalTranscript = "",
  assistantTranscript = "",
  inputAmplitude = 0,
  outputAmplitude = 0,
  error = null,
  muted = false,
  variant = "inline",
  onToggleMute,
  onClose,
  onOpenInWorklin,
}: VoiceConversationPanelProps) {
  const userText = partialTranscript || finalTranscript;
  const overlay = variant === "overlay";

  return (
    <section
      className={
        overlay
          ? "flex h-full w-full items-center gap-4 overflow-hidden rounded-[28px] border border-white/10 bg-[#111015]/95 px-5 py-4 text-white shadow-2xl backdrop-blur-xl"
          : "mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-[#4169e1]/20 bg-[#4169e1]/[0.045] px-3 py-2"
      }
      aria-label="Live voice transcript"
      aria-live="polite"
    >
      <VoiceOrb
        state={state}
        inputAmplitude={inputAmplitude}
        outputAmplitude={outputAmplitude}
      />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-[#7394ff]">
          {STATE_LABELS[state]}
        </p>
        {error ? (
          <p className="line-clamp-2 text-sm text-red-400">{error}</p>
        ) : (
          <>
            <p className="truncate text-sm text-[var(--content-primary,#f5f3ff)]">
              {userText ||
                (state === "listening" ? "Go ahead — I’m listening." : "")}
            </p>
            {assistantTranscript && (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--content-secondary,#c4b5d6)]">
                {assistantTranscript}
              </p>
            )}
          </>
        )}
      </div>
      {overlay && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggleMute}
            className="rounded-full p-2 text-zinc-300 hover:bg-white/10 hover:text-white"
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          >
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <button
            type="button"
            onClick={onOpenInWorklin}
            className="rounded-full p-2 text-zinc-300 hover:bg-white/10 hover:text-white"
            aria-label="Open in Worklin"
            title="Open in Worklin"
          >
            <ExternalLink size={17} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-300 hover:bg-white/10 hover:text-white"
            aria-label="End voice conversation"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </section>
  );
}
