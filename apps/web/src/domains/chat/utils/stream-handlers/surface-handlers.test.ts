import { beforeEach, describe, expect, it } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
} from "@/domains/chat/utils/stream-handlers/surface-handlers";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { useViewerStore } from "@/stores/viewer-store";

beforeEach(() => {
  useViewerStore.getState().reset();
});

describe("handleUISurfaceShow", () => {
  it("increments assets refresh key for dynamic_page", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      {
        type: "ui_surface_show",
        conversationId: "c-1",
        surfaceId: "s-1",
        surfaceType: "dynamic_page",
        data: {},
      },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.showSurface).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("increments assets refresh key for document_preview", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      {
        type: "ui_surface_show",
        conversationId: "c-1",
        surfaceId: "s-1",
        surfaceType: "document_preview",
        data: {},
      },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
  });

  it("does not increment assets refresh key for other surface types", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      {
        type: "ui_surface_show",
        conversationId: "c-1",
        surfaceId: "s-1",
        surfaceType: "form",
        data: {},
      },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });

  it("opens browser_view surfaces in the browser workspace", () => {
    const ctx = makeCtx();
    handleUISurfaceShow(
      {
        type: "ui_surface_show",
        conversationId: "c-1",
        surfaceId: "browser-1",
        surfaceType: "browser_view",
        data: {
          url: "https://example.com/",
          title: "Example",
          status: "ready",
          updatedAt: 123,
          activity: [],
        },
      },
      ctx,
    );

    expect(useViewerStore.getState().mainView).toBe("browser");
    expect(useViewerStore.getState().openedBrowserState?.surfaceId).toBe(
      "browser-1",
    );
    expect(useViewerStore.getState().openedBrowserState?.data.url).toBe(
      "https://example.com/",
    );
  });
});

describe("handleUISurfaceUpdate", () => {
  it("dispatches UI_SURFACE_UPDATE and updates messages", () => {
    const ctx = makeCtx();
    handleUISurfaceUpdate(
      {
        type: "ui_surface_update",
        conversationId: "c-1",
        surfaceId: "s-1",
        data: { key: "value" },
      },
      ctx,
    );
    expect(ctx.turnActions.updateSurface).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("updates the active browser without clearing omitted fields", () => {
    useViewerStore.getState().openBrowser({
      surfaceId: "browser-1",
      data: {
        url: "https://example.com/",
        title: "Original",
        screenshotDataUrl: "data:image/jpeg;base64,YWJjZA==",
        status: "ready",
        updatedAt: 123,
        activity: [
          {
            id: "step-1",
            label: "Opened a page",
            status: "completed",
            timestamp: 123,
          },
        ],
      },
    });
    const ctx = makeCtx();
    handleUISurfaceUpdate(
      {
        type: "ui_surface_update",
        conversationId: "c-1",
        surfaceId: "browser-1",
        data: { title: "Updated" },
      },
      ctx,
    );

    const data = useViewerStore.getState().openedBrowserState?.data;
    expect(data?.title).toBe("Updated");
    expect(data?.url).toBe("https://example.com/");
    expect(data?.screenshotDataUrl).toBe("data:image/jpeg;base64,YWJjZA==");
    expect(data?.activity).toHaveLength(1);
  });
});

describe("handleUISurfaceDismiss", () => {
  it("adds surfaceId to dismissed set and updates messages", () => {
    const ctx = makeCtx();
    handleUISurfaceDismiss(
      { type: "ui_surface_dismiss", conversationId: "c-1", surfaceId: "s-1" },
      ctx,
    );
    expect(ctx.turnActions.dismissSurface).toHaveBeenCalled();
    expect(ctx.addDismissedSurfaceId).toHaveBeenCalledWith("s-1");
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("closes the active browser workspace", () => {
    useViewerStore.getState().openBrowser({
      surfaceId: "browser-1",
      data: { status: "ready", updatedAt: 123, activity: [] },
    });
    const ctx = makeCtx();
    handleUISurfaceDismiss(
      {
        type: "ui_surface_dismiss",
        conversationId: "c-1",
        surfaceId: "browser-1",
      },
      ctx,
    );

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().openedBrowserState).toBeNull();
  });
});

describe("handleUISurfaceComplete", () => {
  it("increments refresh key when completed surface is dynamic_page", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      ...textBody(""),
      timestamp: 1,
      surfaces: [{ surfaceId: "s-1", surfaceType: "dynamic_page", data: {} }],
    };
    const ctx = makeCtx({ messages: [msg] });
    handleUISurfaceComplete(
      {
        type: "ui_surface_complete",
        conversationId: "c-1",
        surfaceId: "s-1",
        summary: "Done",
      },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).toHaveBeenCalled();
    expect(ctx.turnActions.completeSurface).toHaveBeenCalled();
  });

  it("does not increment refresh key for non-dynamic surface types", () => {
    const msg: DisplayMessage = {
      id: "m-1",
      role: "assistant",
      ...textBody(""),
      timestamp: 1,
      surfaces: [{ surfaceId: "s-1", surfaceType: "form", data: {} }],
    };
    const ctx = makeCtx({ messages: [msg] });
    handleUISurfaceComplete(
      {
        type: "ui_surface_complete",
        conversationId: "c-1",
        surfaceId: "s-1",
        summary: "Done",
      },
      ctx,
    );
    expect(ctx.setAssetsRefreshKey).not.toHaveBeenCalled();
  });
});
