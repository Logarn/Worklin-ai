import { useMemo, useState } from "react";
import { Link } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SaveButton, ByoServiceCard } from "@/domains/settings/ai/shared-ui";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

type LiveVoiceEngine = "native" | "hume" | "elevenlabs";

const ENGINE_OPTIONS: Array<{
  value: LiveVoiceEngine;
  label: string;
  description: string;
}> = [
  {
    value: "hume",
    label: "Hume",
    description: "Expressive, continuous speech-to-speech through Hume EVI.",
  },
  {
    value: "elevenlabs",
    label: "ElevenLabs",
    description:
      "Continuous conversational voice through ElevenLabs Agents.",
  },
  {
    value: "native",
    label: "Worklin Native",
    description:
      "Worklin's streaming fallback, using configured transcription and speech services.",
  },
];

function parseEngine(value: unknown): LiveVoiceEngine {
  return value === "hume" || value === "elevenlabs" ? value : "native";
}

/** Internal provider selector for the private continuous-voice pilot. */
export function LiveVoiceCard() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const [saving, setSaving] = useState(false);

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });

  const serverEngine = parseEngine(
    (daemonConfig?.services?.voice as { engine?: unknown } | undefined)?.engine,
  );
  const [engine, setEngine] = useDraftOverride(serverEngine);
  const selected = useMemo(
    () => ENGINE_OPTIONS.find((option) => option.value === engine)!,
    [engine],
  );

  if (!voiceMode) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { services: { voice: { engine } } },
      });
      toast.success("Live Voice provider saved.");
    } catch {
      toast.error("Live Voice provider could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ByoServiceCard
      id="live-voice"
      title="Live Voice"
      subtitle="Continuous, two-way voice conversation. This is separate from dictation and read-aloud."
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown<LiveVoiceEngine>
            value={engine}
            onChange={setEngine}
            options={ENGINE_OPTIONS.map(({ value, label }) => ({
              value,
              label,
            }))}
            aria-label="Live Voice provider"
          />
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {selected.description}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SaveButton
            onClick={() => void handleSave()}
            disabled={saving || engine === serverEngine}
          />
          {engine !== "native" && settingsDeveloperNav && (
            <Link
              to={`${routes.settings.developer}?tab=live-voice`}
              className="text-body-medium-default text-[var(--system-positive-strong)] underline hover:opacity-80"
            >
              Configure {selected.label} credentials
            </Link>
          )}
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            Private pilot
          </span>
        </div>
      </div>
    </ByoServiceCard>
  );
}
