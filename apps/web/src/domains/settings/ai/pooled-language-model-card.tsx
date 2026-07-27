import { useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  POOLED_API_KEY_PROVIDERS,
  isPooledApiKeyProvider,
  type PooledApiKeyProvider,
} from "@/assistant/pooled-model-provider";
import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import {
  deletePooledProviderKey,
  savePooledProviderKey,
} from "@/domains/settings/ai/pooled-provider-keys";
import {
  secretsGetOptions,
  secretsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

export function PooledLanguageModelCard({
  assistantId,
}: {
  assistantId: string;
}) {
  const queryClient = useQueryClient();
  const secretsQuery = useQuery({
    ...secretsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const configuredProviders = useMemo(
    () =>
      (secretsQuery.data?.secrets ?? [])
        .filter(
          (secret) =>
            secret.type === "api_key" &&
            isPooledApiKeyProvider(secret.name),
        )
        .map((secret) => secret.name as PooledApiKeyProvider),
    [secretsQuery.data?.secrets],
  );
  const configuredProvider = configuredProviders[0] ?? null;
  const [provider, setProvider] = useState<PooledApiKeyProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (configuredProvider) setProvider(configuredProvider);
  }, [configuredProvider]);

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: secretsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
  };

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await savePooledProviderKey({ assistantId, provider, value: apiKey });
      setApiKey("");
      setSaved(true);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Worklin could not save this API key. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!configuredProvider) return;
    setDeleting(true);
    setError(null);
    setSaved(false);
    try {
      await deletePooledProviderKey({
        assistantId,
        provider: configuredProvider,
      });
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Worklin could not remove this API key. Please try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ByoServiceCard
      title="Your assistant's model"
      subtitle="Use your own provider API key. Worklin keeps it tenant-scoped and supplies it only while your pooled assistant is handling a request."
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] px-4 py-3 text-body-small-default text-[var(--content-tertiary)]">
          Pooled assistants use one supported model provider at a time. Worklin
          creates the connection automatically; custom endpoints, credential
          aliases, ChatGPT subscription sign-in, xAI, and Ollama need a
          dedicated assistant runtime.
        </div>

        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Model provider
          </label>
          <Dropdown
            aria-label="Model provider"
            value={provider}
            onChange={setProvider}
            disabled={configuredProvider !== null}
            options={POOLED_API_KEY_PROVIDERS.map((candidate) => ({
              value: candidate,
              label: PROVIDER_DISPLAY_NAMES[candidate] ?? candidate,
            }))}
          />
          {configuredProvider ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              Remove the current key before switching providers. Re-enter a key
              for {PROVIDER_DISPLAY_NAMES[configuredProvider] ?? configuredProvider} to rotate it.
            </Typography>
          ) : null}
        </div>

        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            API key
          </label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
              setSaved(false);
            }}
            placeholder={
              configuredProvider
                ? "Enter a replacement key"
                : "Enter your provider API key"
            }
            autoComplete="off"
            fullWidth
          />
        </div>

        {secretsQuery.isError ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-negative-strong)"
          >
            Worklin could not read the current provider-key status. Try again.
          </Typography>
        ) : null}
        {error ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-negative-strong)"
          >
            {error}
          </Typography>
        ) : null}
        {saved ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-positive-strong)"
          >
            API key saved. It will be used on the next assistant request.
          </Typography>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="compact"
            disabled={saving || deleting || apiKey.trim().length === 0}
            onClick={() => void handleSave()}
          >
            {saving
              ? "Saving…"
              : configuredProvider
                ? "Replace API key"
                : "Save API key"}
          </Button>
          {configuredProvider ? (
            <Button
              variant="dangerGhost"
              size="compact"
              disabled={saving || deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? "Removing…" : "Remove API key"}
            </Button>
          ) : null}
        </div>
      </div>
    </ByoServiceCard>
  );
}
