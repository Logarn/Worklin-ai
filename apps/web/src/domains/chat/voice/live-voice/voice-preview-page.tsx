import { Sparkles, Square } from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import type { VoiceInputButtonHandle } from "@/domains/chat/components/voice-input-button";

import type { LiveVoiceSessionState } from "./live-voice-store";

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
  "--background-primary": "#000000",
  "--background-secondary": "#0a0a0c",
  "--surface-base": "#000000",
  "--surface-lift": "#111114",
  "--surface-overlay": "#18181c",
  "--content-primary": "#f7f5fb",
  "--content-default": "#f7f5fb",
  "--content-secondary": "#b8b3c2",
  "--content-tertiary": "#817a8e",
  "--content-disabled": "#625d6c",
  "--border-secondary": "rgba(255, 255, 255, 0.12)",
  "--ring": "#73737c",
  "--chat-max-width": "768px",
  background: "#000000",
} as CSSProperties;

export function VoicePreviewPage() {
  const [phaseIndex, setPhaseIndex] = useState(-1);
  const [amplitude, setAmplitude] = useState(0.3);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);

  const active = phaseIndex >= 0;
  const phase = active ? DEMO_SEQUENCE[phaseIndex] : undefined;
  const state = phase?.state ?? "idle";
  const voiceButtonClass = active
    ? "flex h-8 items-center gap-2 rounded-full bg-white/8 px-3 text-xs font-medium text-[#9ab2ff] ring-1 ring-white/12 transition-all"
    : "flex h-8 items-center gap-2 rounded-full bg-white/6 px-3 text-xs font-medium text-zinc-200 ring-1 ring-white/10 transition-all hover:bg-white/10";

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

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
  };

  const voiceControl = (
    <button
      type="button"
      onClick={toggleDemo}
      className={voiceButtonClass}
      aria-label={active ? "End live voice demo" : "Start live voice demo"}
    >
      {active ? (
        <Square size={11} fill="currentColor" />
      ) : (
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-[#4169e1]/20" />
          <span className="relative h-2 w-2 rounded-full border border-[#9ab2ff]" />
        </span>
      )}
      {active ? "End voice" : "Live voice"}
    </button>
  );

  return (
    <main
      className="flex min-h-screen flex-col text-[var(--content-default)]"
      style={PREVIEW_THEME}
    >
      <ChatLayoutHeader
        isMobile={false}
        drawerOpen={false}
        collapsed={false}
        sidebarWidth={230}
        toggleSidebar={() => undefined}
        topBarCenter={
          <div className="text-center">
            <p className="text-sm font-medium">Launch planning</p>
            <p className="text-[11px] text-[var(--content-tertiary)]">
              Worklin · Online
            </p>
          </div>
        }
        topBarRightSlot={
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.13em] text-zinc-500">
            Preview
          </span>
        }
      />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[230px] shrink-0 border-r border-white/8 px-4 py-4 md:flex md:flex-col">
          <button
            type="button"
            className="flex items-center gap-3 rounded-[10px] bg-[var(--surface-lift)] px-3 py-2.5 text-left text-sm"
          >
            <span className="h-2 w-2 rounded-full bg-zinc-500" />
            Launch planning
          </button>
          <div className="mt-auto px-3 pb-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--content-tertiary)]">
              Visual demo
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--content-tertiary)]">
              No microphone or provider connection.
            </p>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-1 flex-col justify-end px-4 py-8">
            <div className="space-y-6">
              <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-[var(--surface-lift)] px-4 py-3 text-sm leading-6">
                Let’s get tomorrow’s launch organized. We need a clear order for
                product, design, and go-to-market.
              </div>
              <div className="flex max-w-[86%] gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 text-zinc-400">
                  <Sparkles size={15} />
                </div>
                <p className="text-sm leading-6 text-[var(--content-secondary)]">
                  I have the project context. Start live voice and talk me
                  through the priority order.
                </p>
              </div>
            </div>
          </div>

          <div className="px-3 pt-2 pb-5 sm:px-6">
            <div className="mx-auto max-w-[var(--chat-max-width)]">
              <ChatComposer
                input={input}
                setInput={setInput}
                placeholder="What would you like to do?"
                onSubmit={handleSubmit}
                inputRef={inputRef}
                typingDisabled={false}
                sendDisabled={!input.trim()}
                attachmentsUploadingCount={0}
                canSendAttachments={false}
                chatAttachments={[]}
                onAddAttachmentFiles={() => undefined}
                onRemoveAttachment={() => undefined}
                voiceInputRef={voiceInputRef}
                onVoiceTranscript={() => undefined}
                onVoiceInterimTranscript={() => undefined}
                onVoiceError={() => undefined}
                onVoiceBeforeStart={() => false}
                onStopGenerating={() => undefined}
                canStopGenerating={false}
                assistantId="voice-preview"
                conversationId="voice-preview"
                modelSupportsVision
                liveVoicePreview={{
                  state,
                  partialTranscript: phase?.partialTranscript,
                  finalTranscript: phase?.finalTranscript,
                  assistantTranscript: phase?.assistantTranscript,
                  inputAmplitude,
                  outputAmplitude,
                  control: voiceControl,
                }}
              />
              <p className="mt-3 text-center text-[11px] text-[var(--content-tertiary)]">
                Click Live voice to play the two-turn conversation.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
