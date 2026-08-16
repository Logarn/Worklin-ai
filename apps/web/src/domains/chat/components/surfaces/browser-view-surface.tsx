import { Globe2, PanelRightOpen } from "lucide-react";

import type { Surface } from "@/domains/chat/types/types";
import { normalizeBrowserWorkspaceData } from "@/domains/chat/utils/browser-workspace-data";
import { useViewerStore } from "@/stores/viewer-store";

interface BrowserViewSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

export function BrowserViewSurface({ surface }: BrowserViewSurfaceProps) {
  const data = normalizeBrowserWorkspaceData(surface.data);
  const handleOpen = () => {
    useViewerStore
      .getState()
      .openBrowser({ surfaceId: surface.surfaceId, data });
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="flex w-full max-w-sm items-center gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-3 text-left transition-colors hover:bg-[var(--surface-active)]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--surface-active)] text-[var(--content-secondary)]">
        <Globe2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-medium-default font-medium text-[var(--content-strong)]">
          {data.title ?? surface.title ?? "Browser"}
        </span>
        <span className="block truncate text-body-small-default text-[var(--content-tertiary)]">
          {data.url ?? data.connectionLabel ?? "Open browser workspace"}
        </span>
      </span>
      <span className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)]">
        Open
        <PanelRightOpen className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
