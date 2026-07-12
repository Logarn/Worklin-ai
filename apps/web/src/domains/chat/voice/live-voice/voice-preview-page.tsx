import { useEffect, useState } from "react";

import type { LiveVoiceSessionState } from "./live-voice-store";
import { VoiceConversationPanel } from "./voice-conversation-panel";

const PREVIEW_STATES: Array<{
  label: string;
  state: LiveVoiceSessionState;
}> = [
  { label: "Ready", state: "idle" },
  { label: "Listening", state: "listening" },
  { label: "Thinking", state: "thinking" },
  { label: "Speaking", state: "speaking" },
  { label: "Interrupted", state: "interrupted" },
];

export function VoicePreviewPage() {
  const [state, setState] = useState<LiveVoiceSessionState>("speaking");
  const [amplitude, setAmplitude] = useState(0.3);

  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const animate = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      const primary = (Math.sin(elapsed * 8.2) + 1) / 2;
      const secondary = (Math.sin(elapsed * 17.4 + 0.8) + 1) / 2;
      setAmplitude(Math.min(1, 0.12 + primary * 0.48 + secondary * 0.24));
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  const inputAmplitude =
    state === "listening" || state === "interrupted" ? amplitude : 0;
  const outputAmplitude = state === "speaking" ? amplitude : 0;

  return (
    <main className="min-h-full overflow-auto bg-[radial-gradient(circle_at_50%_10%,rgba(107,33,168,.14),transparent_42%),var(--background-primary)] px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-violet-500">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
            Internal visual review
          </div>
          <h1 className="text-2xl font-semibold text-[var(--content-primary)]">
            Worklin Voice
          </h1>
          <p className="max-w-2xl text-sm text-[var(--content-secondary)]">
            This production preview uses the real shared voice interface. It
            does not activate a microphone or connect to Hume or ElevenLabs.
          </p>
        </header>

        <nav className="flex flex-wrap gap-2" aria-label="Voice preview state">
          {PREVIEW_STATES.map((item) => (
            <button
              key={item.state}
              type="button"
              onClick={() => setState(item.state)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                state === item.state
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
                  : "border-[var(--border-secondary)] bg-[var(--background-secondary)] text-[var(--content-secondary)] hover:border-violet-500/30"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <section className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--content-tertiary)]">
            In conversation
          </p>
          <div className="max-w-2xl rounded-[26px] border border-[var(--border-secondary)] bg-[var(--background-secondary)] pt-3 shadow-sm">
            <VoiceConversationPanel
              state={state}
              partialTranscript={
                state === "listening" || state === "interrupted"
                  ? "Can you pull together the launch plan for tomorrow?"
                  : ""
              }
              finalTranscript="Can you pull together the launch plan for tomorrow?"
              assistantTranscript={
                state === "thinking"
                  ? ""
                  : "Absolutely. I’ll organize the priorities, owners, and timing."
              }
              inputAmplitude={inputAmplitude}
              outputAmplitude={outputAmplitude}
            />
            <div className="h-11 border-t border-[var(--border-secondary)] px-4 py-3 text-xs text-[var(--content-tertiary)]">
              Message Worklin…
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--content-tertiary)]">
            macOS floating panel
          </p>
          <div className="max-w-[620px] rounded-[34px] bg-black/20 p-2 shadow-[0_24px_80px_rgba(0,0,0,.32)]">
            <div className="h-[134px]">
              <VoiceConversationPanel
                state={state}
                partialTranscript={
                  state === "listening" || state === "interrupted"
                    ? "Can you pull together the launch plan for tomorrow?"
                    : ""
                }
                finalTranscript="Can you pull together the launch plan for tomorrow?"
                assistantTranscript={
                  state === "thinking"
                    ? ""
                    : "Absolutely. I’ll organize the priorities, owners, and timing."
                }
                inputAmplitude={inputAmplitude}
                outputAmplitude={outputAmplitude}
                variant="overlay"
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
