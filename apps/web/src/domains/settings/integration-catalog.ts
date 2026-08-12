import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";

export type OAuthProvider =
  OauthProvidersGetResponses[200]["providers"][number];
export type IntegrationFilter = "all" | "enabled" | "not-enabled";

const MANUAL_TOKEN_PROVIDER_KEYS = new Set([
  "sanity",
  "slack_channel",
  "telegram",
]);

const HOSTED_MANAGED_OAUTH_PROVIDER_KEYS = new Set(["google"]);

function fallbackOAuthProvider(
  providerKey: string,
  displayName: string,
  description: string,
): OAuthProvider {
  return {
    provider_key: providerKey,
    display_name: displayName,
    description,
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: true,
    logo_url: null,
    supports_managed_mode: hasHostedManagedOAuth(providerKey),
    managed_service_is_paid: false,
    feature_flag: null,
  };
}

const CUSTOMER_PROVIDER_FALLBACKS: readonly OAuthProvider[] = [
  fallbackOAuthProvider(
    "google",
    "Google",
    "Gmail, Calendar, Drive, and Contacts",
  ),
  fallbackOAuthProvider("slack", "Slack", "Workspace messaging"),
  fallbackOAuthProvider("notion", "Notion", "Pages and databases"),
  fallbackOAuthProvider("twitter", "X (Twitter)", "Posts and account activity"),
  fallbackOAuthProvider("github", "GitHub", "Repositories and issues"),
  fallbackOAuthProvider("linear", "Linear", "Issues and projects"),
  fallbackOAuthProvider("spotify", "Spotify", "Music and playlists"),
  fallbackOAuthProvider("todoist", "Todoist", "Tasks and projects"),
  fallbackOAuthProvider("discord", "Discord", "Servers and messages"),
  fallbackOAuthProvider("dropbox", "Dropbox", "Files and folders"),
  fallbackOAuthProvider("asana", "Asana", "Tasks and projects"),
  fallbackOAuthProvider("airtable", "Airtable", "Bases and records"),
  fallbackOAuthProvider("hubspot", "HubSpot", "CRM contacts and deals"),
  fallbackOAuthProvider(
    "salesforce",
    "Salesforce",
    "CRM contacts, leads, and opportunities",
  ),
  fallbackOAuthProvider("figma", "Figma", "Design files and comments"),
  fallbackOAuthProvider("outlook", "Outlook / Microsoft", "Email and calendar"),
] as const;

const PROVIDER_DEEP_LINK_ALIASES: Record<string, string> = {
  calendar: "google",
  drive: "google",
  gmail: "google",
  microsoft: "outlook",
};

/**
 * Providers that belong in the customer OAuth catalog. Manual-token tools
 * have their own, more appropriate setup surfaces elsewhere in Settings.
 */
export function customerOAuthProviders(
  providers: OAuthProvider[] | undefined,
): OAuthProvider[] {
  return (
    providers?.filter(
      (provider) => !MANUAL_TOKEN_PROVIDER_KEYS.has(provider.provider_key),
    ) ?? []
  );
}

/**
 * Customer-facing OAuth discovery must not depend on assistant-local
 * credential routes. Managed runtimes deliberately block those routes, so
 * retain a static catalog while preferring any richer runtime metadata that
 * is available.
 */
export function customerOAuthProvidersWithHostedFallbacks(
  providers: OAuthProvider[] | undefined,
): OAuthProvider[] {
  const customerProviders = customerOAuthProviders(providers);
  const dynamicProvidersByKey = new Map<string, OAuthProvider>();
  for (const provider of customerProviders) {
    if (!dynamicProvidersByKey.has(provider.provider_key)) {
      dynamicProvidersByKey.set(provider.provider_key, provider);
    }
  }

  const fallbackKeys = new Set(
    CUSTOMER_PROVIDER_FALLBACKS.map((provider) => provider.provider_key),
  );
  return [
    ...CUSTOMER_PROVIDER_FALLBACKS.map(
      (fallback) =>
        dynamicProvidersByKey.get(fallback.provider_key) ?? fallback,
    ),
    ...Array.from(dynamicProvidersByKey.values()).filter(
      (provider) => !fallbackKeys.has(provider.provider_key),
    ),
  ];
}

export interface OAuthRuntimeIdentity {
  isLocal: boolean;
  runtimeProvider?: string | null;
}

/**
 * Runtime-owned OAuth credentials are safe only on a positively identified
 * local or isolated assistant. Unknown and shared runtimes fail closed.
 */
export function assistantSupportsAdvancedOAuthSetup(
  assistant: OAuthRuntimeIdentity | null | undefined,
): boolean {
  if (!assistant) return false;
  if (assistant.isLocal) return true;
  return (
    assistant.runtimeProvider === "railway" ||
    assistant.runtimeProvider === "preprovisioned"
  );
}

/**
 * This is deliberately narrower than the assistant schema's
 * `supports_managed_mode` flag. It represents what the Worklin hosted control
 * plane can actually start today, not what a dedicated runtime could be
 * configured to understand.
 */
export function hasHostedManagedOAuth(providerKey: string): boolean {
  return HOSTED_MANAGED_OAUTH_PROVIDER_KEYS.has(providerKey);
}

export function groupOAuthProvidersBySetup(providers: OAuthProvider[]): {
  primary: OAuthProvider[];
  advanced: OAuthProvider[];
} {
  return {
    primary: providers.filter((provider) =>
      hasHostedManagedOAuth(provider.provider_key),
    ),
    advanced: providers.filter(
      (provider) => !hasHostedManagedOAuth(provider.provider_key),
    ),
  };
}

export function resolveOAuthProviderDeepLink(providerKey: string): string {
  return PROVIDER_DEEP_LINK_ALIASES[providerKey] ?? providerKey;
}

/**
 * Developer-app OAuth connections are stored in the assistant runtime, while
 * the Settings summary receives only hosted-connection state. Keep these
 * providers visible under All, but do not misclassify them as enabled or not
 * enabled until a unified status endpoint exists.
 */
export function oauthProviderMatchesConnectionFilter(
  providerKey: string,
  connected: boolean,
  statusKnown: boolean,
  filter: IntegrationFilter,
): boolean {
  if (filter === "all") return true;
  if (!hasHostedManagedOAuth(providerKey)) return false;
  if (!statusKnown) return false;
  return filter === "enabled" ? connected : !connected;
}
