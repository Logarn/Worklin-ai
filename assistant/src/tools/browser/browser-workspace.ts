import { optimizeImageForTransport } from "../../agent/image-optimize.js";
import type {
  BrowserViewActivityItem,
  BrowserViewSurfaceData,
} from "../../daemon/message-types/surfaces.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { browserManager } from "./browser-manager.js";
import {
  captureScreenshotJpeg,
  getCurrentUrl,
  getPageTitle,
} from "./cdp-client/cdp-dom-helpers.js";
import { getCdpClient } from "./cdp-client/factory.js";

const MAX_ACTIVITY_ITEMS = 20;
const MAX_SCREENSHOT_DATA_CHARS = 800_000;

const VISUAL_BROWSER_TOOLS = new Set([
  "browser_attach",
  "browser_click",
  "browser_fill_credential",
  "browser_hover",
  "browser_navigate",
  "browser_press_key",
  "browser_screenshot",
  "browser_scroll",
  "browser_select_option",
  "browser_snapshot",
  "browser_type",
  "browser_wait_for",
]);

interface BrowserWorkspaceEntry {
  surfaceId: string;
  data: BrowserViewSurfaceData;
}

const workspaceByConversation = new Map<string, BrowserWorkspaceEntry>();

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function browserActivityForTool(
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
  timestamp = Date.now(),
): BrowserViewActivityItem {
  const labelByTool: Record<string, string> = {
    browser_attach: "Connected to the browser",
    browser_click: "Clicked an element",
    browser_fill_credential: "Filled a saved sign-in field securely",
    browser_hover: "Inspected an element",
    browser_navigate: "Opened a page",
    browser_press_key: "Used the keyboard",
    browser_screenshot: "Captured the current page",
    browser_scroll: "Scrolled the page",
    browser_select_option: "Selected an option",
    browser_snapshot: "Read the page structure",
    browser_type: "Entered text securely",
    browser_wait_for: "Waited for the page",
  };
  const requestedUrl =
    toolName === "browser_navigate" && typeof input.url === "string"
      ? displayUrl(input.url)
      : "";
  return {
    id: `${timestamp}-${toolName}`,
    label: isError
      ? "Browser step could not be completed"
      : (labelByTool[toolName] ?? "Updated the browser"),
    ...(requestedUrl ? { detail: requestedUrl } : {}),
    status: isError ? "error" : "completed",
    timestamp,
  };
}

function connectionLabel(kind: string): string {
  switch (kind) {
    case "extension":
    case "host-bridge":
    case "cdp-inspect":
      return "Connected Chrome";
    case "local":
      return "Worklin browser";
    default:
      return "Browser connected";
  }
}

async function captureWorkspaceData(
  context: ToolContext,
  activity: BrowserViewActivityItem[],
): Promise<BrowserViewSurfaceData> {
  const preferredKind = browserManager.getPreferredBackendKind(
    context.conversationId,
  );
  const cdp = getCdpClient(context, {
    mode: preferredKind ?? "auto",
  });
  try {
    const [url, title, screenshot] = await Promise.all([
      getCurrentUrl(cdp, context.signal),
      getPageTitle(cdp, context.signal),
      captureScreenshotJpeg(
        cdp,
        { quality: 55, fullPage: false },
        context.signal,
      ),
    ]);
    const optimized = optimizeImageForTransport(
      screenshot.toString("base64"),
      "image/jpeg",
    );
    const screenshotDataUrl = `data:${optimized.mediaType};base64,${optimized.data}`;
    return {
      url: displayUrl(url),
      title: title.trim() || "Browser",
      ...(screenshotDataUrl.length <= MAX_SCREENSHOT_DATA_CHARS
        ? { screenshotDataUrl }
        : {}),
      status: "ready",
      connectionLabel: connectionLabel(cdp.kind),
      updatedAt: Date.now(),
      activity,
    };
  } finally {
    cdp.dispose();
  }
}

async function showOrUpdateWorkspace(
  context: ToolContext,
  data: BrowserViewSurfaceData,
): Promise<void> {
  const resolver = context.proxyToolResolver;
  if (!resolver) return;

  const existing = workspaceByConversation.get(context.conversationId);
  if (existing) {
    const update = await resolver("ui_update", {
      surface_id: existing.surfaceId,
      data,
    });
    if (!update.isError) {
      workspaceByConversation.set(context.conversationId, {
        surfaceId: existing.surfaceId,
        data,
      });
    }
    return;
  }

  const shown = await resolver("ui_show", {
    surface_type: "browser_view",
    title: "Browser",
    data,
    display: "panel",
    await_action: false,
    persistent: true,
  });
  if (shown.isError) return;
  try {
    const parsed = JSON.parse(shown.content) as { surfaceId?: unknown };
    if (typeof parsed.surfaceId === "string") {
      workspaceByConversation.set(context.conversationId, {
        surfaceId: parsed.surfaceId,
        data,
      });
    }
  } catch {
    // An invalid surface response should not affect the browser tool result.
  }
}

export async function syncBrowserWorkspaceAfterTool(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolExecutionResult,
  context: ToolContext,
): Promise<void> {
  if (toolName === "browser_close" || toolName === "browser_detach") {
    const existing = workspaceByConversation.get(context.conversationId);
    if (!existing || !context.proxyToolResolver) return;
    const data: BrowserViewSurfaceData = {
      ...existing.data,
      status: "closed",
      updatedAt: Date.now(),
    };
    await context.proxyToolResolver("ui_update", {
      surface_id: existing.surfaceId,
      data,
    });
    workspaceByConversation.delete(context.conversationId);
    return;
  }

  if (!VISUAL_BROWSER_TOOLS.has(toolName)) return;

  const existing = workspaceByConversation.get(context.conversationId);
  const activity = [
    ...(existing?.data.activity ?? []),
    browserActivityForTool(toolName, input, result.isError),
  ].slice(-MAX_ACTIVITY_ITEMS);

  if (result.isError) {
    if (!existing) return;
    await showOrUpdateWorkspace(context, {
      ...existing.data,
      status: "error",
      errorMessage: "Worklin could not complete the latest browser step.",
      updatedAt: Date.now(),
      activity,
    });
    return;
  }

  try {
    const data = await captureWorkspaceData(context, activity);
    await showOrUpdateWorkspace(context, data);
  } catch {
    // Browser workspace rendering is best-effort and must never fail the tool.
  }
}

export async function markBrowserWorkspaceWorking(
  toolName: string,
  context: ToolContext,
): Promise<void> {
  if (!VISUAL_BROWSER_TOOLS.has(toolName)) return;

  const existing = workspaceByConversation.get(context.conversationId);
  if (!existing || !context.proxyToolResolver) return;

  const data: BrowserViewSurfaceData = {
    ...existing.data,
    status: "working",
    errorMessage: undefined,
    updatedAt: Date.now(),
  };
  try {
    const update = await context.proxyToolResolver("ui_update", {
      surface_id: existing.surfaceId,
      data,
    });
    if (!update.isError) {
      workspaceByConversation.set(context.conversationId, {
        surfaceId: existing.surfaceId,
        data,
      });
    }
  } catch {
    // Browser workspace rendering is best-effort and must never fail the tool.
  }
}

export function clearBrowserWorkspace(conversationId: string): void {
  workspaceByConversation.delete(conversationId);
}

export function resetBrowserWorkspacesForTests(): void {
  workspaceByConversation.clear();
}
