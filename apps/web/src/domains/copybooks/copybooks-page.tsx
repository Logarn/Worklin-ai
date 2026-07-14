import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenText, Loader2, MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import {
  copybooksByIdGetOptions,
  copybooksGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { CopybooksByIdGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/utils/conversation-selection";
import { routes } from "@/utils/routes";

import { copybookStartPrompt, getCopybookDestination } from "./copybook-navigation";

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function CopybooksPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const copybooksQuery = useQuery(
    copybooksGetOptions({ path: { assistant_id: assistantId } }),
  );
  const copybooks = useMemo(
    () =>
      [...(copybooksQuery.data?.copybooks ?? [])].sort(
        (a, b) => b.year - a.year || a.title.localeCompare(b.title),
      ),
    [copybooksQuery.data?.copybooks],
  );
  const detailQueries = useQueries({
    queries: copybooks.map((copybook) =>
      copybooksByIdGetOptions({
        path: { assistant_id: assistantId, id: copybook.id },
      }),
    ),
  });

  useEffect(() => {
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        Campaign Copybooks
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [setTopBarCenter]);

  const startWithWorklin = useCallback(
    (title?: string) => {
      const draftConversationId = createDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftConversationId);
      useViewerStore.getState().setMainView("chat");
      void navigate(
        `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(copybookStartPrompt(title))}`,
      );
    },
    [navigate],
  );

  if (copybooksQuery.isPending) {
    return (
      <PageShell className="items-center justify-center">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }

  if (copybooksQuery.isError) {
    return (
      <PageShell className="items-center justify-center gap-3 text-center">
        <p className="text-title-small text-[var(--content-emphasised)]">
          Copybooks could not be loaded
        </p>
        <button
          type="button"
          className="text-body-small-default text-[var(--content-link)] hover:underline"
          onClick={() => void copybooksQuery.refetch()}
        >
          Try again
        </button>
      </PageShell>
    );
  }

  if (copybooks.length === 0) {
    return (
      <PageShell className="items-center justify-center">
        <div className="flex max-w-md flex-col items-center text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] text-[var(--content-secondary)]">
            <BookOpenText className="size-6" />
          </span>
          <h1 className="text-title-large text-[var(--content-emphasised)]">
            Build your first Campaign Copybook
          </h1>
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            Worklin can turn your brand context and monthly priorities into a reviewable strategy, campaign briefs, email copy, and SMS copy.
          </p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-[var(--primary-base)] px-4 py-2 text-body-small-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
            onClick={() => startWithWorklin()}
          >
            <MessageSquarePlus className="size-4" />
            Start with Worklin
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell className="overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border-base)] pb-5">
          <div>
            <h1 className="text-title-large text-[var(--content-emphasised)]">
              Campaign Copybooks
            </h1>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Monthly strategy, campaign briefs, and approved email and SMS copy in one reviewable workspace.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default text-[var(--content-secondary)] hover:bg-[var(--surface-hover)]"
            onClick={() => startWithWorklin()}
          >
            <MessageSquarePlus className="size-4" />
            New copybook
          </button>
        </div>

        <ul className="mt-5 grid gap-3 md:grid-cols-2">
          {copybooks.map((copybook, index) => {
            const detail = detailQueries[index]?.data as
              | CopybooksByIdGetResponse
              | undefined;
            const detailFailed = detailQueries[index]?.isError;
            const destination = getCopybookDestination(detail);
            const brandName = detail?.brand?.name;
            const campaignCount =
              detail?.months.reduce(
                (total, month) => total + month.campaigns.length,
                0,
              ) ?? 0;
            const content = (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-title-small text-[var(--content-emphasised)]">
                    {copybook.title}
                  </span>
                  <span className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    {brandName ? `${brandName} · ` : ""}{copybook.year}
                  </span>
                  <span className="mt-4 text-body-small-default text-[var(--content-tertiary)]">
                    {detail
                      ? `${detail.months.length} ${detail.months.length === 1 ? "month" : "months"} · ${campaignCount} ${campaignCount === 1 ? "campaign" : "campaigns"}`
                      : detailFailed
                        ? "Open with Worklin"
                        : "Loading workspace…"}
                  </span>
                  <span className="mt-1 text-body-small-default text-[var(--content-quiet)]">
                    Updated {DATE_FORMATTER.format(new Date(copybook.updatedAt))}
                  </span>
                </span>
                <ArrowRight className="mt-1 size-4 shrink-0 text-[var(--content-tertiary)]" />
              </>
            );

            return (
              <li key={copybook.id}>
                {destination ? (
                  <Link
                    to={destination}
                    className="flex min-h-40 gap-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4 transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="flex min-h-40 w-full gap-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4 text-left transition-colors hover:bg-[var(--surface-hover)]"
                    onClick={() => startWithWorklin(copybook.title)}
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </PageShell>
  );
}
