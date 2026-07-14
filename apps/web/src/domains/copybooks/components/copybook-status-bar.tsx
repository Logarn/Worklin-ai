import { Typography } from "@vellumai/design-library";

import type { CopybookMonth } from "../copybook-api";
import { CopybookStatus } from "../copybook-status";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function CopybookStatusBar({
  title,
  year,
  month,
}: {
  title: string;
  year: number;
  month: CopybookMonth;
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
    </div>
  );
}
