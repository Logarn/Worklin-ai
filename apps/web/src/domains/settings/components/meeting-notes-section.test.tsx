import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import {
  filterMeetingSources,
  MEETING_SOURCES,
  MeetingNotesSection,
} from "./meeting-notes-section";

afterEach(cleanup);

describe("MeetingNotesSection", () => {
  test("catalogs every meeting app without exposing a fake connection action", () => {
    expect(MEETING_SOURCES).toHaveLength(20);
    expect(filterMeetingSources("", "enabled")).toEqual([]);
    expect(filterMeetingSources("", "not-enabled")).toEqual([]);

    render(<MeetingNotesSection sources={filterMeetingSources("", "all")} />);

    expect(screen.getByRole("region", { name: "Meeting notes" })).toBeTruthy();
    expect(screen.getByLabelText("Meeting note apps")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /connect|enable/iu }),
    ).toBeNull();
  });

  test("shows honest stages without present-tense sync or action claims", () => {
    render(
      <MeetingNotesSection
        sources={filterMeetingSources("", "all")}
        searchActive
      />,
    );
    const list = within(
      screen.getByRole("list", { name: "Meeting note connections" }),
    );

    const fathomStatus = list.getByLabelText("Fathom status: In development");
    expect(fathomStatus).toBeTruthy();
    expect(fathomStatus.className.split(/\s+/u)).not.toContain("hidden");
    expect(
      list.getByLabelText("Fireflies status: In development"),
    ).toBeTruthy();
    expect(list.getByLabelText("Granola status: Planned")).toBeTruthy();
    expect(list.getByLabelText("Otter status: Planned")).toBeTruthy();
    expect(
      list.getByLabelText(
        "Microsoft Teams status: Planned · admin setup required",
      ),
    ).toBeTruthy();

    for (const claim of [
      "Updates automatically",
      "Checked periodically",
      "Ask on demand",
      "Automatic updates planned",
      "On-demand access planned",
      "Team setup required",
    ]) {
      expect(list.queryByText(claim)).toBeNull();
    }
  });

  test("searches the catalog and opens the group while searching", () => {
    render(
      <MeetingNotesSection
        sources={filterMeetingSources("Zoom", "all")}
        searchActive
      />,
    );

    expect(screen.getAllByText("Zoom").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fathom")).toBeNull();
    expect(
      screen
        .getByLabelText("Meeting note apps")
        .closest("details")
        ?.hasAttribute("open"),
    ).toBe(true);
  });
});
