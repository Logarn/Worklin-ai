import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { providerSupportsPlatformAuth, PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { credentialPresenceQueryKey, useStoredCredentialPresence } from "@/domains/settings/ai/use-stored-credential-presence";
import { configGetQueryKey, secretsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
    inferenceProviderconnectionsGet,
    inferenceProviderconnectionsPost,
    secretsPost,
} from "@/generated/daemon/sdk.gen";

import { ChatgptOAuthSection } from "@/components/ai/chatgpt-oauth-section";
import type { ProviderConnectionPreset } from "@/assistant/provider-connection-presets";
import {
  dedupeProviderConnectionName,
  deriveProviderDefaults,
} from "@/domains/settings/ai/profile-prefill";
import type { Auth, ConnectionProvider, InferenceProviderconnectionsPostData, ProviderConnection } from "@/generated/daemon/types.gen";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
    AUTH_TYPE_DISPLAY_NAMES,
    CONNECTION_PROVIDERS,
    connectionSaveErrorMessage,
    parseCredentialRef,
    type AuthType,
} from "@/domains/settings/ai/provider-editor-constants";
import { providerApiKeySecretBody } from "@/domains/settings/ai/provider-secret-body";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";
import { useProviderCredentialsList } from "@/domains/settings/ai/use-provider-credentials-list";
import { ensureRunnableProfileForConnection } from "@/assistant/provider-profile-repair";

// ---------------------------------------------------------------------------
// ProviderCreateForm
// ---------------------------------------------------------------------------
//
// Controlled presentational form for the CREATE path of a provider
// connection. Lifted out of `ProviderEditorContent` so both the standalone
// "Add Provider" modal (`variant="modal"`) and inline embeddings such as the
// provider-first profile quick-add flow (`variant="inline"`) share the exact
// same create UX, validation strings, and submit sequence
// (`secretsPost` → `inferenceProviderconnectionsPost`).
//
// Edit / managed-edit live in `ProviderEditorContent` and are intentionally
// NOT handled here — this component is create-only.

export interface ProviderCreateFormProps {
  assistantId: string;
  existingNames: string[];
  /** Pre-selected provider type (e.g. when cloning a managed connection). */
  defaultProviderType?: ConnectionProvider;
  /**
   * Pre-selected auth type. A platform value is honored only when managed
   * inference routing is configured for this assistant.
   */
  defaultAuthType?: AuthType;
  /** Whether local managed-inference routing is configured for this assistant. */
  managedInferenceConfigured?: boolean;
  /** Branded defaults for a first-class OpenAI-compatible service. */
  preset?: ProviderConnectionPreset;
  onCreated: (connection: ProviderConnection) => void;
  onCancel: () => void;
  /** "modal" wraps the form in Modal chrome; "inline" drops it for embedding. */
  variant?: "modal" | "inline";
}

