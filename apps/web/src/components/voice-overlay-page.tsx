import { useEffect, useState } from "react";

import type { VoiceOverlayState } from "@vellumai/ipc-contract";

import { VoiceConversationPanel } from "@/domains/chat/voice/live-voice/voice-conversation-panel";
import {
  closeVoiceOverlay,
  getVoiceOverlayState,
  openVoiceConversationInWorklin,
  subscribeVoiceOverlayState,
  toggleVoiceOverlayMute,
} from "@/runtime/voice-overlay";

export function VoiceOverlayPage() {
  const [state, setState] = useState<VoiceOverlayState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeVoiceOverlayState(setState);
    void getVoiceOverlayState().then(setState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void closeVoiceOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!state) return <main className="h-screen w-screen bg-transparent" />;

  return (
    <main className="h-screen w-screen bg-transparent p-2">
      <VoiceConversationPanel
        {...state}
        variant="overlay"
        onToggleMute={() => void toggleVoiceOverlayMute()}
        onClose={() => void closeVoiceOverlay()}
        onOpenInWorklin={() => void openVoiceConversationInWorklin()}
      />
    </main>
  );
}
