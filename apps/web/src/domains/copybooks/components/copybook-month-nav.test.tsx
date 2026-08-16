import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CopybookMonth } from "../copybook-api";
import { CopybookMonthNav } from "./copybook-month-nav";

const MONTHS: CopybookMonth[] = [
  {
    id: "month-1",
    copybookId: "copybook-1",
    month: 1,
    documentSurfaceId: "document-1",
    strategyStatus: "in_review",
    createdAt: 1,
    updatedAt: 1,
    campaigns: [
      {
        id: "campaign-2",
        monthId: "month-1",
        channel: "sms",
        ordinal: 2,
        title: "Follow-up",
        status: "copy_draft",
        packageId: null,
        metadata: null,
        createdAt: 1,
        updatedAt: 1,
        workItems: [],
      },
      {
        id: "campaign-1",
        monthId: "month-1",
        channel: "email",
        ordinal: 1,
        title: "Recent browsers - Help interested non-buyers choose",
        status: "approved",
        packageId: null,
        metadata: {
          source: "retention_segment_run",
          microSegmentName: "Recent browsers without a purchase",
          campaignAngle: "Reduce choice friction with a short product guide.",
          eligibleCount: 108,
          sampleCount: 2,
          draftSubjects: ["A simpler way to choose", "Start with what fits"],
          representativeMessages: [
            {
              subject: "A simpler way to choose",
              body: "If you were comparing options, start with the product that fits your current routine.",
            },
          ],
        },
        createdAt: 1,
        updatedAt: 1,
        workItems: [],
      },
    ],
  },
  {
    id: "month-2",
    copybookId: "copybook-1",
    month: 2,
    documentSurfaceId: "document-2",
    strategyStatus: "draft",
    createdAt: 1,
    updatedAt: 1,
    campaigns: [],
  },
];

afterEach(cleanup);

describe("CopybookMonthNav", () => {
  test("shows the annual month list and selected month's ordered campaign outline", () => {
    render(
      <CopybookMonthNav
        year={2026}
        months={MONTHS}
        selectedMonth={1}
        onSelectMonth={() => {}}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Months" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /January/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      (screen.getByRole("button", { name: /March/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const campaignRows = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent)
      .filter(
        (text) =>
          text?.includes("Recent browsers") || text?.includes("Follow-up"),
      );
    expect(campaignRows).toEqual([
      expect.stringContaining(
        "1. Recent browsers - Help interested non-buyers choose",
      ),
      "2. Follow-upCopy draft",
    ]);
    expect(campaignRows[0]).toContain(
      "Segment: Recent browsers without a purchase",
    );
    expect(campaignRows[0]).toContain(
      "Angle: Reduce choice friction with a short product guide.",
    );
    expect(campaignRows[0]).toContain("108 eligible");
    expect(campaignRows[0]).toContain("2 drafts");
    expect(campaignRows[0]).toContain(
      "Subjects: A simpler way to choose / Start with what fits",
    );
    expect(campaignRows[0]).toContain(
      "Copy: If you were comparing options, start with the product that fits your current routine.",
    );
  });

  test("selects an available month", () => {
    const onSelectMonth = mock((_month: number) => {});
    render(
      <CopybookMonthNav
        year={2026}
        months={MONTHS}
        selectedMonth={1}
        onSelectMonth={onSelectMonth}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /February/ }));
    expect(onSelectMonth).toHaveBeenCalledWith(2);
  });
});
