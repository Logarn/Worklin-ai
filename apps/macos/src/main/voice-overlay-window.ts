import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import type { VoiceOverlayState } from "@vellumai/ipc-contract";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";
import { dispatchToMain, ensureVisible } from "./main-window";

const OVERLAY_KIND = "voice-overlay";
const OVERLAY_PATH = "/floating/voice-overlay";
const OVERLAY_WIDTH = 620;
const OVERLAY_HEIGHT = 150;

const voiceStateSchema = z.object({
  state: z.enum([
    "idle",
    "connecting",
    "listening",
    "transcribing",
    "thinking",
    "speaking",
    "interrupted",
    "ending",
    "failed",
  ]),
  partialTranscript: z.string(),
  finalTranscript: z.string(),
  assistantTranscript: z.string(),
  inputAmplitude: z.number().min(0).max(1),
  outputAmplitude: z.number().min(0).max(1),
  muted: z.boolean(),
  error: z.string().nullable(),
});

let latestState: VoiceOverlayState | null = null;

const overlayPosition = (): { x: number; y: number } => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return {
    x: Math.round(
      display.workArea.x + (display.workArea.width - OVERLAY_WIDTH) / 2,
    ),
    y: display.workArea.y + 18,
  };
};

const ensureOverlay = (): BrowserWindow =>
  createFloatingWindow({
    kind: OVERLAY_KIND,
    route: OVERLAY_PATH,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    focusOnShow: false,
    ignoreMouseEvents: false,
    position: overlayPosition,
    browserWindow: {
      movable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
    },
  });

export const showVoiceOverlay = (): void => {
  ensureOverlay();
};

export const hideVoiceOverlay = (): void => {
  latestState = null;
  getFloatingWindow(OVERLAY_KIND)?.hide();
};

const forwardState = (state: VoiceOverlayState): void => {
  latestState = state;
  const window = ensureOverlay();
  window.webContents.send("vellum:voiceOverlay:state", state);
};

let installed = false;

export const installVoiceOverlay = (): void => {
  if (installed) return;
  installed = true;

  on(
    "vellum:voiceOverlay:setState",
    z.tuple([voiceStateSchema.nullable()]),
    ([state]) => {
      if (state === null) {
        hideVoiceOverlay();
      } else {
        forwardState(state);
      }
    },
  );
  handle("vellum:voiceOverlay:getState", z.tuple([]), () => latestState);
  handle("vellum:voiceOverlay:close", z.tuple([]), () => {
    dispatchToMain({ kind: "endVoiceConversation" });
    hideVoiceOverlay();
  });
  handle("vellum:voiceOverlay:toggleMute", z.tuple([]), () => {
    dispatchToMain({ kind: "toggleVoiceMute" });
  });
  handle("vellum:voiceOverlay:openInWorklin", z.tuple([]), async () => {
    await ensureVisible();
  });
};
