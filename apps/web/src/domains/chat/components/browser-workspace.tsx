import { Tooltip } from "@vellumai/design-library";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Globe2,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { submitSurfaceAction } from "@/domains/chat/api/surfaces";
import {
  isSafeBrowserScreenshot,
  isSafeBrowserUrl,
} from "@/domains/chat/utils/browser-workspace-data";
import { useStreamStore } from "@/domains/chat/stream-store";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import type { OpenedBrowserState } from "@/stores/viewer-store";

interface BrowserWorkspaceProps {
  browser: OpenedBrowserState;
  onClose: () => void;
}

type BrowserTab = "live" | "activity";

function normalizeRequestedUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return isSafeBrowserUrl(candidate) ? candidate : null;
}

export function BrowserWorkspace({ browser, onClose }: BrowserWorkspaceProps) {
  const [tab, setTab] = useState<BrowserTab>("live");
  const [urlInput, setUrlInput] = useState(browser.data.url ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const turnPhase = useTurnStore.use.phase();
  const disabled =
    submitting || isSending(turnPhase) || browser.data.status === "closed";

  useEffect(() => {
    if (browser.data.url) setUrlInput(browser.data.url);
  }, [browser.data.url]);

  const sendBrowserPrompt = useCallback(
    async (prompt: string) => {
      const streamContext = useStreamStore.getState().streamContext;
      if (!streamContext) {
        setLocalError(
          "The browser session is not connected. Please try again.",
        );
        return;
      }
      setSubmitting(true);
      setLocalError(null);
      const result = await submitSurfaceAction(
        streamContext.assistantId,
        browser.surfaceId,
        "agent_prompt",
        { prompt },
      );
      setSubmitting(false);
      if (!result.ok) {
        setLocalError(
          "Worklin could not send that browser command. Please try again.",
        );
        return;
      }
      useTurnStore.getState().requestSend();
    },
    [browser.surfaceId],
  );

  const handleNavigate = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const url = normalizeRequestedUrl(urlInput);
      if (!url) {
        setLocalError("Enter a valid website address.");
        return;
      }
      void sendBrowserPrompt(
        `Open ${url} in the browser and continue the current task.`,
      );
    },
    [sendBrowserPrompt, urlInput],
  );

  const activity = useMemo(
    () => [...browser.data.activity].reverse(),
    [browser.data.activity],
  );
  const statusText =
    browser.data.status === "closed"
      ? "Browser closed"
      : browser.data.status === "error"
        ? "Needs attention"
        : (browser.data.connectionLabel ?? "Browser connected");

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-[var(--surface-base)]"
      aria-label="Browser workspace"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-4">
        <Globe2
          className="h-4 w-4 text-[var(--content-secondary)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-medium-default font-medium text-[var(--content-strong)]">
            Browser
          </p>
          <div className="flex min-w-0 items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                browser.data.status === "error"
                  ? "bg-[var(--system-critical-strong)]"
                  : browser.data.status === "working"
                    ? "animate-pulse bg-[var(--system-mid-strong)] motion-reduce:animate-none"
                    : "bg-[var(--system-positive-strong)]"
              }`}
              aria-hidden
            />
            <span className="truncate">{statusText}</span>
          </div>
        </div>
        <div className="flex h-full items-end gap-1">
          <button
            type="button"
            onClick={() => setTab("live")}
            className={`h-10 border-b-2 px-2 text-body-small-default transition-colors ${
              tab === "live"
                ? "border-[var(--content-strong)] text-[var(--content-strong)]"
                : "border-transparent text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
            }`}
          >
            Live view
          </button>
          <button
            type="button"
            onClick={() => setTab("activity")}
            className={`h-10 border-b-2 px-2 text-body-small-default transition-colors ${
              tab === "activity"
                ? "border-[var(--content-strong)] text-[var(--content-strong)]"
                : "border-transparent text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
            }`}
          >
            Activity
          </button>
        </div>
        <Tooltip content="Close browser" side="bottom">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close browser"
            className="flex h-8 w-8 items-center justify-center rounded text-[var(--content-tertiary)] hover:bg-[var(--surface-active)] hover:text-[var(--content-strong)]"
          >
            <X className="h-4 w-4" />
          </button>
        </Tooltip>
      </header>

      {tab === "live" ? (
        <>
          <form
            onSubmit={handleNavigate}
            className="flex shrink-0 items-center gap-1 border-b border-[var(--border-base)] p-2"
          >
            <Tooltip content="Back" side="bottom">
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void sendBrowserPrompt(
                    "Go back one page in the browser and continue the current task.",
                  )
                }
                aria-label="Back"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--content-secondary)] hover:bg-[var(--surface-active)] disabled:opacity-40"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content="Forward" side="bottom">
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void sendBrowserPrompt(
                    "Go forward one page in the browser and continue the current task.",
                  )
                }
                aria-label="Forward"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--content-secondary)] hover:bg-[var(--surface-active)] disabled:opacity-40"
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content="Refresh" side="bottom">
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void sendBrowserPrompt(
                    "Refresh the current browser page and continue the current task.",
                  )
                }
                aria-label="Refresh"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--content-secondary)] hover:bg-[var(--surface-active)] disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </Tooltip>
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              disabled={disabled}
              aria-label="Website address"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded border border-[var(--border-base)] bg-[var(--surface-lift)] px-3 text-body-small-default text-[var(--content-default)] outline-none focus:border-[var(--border-strong)] disabled:opacity-60"
              placeholder="Enter a website address"
            />
            {isSafeBrowserUrl(browser.data.url) && (
              <Tooltip content="Open in my browser" side="bottom">
                <a
                  href={browser.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in my browser"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--content-secondary)] hover:bg-[var(--surface-active)]"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Tooltip>
            )}
          </form>

          {(localError || browser.data.errorMessage) && (
            <div className="flex items-center gap-2 border-b border-[var(--system-critical-strong)]/30 bg-[var(--system-critical-weak)] px-3 py-2 text-body-small-default text-[var(--system-critical-strong)]">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{localError ?? browser.data.errorMessage}</span>
            </div>
          )}

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--surface-inset)] p-3">
            {isSafeBrowserScreenshot(browser.data.screenshotDataUrl) ? (
              <img
                src={browser.data.screenshotDataUrl}
                alt={`Current page: ${browser.data.title ?? browser.data.url ?? "Browser"}`}
                className="max-h-full max-w-full rounded-md border border-[var(--border-base)] bg-white object-contain"
              />
            ) : (
              <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-[var(--content-tertiary)]">
                {submitting || browser.data.status === "working" ? (
                  <Loader2 className="h-6 w-6 animate-spin" />
                ) : (
                  <Globe2 className="h-8 w-8" />
                )}
                <p className="text-body-medium-default">
                  {browser.data.status === "closed"
                    ? "This browser session has ended."
                    : "The page preview will appear after Worklin opens a website."}
                </p>
              </div>
            )}
            {submitting &&
              isSafeBrowserScreenshot(browser.data.screenshotDataUrl) && (
                <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded bg-[var(--surface-overlay)] px-3 py-2 text-body-small-default text-[var(--content-secondary)] shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Worklin is updating the browser…
                </div>
              )}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {activity.length === 0 ? (
            <p className="py-8 text-center text-body-medium-default text-[var(--content-tertiary)]">
              Browser activity will appear here.
            </p>
          ) : (
            activity.map((item) => (
              <div
                key={item.id}
                className="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-2 border-b border-[var(--border-subtle)] py-3 last:border-0"
              >
                {item.status === "error" ? (
                  <AlertCircle className="mt-0.5 h-4 w-4 text-[var(--system-critical-strong)]" />
                ) : (
                  <Check className="mt-0.5 h-4 w-4 text-[var(--system-positive-strong)]" />
                )}
                <div className="min-w-0">
                  <p className="text-body-medium-default text-[var(--content-default)]">
                    {item.label}
                  </p>
                  {item.detail && (
                    <p className="truncate text-body-small-default text-[var(--content-tertiary)]">
                      {item.detail}
                    </p>
                  )}
                </div>
                <time className="text-body-small-default text-[var(--content-tertiary)]">
                  {new Date(item.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
