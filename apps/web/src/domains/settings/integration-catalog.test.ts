import { describe, expect, test } from "bun:test";

import {
  assistantSupportsAdvancedOAuthSetup,
  customerOAuthProviders,
  customerOAuthProvidersWithHostedFallbacks,
  groupOAuthProvidersBySetup,
  hasHostedManagedOAuth,
  oauthProviderMatchesConnectionFilter,
  resolveOAuthProviderDeepLink,
  type OAuthProvider,
} from "./integration-catalog";

function provider(
  providerKey: string,
  overrides: Partial<OAuthProvider> = {},
): OAuthProvider {
  return {
    provider_key: providerKey,
    display_name: providerKey,
    description: null,
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: true,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
    ...overrides,
  };
}

const BUILT_IN_OAUTH_CATALOG = [
  ["google", "Google", "Gmail, Calendar, Drive, and Contacts"],
  ["slack", "Slack", "Workspace messaging"],
  ["notion", "Notion", "Pages and databases"],
  ["twitter", "X (Twitter)", "Posts and account activity"],
  ["github", "GitHub", "Repositories and issues"],
  ["linear", "Linear", "Issues and projects"],
  ["spotify", "Spotify", "Music and playlists"],
  ["todoist", "Todoist", "Tasks and projects"],
  ["discord", "Discord", "Servers and messages"],
  ["dropbox", "Dropbox", "Files and folders"],
  ["asana", "Asana", "Tasks and projects"],
  ["airtable", "Airtable", "Bases and records"],
  ["hubspot", "HubSpot", "CRM contacts and deals"],
  ["salesforce", "Salesforce", "CRM contacts, leads, and opportunities"],
  ["figma", "Figma", "Design files and comments"],
  ["outlook", "Outlook / Microsoft", "Email and calendar"],
] as const;

describe("customer integration catalog", () => {
  test("keeps OAuth providers and leaves manual-token tools to their own setup", () => {
    expect(
      customerOAuthProviders([
        provider("google"),
        provider("github"),
        provider("airtable"),
        provider("sanity"),
        provider("slack_channel"),
        provider("telegram"),
      ]).map((item) => item.provider_key),
    ).toEqual(["google", "github", "airtable"]);
  });

  test("advertises hosted managed OAuth only where the platform supports it", () => {
    expect(hasHostedManagedOAuth("google")).toBe(true);
    for (const providerKey of [
      "github",
      "linear",
      "notion",
      "outlook",
      "slack",
    ]) {
      expect(hasHostedManagedOAuth(providerKey)).toBe(false);
    }
  });

  test("keeps every built-in OAuth provider visible without a runtime catalog", () => {
    const catalog = customerOAuthProvidersWithHostedFallbacks(undefined);

    expect(
      catalog.map(({ provider_key, display_name, description }) => [
        provider_key,
        display_name,
        description,
      ]),
    ).toEqual(BUILT_IN_OAUTH_CATALOG.map((entry) => [...entry]));
    expect(
      catalog
        .filter((item) => item.supports_managed_mode)
        .map((item) => item.provider_key),
    ).toEqual(["google"]);
  });

  test("preserves runtime metadata and removes duplicate providers", () => {
    const runtimeGitHub = provider("github", {
      display_name: "GitHub Enterprise",
      description: "Live runtime metadata",
      dashboard_url: "https://github.example.test/settings",
      logo_url: "https://github.example.test/logo.svg",
    });
    const catalog = customerOAuthProvidersWithHostedFallbacks([
      runtimeGitHub,
      provider("github", { display_name: "Duplicate GitHub" }),
      provider("google"),
      provider("sanity"),
      provider("slack_channel"),
      provider("telegram"),
    ]);

    expect(catalog.map((item) => item.provider_key)).toEqual(
      BUILT_IN_OAUTH_CATALOG.map(([providerKey]) => providerKey),
    );
    expect(catalog.filter((item) => item.provider_key === "github")).toEqual([
      runtimeGitHub,
    ]);
  });

  test("fails advanced credential setup closed unless the runtime is known isolated", () => {
    expect(assistantSupportsAdvancedOAuthSetup(undefined)).toBe(false);
    for (const runtimeProvider of [
      null,
      "legacy_shared",
      "pooled_worker",
      "concurrent_service",
      "static_template",
    ]) {
      expect(
        assistantSupportsAdvancedOAuthSetup({
          isLocal: false,
          runtimeProvider,
        }),
      ).toBe(false);
    }
    for (const runtimeProvider of ["railway", "preprovisioned"]) {
      expect(
        assistantSupportsAdvancedOAuthSetup({
          isLocal: false,
          runtimeProvider,
        }),
      ).toBe(true);
    }
    expect(
      assistantSupportsAdvancedOAuthSetup({
        isLocal: true,
        runtimeProvider: undefined,
      }),
    ).toBe(true);
  });

  test("keeps developer-app connections out of the simple primary list", () => {
    const grouped = groupOAuthProvidersBySetup([
      provider("google"),
      provider("github"),
      provider("slack"),
    ]);

    expect(grouped.primary.map((item) => item.provider_key)).toEqual([
      "google",
    ]);
    expect(grouped.advanced.map((item) => item.provider_key)).toEqual([
      "github",
      "slack",
    ]);
  });

  test("does not pretend unknown advanced connection state is enabled or disabled", () => {
    expect(
      oauthProviderMatchesConnectionFilter("github", false, false, "all"),
    ).toBe(true);
    expect(
      oauthProviderMatchesConnectionFilter(
        "github",
        false,
        false,
        "not-enabled",
      ),
    ).toBe(false);
    expect(
      oauthProviderMatchesConnectionFilter("github", true, true, "enabled"),
    ).toBe(false);
    expect(
      oauthProviderMatchesConnectionFilter("google", true, true, "enabled"),
    ).toBe(true);
    expect(
      oauthProviderMatchesConnectionFilter(
        "google",
        false,
        true,
        "not-enabled",
      ),
    ).toBe(true);
  });

  test("does not classify a hosted connection while its status is unavailable", () => {
    expect(
      oauthProviderMatchesConnectionFilter("google", false, false, "enabled"),
    ).toBe(false);
    expect(
      oauthProviderMatchesConnectionFilter(
        "google",
        false,
        false,
        "not-enabled",
      ),
    ).toBe(false);
    expect(
      oauthProviderMatchesConnectionFilter("google", false, false, "all"),
    ).toBe(true);
  });

  test("resolves friendly deep links to the provider that owns the connection", () => {
    expect(resolveOAuthProviderDeepLink("gmail")).toBe("google");
    expect(resolveOAuthProviderDeepLink("calendar")).toBe("google");
    expect(resolveOAuthProviderDeepLink("microsoft")).toBe("outlook");
    expect(resolveOAuthProviderDeepLink("linear")).toBe("linear");
  });
});
