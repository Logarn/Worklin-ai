import {
  Check,
  ChevronDown,
  CreditCard,
  KeyRound,
  Loader2,
  SlidersHorizontal,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";

import {
  AUTO_PROFILE_NAME,
  gateAutoProfile,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import {
  getModelsForProvider,
  providerSupportsPlatformAuth,
  PROVIDER_DISPLAY_NAMES,
} from "@/assistant/llm-model-catalog";
import {
  connectionsAvailableForManagedInference,
  profilesAvailableForManagedInference,
} from "@/assistant/managed-inference";
import { useManagedInferenceCapability } from "@/assistant/managed-inference-availability";
import {
  connectionMatchesPreset,
  XAI_PROVIDER_PRESET,
  type ProviderConnectionPreset,
} from "@/assistant/provider-connection-presets";
import { isProviderConnectionReady } from "@/assistant/provider-connection-readiness";
import { isPooledRuntimeProvider } from "@/assistant/pooled-model-provider";
import {
  buildInteractiveProfileSelectionPatch,
  isConfigSelectionConflict,
} from "@/assistant/provider-profile-repair";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { CallSiteOverridesModal } from "@/domains/settings/ai/call-site-overrides-modal";
import { ManageProfilesModal } from "@/domains/settings/ai/manage-profiles-modal";
import { PooledLanguageModelCard } from "@/domains/settings/ai/pooled-language-model-card";
import {
  ManageProvidersModal,
  type ProviderCreateSeed,
} from "@/domains/settings/ai/manage-providers-modal";
import type { AuthType } from "@/domains/settings/ai/provider-editor-constants";
import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import {
  buildOrderedProfiles,
  type ProfileWithName,
} from "@/domains/settings/ai/utils";
import {
  configGetOptions,
  configGetSetQueryData,
  inferenceProviderconnectionsGetOptions,
  secretsGetOptions,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  Auth,
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type PowerSource = "worklin-credits" | "api-key";

interface LanguageModelService {
  readonly id: string;
  readonly provider: ConnectionProvider;
  readonly displayName: string;
  readonly description: string;
  readonly preset?: ProviderConnectionPreset;
}

const LANGUAGE_MODEL_SERVICES: readonly LanguageModelService[] = [
  {
    id: "openai",
    provider: "openai",
    displayName: "OpenAI",
    description: "GPT models, API key, or ChatGPT subscription.",
  },
  {
    id: XAI_PROVIDER_PRESET.id,
    provider: XAI_PROVIDER_PRESET.provider,
    displayName: XAI_PROVIDER_PRESET.displayName,
    description: "Grok models through your xAI account.",
    preset: XAI_PROVIDER_PRESET,
  },
  {
    id: "anthropic",
    provider: "anthropic",
    displayName: "Anthropic",
    description: "Claude models for careful reasoning.",
  },
  {
    id: "gemini",
    provider: "gemini",
    displayName: "Google Gemini",
    description: "Google models for fast everyday work.",
  },
  {
    id: "kimi",
    provider: "kimi",
    displayName: "Kimi",
    description: "Long-context Kimi models.",
  },
  {
    id: "openrouter",
    provider: "openrouter",
    displayName: "OpenRouter",
    description: "Many model families through one key.",
  },
  {
    id: "fireworks",
    provider: "fireworks",
    displayName: "Fireworks",
    description: "Hosted open and frontier models.",
  },
  {
    id: "minimax",
    provider: "minimax",
    displayName: "MiniMax",
    description: "Long-context MiniMax models.",
  },
];

const METHOD_LABELS: Record<AuthType, string> = {
  api_key: "API key",
  platform: "Worklin credits",
  none: "No key needed",
  oauth_subscription: "ChatGPT subscription",
  service_account: "Service account",
};

function getProviderLabel(provider: string | null | undefined): string {
  if (!provider) return "No provider selected";
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

function getProviderMark(provider: string): string {
  switch (provider) {
    case "openai":
      return "O";
    case "xai":
      return "X";
    case "anthropic":
      return "AI";
    case "gemini":
      return "G";
    case "kimi":
      return "K";
    case "openrouter":
      return "OR";
    case "fireworks":
      return "FW";
    case "minimax":
      return "MM";
    default:
      return provider.slice(0, 2).toUpperCase();
  }
}

function getModelLabel(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  if (!model) return "No model selected";
  const catalogModel = provider
    ? getModelsForProvider(provider).find((candidate) => candidate.id === model)
    : null;
  return catalogModel?.displayName ?? model;
}

function getProfileTitle(profile: ProfileWithName | null): string {
  if (!profile) return "No model selected";
  if (profile.name === AUTO_PROFILE_NAME) return "Automatic";
  return profile.label ?? getProviderLabel(profile.provider);
}

function getProfileSubtitle(profile: ProfileWithName | null): string {
  if (!profile) return "Choose how Worklin should answer first.";
  if (profile.name === AUTO_PROFILE_NAME) {
    return "Worklin chooses the best saved setup for each reply.";
  }
  return getModelLabel(profile.provider, profile.model);
}

function resolvePowerSource(
  profile: ProfileWithName | null,
  connection: ProviderConnection | null,
): PowerSource {
  if (!profile) return "api-key";
  if (
    profile.source === "managed" ||
    connection?.isManaged ||
    connection?.auth.type === "platform"
  ) {
    return "worklin-credits";
  }
  return "api-key";
}

function getConnectionStatus(
  powerSource: PowerSource,
  auth: Auth | undefined,
): string {
  if (powerSource === "worklin-credits") return "Using Worklin credits";
  if (!auth) return "Key required";
  if (auth?.type === "oauth_subscription") return "ChatGPT connected";
  if (auth?.type === "none") return "Local connection";
  return "Key connected";
}

function getMethodOptions(
  provider: ConnectionProvider,
  managedInferenceConfigured: boolean,
): AuthType[] {
  if (provider === "ollama") return ["none"];
  const options: AuthType[] = ["api_key"];
  if (provider === "openai") {
    options.push("oauth_subscription");
  }
  if (
    managedInferenceConfigured &&
    providerSupportsPlatformAuth(provider)
  ) {
    options.push("platform");
  }
  return options;
}

function serviceMatchesConnection(
  service: LanguageModelService,
  connection: ProviderConnection,
): boolean {
  return service.preset
    ? connectionMatchesPreset(connection, service.preset)
    : connection.provider === service.provider;
}

function PowerSourceTile({
  selected,
  icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[112px] w-full items-center gap-4 rounded-lg border bg-[var(--surface-base)] px-5 py-4 text-left transition hover:border-[var(--border-strong)]",
        selected
          ? "border-[var(--content-default)]"
          : "border-[var(--border-base)]",
      )}
    >
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
          selected
            ? "border-[var(--content-default)] bg-[var(--content-default)] text-[var(--surface-base)]"
            : "border-[var(--content-tertiary)] text-transparent",
        )}
        aria-hidden="true"
      >
        <Check className="h-3.5 w-3.5" />
      </span>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] text-[var(--content-secondary)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-body-large-default font-semibold text-[var(--content-emphasised)]">
          {title}
        </span>
        <span className="mt-1 block text-body-medium-lighter text-[var(--content-tertiary)]">
          {description}
        </span>
      </span>
    </button>
  );
}

