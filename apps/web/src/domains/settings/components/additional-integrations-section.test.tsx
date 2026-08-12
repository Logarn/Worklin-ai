import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import {
  ADDITIONAL_INTEGRATIONS,
  AdditionalIntegrationsSection,
  filterAdditionalIntegrations,
} from "./additional-integrations-section";

afterEach(cleanup);

describe("additional integrations", () => {
  test("lists every specialist integration without inventing one shared connection state", () => {
    expect(
      ADDITIONAL_INTEGRATIONS.map((integration) => integration.id),
    ).toEqual([
      "slack_channel",
      "telegram",
      "twilio",
      "worklin_email",
      "whatsapp",
      "vercel",
      "sanity",
      "worklin_a2a",
      "custom_mcp",
      "web_search",
      "trendtrack",
      "meld",
      "instagram",
      "facebook",
      "linkedin",
      "youtube",
    ]);
    expect(filterAdditionalIntegrations("", "all")).toHaveLength(16);
    expect(filterAdditionalIntegrations("", "enabled")).toEqual([]);
    expect(filterAdditionalIntegrations("", "not-enabled")).toEqual([]);
  });

  test("searches names, descriptions, and setup labels", () => {
    expect(
      filterAdditionalIntegrations("Twilio number", "all").map(
        (integration) => integration.id,
      ),
    ).toEqual(["twilio"]);
    expect(
      filterAdditionalIntegrations("in development", "all").map(
        (integration) => integration.id,
      ),
    ).toEqual([
      "sanity",
      "meld",
      "instagram",
      "facebook",
      "linkedin",
      "youtube",
    ]);
  });

  test("routes setup actions to their real product surfaces", () => {
    const actions: string[] = [];
    render(
      <AdditionalIntegrationsSection
        integrations={[
          ADDITIONAL_INTEGRATIONS[0]!,
          ADDITIONAL_INTEGRATIONS[3]!,
          ADDITIONAL_INTEGRATIONS[9]!,
        ]}
        onOpen={(action) => actions.push(action)}
        dedicatedSetupAvailable
        searchActive
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open channels for Slack messages",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Manage for Email",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Custom setup for Web search",
      }),
    );
    expect(actions).toEqual([
      "contacts",
      "email_settings",
      "web_search_settings",
    ]);
    expect(screen.getByLabelText("Messaging and calls")).toBeTruthy();
    expect(screen.getByLabelText("Research sources")).toBeTruthy();
  });

  test("disables dedicated channel setup on unsupported runtimes and leaves A2A informational", () => {
    const actions: string[] = [];
    const integrations = ADDITIONAL_INTEGRATIONS.filter((integration) =>
      [
        "slack_channel",
        "telegram",
        "twilio",
        "worklin_a2a",
        "web_search",
        "trendtrack",
      ].includes(integration.id),
    );

    render(
      <AdditionalIntegrationsSection
        integrations={integrations}
        onOpen={(action) => actions.push(action)}
        dedicatedSetupAvailable={false}
        searchActive
      />,
    );

    for (const name of [
      "Open channels for Slack messages",
      "Open channels for Telegram",
      "Open channels for Phone calls",
      "Custom setup for Web search",
    ]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }

    expect(
      screen.queryByRole("button", {
        name: /Other Worklin assistants/iu,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Market Intelligence/iu,
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Open contacts" })).toBeNull();
    expect(actions).toEqual([]);
  });

  test("keeps every release-stage label visible at all viewport sizes", () => {
    const view = render(
      <AdditionalIntegrationsSection
        integrations={[...ADDITIONAL_INTEGRATIONS]}
        onOpen={() => {}}
        dedicatedSetupAvailable
        searchActive
      />,
    );

    for (const integration of ADDITIONAL_INTEGRATIONS) {
      const title = screen.getByText(integration.displayName);
      const row = title.closest('[role="listitem"]');
      expect(row).toBeTruthy();
      const status = within(row as HTMLElement).getByText(
        integration.statusLabel,
      );
      expect(status.classList.contains("hidden")).toBe(false);
    }

    expect(view.container.querySelector("span.hidden")).toBeNull();
  });
});
