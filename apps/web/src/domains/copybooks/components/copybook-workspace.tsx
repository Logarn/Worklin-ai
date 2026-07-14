import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "@/components/document-viewer-container";
import { documentsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  copybookcampaignsByIdApprovePost,
  copybookcampaignsByIdPatch,
  copybookcampaignsByIdReadyfordesignPost,
  copybookmonthsByIdPatch,
  documentsByIdCommentsGet,
  documentsByIdConversationsPost,
  documentsByIdPdfGet,
} from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useDocumentCommentEvents } from "@/hooks/use-document-comment-events";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import {
  openPdfPreparingWindow,
  presentPdfBlob,
  safePdfFilename,
} from "@/utils/pdf-export";

import type { CopybookDetail, CopybookMonth } from "../copybook-api";
import { copybookWorklinPrompt } from "../copybook-navigation";
import { copybookQueryKey } from "../use-copybook-data";
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
  const queryClient = useQueryClient();
  const viewerRef = useRef<DocumentViewerContainerHandle>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const {
    data: document,
    isLoading,
    error,
  } = useQuery({
    ...documentsByIdGetOptions({
      path: { assistant_id: assistantId, id: month.documentSurfaceId ?? "" },
    }),
    enabled: month.documentSurfaceId != null,
  });
  const commentsQuery = useQuery({
    queryKey: ["document-comments", assistantId, month.documentSurfaceId],
    queryFn: async () => {
      const { data } = await documentsByIdCommentsGet({
        path: {
          assistant_id: assistantId,
          id: month.documentSurfaceId ?? "",
        },
        throwOnError: true,
      });
      return data?.comments ?? [];
    },
    enabled: month.documentSurfaceId != null,
  });
  const blockingCommentCount =
    commentsQuery.data?.filter((comment) => comment.status === "open").length ??
    0;

  const approvalAction = useMemo(() => {
    if (month.strategyStatus === "in_review") {
      return {
        kind: "strategy" as const,
        campaigns: [],
        label: "Approve strategy",
      };
    }
    const briefReviews = month.campaigns.filter(
      (campaign) => campaign.status === "brief_review",
    );
    if (briefReviews.length > 0) {
      return {
        kind: "briefs" as const,
        campaigns: briefReviews,
        label:
          briefReviews.length === 1
            ? "Approve brief"
            : `Approve ${briefReviews.length} briefs`,
      };
    }
    const copyReviews = month.campaigns.filter(
      (campaign) => campaign.status === "copy_review",
    );
    if (copyReviews.length > 0) {
      return {
        kind: "copy" as const,
        campaigns: copyReviews,
        label:
          copyReviews.length === 1
            ? "Approve copy"
            : `Approve ${copyReviews.length} campaigns`,
      };
    }
    const approved = month.campaigns.filter(
      (campaign) => campaign.status === "approved",
    );
    if (approved.length > 0) {
      return {
        kind: "design" as const,
        campaigns: approved,
        label:
          approved.length === 1
            ? "Send to design"
            : `Send ${approved.length} to design`,
      };
    }
    return null;
  }, [month.campaigns, month.strategyStatus]);

  const handleApprove = useCallback(async () => {
    if (!approvalAction || approvalPending || blockingCommentCount > 0) return;
    setApprovalPending(true);
    try {
      if (approvalAction.kind === "strategy") {
        await copybookmonthsByIdPatch({
          path: { assistant_id: assistantId, id: month.id },
          body: { strategyStatus: "approved" },
          throwOnError: true,
        });
      } else if (approvalAction.kind === "briefs") {
        await Promise.all(
          approvalAction.campaigns.map((campaign) =>
            copybookcampaignsByIdPatch({
              path: { assistant_id: assistantId, id: campaign.id },
              body: { status: "brief_approved" },
              throwOnError: true,
            }),
          ),
        );
      } else if (approvalAction.kind === "copy") {
        await Promise.all(
          approvalAction.campaigns.map((campaign) =>
            copybookcampaignsByIdApprovePost({
              path: { assistant_id: assistantId, id: campaign.id },
              throwOnError: true,
            }),
          ),
        );
      } else {
        await Promise.all(
          approvalAction.campaigns.map((campaign) =>
            copybookcampaignsByIdReadyfordesignPost({
              path: { assistant_id: assistantId, id: campaign.id },
              throwOnError: true,
            }),
          ),
        );
      }
      await queryClient.invalidateQueries({
        queryKey: copybookQueryKey(assistantId, copybook.copybook.id),
      });
      toast.success(`${approvalAction.label} completed.`);
    } catch {
      toast.error("Approval could not be completed. Please try again.");
    } finally {
      setApprovalPending(false);
    }
  }, [
    approvalAction,
    approvalPending,
    blockingCommentCount,
    assistantId,
    month.id,
    queryClient,
    copybook.copybook.id,
  ]);

  const refreshComments = useCallback(() => {
    void viewerRef.current?.refreshComments();
  }, []);
  const handleCommentEvent = useDocumentCommentEvents({
    surfaceId: month.documentSurfaceId ?? "",
    enabled: month.documentSurfaceId != null,
    onCommentsChanged: refreshComments,
  });
  useBusSubscription("sse.event", handleCommentEvent);

  const handleWorkWithWorklin = useCallback(async () => {
    if (!document) return;
    const conversationId = document.conversationId;
    try {
      await documentsByIdConversationsPost({
        path: { assistant_id: assistantId, id: document.surfaceId },
        body: { conversationId },
        throwOnError: true,
      });
    } catch {
      toast.error(
        "Could not connect this artifact to Worklin. Please try again.",
      );
      return;
    }
    useViewerStore.getState().openDocument();
    useViewerStore.getState().setLoadedDocument({
      surfaceId: document.surfaceId,
      conversationId,
      documentName: document.title,
      content: document.content,
    });
    useConversationStore.getState().setActiveConversationId(conversationId);
    const prompt = copybookWorklinPrompt({
      title: document.title,
      year: copybook.copybook.year,
      month: month.month,
    });
    void navigate(
      `${routes.conversation(conversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
  }, [assistantId, copybook.copybook.year, document, month.month, navigate]);

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
          approvalLabel={approvalAction?.label}
          approvalPending={approvalPending}
          blockingCommentCount={blockingCommentCount}
          onApprove={() => void handleApprove()}
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
              onClose={() =>
                void navigate(
                  routes.work.brandArtifacts(copybook.copybook.brandId),
                )
              }
              onExport={() => void handleExport()}
              onSubmitFeedback={() => void handleWorkWithWorklin()}
              onWorkWithAssistant={() => void handleWorkWithWorklin()}
              handleRef={viewerRef}
            />
          )}
        </div>
      </main>
    </div>
  );
}
