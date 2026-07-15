import { Button } from "@vellumai/design-library/components/button";
import { Loader2, MessageSquarePlus, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";

import { PageShell } from "@/components/page-shell";

import {
  createSharedCopybookComment,
  getSharedCopybookSnapshot,
  listSharedCopybookComments,
  updateSharedCopybookMonth,
  type SharedComment,
  type SharedCopybookSnapshot,
} from "./artifact-sharing-api";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function SharedCopybookPage() {
  const { artifactId = "" } = useParams<{ artifactId: string }>();
  const [snapshot, setSnapshot] = useState<SharedCopybookSnapshot | null>(null);
  const [selectedMonthId, setSelectedMonthId] = useState("");
  const [content, setContent] = useState("");
  const [comments, setComments] = useState<SharedComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const documentRef = useRef<HTMLTextAreaElement>(null);

  const selectedMonth = useMemo(
    () =>
      snapshot?.months.find((month) => month.id === selectedMonthId) ??
      snapshot?.months[0] ??
      null,
    [selectedMonthId, snapshot],
  );
  const canComment =
    snapshot?.collaborationRole === "commenter" ||
    snapshot?.collaborationRole === "editor" ||
    snapshot?.collaborationRole === "owner";
  const canEdit =
    snapshot?.collaborationRole === "editor" ||
    snapshot?.collaborationRole === "owner";

  const loadComments = useCallback(
    async (monthId: string) => {
      const result = await listSharedCopybookComments(artifactId, monthId);
      setComments(result.comments);
    },
    [artifactId],
  );

  useEffect(() => {
    void getSharedCopybookSnapshot(artifactId)
      .then((result) => {
        setSnapshot(result);
        const first =
          result.months.find((month) => month.document) ?? result.months[0];
        if (first) setSelectedMonthId(first.id);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Shared work could not be opened.",
        ),
      );
  }, [artifactId]);

  useEffect(() => {
    setContent(selectedMonth?.document?.content ?? "");
    setSelection(null);
    if (selectedMonth)
      void loadComments(selectedMonth.id).catch(() => setComments([]));
  }, [loadComments, selectedMonth]);

  const save = async () => {
    if (!selectedMonth?.document || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateSharedCopybookMonth({
        artifactId,
        monthId: selectedMonth.id,
        content,
      });
      setSnapshot((current) =>
        current
          ? {
              ...current,
              months: current.months.map((month) =>
                month.id === selectedMonth.id && month.document
                  ? {
                      ...month,
                      document: {
                        ...month.document,
                        content,
                        updatedAt: Date.now(),
                      },
                    }
                  : month,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your changes could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const addComment = async () => {
    if (!selectedMonth || !commentText.trim()) return;
    try {
      const comment = await createSharedCopybookComment({
        artifactId,
        monthId: selectedMonth.id,
        content: commentText,
        anchorStart: selection?.start,
        anchorEnd: selection?.end,
        anchorText: selection?.text,
      });
      setComments((current) => [...current, comment]);
      setCommentText("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your comment could not be added.",
      );
    }
  };

  if (!snapshot && !error) {
    return (
      <PageShell className="items-center justify-center p-0">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }
  if (!snapshot) {
    return (
      <PageShell className="items-center justify-center p-6 text-body-small-default text-[var(--content-tertiary)]">
        {error}
      </PageShell>
    );
  }

  return (
    <PageShell className="overflow-hidden p-0">
      <div className="flex h-full min-h-0 flex-col bg-[var(--surface-overlay)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-title-small text-[var(--content-emphasised)]">
              {snapshot.copybook.title}
            </h1>
            <p className="m-0 text-label-small-default text-[var(--content-tertiary)]">
              Shared Copybook · {snapshot.brand?.name ?? "Unassigned"}
            </p>
          </div>
          <Button
            size="compact"
            variant="primary"
            onClick={() => void save()}
            disabled={!selectedMonth?.document || saving || !canEdit}
            leftIcon={saving ? <Loader2 className="animate-spin" /> : <Save />}
          >
            Save changes
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-base)] p-2 md:w-52 md:flex-col md:border-b-0 md:border-r">
            {snapshot.months.map((month) => (
              <button
                key={month.id}
                type="button"
                onClick={() => setSelectedMonthId(month.id)}
                className={`rounded-md px-3 py-2 text-left text-body-small-default ${month.id === selectedMonth?.id ? "bg-[var(--surface-selected)] text-[var(--content-emphasised)]" : "text-[var(--content-secondary)]"}`}
              >
                {MONTH_NAMES[month.month - 1]} {snapshot.copybook.year}
              </button>
            ))}
          </nav>
          <main className="min-h-0 min-w-0 flex-1 p-4">
            {selectedMonth?.document ? (
              <textarea
                ref={documentRef}
                value={content}
                readOnly={!canEdit}
                onChange={(event) => setContent(event.target.value)}
                onSelect={() => {
                  const field = documentRef.current;
                  if (!field || field.selectionStart === field.selectionEnd)
                    return setSelection(null);
                  setSelection({
                    start: field.selectionStart,
                    end: field.selectionEnd,
                    text: field.value.slice(
                      field.selectionStart,
                      field.selectionEnd,
                    ),
                  });
                }}
                className="h-full min-h-80 w-full resize-none rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] p-4 font-sans text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                aria-label="Shared copybook document"
              />
            ) : (
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                No document is linked to this month.
              </p>
            )}
          </main>
          <aside className="flex w-full shrink-0 flex-col border-t border-[var(--border-base)] md:w-80 md:border-l md:border-t-0">
            <div className="border-b border-[var(--border-base)] px-4 py-3 text-label-medium text-[var(--content-emphasised)]">
              Comments
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {comments.length ? (
                comments.map((comment) => (
                  <article
                    key={comment.id}
                    className="rounded-md bg-[var(--surface-base)] p-3 text-body-small-default text-[var(--content-secondary)]"
                  >
                    <p className="m-0 font-medium text-[var(--content-emphasised)]">
                      {comment.author.replace("collaborator:", "Collaborator")}
                    </p>
                    {comment.anchorText ? (
                      <p className="mb-2 mt-1 truncate text-label-small-default text-[var(--content-tertiary)]">
                        “{comment.anchorText}”
                      </p>
                    ) : null}
                    <p className="m-0">{comment.content}</p>
                  </article>
                ))
              ) : (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  No comments yet.
                </p>
              )}
            </div>
            {canComment ? (
              <div className="border-t border-[var(--border-base)] p-3">
                {selection ? (
                  <p className="mb-2 truncate text-label-small-default text-[var(--content-tertiary)]">
                    Commenting on “{selection.text}”
                  </p>
                ) : null}
                <textarea
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  placeholder="Add a comment"
                  className="min-h-20 w-full rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] p-2 text-body-small-default text-[var(--content-default)]"
                />
                <Button
                  className="mt-2 w-full"
                  variant="outlined"
                  size="compact"
                  onClick={() => void addComment()}
                  disabled={!commentText.trim()}
                  leftIcon={<MessageSquarePlus />}
                >
                  Comment
                </Button>
              </div>
            ) : (
              <p className="m-0 border-t border-[var(--border-base)] p-3 text-body-small-default text-[var(--content-tertiary)]">
                You can view this Copybook.
              </p>
            )}
          </aside>
        </div>
        {error ? (
          <p
            role="alert"
            className="m-0 border-t border-[var(--border-base)] px-4 py-2 text-body-small-default text-[var(--system-negative-strong)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    </PageShell>
  );
}
