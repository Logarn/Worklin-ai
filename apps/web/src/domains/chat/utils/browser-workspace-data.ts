import type {
  BrowserActivityItem,
  BrowserWorkspaceData,
} from "@/stores/viewer-store";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

const VALID_STATUSES = new Set(["working", "ready", "error", "closed"]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeActivity(value: unknown): BrowserActivityItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const label = stringValue(record.label);
    const timestamp = numberValue(record.timestamp);
    if (!label || timestamp === undefined) return [];
    return [
      {
        id: stringValue(record.id) ?? `${timestamp}-${label}`,
        label,
        ...(stringValue(record.detail)
          ? { detail: stringValue(record.detail) }
          : {}),
        status:
          record.status === "error"
            ? ("error" as const)
            : ("completed" as const),
        timestamp,
      },
    ];
  });
}

export function isSafeBrowserUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isSafeBrowserScreenshot(
  value: string | undefined,
): value is string {
  return Boolean(
    value && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value),
  );
}

export function normalizeBrowserWorkspaceData(
  value: unknown,
): BrowserWorkspaceData {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rawStatus = stringValue(record.status);
  const status =
    rawStatus && VALID_STATUSES.has(rawStatus)
      ? (rawStatus as BrowserWorkspaceData["status"])
      : "ready";
  const screenshotDataUrl = stringValue(record.screenshotDataUrl);
  const url = stringValue(record.url);
  return {
    ...(isSafeBrowserUrl(url) ? { url } : {}),
    ...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
    ...(isSafeBrowserScreenshot(screenshotDataUrl)
      ? { screenshotDataUrl }
      : {}),
    status,
    ...(stringValue(record.connectionLabel)
      ? { connectionLabel: stringValue(record.connectionLabel) }
      : {}),
    ...(stringValue(record.errorMessage)
      ? { errorMessage: stringValue(record.errorMessage) }
      : {}),
    updatedAt: numberValue(record.updatedAt) ?? Date.now(),
    activity: normalizeActivity(record.activity),
  };
}

export function findLatestRestorableBrowserSurface(
  messages: readonly DisplayMessage[],
): { surface: Surface; data: BrowserWorkspaceData } | null {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const surfaces = messages[messageIndex]?.surfaces;
    if (!surfaces) continue;
    for (
      let surfaceIndex = surfaces.length - 1;
      surfaceIndex >= 0;
      surfaceIndex--
    ) {
      const surface = surfaces[surfaceIndex];
      if (
        !surface ||
        surface.surfaceType !== "browser_view" ||
        surface.completed
      ) {
        continue;
      }
      const data = normalizeBrowserWorkspaceData(surface.data);
      if (data.status === "closed") continue;
      return { surface, data };
    }
  }
  return null;
}
