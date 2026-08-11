import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2, Search, Sparkles } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useNavigate, useSearchParams } from "react-router";

import {
  AdditionalIntegrationsSection,
  filterAdditionalIntegrations,
} from "@/domains/settings/components/additional-integrations-section";
import { IntegrationDetailModal } from "@/domains/settings/components/integration-detail-modal";
import { IntegrationRow } from "@/domains/settings/components/integration-row";
import {
  isKlaviyoConnected,
  KlaviyoIntegrationModal,
  KlaviyoIntegrationRow,
} from "@/domains/settings/components/klaviyo-integration";
import {
  filterMeetingSources,
  MeetingNotesSection,
} from "@/domains/settings/components/meeting-notes-section";
import { useKlaviyoIntegration } from "@/domains/settings/hooks/use-klaviyo-integration";
import {
  assistantSupportsAdvancedOAuthSetup,
  customerOAuthProvidersWithHostedFallbacks,
  groupOAuthProvidersBySetup,
  hasHostedManagedOAuth,
  type IntegrationFilter,
  oauthProviderMatchesConnectionFilter,
  resolveOAuthProviderDeepLink,
} from "@/domains/settings/integration-catalog";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Popover } from "@vellumai/design-library/components/popover";

import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

const BANNER_STORAGE_KEY = "vellum:integrations:bannerDismissed";

const FILTER_OPTIONS: Array<{ value: IntegrationFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "not-enabled", label: "Not Enabled" },
];

function connectionForProvider(
  connections: OAuthConnection[] | undefined,
  providerKey: string,
): OAuthConnection | null {
  return connections?.find((c) => c.provider === providerKey) ?? null;
}

