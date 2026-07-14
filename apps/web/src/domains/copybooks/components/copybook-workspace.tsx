import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useRef } from "react";
import { useNavigate } from "react-router";

import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "@/components/document-viewer-container";
import { documentsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { documentsByIdPdfGet } from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useDocumentCommentEvents } from "@/hooks/use-document-comment-events";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import {
  openPdfPreparingWindow,
  presentPdfBlob,
  safePdfFilename,
} from "@/utils/pdf-export";

import type { CopybookDetail, CopybookMonth } from "../copybook-api";
import { CopybookMonthNav } from "./copybook-month-nav";
import { CopybookStatusBar } from "./copybook-status-bar";

export function CopybookWorkspace({
  assistantId,
  copybook,
  month,
  onSelectMonth,
}: {
  assistantId: string;
  copybook: CopybookDetail;
  month: CopybookMonth;
  onSelectMonth: (month: number) => void;
}) {
  const navigate = useNavigate();
  const viewerRef = useRef<DocumentViewerContainerHandle>(null);
  const { data: document, isLoading, error } = useQuery({
    ...documentsByIdGetOptions({
      path: { assistant_id: assistantId, id: month.documentSurfaceId ?? "" },
    }),
    enabled: month.documentSurfaceId != null,
  });

  const refreshComments = useCallback(() => {
    void viewerRef.current?.refreshComments();
  }, []);
  const handleCommentEvent = useDocumentCommentEvents({
    surfaceId: month.documentSurfaceId ?? "",
    enabled: month.documentSurfaceId != null,
    onCommentsChanged: refreshComments,
  });
  useBusSubscription("sse.event", handleCommentEvent);

  const handleWorkWithWorklin = useCallback(() => {
    if (!document) return;
    const conversationId = document.conversationId;
    useViewerStore.getState().openDocument();
    useViewerStore.getState().setLoadedDocument({
      surfaceId: document.surfaceId,
      conversationId,
      documentName: document.title,
      content: document.content,
    });
    const prompt = `Help me review and improve the ${month.month}/${copybook.copybook.year} campaign copy in "${document.title}".`;
    void navigate(
      `${routes.conversation(conversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
  }, [copybook.copybook.year, document, month.month, navigate]);

  const handleExport = useCallback(async () => {
    if (!document) return;
    const pdfWindow = openPdfPreparingWindow(`${document.title} PDF Export`);
    try {
      const { data: blob, response } = await documentsByIdPdfGet({
        path: { assistant_id: assistantId, id: document.surfaceId },
        throwOnError: false,
        parseAs: "blob",
      });
      if (!response?.ok || !blob) {
        pdfWindow?.close();
        return;
      }
      await presentPdfBlob(blob, safePdfFilename(document.title), pdfWindow);
    } catch {
      pdfWindow?.close();
    }
  }, [assistantId, document]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="hidden md:flex">
        <CopybookMonthNav
          year={copybook.copybook.year}
          months={copybook.months}
          selectedMonth={month.month}
          onSelectMonth={onSelectMonth}
        />
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--surface-overlay)]">
        <CopybookStatusBar
          title={copybook.copybook.title}
          year={copybook.copybook.year}
          month={month}
        />
        <label className="mx-4 mt-3 md:hidden">
          <span className="sr-only">Select month</span>
          <select
            value={month.month}
            onChange={(event) => onSelectMonth(Number(event.target.value))}
            className="w-full rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-default text-[var(--content-default)]"
          >
            {copybook.months.map((item) => (
              <option key={item.id} value={item.month}>
                {new Date(2000, item.month - 1).toLocaleString(undefined, {
                  month: "long",
                })}
              </option>
            ))}
          </select>
        </label>
        <div className="min-h-0 flex-1 p-3 md:p-4">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : error || !document ? (
            <div className="flex h-full items-center justify-center text-body-small-default text-[var(--content-tertiary)]">
              Failed to load this month&apos;s copy document.
            </div>
          ) : (
            <DocumentViewerContainer
              key={document.surfaceId}
              surfaceId={document.surfaceId}
              assistantId={assistantId}
              conversationId={document.conversationId}
              documentName={document.title}
              content={document.content}
              onClose={() => void navigate(routes.library.root)}
              onExport={() => void handleExport()}
              onSubmitFeedback={handleWorkWithWorklin}
              onWorkWithAssistant={handleWorkWithWorklin}
              handleRef={viewerRef}
            />
          )}
        </div>
      </main>
    </div>
  );
}
