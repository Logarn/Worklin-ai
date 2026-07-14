import { ExternalLink, Mic, MicOff, X } from "lucide-react";

import { WorklinOrb } from "@/components/worklin-orb";

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
  onStart?: () => void;
  startDisabled?: boolean;
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
  onStart,
  startDisabled = false,
  onClose,
  onOpenInWorklin,
}: VoiceConversationPanelProps) {
  const userText = partialTranscript || finalTranscript;
  const overlay = variant === "overlay";
  const canStart = (state === "idle" || state === "failed") && !!onStart;
  const orb = (
    <WorklinOrb
      state={state}
      inputAmplitude={inputAmplitude}
      outputAmplitude={outputAmplitude}
    />
  );

  return (
    <section
      className={
        overlay
          ? "flex h-full w-full items-center gap-4 overflow-hidden rounded-[28px] border border-white/10 bg-[#111015]/95 px-5 py-4 text-white shadow-2xl backdrop-blur-xl"
          : "relative mx-3 mb-2 flex items-center gap-3 rounded-2xl border border-[#4169e1]/20 bg-[#4169e1]/[0.045] px-3 py-2 pr-11"
      }
      aria-label="Live voice transcript"
      aria-live="polite"
    >
      {canStart ? (
        <button
          type="button"
          onClick={onStart}
          disabled={startDisabled}
          className="shrink-0 rounded-full outline-none transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-[#7394ff] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none"
          aria-label={
            state === "failed" ? "Try live voice again" : "Start live voice"
          }
          title={
            state === "failed" ? "Try live voice again" : "Start live voice"
          }
        >
          {orb}
        </button>
      ) : (
        orb
      )}
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-[#7394ff]">
          {STATE_LABELS[state]}
        </p>
        {error ? (
          <>
            <p className="line-clamp-2 text-sm text-red-400">{error}</p>
            {canStart && (
              <p className="mt-1 text-xs text-[var(--content-secondary,#c4b5d6)]">
                Click the orb to try again.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="truncate text-sm text-[var(--content-primary,#f5f3ff)]">
              {userText ||
                (state === "idle"
                  ? "Click the orb to start live voice."
                  : state === "connecting"
                    ? "Connecting to voice…"
                    : state === "listening"
                      ? "Go ahead — I’m listening."
                      : "")}
            </p>
            {assistantTranscript && (
              <p className="mt-1 line-clamp-2 text-xs text-[var(--content-secondary,#c4b5d6)]">
                {assistantTranscript}
              </p>
            )}
            {state === "idle" && (
              <p className="mt-1 text-xs text-[var(--content-secondary,#c4b5d6)]">
                Your microphone and voice provider connect only after you click.
              </p>
            )}
          </>
        )}
      </div>
      {!overlay && onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 rounded-full p-2 text-[var(--content-tertiary,#a1a1aa)] hover:bg-white/10 hover:text-[var(--content-primary,#fff)]"
          aria-label={
            state === "idle" || state === "failed"
              ? "Hide live voice"
              : "End and hide live voice"
          }
          title={
            state === "idle" || state === "failed"
              ? "Hide live voice"
              : "End and hide live voice"
          }
        >
          <X size={18} />
        </button>
      )}
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
