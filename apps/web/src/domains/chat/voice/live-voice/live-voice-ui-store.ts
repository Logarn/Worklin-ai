import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface LiveVoiceUiStore {
  /** Whether the inline live-voice card is expanded in the composer. */
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
}

/**
 * Presentation state for live voice, intentionally separate from the session
 * store. Ending/resetting a provider session must not undo the user's choice
 * to keep the composer compact, while a page reload starts from the visible
 * discovery state again.
 */
const useLiveVoiceUiStoreBase = create<LiveVoiceUiStore>()((set) => ({
  panelOpen: true,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
}));

export const useLiveVoiceUiStore = createSelectors(useLiveVoiceUiStoreBase);
