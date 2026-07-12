import {
  ArrowUp,
  Mic,
  Paperclip,
  PanelLeft,
  Sparkles,
  Square,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import type { LiveVoiceSessionState } from "./live-voice-store";
import { VoiceConversationPanel } from "./voice-conversation-panel";

interface DemoPhase {
  state: LiveVoiceSessionState;
  duration?: number;
  partialTranscript?: string;
  finalTranscript?: string;
  assistantTranscript?: string;
}

const DEMO_SEQUENCE: DemoPhase[] = [
  {
    state: "listening",
    duration: 2400,
    partialTranscript: "Can you turn this into tomorrow’s launch plan?",
  },
  {
    state: "thinking",
    duration: 1300,
    finalTranscript: "Can you turn this into tomorrow’s launch plan?",
  },
  {
    state: "speaking",
    duration: 3800,
    finalTranscript: "Can you turn this into tomorrow’s launch plan?",
    assistantTranscript:
      "Absolutely. I’ve grouped it into product, design, and go-to-market priorities.",
  },
  {
    state: "interrupted",
    duration: 900,
    partialTranscript: "Actually — move design to the top.",
    finalTranscript: "Can you turn this into tomorrow’s launch plan?",
    assistantTranscript:
      "Absolutely. I’ve grouped it into product, design, and go-to-market priorities.",
  },
  {
    state: "listening",
    duration: 1900,
    partialTranscript: "Actually — move design to the top.",
    assistantTranscript:
      "Absolutely. I’ve grouped it into product, design, and go-to-market priorities.",
  },
  {
    state: "thinking",
    duration: 1200,
    finalTranscript: "Actually — move design to the top.",
  },
  {
    state: "speaking",
    duration: 4200,
    finalTranscript: "Actually — move design to the top.",
    assistantTranscript:
      "Done. Design is first, with the prototype review at 10:00 AM.",
  },
  {
    state: "listening",
    finalTranscript: "Actually — move design to the top.",
    assistantTranscript:
      "Done. Design is first, with the prototype review at 10:00 AM.",
  },
];

const PREVIEW_THEME = {
  "--background-primary": "#0b0a0f",
  "--background-secondary": "#15131b",
  "--content-primary": "#f7f5fb",
  "--content-secondary": "#b8b3c2",
  "--content-tertiary": "#817a8e",
  "--border-secondary": "rgba(255, 255, 255, 0.12)",
  background:
    "radial-gradient(circle at 50% 0%, rgba(107, 33, 168, 0.15), transparent 38%), #0b0a0f",
} as CSSProperties;

export function VoicePreviewPage() {
  const [phaseIndex, setPhaseIndex] = useState(-1);
  const [amplitude, setAmplitude] = useState(0.3);

  const active = phaseIndex >= 0;
  const phase = active ? DEMO_SEQUENCE[phaseIndex] : undefined;
  const state = phase?.state ?? "idle";
  const voiceButtonClass = active
    ? "flex h-9 items-center gap-2 rounded-full bg-violet-500/16 px-3 text-xs font-medium text-violet-200 ring-1 ring-violet-400/30 transition-all"
    : "flex h-9 items-center gap-2 rounded-full bg-violet-600 px-3 text-xs font-medium text-white shadow-[0_0_24px_rgba(124,58,237,.28)] transition-all hover:bg-violet-500";

  useEffect(() => {
    if (!phase?.duration) return;
    const timeout = window.setTimeout(() => {
      setPhaseIndex((current) =>
        Math.min(current + 1, DEMO_SEQUENCE.length - 1),
      );
    }, phase.duration);
    return () => window.clearTimeout(timeout);
  }, [phase]);

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

  const toggleDemo = () => {
    setPhaseIndex((current) => (current >= 0 ? -1 : 0));
  };

  return (
    <main className="min-h-screen text-[#f7f5fb]" style={PREVIEW_THEME}>
      <div className="grid min-h-screen md:grid-cols-[220px_1fr]">
        <aside className="hidden border-r border-white/8 bg-black/15 px-4 py-5 md:flex md:flex-col">
          <div className="mb-8 flex items-center gap-3 px-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-500/18 text-violet-300">
              <Sparkles size={17} />
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Worklin
            </span>
          </div>
          <button
            type="button"
            className="flex items-center gap-3 rounded-xl bg-white/6 px-3 py-2.5 text-left text-sm text-zinc-200"
          >
            <span className="h-2 w-2 rounded-full bg-violet-400" />
            Launch planning
          </button>
          <div className="mt-auto rounded-xl border border-white/8 bg-white/[0.025] p-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
              Visual demo
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              No microphone or voice provider is connected.
            </p>
          </div>
        </aside>

        <section className="flex min-h-screen min-w-0 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-white/8 px-5">
            <div className="flex items-center gap-3">
              <PanelLeft className="text-zinc-500 md:hidden" size={18} />
              <div>
                <h1 className="text-sm font-medium">Launch planning</h1>
                <p className="text-xs text-zinc-500">Worklin · Online</p>
              </div>
            </div>
            <span className="rounded-full border border-violet-400/20 bg-violet-500/8 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.13em] text-violet-300">
              Interactive preview
            </span>
          </header>

          <div className="flex flex-1 flex-col">
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end px-5 py-8">
              <div className="space-y-6">
                <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-white/8 px-4 py-3 text-sm leading-6 text-zinc-200">
                  Let’s get tomorrow’s launch organized. We need a clear order
                  for product, design, and go-to-market.
                </div>
                <div className="flex max-w-[86%] gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-300">
                    <Sparkles size={15} />
                  </div>
                  <div className="text-sm leading-6 text-zinc-300">
                    I have the project context. Start live voice and talk me
                    through the priority order.
                  </div>
                </div>
              </div>
            </div>

            <div className="px-4 pb-6">
              <div className="mx-auto max-w-3xl rounded-[24px] border border-white/10 bg-[#121117] shadow-[0_20px_70px_rgba(0,0,0,.3)]">
                {active && (
                  <div className="pt-3">
                    <VoiceConversationPanel
                      state={state}
                      partialTranscript={phase?.partialTranscript}
                      finalTranscript={phase?.finalTranscript}
                      assistantTranscript={phase?.assistantTranscript}
                      inputAmplitude={inputAmplitude}
                      outputAmplitude={outputAmplitude}
                    />
                  </div>
                )}

                <div className="min-h-14 px-4 py-4 text-sm text-zinc-500">
                  Message Worklin…
                </div>

                <div className="flex items-center justify-between border-t border-white/8 px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                      aria-label="Attach file"
                    >
                      <Paperclip size={17} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                      aria-label="Dictate one message"
                    >
                      <Mic size={17} />
                    </button>
                    <button
                      type="button"
                      onClick={toggleDemo}
                      className={voiceButtonClass}
                      aria-label={
                        active ? "End live voice demo" : "Start live voice demo"
                      }
                    >
                      {active ? (
                        <Square size={12} fill="currentColor" />
                      ) : (
                        <span className="relative flex h-4 w-4 items-center justify-center">
                          <span className="absolute inset-0 rounded-full bg-white/20" />
                          <span className="relative h-2 w-2 rounded-full border border-white/90" />
                        </span>
                      )}
                      {active ? "End voice" : "Live voice"}
                    </button>
                    <button
                      type="button"
                      className="rounded-full bg-zinc-800 p-2 text-zinc-500"
                      aria-label="Send message"
                    >
                      <ArrowUp size={17} />
                    </button>
                  </div>
                </div>
              </div>
              <p className="mx-auto mt-3 max-w-3xl text-center text-[11px] text-zinc-600">
                Click Live voice to play a complete two-turn conversation.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
