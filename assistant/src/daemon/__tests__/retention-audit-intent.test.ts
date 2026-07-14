import { describe, expect, test } from "bun:test";

import {
  extractWebsiteUrl,
  isRetentionOnboardingWebsiteReply,
} from "../conversation-process.js";
import {
  isDirectRetentionAuditIntent,
  isRetentionAuditSubagentNotification,
  isRetentionKlaviyoConnectionIntent,
  isRetentionOnboardingIntent,
} from "../retention-audit-intent.js";

describe("isDirectRetentionAuditIntent", () => {
  test("accepts explicit user Klaviyo audit requests", () => {
    expect(
      isDirectRetentionAuditIntent(
        "Run a full Dr. Rachael Institute Klaviyo L365 deep retention audit for https://drrachaelinstitute.com.",
      ),
    ).toBe(true);
  });

  test("ignores subagent notifications so audit swarms do not restart themselves", () => {
    expect(
      isDirectRetentionAuditIntent(
        '[Subagent "audit-mqksczf7-10-final_editor_agent" - important] Noteworthy: Worklin deep retention audit for Klaviyo is complete.',
      ),
    ).toBe(false);
  });

  test("detects retention audit subagent completion notifications as internal queue events", () => {
    expect(
      isRetentionAuditSubagentNotification(
        '[Subagent "audit-mqktukz0-1-data_trust_agent" completed]\n\nUse subagent_read with subagent_id "abc" to retrieve the full output.',
      ),
    ).toBe(true);
    expect(
      isRetentionAuditSubagentNotification(
        '[Subagent "audit-mqkuwdwg-2-campaign_cadence_agent" — important] Campaign Cadence handoff is ready.',
      ),
    ).toBe(true);
    expect(
      isRetentionAuditSubagentNotification(
        '[Subagent "general-research-agent" completed]\n\nUse subagent_read with subagent_id "abc" to retrieve the full output.',
      ),
    ).toBe(false);
  });

  test("ignores internal child-agent objectives", () => {
    expect(
      isDirectRetentionAuditIntent(
        "You are the Data Trust Agent for a Worklin deep retention audit.\n\nUse only the source packet below.",
      ),
    ).toBe(false);
  });

  test("ignores memory consolidation prompts that mention prior audits", () => {
    expect(
      isDirectRetentionAuditIntent(
        "You are running memory consolidation. Prior notes mention a Dr. Rachael Klaviyo audit and retention recommendations.",
      ),
    ).toBe(false);
  });

  test("leaves conversational brand onboarding to the agent", () => {
    expect(
      isDirectRetentionAuditIntent(
        "I want to onboard a new DTC brand for retention. The site is https://drrachaelinstitute.com.",
      ),
    ).toBe(false);
    expect(
      isDirectRetentionAuditIntent(
        "Set up the Brand Brain for Dr. Rachael Institute before we run the Klaviyo audit.",
      ),
    ).toBe(false);
  });
});

describe("isRetentionOnboardingIntent", () => {
  test("accepts conversational brand onboarding with a domain", () => {
    expect(
      isRetentionOnboardingIntent(
        "Let's onboard Dr. Rachael Institute: https://drrachaelinstitute.com. Learn the brand first.",
      ),
    ).toBe(true);
  });

  test("accepts guided onboarding before the user knows what to provide", () => {
    expect(isRetentionOnboardingIntent("I want to onboard a new client.")).toBe(
      true,
    );
    expect(
      isRetentionOnboardingIntent(
        "Help me set up a new customer account for Worklin.",
      ),
    ).toBe(true);
  });

  test("does not accept generic audit requests", () => {
    expect(
      isRetentionOnboardingIntent(
        "Run a full Klaviyo L365 retention audit for Dr. Rachael Institute.",
      ),
    ).toBe(false);
  });
});

describe("isRetentionKlaviyoConnectionIntent", () => {
  test("accepts typed Klaviyo key connection requests", () => {
    expect(
      isRetentionKlaviyoConnectionIntent(
        "I want to add a different Klaviyo key. Please show the read-only Klaviyo connection card now.",
      ),
    ).toBe(true);
    expect(
      isRetentionKlaviyoConnectionIntent(
        "Klaviyo is not connected yet, open the connection card.",
      ),
    ).toBe(true);
  });

  test("accepts direct card requests even when the brand is named", () => {
    expect(
      isRetentionKlaviyoConnectionIntent(
        "Show the read-only Klaviyo connection card now for Dr. Rachael Institute. I want to add a different Klaviyo API key.",
      ),
    ).toBe(true);
  });

  test("does not steal ordinary Klaviyo audit requests", () => {
    expect(
      isRetentionKlaviyoConnectionIntent(
        "Run a full Klaviyo L365 retention audit for Dr. Rachael Institute.",
      ),
    ).toBe(false);
  });
});

describe("isRetentionOnboardingWebsiteReply", () => {
  test("accepts a standalone website after Worklin asks for the brand website", () => {
    const conversation = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "First question\n\nWhat is the brand website?\n\nPaste the URL, like yourbrand.com.",
            },
          ],
        },
      ],
    };

    expect(
      isRetentionOnboardingWebsiteReply(
        conversation as Parameters<typeof isRetentionOnboardingWebsiteReply>[0],
        "drrachaelinstitute.com",
      ),
    ).toBe(true);
  });

  test("does not treat random links as onboarding replies", () => {
    const conversation = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the report link." }],
        },
      ],
    };

    expect(
      isRetentionOnboardingWebsiteReply(
        conversation as Parameters<typeof isRetentionOnboardingWebsiteReply>[0],
        "https://example.com",
      ),
    ).toBe(false);
  });
});

describe("extractWebsiteUrl", () => {
  test("normalizes bare brand domains during onboarding", () => {
    expect(extractWebsiteUrl("drrachaelinstitute.com")).toBe(
      "https://drrachaelinstitute.com",
    );
    expect(extractWebsiteUrl("https://drrachaelinstitute.com.")).toBe(
      "https://drrachaelinstitute.com",
    );
  });
});