function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] text-body-small-default font-semibold text-[var(--content-emphasised)]">
      {getProviderMark(provider)}
    </span>
  );
}

export function LanguageModelCard() {
  const assistantId = useActiveAssistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const runtimeProvider = assistants.find(
    (assistant) => assistant.id === assistantId,
  )?.runtimeProvider;

  if (isPooledRuntimeProvider(runtimeProvider)) {
    return <PooledLanguageModelCard assistantId={assistantId} />;
  }

  return <DedicatedLanguageModelCard assistantId={assistantId} />;
}

function DedicatedLanguageModelCard({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const { configured: managedInferenceConfigured } =
    useManagedInferenceCapability(assistantId);

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
    staleTime: 30_000,
  });
  const allConnections = useMemo(
    () => connectionsData?.connections ?? [],
    [connectionsData?.connections],
  );
  const connections = useMemo(
    () =>
      connectionsAvailableForManagedInference(
        allConnections,
        managedInferenceConfigured,
      ),
    [allConnections, managedInferenceConfigured],
  );
  const { data: secretsData } = useQuery({
    ...secretsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const secrets = useMemo(
    () => secretsData?.secrets ?? [],
    [secretsData?.secrets],
  );

  const activeProfile = config?.llm?.activeProfile ?? null;
  const callSites = useMemo(
    () => config?.llm?.callSites ?? {},
    [config?.llm?.callSites],
  );
  // Retain the last non-empty profile list so a transient empty config payload
  // can't blank the main model surface until the next good fetch.
  const { profiles, profileOrder } = useStickyProfiles(config?.llm, assistantId);
  const orderedProfiles = useMemo(
    () =>
      profilesAvailableForManagedInference(
        buildOrderedProfiles(profiles, profileOrder),
        allConnections,
        managedInferenceConfigured,
      ),
    [profiles, profileOrder, allConnections, managedInferenceConfigured],
  );

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(queryClient, { path: { assistant_id: assistantId } }, data);
    },
  });

  const [effectiveActiveProfile, setDraftActiveProfile] = useDraftOverride(activeProfile);

  // Modal toggles — ephemeral UI state, correct as useState
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [manageProvidersOpen, setManageProvidersOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [providerMethods, setProviderMethods] = useState<
    Partial<Record<string, AuthType>>
  >({});
  const [providerCreateSeed, setProviderCreateSeed] =
    useState<ProviderCreateSeed | null>(null);

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const defaultProfilePickerEntries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(orderedProfiles, [effectiveActiveProfile]),
        queryComplexityRoutingEnabled,
      ),
    [orderedProfiles, effectiveActiveProfile, queryComplexityRoutingEnabled],
  );

  const overrideCount = Object.entries(callSites).filter(
    ([id, s]) => id !== "mainAgent" && (s?.profile != null || s?.provider != null || s?.model != null),
  ).length;
  const isProfileDirty = effectiveActiveProfile !== activeProfile;
  const selectedProfile =
    orderedProfiles.find((profile) => profile.name === effectiveActiveProfile) ??
    null;
  const selectedConnection =
    selectedProfile?.provider_connection
      ? connections.find(
          (connection) => connection.name === selectedProfile.provider_connection,
        ) ?? null
      : null;
  const selectedPowerSource = resolvePowerSource(
    selectedProfile,
    selectedConnection,
  );
  const managedProfile = orderedProfiles.find(
    (profile) => profile.source === "managed",
  );
  const userProfiles = orderedProfiles.filter(
    (profile) => profile.source !== "managed",
  );
  const selectedProvider = selectedProfile?.provider ?? null;
  const selectedService =
    (selectedConnection
      ? LANGUAGE_MODEL_SERVICES.find((service) =>
          serviceMatchesConnection(service, selectedConnection),
        )
      : null) ??
    LANGUAGE_MODEL_SERVICES.find(
      (service) =>
        !service.preset && service.provider === selectedProvider,
    ) ??
    null;
  const selectedStatus = getConnectionStatus(
    selectedPowerSource,
    selectedConnection && isProviderConnectionReady(selectedConnection, secrets)
      ? selectedConnection.auth
      : undefined,
  );

  const handleProfileSave = useCallback(async () => {
    if (!effectiveActiveProfile) return;
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: buildInteractiveProfileSelectionPatch(
          { profiles, callSites },
          effectiveActiveProfile,
          activeProfile,
          allConnections,
          !managedInferenceConfigured,
        ),
      });
      toast.success("Model choice saved.");
    } catch (error) {
      toast.error(
        isConfigSelectionConflict(error)
          ? "The model choice changed before this selection was saved. Try again."
          : "Failed to save model choice. Please try again.",
      );
      captureError(error, { context: "settings-ai-language-model-save" });
    }
  }, [
    activeProfile,
    allConnections,
    assistantId,
    callSites,
    configMutation,
    effectiveActiveProfile,
    managedInferenceConfigured,
    profiles,
  ]);

  const handlePowerSourceSelect = useCallback(
    (source: PowerSource) => {
      if (source === selectedPowerSource && selectedProfile) return;
      if (source === "worklin-credits" && managedProfile) {
        setDraftActiveProfile(managedProfile.name);
        return;
      }
      if (source === "api-key") {
        if (userProfiles.length === 1) {
          setDraftActiveProfile(userProfiles[0].name);
          return;
        }
        if (userProfiles.length > 1) {
          setManageProfilesOpen(true);
          return;
        }
        setProviderCreateSeed(null);
        setManageProvidersOpen(true);
      } else {
        setManageProfilesOpen(true);
      }
    },
    [
      managedProfile,
      selectedProfile,
      selectedPowerSource,
      setDraftActiveProfile,
      userProfiles,
    ],
  );

  const handleProviderMethodChange = useCallback(
    (serviceId: string, method: AuthType) => {
      setProviderMethods((current) => ({
        ...current,
        [serviceId]: method,
      }));
    },
    [],
  );

  const openProviderFlow = useCallback(
    (
      provider?: ConnectionProvider,
      method?: AuthType,
      preset?: ProviderConnectionPreset,
    ) => {
      if (provider && method) {
        setProviderCreateSeed((current) => ({
          provider,
          authType: method,
          preset,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      } else {
        setProviderCreateSeed(null);
      }
      setManageProvidersOpen(true);
    },
    [],
  );

  return (
    <>
      <ByoServiceCard
        title="Your assistant's main model"
        subtitle="Choose how Worklin should power replies, then pick the provider and model."
      >
        <div className="space-y-4">
          <div className={cn("grid gap-3", managedInferenceConfigured && "lg:grid-cols-2")}>
            {managedInferenceConfigured ? (
              <PowerSourceTile
                selected={selectedPowerSource === "worklin-credits"}
                icon={<CreditCard className="h-5 w-5" />}
                title="Use Worklin credits"
                description="No API key needed. Usage comes from your Worklin balance."
                onClick={() => handlePowerSourceSelect("worklin-credits")}
              />
            ) : null}
            <PowerSourceTile
              selected={selectedPowerSource === "api-key"}
              icon={<KeyRound className="h-5 w-5" />}
              title="Use my API key"
              description="Connect a provider account and change keys anytime."
              onClick={() => handlePowerSourceSelect("api-key")}
            />
          </div>

          {queryComplexityRoutingEnabled && effectiveActiveProfile === AUTO_PROFILE_NAME && (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-warning-subtle)] px-3 py-2">
              <span className="text-body-small-default text-[var(--content-warning)]">
                Automatic mode may use stronger models when needed, which can increase costs.
              </span>
            </div>
          )}

          <section className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] text-body-medium-default font-semibold text-[var(--content-emphasised)]">
                  {selectedService
                    ? getProviderMark(selectedService.id)
                    : selectedProvider
                      ? getProviderMark(selectedProvider)
                      : "M"}
                </span>
                <div className="min-w-0">
                  <p className="text-body-large-default font-semibold text-[var(--content-emphasised)]">
                    {getProfileTitle(selectedProfile)}
                  </p>
                  <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                    {getProfileSubtitle(selectedProfile)}
                  </p>
                  <p className="mt-2 flex items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selectedStatus === "Key required"
                          ? "bg-[var(--content-disabled)]"
                          : "bg-[var(--system-positive-strong)]",
                      )}
                    />
                    {selectedStatus}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => setManageProfilesOpen(true)}
                >
                  Change model
                </Button>
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => openProviderFlow()}
                >
                  Update key
                </Button>
              </div>
            </div>
          </section>

          {isProfileDirty && (
            <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-body-small-default text-[var(--content-secondary)]">
                Save this model choice so new replies use it.
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="compact"
                  onClick={() => void handleProfileSave()}
                  disabled={configMutation.isPending}
                >
                  Save choice
                </Button>
                {configMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
                )}
              </div>
            </div>
          )}

          <section className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              onClick={() => setServicesOpen((open) => !open)}
            >
              <span>
                <span className="block text-body-large-default font-semibold text-[var(--content-emphasised)]">
                  Available services
                </span>
                <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
                  Connect or manage the model services Worklin can use.
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform",
                  servicesOpen ? "rotate-180" : "",
                )}
              />
            </button>

            {servicesOpen ? (
              <div className="grid gap-3 border-t border-[var(--border-subtle)] p-4 sm:grid-cols-2 xl:grid-cols-3">
                {LANGUAGE_MODEL_SERVICES.map((service) => {
                  const { provider } = service;
                  const providerConnections = connections.filter(
                    (connection) =>
                      serviceMatchesConnection(service, connection) &&
                      isProviderConnectionReady(connection, secrets),
                  );
                  const hasConnection = providerConnections.length > 0;
                  const isActive = selectedService?.id === service.id;
                  const method =
                    providerMethods[service.id] ??
                    (selectedPowerSource === "worklin-credits" &&
                    providerSupportsPlatformAuth(provider)
                      ? "platform"
                      : "api_key");
                  const methodOptions = getMethodOptions(
                    provider,
                    managedInferenceConfigured,
                  );
                  const fallbackMethod = methodOptions[0] ?? "api_key";
                  const effectiveMethod = methodOptions.includes(method)
                    ? method
                    : fallbackMethod;

                  return (
                    <div
                      key={service.id}
                      className={cn(
                        "flex min-h-[178px] flex-col rounded-lg border bg-[var(--surface-base)] p-3",
                        isActive
                          ? "border-[var(--content-default)]"
                          : "border-[var(--border-base)]",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <ProviderMark provider={service.id} />
                        <div className="min-w-0">
                          <p className="text-body-medium-default font-semibold text-[var(--content-emphasised)]">
                            {service.displayName}
                          </p>
                          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                            {service.description}
                          </p>
                        </div>
                      </div>

                      <div className="mt-auto space-y-3 pt-4">
                        <div className="space-y-1">
                          <label className="block text-body-small-default text-[var(--content-tertiary)]">
                            Method
                          </label>
                          <Dropdown
                            value={effectiveMethod}
                            onChange={(next) =>
                              handleProviderMethodChange(service.id, next)
                            }
                            options={methodOptions.map((option) => ({
                              value: option,
                              label: METHOD_LABELS[option],
                            }))}
                          />
                        </div>
                        <Button
                          variant="outlined"
                          size="compact"
                          onClick={() =>
                            hasConnection
                              ? openProviderFlow()
                              : openProviderFlow(
                                  provider,
                                  effectiveMethod,
                                  service.preset,
                                )
                          }
                          className="w-full justify-center"
                        >
                          {hasConnection ? "Manage" : "Connect"}
                        </Button>
                        {hasConnection ? (
                          <span className="flex items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
                            <span className="h-2 w-2 rounded-full bg-[var(--system-positive-strong)]" />
                            Connected
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] text-[var(--content-secondary)]">
                  <SlidersHorizontal className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-body-large-default font-semibold text-[var(--content-emphasised)]">
                    Advanced model settings
                  </span>
                  <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
                    Saved setups and task-specific models.
                  </span>
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform",
                  advancedOpen ? "rotate-180" : "",
                )}
              />
            </button>

            {advancedOpen ? (
              <div className="grid gap-3 border-t border-[var(--border-subtle)] p-4 md:grid-cols-2">
                <div className="rounded-lg border border-[var(--border-base)] p-3">
                  <p className="text-body-medium-default font-semibold text-[var(--content-emphasised)]">
                    Saved model setups
                  </p>
                  <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    Reusable provider and model choices.
                  </p>
                  <Button
                    variant="outlined"
                    size="compact"
                    onClick={() => setManageProfilesOpen(true)}
                    className="mt-3"
                  >
                    Manage
                  </Button>
                </div>
                <div className="rounded-lg border border-[var(--border-base)] p-3">
                  <p className="text-body-medium-default font-semibold text-[var(--content-emphasised)]">
                    Task-specific models
                  </p>
                  <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    {overrideCount > 0
                      ? `${overrideCount} custom task ${overrideCount === 1 ? "model" : "models"}.`
                      : "Use special models for search, writing, or analysis."}
                  </p>
                  <Button
                    variant="outlined"
                    size="compact"
                    onClick={() => setOverridesOpen(true)}
                    className="mt-3"
                  >
                    Manage
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          {defaultProfilePickerEntries.length === 0 ? (
            <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] px-4 py-3 text-body-small-default text-[var(--content-tertiary)]">
              No saved model setups yet. Connect a service to get started.
            </div>
          ) : null}
        </div>
      </ByoServiceCard>

      {assistantId && (
        <ManageProfilesModal
          isOpen={manageProfilesOpen}
          assistantId={assistantId}
          managedInferenceConfigured={managedInferenceConfigured}
          onClose={() => setManageProfilesOpen(false)}
        />
      )}

      {assistantId && (
        <CallSiteOverridesModal
          isOpen={overridesOpen}
          onClose={() => setOverridesOpen(false)}
          assistantId={assistantId}
          managedInferenceConfigured={managedInferenceConfigured}
        />
      )}

      {assistantId && (
        <ManageProvidersModal
          isOpen={manageProvidersOpen}
          assistantId={assistantId}
          managedInferenceConfigured={managedInferenceConfigured}
          createSeed={providerCreateSeed}
          onClose={() => setManageProvidersOpen(false)}
        />
      )}
    </>
  );
}
