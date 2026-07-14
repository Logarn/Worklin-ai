import type { CopybookDetail } from "./copybook-api";

import { routes } from "@/utils/routes";

export function getCopybookDestination(
  detail: CopybookDetail | undefined,
): string | null {
  if (!detail) return null;

  const firstMonth = detail.months.reduce<number | null>(
    (earliest, item) =>
      earliest === null || item.month < earliest ? item.month : earliest,
    null,
  );

  return firstMonth === null
    ? null
    : routes.copybooks.month(
        detail.copybook.id,
        detail.copybook.year,
        firstMonth,
      );
}

export function copybookStartPrompt(title?: string): string {
  return title
    ? `Set up the monthly strategy and first campaign brief for "${title}". Stop for my review before writing campaign copy.`
    : "Help me create a Campaign Copybook for my brand. Start by gathering the monthly strategy inputs, then stop for my review.";
}
