/**
 * `LiveVoiceButton` — composer control that toggles a live-voice conversation.
 *
 * Distinct from the dictation {@link import("./voice-input-button").VoiceInputButton}:
 * that one records a single utterance and drops a transcript into the composer,
 * while this one opens a full-duplex live-voice session via {@link useLiveVoice}
 * (mic streaming + TTS playback + barge-in). The button is gated behind the
 * `voice-mode` assistant flag and renders nothing when the flag is off.
 *
 * The expanded card owns explicit start/end controls. When that card is
 * dismissed, this component paints a compact orb that only reopens it; it does
 * not activate the microphone or provider. The component remains mounted while
 * hidden because it owns the single live-voice controller instance.
 */

import { Loader2, StopCircle } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
} from "react";

import { Button } from "@vellumai/design-library";

import { WorklinOrb } from "@/components/worklin-orb";
import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import { publishVoiceOverlayState } from "@/runtime/voice-overlay";
import { useVellumCommands } from "@/runtime/vellum-commands";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface LiveVoiceButtonProps {
  /** Assistant whose live-voice channel the session attaches to. */
  assistantId: string;
  /** Optional conversation to continue inside the session. */
  conversationId?: string;
  /** Disable the control (e.g. while the composer is otherwise busy). */
  disabled?: boolean;
  /** Whether the shared transcript/start card is currently expanded. */
  panelOpen?: boolean;
  /** Reopen the card without activating the microphone or provider. */
  onOpenPanel?: () => void;
}

export interface LiveVoiceButtonHandle {
  /** Explicitly start live voice (used by the large orb in the card). */
  start: () => void;
  /** End live voice and release provider/audio resources. */
  stop: () => void;
}

const VOICE_DISCLOSURE_KEY = "worklin.voice-disclosure.v1";

function confirmVoiceDisclosure(): boolean {
  if (window.localStorage.getItem(VOICE_DISCLOSURE_KEY) === "accepted") {
    return true;
  }
  const accepted = window.confirm(
    "Worklin uses an AI-generated voice. Your live audio will be processed by the selected voice provider; Worklin retains the transcript, not the pilot audio. Continue?",
  );
  if (accepted) window.localStorage.setItem(VOICE_DISCLOSURE_KEY, "accepted");
  return accepted;
}

export const LiveVoiceButton = forwardRef<
  LiveVoiceButtonHandle,
  LiveVoiceButtonProps
>(function LiveVoiceButton(
  {
    assistantId,
    conversationId,
    disabled = false,
    panelOpen = true,
    onOpenPanel,
  },
  ref,
) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const {
    state,
    partialTranscript,
    finalTranscript,
    assistantTranscript,
    inputAmplitude,
    outputAmplitude,
    muted,
    error,
    start,
    stop,
    toggleMute,
  } = useLiveVoice();

  const connecting = state === "connecting";
  // Anything past connecting (listening/transcribing/thinking/speaking/ending)
  // means a session is live and the button acts as a stop control.
  const active =
    state !== "idle" && state !== "failed" && state !== "connecting";

  const startWithDisclosure = useCallback(() => {
    if (connecting || active || disabled) return;
    if (!confirmVoiceDisclosure()) return;
    onOpenPanel?.();
    void start(assistantId, conversationId);
  }, [
    active,
    assistantId,
    connecting,
    conversationId,
    disabled,
    onOpenPanel,
    start,
  ]);

  const stopSession = useCallback(() => {
    void stop();
  }, [stop]);

  useImperativeHandle(
    ref,
    () => ({ start: startWithDisclosure, stop: stopSession }),
    [startWithDisclosure, stopSession],
  );

  const handleClick = useCallback(() => {
    if (connecting) return;
    if (active) {
      // An active session must always be stoppable, even if the parent has
      // raised `disabled` in the meantime — otherwise the user is stuck with a
      // live mic/socket until some automatic teardown.
      stopSession();
    } else {
      // The compact orb is a disclosure affordance, not a second start
      // control. Reopening the UI does not activate the microphone or create a
      // billable provider session; the large orb inside the card does that.
      if (disabled) return;
      onOpenPanel?.();
    }
  }, [active, connecting, disabled, onOpenPanel, stopSession]);

  useVellumCommands({
    toggleVoiceConversation: () => {
      if (connecting) return;
      if (active) stopSession();
      else if (!disabled) startWithDisclosure();
    },
    endVoiceConversation: stopSession,
    toggleVoiceMute: () => toggleMute(),
  });

  useEffect(() => {
    if (state === "idle") {
      publishVoiceOverlayState(null);
      return;
    }
    publishVoiceOverlayState({
      state,
      partialTranscript,
      finalTranscript,
      assistantTranscript,
      inputAmplitude,
      outputAmplitude,
      muted,
      error,
    });
  }, [
    assistantTranscript,
    error,
    finalTranscript,
    inputAmplitude,
    muted,
    outputAmplitude,
    partialTranscript,
    state,
  ]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stopSession();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, stopSession]);

  if (!voiceMode) return null;

  // Keep the controller mounted while the expanded card owns the interaction,
  // but do not paint a competing tiny start/stop target beside the send button.
  if (panelOpen) return null;

  const label = connecting
    ? "Connecting live voice"
    : active
      ? "Stop voice mode"
      : "Show live voice";

  return (
    <Button
      variant="ghost"
      iconOnly={
        connecting ? (
          <Loader2 className="animate-spin" strokeWidth={2} />
        ) : active ? (
          <StopCircle strokeWidth={2} />
        ) : (
          <WorklinOrb
            state={state}
            inputAmplitude={inputAmplitude}
            size={18}
          />
        )
      }
      onClick={handleClick}
      // An active session is always stoppable; the external `disabled` prop
      // only gates the start path. `connecting` stays disabled/busy.
      disabled={connecting || (!active && disabled)}
      aria-label={label}
      aria-pressed={active}
      aria-busy={connecting}
      title={label}
      className="[--vbtn-fg:var(--content-secondary)]"
      style={
        // While listening, scale the icon with live amplitude so the control
        // visibly reacts to the user's voice (clamped to a gentle 1.0–1.25).
        active
          ? { transform: `scale(${1 + Math.min(inputAmplitude, 1) * 0.25})` }
          : undefined
      }
    />
  );
});
