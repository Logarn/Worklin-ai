import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CopybookMonth } from "../copybook-api";
import { CopybookStatusBar } from "./copybook-status-bar";

const MONTH: CopybookMonth = {
  id: "month-8",
  copybookId: "copybook-1",
  month: 8,
  documentSurfaceId: "document-8",
  strategyStatus: "in_review",
  createdAt: 1,
  updatedAt: 1,
  campaigns: [],
};

afterEach(cleanup);

describe("CopybookStatusBar", () => {
  test("lets a human approve the current artifact stage", () => {
    const onApprove = mock(() => {});
    render(
      <CopybookStatusBar
        title="Campaign Copybook"
        year={2026}
        month={MONTH}
        approvalLabel="Approve strategy"
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve strategy" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  test("blocks approval while unresolved comments remain", () => {
    render(
      <CopybookStatusBar
        title="Campaign Copybook"
        year={2026}
        month={MONTH}
        approvalLabel="Approve strategy"
        blockingCommentCount={2}
        onApprove={() => {}}
      />,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Approve strategy",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Resolve 2 open comments to approve")).toBeTruthy();
  });
});
