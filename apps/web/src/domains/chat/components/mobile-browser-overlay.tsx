import type { MouseEvent } from "react";

import { BrowserWorkspace } from "@/domains/chat/components/browser-workspace";
import type { OpenedBrowserState } from "@/stores/viewer-store";

interface MobileBrowserOverlayProps {
  browser: OpenedBrowserState | null;
  onClose: () => void;
}

export function MobileBrowserOverlay({
  browser,
  onClose,
}: MobileBrowserOverlayProps) {
  if (!browser) return null;

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh] bg-black/40"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom:
          "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft:
          "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight:
          "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
      }}
      onClick={handleBackdropClick}
    >
      <BrowserWorkspace browser={browser} onClose={onClose} />
    </div>
  );
}
