import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { FarmRecord } from "./farm-record-model";
import { FarmOperationsPage } from "./farm-operations-page";

const RECORDS: FarmRecord[] = [
  {
    artifactId: "farm_record:example-farm:feed-order",
    brandId: "example-farm",
    recordId: "feed-order",
    title: "Grower feed order",
    reference: "PO-1042",
    category: "Purchases",
    recordType: "Purchase order",
    status: "Short delivery open",
    summary: "The counted delivery is 50 kg short.",
    attentionLevel: "action",
    amount: "KSh 73,100",
    details: [{ label: "Received", value: "1,450 kg" }],
    activity: [
      {
        at: "2026-10-07T07:00:00.000Z",
        label: "Shortage recorded",
        state: "current",
      },
    ],
    createdAt: 1_791_358_200_000,
    updatedAt: 1_791_358_200_000,
  },
  {
    artifactId: "farm_record:example-farm:weight-sample",
    brandId: "example-farm",
    recordId: "weight-sample",
    title: "House 2 weight sample",
    reference: "OBS-H2-1007",
    category: "Production",
    recordType: "Production record",
    status: "Verified",
    summary: "The thirty-bird sample averaged 1.58 kg.",
    attentionLevel: "watch",
    details: [{ label: "Average", value: "1.58 kg" }],
    activity: [],
    createdAt: 1_791_358_100_000,
    updatedAt: 1_791_358_100_000,
  },
];

afterEach(cleanup);

describe("FarmOperationsPage", () => {
  test("filters persisted records and opens their traceable detail", () => {
    render(
      <MemoryRouter>
        <FarmOperationsPage
          brandName="Example Farm"
          records={RECORDS}
          hasPartialError={false}
          filesHref="/assistant/work/brands/example-farm/artifacts?view=files"
          onAskWorklin={() => {}}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("1 item needs a decision or follow-up"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Files & documents" })
        .getAttribute("href"),
    ).toBe("/assistant/work/brands/example-farm/artifacts?view=files");
    fireEvent.click(screen.getByRole("tab", { name: /Production 1/ }));
    const records = screen.getByRole("region", { name: "Farm records" });
    expect(within(records).getByText("House 2 weight sample")).toBeTruthy();
    expect(within(records).queryByText("Grower feed order")).toBeNull();

    fireEvent.click(
      within(records).getByRole("button", { name: /House 2 weight sample/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "House 2 weight sample" }),
    ).toBeTruthy();
    expect(screen.getByText("1.58 kg")).toBeTruthy();
  });

  test("hands the current farm and record back to the real conversation", () => {
    const onAskWorklin = mock((_prompt: string) => {});
    render(
      <MemoryRouter>
        <FarmOperationsPage
          brandName="Example Farm"
          records={RECORDS}
          hasPartialError={false}
          filesHref="/assistant/work/brands/example-farm/artifacts?view=files"
          onAskWorklin={onAskWorklin}
        />
      </MemoryRouter>,
    );

    const records = screen.getByRole("region", { name: "Farm records" });
    fireEvent.click(
      within(records).getByRole("button", { name: /Grower feed order/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review with Worklin" }),
    );

    expect(onAskWorklin).toHaveBeenCalledTimes(1);
    expect(onAskWorklin.mock.calls[0]?.[0]).toContain("PO-1042");
    expect(onAskWorklin.mock.calls[0]?.[0]).toContain(
      "pending work as complete",
    );
  });
});
