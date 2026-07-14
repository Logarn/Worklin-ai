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
        title: "New Year launch",
        status: "approved",
        packageId: null,
        metadata: null,
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
    const campaignNames = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent)
      .filter(
        (text) =>
          text?.includes("New Year launch") || text?.includes("Follow-up"),
      );
    expect(campaignNames).toEqual([
      "1. New Year launchApproved",
      "2. Follow-upCopy draft",
    ]);
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
