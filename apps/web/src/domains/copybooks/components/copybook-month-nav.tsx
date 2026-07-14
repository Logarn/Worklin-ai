import { Button, Tag, Typography, cn } from "@vellumai/design-library";
import { CalendarDays } from "lucide-react";

import type { CopybookMonth } from "../copybook-api";
import { CampaignOutlineItem } from "./campaign-outline-item";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function CopybookMonthNav({
  year,
  months,
  selectedMonth,
  onSelectMonth,
}: {
  year: number;
  months: CopybookMonth[];
  selectedMonth: number;
  onSelectMonth: (month: number) => void;
}) {
  const monthsByNumber = new Map(months.map((month) => [month.month, month]));
  const active = monthsByNumber.get(selectedMonth);

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col border-r border-[var(--border-base)] bg-[var(--surface-base)]"
      aria-label={`${year} copybook months`}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border-base)] px-4 py-3">
        <CalendarDays size={16} className="text-[var(--content-secondary)]" />
        <Typography variant="title-small" className="text-[var(--content-emphasised)]">
          {year} Copybook
        </Typography>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Months">
        <ul className="flex flex-col gap-1">
          {MONTH_NAMES.map((name, index) => {
            const monthNumber = index + 1;
            const month = monthsByNumber.get(monthNumber);
            const selected = monthNumber === selectedMonth;
            return (
              <li key={name}>
                <Button
                  variant="ghost"
                  size="regular"
                  className={cn(
                    "w-full justify-start",
                    selected && "bg-[var(--surface-active)]",
                  )}
                  disabled={!month}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => month && onSelectMonth(monthNumber)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                  {month ? <Tag tone="neutral">{month.campaigns.length}</Tag> : null}
                </Button>
              </li>
            );
          })}
        </ul>

        {active?.campaigns.length ? (
          <section
            className="mt-5 border-t border-[var(--border-base)] pt-4"
            aria-labelledby="campaign-outline-title"
          >
            <Typography
              id="campaign-outline-title"
              variant="label-small-default"
              className="mb-2 px-1 uppercase tracking-wide text-[var(--content-tertiary)]"
            >
              Campaigns
            </Typography>
            <ul className="flex flex-col gap-2">
              {[...active.campaigns]
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((campaign) => (
                  <CampaignOutlineItem key={campaign.id} campaign={campaign} />
                ))}
            </ul>
          </section>
        ) : null}
      </nav>
    </aside>
  );
}