export function ProviderCreateForm({
  assistantId,
  existingNames,
  defaultProviderType,
  defaultAuthType,
  managedInferenceConfigured = false,
  preset,
  onCreated,
  onCancel,
  variant = "modal",
}: ProviderCreateFormProps) {
  const initialProvider: ConnectionProvider = defaultProviderType ?? "anthropic";

  // Seed Display Name (label) + Key (name) from the initial provider type so
  // the form opens pre-filled (e.g. Anthropic → "Anthropic" / "anthropic"),
  // deduped against existing connection names. The user can override both, and
  // a provider-type change re-seeds only while they haven't edited the fields
  // (see the dirty guard in the Provider dropdown's onChange below).
  const providerDefaults = deriveProviderDefaults(
    initialProvider,
    existingNames,
  );
  const initialDefaults = preset
    ? {
        name: preset.displayName,
        key: dedupeProviderConnectionName(
          preset.connectionName,
          existingNames,
        ),
      }
    : providerDefaults;

  const [label, setLabel] = useState(initialDefaults.name);
  const [name, setName] = useState(initialDefaults.key);
  const [provider, setProvider] = useState<ConnectionProvider>(initialProvider);
  const [authType, setAuthType] = useState<AuthType>(
    () =>
      (defaultAuthType === "platform" && !managedInferenceConfigured
        ? "api_key"
        : defaultAuthType) ??
      (initialProvider === "ollama"
        ? "none"
        : managedInferenceConfigured &&
            providerSupportsPlatformAuth(initialProvider)
          ? "platform"
          : "api_key"),
  );
  const [credential, setCredential] = useState(() =>
    initialProvider === "ollama"
      ? ""
      : `credential/${preset?.credentialName ?? initialProvider}/api_key`,
  );
  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? "");
  const [connectionModels, setConnectionModels] = useState(
    preset?.models?.map((model) => model.id).join(", ") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const platformAuthAvailable =
    managedInferenceConfigured && providerSupportsPlatformAuth(provider);

  useEffect(() => {
    if (authType !== "platform" || platformAuthAvailable) return;
    setAuthType(provider === "ollama" ? "none" : "api_key");
  }, [authType, platformAuthAvailable, provider]);

  const isOpenAICompatible = provider === "openai-compatible";
  const connectionProviderOptions = useMemo(() => {
    if (provider && !CONNECTION_PROVIDERS.includes(provider)) {
      return [...CONNECTION_PROVIDERS, provider];
    }
    return CONNECTION_PROVIDERS;
  }, [provider]);

  const { handleLabelChange, handleKeyChange: handleNameChange, getDirty } =
    useLabelKeySync("create", setLabel, setName);

  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const queryClient = useQueryClient();

  // --- Credential presence (shared hook) ---
  const parsedCredRef = useMemo(() => parseCredentialRef(credential), [credential]);
  const needsCredentialCheck = authType === "api_key" && parsedCredRef !== null;

  const {
    hasStoredCredential,
    isLoading: isLoadingCredential,
  } = useStoredCredentialPresence({
    assistantId,
    credentialKind: "credential",
    credentialName: parsedCredRef ? `${parsedCredRef.service}:${parsedCredRef.field}` : "",
    enabled: needsCredentialCheck,
  });

  // --- Available credentials list ---
  const {
    credentials: availableCredentials,
  } = useProviderCredentialsList({
    assistantId,
    enabled: true,
  });

  const nameError = (() => {
    if (!name.trim()) return null;
    if (existingNames.includes(name.trim())) {
      return `A connection named "${name.trim()}" already exists.`;
    }
    return null;
  })();
  const modelsError =
    isOpenAICompatible && !connectionModels.trim()
      ? "Add at least one model before connecting this service."
      : null;

  const canSave =
    name.trim().length > 0 && !nameError && modelsError === null;

  async function handleSave() {
    if (!canSave) return;
    if (authType === "platform" && !platformAuthAvailable) {
      setAuthType(provider === "ollama" ? "none" : "api_key");
      setError(
        "Worklin credits are not available for this provider. Connect your API key instead.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let auth: Auth;

      if (authType === "api_key") {
        const effectiveCredential =
          credential.trim() || `credential/${provider}/api_key`;
        const trimmedKey = apiKeyValue.trim();

        if (trimmedKey) {
          setIsSavingKey(true);
          const parsed = parseCredentialRef(effectiveCredential);
          try {
            await secretsPost({
              path: { assistant_id: assistantId },
              body: providerApiKeySecretBody(
                provider,
                effectiveCredential,
                trimmedKey,
              ),
              throwOnError: true,
            });
          } catch {
            setError(
              "Worklin could not save this API key. Check that it belongs to the selected provider, then try again.",
            );
            return;
          } finally {
            setIsSavingKey(false);
          }
          try {
            // Cache updates should not block creating the provider connection
            // after the daemon has already accepted the secret.
            const presenceKey = credentialPresenceQueryKey(
              assistantId,
              "credential",
              parsed ? `${parsed.service}:${parsed.field}` : "",
            );
            queryClient.setQueryData(presenceKey, true);
            void queryClient.invalidateQueries({
              queryKey: secretsGetQueryKey({ path: { assistant_id: assistantId } }),
            });
          } catch {
            // Non-critical cache refresh failure; the next query will refetch.
          }
        } else if (!hasStoredCredential) {
          setError("Enter an API key or select an existing credential.");
          return;
        }

        auth = { type: "api_key", credential: effectiveCredential };
      } else if (authType === "oauth_subscription") {
        // OAuth subscription connections are created by the OAuth flow
        // (ChatgptOAuthSection), not through Save.
        setError("Use the \"Sign in with ChatGPT\" button to connect your subscription.");
        return;
      } else if (authType === "none") {
        auth = { type: "none" };
      } else if (authType === "service_account") {
        setError("Service account connections cannot be created through this form.");
        return;
      } else {
        auth = { type: "platform" };
      }

      const labelValue = label.trim() || null;

      const input: InferenceProviderconnectionsPostData["body"] = {
        name: name.trim(),
        provider,
        auth,
        ...(labelValue !== null && { label: labelValue }),
        ...(isOpenAICompatible && {
          base_url: baseUrl.trim() || null,
          models: connectionModels.trim()
            ? connectionModels
                .split(",")
                .map((id) => ({ id: id.trim() }))
                .filter((m) => m.id)
            : null,
        }),
      };
      const { data: created, response: createRes } = await inferenceProviderconnectionsPost({
        path: { assistant_id: assistantId },
        body: input,
      });
      if (!createRes?.ok) {
        setError(connectionSaveErrorMessage(createRes?.status, name.trim()));
        return;
      }
      if (!created) {
        setError("Server returned an empty response. Please try again.");
        return;
      }
      let selectedAsDefault = false;
      try {
        const { data: inventoryData } = await inferenceProviderconnectionsGet({
          path: { assistant_id: assistantId },
          throwOnError: true,
        });
        const inventory = inventoryData?.connections ?? [];
        const completeInventory = inventory.some(
          (candidate) => candidate.name === created.name,
        )
          ? inventory
          : [...inventory, created];
        const profileResult = await ensureRunnableProfileForConnection(
          assistantId,
          created,
          {
            activateConnection: true,
            connections: completeInventory,
            routeInteractiveCallSites: !managedInferenceConfigured,
          },
        );
        selectedAsDefault = profileResult.repaired;
        if (selectedAsDefault) {
          void queryClient.invalidateQueries({
            queryKey: configGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        }
      } catch {
        setError(
          "Provider connected, but Worklin could not select it as the active model. Open Profiles and choose it, or try again.",
        );
        return;
      }
      // Single success confirmation for both the standalone and inline
      // surfaces; failures above already surface inline via `error` (no toast).
      toast.success(
        selectedAsDefault
          ? "Provider connected and selected"
          : "Provider connected",
      );
      onCreated(created);
    } catch {
      setError("Failed to save connection. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Credentials for the current provider (used in the Advanced dropdown)
  const providerCredentials = availableCredentials.filter(
    (c) => c.service === (preset?.credentialName ?? provider),
  );

  // Show the Advanced credential-reference disclosure only when there's at
  // least one stored credential for the provider. In the create-mode empty
  // state the API Key field above is the only path needed — saving a key
  // auto-creates `credential/<provider>/api_key` under the hood, so the
  // disclosure has nothing meaningful to offer.
  const shouldShowAdvancedSection = providerCredentials.length > 0;
  const apiKeyPlaceholder = secretPlaceholder(
    "Enter your API key",
    hasStoredCredential,
  );

  const body = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Name{" "}
          <span className="text-[var(--content-disabled)]">(optional)</span>
        </label>
        <Input
          value={label}
          onChange={(e) => handleLabelChange(e.target.value)}
          placeholder="e.g. My Anthropic Key"
          fullWidth
        />
      </div>

      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Internal name
        </label>
        <Input
          value={name}
          onChange={(e) => {
            handleNameChange(e.target.value);
            setError(null);
          }}
          placeholder="e.g. anthropic-personal"
          fullWidth
        />
        {nameError && (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-negative-strong)"
          >
            {nameError}
          </Typography>
        )}
      </div>

      {/* Provider */}
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Provider
        </label>
        <Dropdown
          aria-label="Provider"
          value={provider}
          disabled={Boolean(preset)}
          onChange={(newProvider) => {
            setProvider(newProvider);
            // Re-seed Name + Key from the newly selected provider type, but
            // only while the user hasn't manually edited either field (dirty
            // tracking lives in useLabelKeySync). Seeding writes state
            // directly so it doesn't itself flip the dirty flag.
            if (!getDirty()) {
              const { name: seedName, key: seedKey } = deriveProviderDefaults(
                newProvider,
                existingNames,
              );
              setLabel(seedName);
              setName(seedKey);
            }
            if (newProvider === "ollama") {
              setAuthType("none");
              setCredential("");
            } else {
              setAuthType((prev) => {
                if (prev === "none") {
                  return "api_key";
                }
                if (
                  prev === "oauth_subscription" &&
                  newProvider !== "openai"
                ) {
                  return "api_key";
                }
                if (
                  prev === "platform" &&
                  (!managedInferenceConfigured ||
                    !providerSupportsPlatformAuth(newProvider))
                ) {
                  return "api_key";
                }
                return prev;
              });
              setCredential(`credential/${newProvider}/api_key`);
            }
            // Credential ref changes above trigger a new TQ query key,
            // so the presence check auto-refetches for the new provider.
          }}
          options={connectionProviderOptions.map((p) => ({
            value: p,
            label:
              p === preset?.provider
                ? preset.displayName
                : PROVIDER_DISPLAY_NAMES[p],
          }))}
        />
      </div>

      {/* Base URL + Models — openai-compatible only */}
      {isOpenAICompatible && !preset && (
        <>
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Base URL
            </label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              fullWidth
            />
          </div>
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Models
            </label>
            <Input
              value={connectionModels}
              onChange={(e) => setConnectionModels(e.target.value)}
              placeholder="model-1, model-2"
              fullWidth
            />
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              Comma-separated model identifiers exposed by your endpoint.
            </Typography>
            {modelsError && (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-(--system-negative-strong)"
              >
                {modelsError}
              </Typography>
            )}
          </div>
        </>
      )}

      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Connection method
        </label>
        <Dropdown
          aria-label="Auth type"
          value={authType}
          onChange={(v) => {
            setAuthType(v);
            setError(null);
          }}
          disabled={provider === "ollama"}
          options={(() => {
            let types: AuthType[];
            if (provider === "ollama") {
              types = ["none"];
            } else if (
              platformAuthAvailable
            ) {
              types = ["api_key", "platform"];
            } else {
              types = ["api_key"];
            }
            // Add oauth_subscription when ChatGPT flag is enabled for OpenAI.
            if (provider === "openai") {
              types.push("oauth_subscription");
            }
            return types.map((t) => ({
              value: t,
              label: AUTH_TYPE_DISPLAY_NAMES[t],
            }));
          })()}
        />
      </div>

      {/* API Key + Advanced disclosure — only shown for api_key auth */}
      {authType === "api_key" && (
        <ProviderEditorApiKeySection
          apiKeyValue={apiKeyValue}
          onApiKeyChange={setApiKeyValue}
          credential={credential}
          onCredentialChange={setCredential}
          isAuthLocked={false}
          isLoadingCredential={isLoadingCredential}
          apiKeyPlaceholder={apiKeyPlaceholder}
          credentialService={preset?.credentialName ?? provider}
          providerCredentials={providerCredentials}
          showAdvancedSection={shouldShowAdvancedSection}
          onError={setError}
        />
      )}

      {/* ChatGPT Subscription OAuth — shown when auth type is oauth_subscription */}
      {authType === "oauth_subscription" && (
        <ChatgptOAuthSection
          assistantId={assistantId}
          managedInferenceConfigured={managedInferenceConfigured}
          onConnected={onCreated}
        />
      )}

      {error && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {error}
        </Typography>
      )}
    </div>
  );

  const footer: ReactNode = (
    <>
      <Button variant="ghost" size="compact" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        variant="primary"
        size="compact"
        disabled={!canSave || saving || isSavingKey}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : "Create"}
      </Button>
    </>
  );

  if (variant === "inline") {
    return (
      <div className="space-y-4">
        {body}
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    );
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>Add model service</Modal.Title>
        <Modal.Description>
          Choose a provider and how Worklin should connect to it.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>{body}</Modal.Body>

      <Modal.Footer>{footer}</Modal.Footer>
    </Modal.Content>
  );
}
