import { ExternalLink, Info } from "lucide-react";
import { useEffect } from "react";

import { useManagedInferenceCapability } from "@/assistant/managed-inference-availability";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { LanguageModelCard } from "@/domains/settings/ai/language-model-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { EmailServiceCard } from "@/domains/settings/ai/email-service-card";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";
import { LiveVoiceCard } from "@/domains/settings/ai/live-voice-card";

// ---------------------------------------------------------------------------
// AiPage — layout shell
// ---------------------------------------------------------------------------

export function AiPage() {
  const assistantId = useActiveAssistantId();
  const { configured: managedInferenceConfigured } =
    useManagedInferenceCapability(assistantId);

  // Scroll to hash target on mount (e.g. deep links to #email).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <div className="space-y-5">
      {managedInferenceConfigured ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            Services using Worklin credits are metered and deducted from your account
            balance.{" "}
            <a
              href="https://www.vellum.ai/docs/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
            >
              View pricing
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </p>
        </div>
      ) : null}

      <LanguageModelCard />
      <WebSearchCard />
      <EmailServiceCard />
      <ImageGenerationCard />
      <LiveVoiceCard />
      <TextToSpeechCard />
      <SpeechToTextCard />
    </div>
  );
}