function IntegrationsPanelInner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const activeAssistantIsPlatformHosted = useActiveAssistantIsPlatformHosted();
  const klaviyo = useKlaviyoIntegration(assistantId);
  const activeAssistant = assistants.find(
    (assistant) => assistant.id === assistantId,
  );
  const advancedSetupAvailable =
    assistantSupportsAdvancedOAuthSetup(activeAssistant);
  const hostedManagedOAuthAvailable =
    platformGate === "full" && activeAssistantIsPlatformHosted;

  const [searchText, setSearchText] = useState("");
  const [selectedFilter, setSelectedFilter] =
    useState<IntegrationFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  const [bannerDismissed, setBannerDismissed] = useState(true);
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    null,
  );

  // Hydrate banner dismissal from localStorage on mount.
  useEffect(() => {
    setBannerDismissed(getLocalSetting(BANNER_STORAGE_KEY, "false") === "true");
  }, []);

  const dismissBanner = () => {
    setBannerDismissed(true);
    setLocalSetting(BANNER_STORAGE_KEY, "true");
  };

  const {
    data: providers,
    isLoading: providersLoading,
    isError: providersError,
  } = useQuery({
    ...oauthProvidersGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    select: (data) => data.providers,
    enabled: assistantId != null && advancedSetupAvailable,
  });

  const {
    data: connections,
    isLoading: connectionsLoading,
    isError: connectionsError,
    isSuccess: connectionStatusKnown,
  } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: assistantId != null && hostedManagedOAuthAvailable,
  });
  const advancedOAuthSetupAvailable = advancedSetupAvailable && !providersError;

  // Completion is verified inside the popup flow against the connection API.
  // OAuth status parameters are untrusted legacy callback residue. The
  // provider parameter is only a local deep link to a known integration.
  useEffect(() => {
    const oauthStatus = searchParams.get("oauth_status");
    if (oauthStatus) {
      navigate(routes.settings.integrations, { replace: true });
      return;
    }
    const provider = searchParams.get("provider");
    if (provider) setSelectedProviderKey(provider);
  }, [searchParams, navigate]);

  const oauthProviders = useMemo(
    () => customerOAuthProvidersWithHostedFallbacks(providers),
    [providers],
  );

  const filteredProviders = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    let list = oauthProviders.filter((provider) => {
      if (!needle) {
        return true;
      }
      const name = (
        provider.display_name ?? provider.provider_key
      ).toLowerCase();
      const description = (provider.description ?? "").toLowerCase();
      return name.includes(needle) || description.includes(needle);
    });

    list = list.filter((provider) =>
      oauthProviderMatchesConnectionFilter(
        provider.provider_key,
        Boolean(
          connectionForProvider(connections, provider.provider_key)?.connected,
        ),
        connectionStatusKnown,
        selectedFilter,
      ),
    );

    return [...list].sort((a, b) => {
      const aEnabled =
        connectionStatusKnown &&
        Boolean(connectionForProvider(connections, a.provider_key)?.connected);
      const bEnabled =
        connectionStatusKnown &&
        Boolean(connectionForProvider(connections, b.provider_key)?.connected);
      if (aEnabled !== bEnabled) {
        return aEnabled ? -1 : 1;
      }
      const aName = (a.display_name ?? a.provider_key).toLowerCase();
      const bName = (b.display_name ?? b.provider_key).toLowerCase();
      return aName.localeCompare(bName);
    });
  }, [
    oauthProviders,
    connections,
    connectionStatusKnown,
    searchText,
    selectedFilter,
  ]);
  const { primary: primaryProviders, advanced: advancedProviders } =
    groupOAuthProvidersBySetup(filteredProviders);

  const klaviyoConnected = isKlaviyoConnected(klaviyo.integration);
  const klaviyoMatchesSearch = [
    "klaviyo",
    "email delivery",
    "customer activity",
  ].some((value) => value.includes(searchText.trim().toLowerCase()));
  const klaviyoMatchesFilter =
    selectedFilter === "all" ||
    (selectedFilter === "enabled" && klaviyoConnected) ||
    (selectedFilter === "not-enabled" && !klaviyoConnected);
  const showKlaviyo = klaviyoMatchesSearch && klaviyoMatchesFilter;

  const visibleMeetingSources = useMemo(
    () => filterMeetingSources(searchText, selectedFilter),
    [searchText, selectedFilter],
  );
  const visibleAdditionalIntegrations = useMemo(
    () => filterAdditionalIntegrations(searchText, selectedFilter),
    [searchText, selectedFilter],
  );
  const staticCatalogVisible =
    visibleMeetingSources.length > 0 ||
    visibleAdditionalIntegrations.length > 0;

  const loading = isLifecycleLoading || providersLoading || connectionsLoading;
  const workAppsHaveResults =
    showKlaviyo || primaryProviders.length > 0 || advancedProviders.length > 0;
  const showWorkAppsSection =
    loading ||
    providersError ||
    connectionsError ||
    !assistantId ||
    workAppsHaveResults;
  const selectedFilterLabel =
    FILTER_OPTIONS.find((o) => o.value === selectedFilter)?.label ?? "All";

  const emptyStateTitle = (() => {
    if (searchText.trim()) {
      return "No integrations matched";
    }
    switch (selectedFilter) {
      case "enabled":
        return "No Enabled Integrations";
      case "not-enabled":
        return "All Integrations Are Enabled";
      default:
        return "No Integrations Available";
    }
  })();

  const emptyStateSubtitle = (() => {
    if (searchText.trim()) {
      return `No integrations matched "${searchText.trim()}"`;
    }
    switch (selectedFilter) {
      case "enabled":
        return "Connect an integration to get started.";
      case "not-enabled":
        return "All available integrations have been connected.";
      default:
        return "Check your connection and try again.";
    }
  })();

  const selectedProvider = useMemo(
    () =>
      selectedProviderKey
        ? (oauthProviders.find(
            (provider) =>
              provider.provider_key ===
              resolveOAuthProviderDeepLink(selectedProviderKey),
          ) ?? null)
        : null,
    [oauthProviders, selectedProviderKey],
  );
  const selectedHostedStatusUnavailable = Boolean(
    selectedProvider &&
    hostedManagedOAuthAvailable &&
    hasHostedManagedOAuth(selectedProvider.provider_key) &&
    !connectionStatusKnown,
  );
  const selectedAdvancedCatalogUnavailable = Boolean(
    selectedProvider &&
    !hasHostedManagedOAuth(selectedProvider.provider_key) &&
    providersError,
  );

  useEffect(() => {
    if (!selectedProviderKey || selectedProviderKey === "klaviyo") return;
    const resolvedProviderKey =
      resolveOAuthProviderDeepLink(selectedProviderKey);
    if (
      oauthProviders.some(
        (provider) => provider.provider_key === resolvedProviderKey,
      )
    ) {
      return;
    }
    setSelectedProviderKey(null);
    if (searchParams.has("provider")) {
      navigate(routes.settings.integrations, { replace: true });
    }
  }, [navigate, oauthProviders, searchParams, selectedProviderKey]);

  return (
    <div className="space-y-4">
      {!bannerDismissed && (
        <Notice
          tone="info"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onDismiss={dismissBanner}
        >
          <span className="text-body-medium-default">Tip:</span> Ask Worklin to
          explain any connection before you set it up.
        </Notice>
      )}

      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search Integrations"
          aria-label="Search integrations"
          leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
          fullWidth
          wrapperClassName="flex-1"
        />
        <Popover.Root open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={filterMenuOpen}
              className="flex w-36 cursor-pointer items-center justify-between gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-lighter text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
            >
              <span>{selectedFilterLabel}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </Popover.Trigger>
          <Popover.Content
            align="end"
            sideOffset={4}
            className="w-36 overflow-hidden p-0"
          >
            <div role="listbox">
              {FILTER_OPTIONS.map((option) => {
                const active = option.value === selectedFilter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setSelectedFilter(option.value);
                      setFilterMenuOpen(false);
                    }}
                    className={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left hover:bg-[var(--ghost-hover)] ${
                      active
                        ? "text-body-medium-default text-[var(--content-default)]"
                        : "text-body-medium-lighter text-[var(--content-default)]"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Root>
      </div>

      <div className="space-y-6">
        {showWorkAppsSection ? (
          <section aria-labelledby="work-apps-heading" className="space-y-3">
            <div>
              <h2
                id="work-apps-heading"
                className="text-title-small text-[var(--content-default)]"
              >
                Work apps
              </h2>
              <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
                Start with simple connections. Developer setup stays tucked away
                until you need it.
              </p>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-tertiary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading...</span>
              </div>
            ) : !assistantId ? (
              <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
                No assistant found. Hatch an assistant to connect integrations.
              </p>
            ) : (
              <div className="space-y-2">
                {providersError ? (
                  <p className="py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
                    Some work apps could not be loaded. The rest of the
                    Integrations directory is still available below.
                  </p>
                ) : null}
                {connectionsError ? (
                  <p className="py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
                    Connection status is temporarily unavailable. Worklin will
                    not offer connection changes until it can verify the current
                    state.
                  </p>
                ) : null}
                {showKlaviyo ? (
                  <KlaviyoIntegrationRow
                    integration={klaviyo.integration}
                    statusLoading={klaviyo.status.isPending}
                    statusUnavailable={klaviyo.status.isError}
                    onConfigure={() => setSelectedProviderKey("klaviyo")}
                  />
                ) : null}
                {primaryProviders.map((provider) => (
                  <IntegrationRow
                    key={provider.provider_key}
                    assistantId={assistantId}
                    providerKey={provider.provider_key}
                    displayName={provider.display_name ?? provider.provider_key}
                    description={provider.description}
                    logoUrl={provider.logo_url}
                    connection={connectionForProvider(
                      connections,
                      provider.provider_key,
                    )}
                    hostedManagedAvailable={hostedManagedOAuthAvailable}
                    advancedSetupAvailable={advancedOAuthSetupAvailable}
                    connectionStatusUnavailable={
                      hostedManagedOAuthAvailable && !connectionStatusKnown
                    }
                    platformGate={platformGate}
                    onConfigure={() =>
                      setSelectedProviderKey(provider.provider_key)
                    }
                  />
                ))}

                {advancedProviders.length > 0 ? (
                  <details
                    open={searchText.trim().length > 0 || undefined}
                    className="group overflow-hidden rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)]"
                  >
                    <summary
                      aria-label="Advanced app connections"
                      className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-body-medium-default text-[var(--content-default)]"
                    >
                      <span>
                        Advanced app connections
                        <span className="ml-2 text-body-small-default text-[var(--content-tertiary)]">
                          Developer connections for advanced tools
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
                        {advancedProviders.length}
                        <ChevronDown
                          className="h-4 w-4 transition-transform group-open:rotate-180"
                          aria-hidden
                        />
                      </span>
                    </summary>
                    <div className="space-y-2 border-t border-[var(--border-element)] p-2">
                      {advancedProviders.map((provider) => (
                        <IntegrationRow
                          key={provider.provider_key}
                          assistantId={assistantId}
                          providerKey={provider.provider_key}
                          displayName={
                            provider.display_name ?? provider.provider_key
                          }
                          description={provider.description}
                          logoUrl={provider.logo_url}
                          connection={null}
                          hostedManagedAvailable={false}
                          advancedSetupAvailable={advancedOAuthSetupAvailable}
                          platformGate={platformGate}
                          onConfigure={() =>
                            setSelectedProviderKey(provider.provider_key)
                          }
                        />
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        <MeetingNotesSection
          sources={visibleMeetingSources}
          searchActive={searchText.trim().length > 0}
        />

        <AdditionalIntegrationsSection
          integrations={visibleAdditionalIntegrations}
          dedicatedSetupAvailable={advancedSetupAvailable}
          searchActive={searchText.trim().length > 0}
          onOpen={(action) => {
            if (action === "contacts") {
              void navigate(routes.contacts.root);
              return;
            }
            if (action === "email_settings") {
              void navigate(`${routes.settings.ai}#email`);
              return;
            }
            void navigate(routes.settings.ai);
          }}
        />

        {!showWorkAppsSection && !staticCatalogVisible ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border-element)] px-4 py-12 text-center">
            <Search className="h-6 w-6 text-[var(--content-disabled)]" />
            <p className="text-body-medium-default text-[var(--content-default)]">
              {emptyStateTitle}
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {emptyStateSubtitle}
            </p>
          </div>
        ) : null}
      </div>

      {selectedProvider &&
        assistantId &&
        !selectedHostedStatusUnavailable &&
        !selectedAdvancedCatalogUnavailable && (
          <IntegrationDetailModal
            assistantId={assistantId}
            providerKey={selectedProvider.provider_key}
            displayName={
              selectedProvider.display_name ?? selectedProvider.provider_key
            }
            description={selectedProvider.description}
            logoUrl={selectedProvider.logo_url}
            hostedManagedAvailable={
              hostedManagedOAuthAvailable &&
              hasHostedManagedOAuth(selectedProvider.provider_key)
            }
            advancedSetupAvailable={advancedOAuthSetupAvailable}
            platformGate={platformGate}
            onClose={() => {
              setSelectedProviderKey(null);
              if (searchParams.has("provider")) {
                navigate(routes.settings.integrations, { replace: true });
              }
            }}
          />
        )}
      {selectedProviderKey === "klaviyo" && assistantId ? (
        <KlaviyoIntegrationModal
          assistantId={assistantId}
          onClose={() => {
            setSelectedProviderKey(null);
            if (searchParams.has("provider")) {
              navigate(routes.settings.integrations, { replace: true });
            }
          }}
        />
      ) : null}
    </div>
  );
}

export function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <Suspense>
        <IntegrationsPanelInner />
      </Suspense>
    </div>
  );
}
