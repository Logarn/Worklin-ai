import type { VoiceOverlayState } from "@vellumai/ipc-contract";

export function publishVoiceOverlayState(
  state: VoiceOverlayState | null,
): void {
  window.vellum?.voiceOverlay?.setState(state);
}

export function subscribeVoiceOverlayState(
  callback: (state: VoiceOverlayState) => void,
): () => void {
  return window.vellum?.voiceOverlay?.onState(callback) ?? (() => undefined);
}

export async function getVoiceOverlayState(): Promise<VoiceOverlayState | null> {
  return (await window.vellum?.voiceOverlay?.getState()) ?? null;
}

export async function closeVoiceOverlay(): Promise<void> {
  await window.vellum?.voiceOverlay?.close();
}

export async function toggleVoiceOverlayMute(): Promise<void> {
  await window.vellum?.voiceOverlay?.toggleMute();
}

export async function openVoiceConversationInWorklin(): Promise<void> {
  await window.vellum?.voiceOverlay?.openInWorklin();
}
