import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { openSlackInvite } from "@/hooks/use-slack-nudge";
import { WORKLIN_SLACK_INVITE_URL } from "@/utils/external-urls";

afterEach(() => {
  mock.restore();
});

describe("Slack community nudge", () => {
  test("opens the private beta Slack invite", () => {
    const openSpy = spyOn(window, "open").mockImplementation(() => null);

    openSlackInvite();

    expect(WORKLIN_SLACK_INVITE_URL).toBe(
      "https://join.slack.com/share/enQtMTE3NDIwMzI5NzQ5NzktZmJiYmQyZjdmOGFhZTk3ODY5NmIyODFhMDQ3M2M0MDYxNzUxODM0Y2M1YTYwMDBlY2U5NDg1ZmZlZDA5NmE2MQ",
    );
    expect(openSpy).toHaveBeenCalledWith(
      WORKLIN_SLACK_INVITE_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });
});
