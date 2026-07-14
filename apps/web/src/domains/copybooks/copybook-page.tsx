import { Loader2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { routes } from "@/utils/routes";

import { CopybookWorkspace } from "./components/copybook-workspace";
import { useCopybookData } from "./use-copybook-data";

export function CopybookPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { copybookId = "", year = "", month = "" } = useParams<{
    copybookId: string;
    year: string;
    month: string;
  }>();
  const selectedYear = Number(year);
  const selectedMonth = Number(month);
  const {
    data: copybook,
    isLoading,
    error,
  } = useCopybookData(assistantId, copybookId);
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();

  useEffect(() => {
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        Campaign Copybook
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [setTopBarCenter]);

  const handleSelectMonth = useCallback(
    (nextMonth: number) => {
      void navigate(routes.copybooks.month(copybookId, selectedYear, nextMonth));
    },
    [copybookId, navigate, selectedYear],
  );

  if (isLoading) {
    return (
      <PageShell className="items-center justify-center p-0">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }

  if (error || !copybook || copybook.copybook.year !== selectedYear) {
    return (
      <PageShell className="items-center justify-center p-0 text-body-small-default text-[var(--content-tertiary)]">
        Copybook not found.
      </PageShell>
    );
  }

  const activeMonth = copybook.months.find(
    (item) => item.month === selectedMonth,
  );
  if (!activeMonth) {
    return (
      <PageShell className="items-center justify-center p-0 text-body-small-default text-[var(--content-tertiary)]">
        This month has not been created in the copybook yet.
      </PageShell>
    );
  }

  return (
    <PageShell className="overflow-hidden p-0">
      <CopybookWorkspace
        assistantId={assistantId}
        copybook={copybook}
        month={activeMonth}
        onSelectMonth={handleSelectMonth}
      />
    </PageShell>
  );
}
