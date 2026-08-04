import { useEffect, useState } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { CompetitorIntelligencePage } from "./competitor-intelligence-page";
import { hangaritasLivePreview } from "./hangaritas-live-preview";

const PREVIEW_ASSISTANT_ID = "brand-research-preview";

export function BrandResearchPreviewPage() {
  const activeAssistantId =
    useResolvedAssistantsStore.use.activeAssistantId();
  const setActiveAssistantId =
    useResolvedAssistantsStore.use.setActiveAssistantId();
  const [previousAssistantId] = useState(activeAssistantId);
  const [ready, setReady] = useState(
    activeAssistantId === PREVIEW_ASSISTANT_ID,
  );

  useEffect(() => {
    setActiveAssistantId(PREVIEW_ASSISTANT_ID);
    setReady(true);
    return () => setActiveAssistantId(previousAssistantId);
  }, [previousAssistantId, setActiveAssistantId]);

  if (!ready) return null;

  return (
    <CompetitorIntelligencePage
      previewReport={hangaritasLivePreview}
      previewBrandId="hangaritas-live-preview"
    />
  );
}
