import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SlackNudgeBanner } from "@/components/nudges/slack-nudge-banner";

describe("SlackNudgeBanner", () => {
  test("describes the limited invite-only beta", () => {
    const html = renderToStaticMarkup(
      <SlackNudgeBanner onJoin={() => {}} onDismiss={() => {}} />,
    );

    expect(html).toContain("Join our private beta Slack");
    expect(html).toContain("Invite-only");
    expect(html).toContain("small group of beta testers");
    expect(html).toContain("Join Slack");
    expect(html).not.toContain("Discord");
  });
});
