import { Button, Typography } from "@vellumai/design-library";
import { Check, Loader2 } from "lucide-react";

import type { CopybookMonth } from "../copybook-api";
import { CopybookStatus } from "../copybook-status";

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
] as const;

export function CopybookStatusBar({
  title,
  year,
  month,
  approvalLabel,
  approvalPending = false,
  blockingCommentCount = 0,
  onApprove,
}: {
  title: string;
  year: number;
  month: CopybookMonth;
  approvalLabel?: string | null;
  approvalPending?: boolean;
  blockingCommentCount?: number;
  onApprove?: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border-base)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <Typography
          variant="title-small"
          className="truncate text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
        <Typography
          variant="label-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {MONTH_NAMES[month.month - 1]} {year}
        </Typography>
      </div>
      <CopybookStatus status={month.strategyStatus} />
      {blockingCommentCount > 0 ? (
        <Typography
          variant="label-small-default"
          className="text-[var(--content-tertiary)]"
        >
          Resolve {blockingCommentCount} open{" "}
          {blockingCommentCount === 1 ? "comment" : "comments"} to approve
        </Typography>
      ) : null}
      {approvalLabel && onApprove ? (
        <Button
          variant="primary"
          size="compact"
          leftIcon={
            approvalPending ? <Loader2 className="animate-spin" /> : <Check />
          }
          disabled={approvalPending || blockingCommentCount > 0}
          onClick={onApprove}
        >
          {approvalPending ? "Approving…" : approvalLabel}
        </Button>
      ) : null}
    </div>
  );
}
