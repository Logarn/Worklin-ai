import { ChevronDown, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@vellumai/design-library/components/card";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import type { AvailableSound } from "@/domains/settings/api/sounds";
import {
  defaultSoundsConfig,
  displayLabelForFilename,
  SOUND_EVENT_DISPLAY_NAMES,
  SOUND_EVENT_IDS,
  type SoundEventConfig,
  type SoundEventId,
} from "@/domains/settings/types/sounds";
import {
  getSoundManager,
  type SoundPreviewResult,
} from "@/domains/settings/utils/sound-manager";
import {
  soundsAvailableGetOptions,
  soundsConfigGetOptions,
  soundsConfigGetSetQueryData,
  soundsConfigPutMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { SoundsConfigGetResponse } from "@/generated/daemon/types.gen";

type SoundsConfig = SoundsConfigGetResponse;

const VOLUME_COMMIT_DELAY_MS = 200;

type SoundPreviewFeedback =
  | { state: "idle" }
  | { state: "starting"; volume: number }
  | { state: "finished"; result: SoundPreviewResult; volume: number }
  | { state: "error" };

function soundPreviewMessage(feedback: SoundPreviewFeedback): string | null {
  if (feedback.state === "idle") return null;
  if (feedback.state === "starting") return "Starting audio preview...";
  if (feedback.state === "error") {
    return "The audio preview could not start. Try again.";
  }

  const percent = Math.round(feedback.volume * 100);
  switch (feedback.result) {
    case "played":
      return percent === 0
        ? "Preview started muted at 0% volume."
        : `Preview started at ${percent}% volume.`;
    case "played-fallback":
      return percent === 0
        ? "The selected sound was unavailable. The default preview started at 0% volume."
        : `The selected sound was unavailable. The default preview started at ${percent}% volume.`;
    case "blocked":
      return "Your browser blocked the audio preview. Allow audio and try again.";
    case "unsupported":
      return "Audio preview is not supported in this browser.";
    case "disabled":
      return "Turn on sound effects to preview audio.";
  }
}

async function resolveSoundPreview(
  play: () => Promise<SoundPreviewResult>,
  volume: number,
): Promise<SoundPreviewFeedback> {
  try {
    return { state: "finished", result: await play(), volume };
  } catch {
    return { state: "error" };
  }
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          {label}
        </div>
        {description && (
          <div className="text-body-small-default text-[var(--content-tertiary)]">
            {description}
          </div>
        )}
      </div>
      <Toggle
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        label={label}
      />
    </div>
  );
}

function Divider() {
  return <div className="border-t border-[var(--border-base)]" />;
}

function SoundEventRow({
  event,
  eventConfig,
  availableSounds,
  globalEnabled,
  volume,
  onToggle,
  onAddSound,
  onRemoveSound,
  onPreview,
}: {
  event: SoundEventId;
  eventConfig: SoundEventConfig;
  availableSounds: AvailableSound[];
  globalEnabled: boolean;
  volume: number;
  onToggle: (enabled: boolean) => void;
  onAddSound: (filename: string) => void;
  onRemoveSound: (filename: string) => void;
  onPreview: (filename: string) => Promise<SoundPreviewResult>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewFeedback, setPreviewFeedback] = useState<SoundPreviewFeedback>({
    state: "idle",
  });

  const remaining = availableSounds.filter(
    (s) => !eventConfig.sounds.includes(s.filename),
  );
  const allAdded = availableSounds.length > 0 && remaining.length === 0;
  const previewMessage = soundPreviewMessage(previewFeedback);

  const handlePreview = async (filename: string) => {
    setPreviewFeedback({ state: "starting", volume });
    setPreviewFeedback(
      await resolveSoundPreview(() => onPreview(filename), volume),
    );
  };

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {SOUND_EVENT_DISPLAY_NAMES[event]}
        </span>
        <Toggle
          checked={eventConfig.enabled}
          disabled={!globalEnabled}
          onChange={onToggle}
          label={`Enable ${SOUND_EVENT_DISPLAY_NAMES[event]}`}
        />
      </div>

      {eventConfig.enabled && (
        <div className="mt-2 space-y-1 pl-2">
          {eventConfig.sounds.length === 0 ? (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              Default Blip
            </p>
          ) : (
            eventConfig.sounds.map((filename) => (
              <div
                key={filename}
                className="flex items-center justify-between gap-2"
              >
                <span
                  className="truncate text-body-small-default text-[var(--content-secondary)]"
                  title={filename}
                >
                  {displayLabelForFilename(filename)}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handlePreview(filename)}
                    disabled={previewFeedback.state === "starting"}
                    className="inline-flex items-center rounded-md px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)] hover:bg-[var(--surface-base)] dark:text-[var(--content-disabled)] dark:hover:bg-[var(--ghost-hover)]"
                    aria-label={`Preview ${filename}`}
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveSound(filename)}
                    className="inline-flex items-center rounded-md px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)] hover:bg-[var(--surface-base)] dark:text-[var(--content-disabled)] dark:hover:bg-[var(--ghost-hover)]"
                    aria-label={`Remove ${filename}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}

          {previewMessage && (
            <p
              role="status"
              className="text-body-small-default text-[var(--content-tertiary)]"
            >
              {previewMessage}
            </p>
          )}

          {availableSounds.length === 0 ? (
            <p className="text-body-small-default italic text-[var(--content-disabled)]">
              No sound files yet. Drop audio files into data/sounds/ in your
              workspace.
            </p>
          ) : allAdded ? (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-base)] bg-white px-2 py-1 text-body-small-default text-[var(--content-disabled)] disabled:cursor-not-allowed dark:bg-[var(--surface-lift)] dark:text-[var(--content-tertiary)]"
            >
              All sounds added
            </button>
          ) : (
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-base)] bg-white px-2 py-1 text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-base)] dark:bg-[var(--surface-lift)] dark:hover:bg-[var(--ghost-hover)]"
              >
                Add sound
                <ChevronDown className="h-3 w-3" />
              </button>
              {pickerOpen && (
                <div
                  className="absolute left-0 z-10 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-[var(--border-base)] bg-white p-1 shadow-lg dark:bg-[var(--surface-lift)]"
                  onMouseLeave={() => setPickerOpen(false)}
                >
                  {remaining.map((s) => (
                    <button
                      key={s.filename}
                      type="button"
                      onClick={() => {
                        onAddSound(s.filename);
                        setPickerOpen(false);
                      }}
                      className="block w-full truncate rounded px-2 py-1 text-left text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-base)] dark:hover:bg-[var(--ghost-hover)]"
                      title={s.filename}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SoundsPage() {
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  const configOptions = useMemo(
    () => soundsConfigGetOptions({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const availableOptions = useMemo(
    () => soundsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const { data: rawConfig } = useQuery(configOptions);

  const { data: availableRaw } = useQuery(availableOptions);

  const config = rawConfig ?? defaultSoundsConfig();
  const available = availableRaw?.sounds ?? [];

  const sdkOptions = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const saveMutation = useMutation({
    ...soundsConfigPutMutation(sdkOptions),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: configOptions.queryKey });
      const previous = queryClient.getQueryData(configOptions.queryKey);
      soundsConfigGetSetQueryData(queryClient, sdkOptions, variables.body);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) {
        soundsConfigGetSetQueryData(queryClient, sdkOptions, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configOptions.queryKey });
    },
  });

  useEffect(() => {
    const manager = getSoundManager();
    manager.setAssistantId(assistantId || null);
    manager.setConfig(config);
    manager.setFeatureEnabled(true);
    return () => {
      manager.setFeatureEnabled(false);
    };
  }, [assistantId, config]);

  const updateConfig = useCallback(
    (producer: (prev: SoundsConfig) => SoundsConfig) => {
      const prev =
        queryClient.getQueryData(configOptions.queryKey) ??
        defaultSoundsConfig();
      const next = producer(prev);
      saveMutation.mutate({
        path: { assistant_id: assistantId },
        body: next,
      });
    },
    [assistantId, configOptions.queryKey, queryClient, saveMutation],
  );

  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const volumeCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingVolumeRef = useRef<number | null>(null);
  const configVolumeRef = useRef(config.volume);

  useEffect(() => {
    configVolumeRef.current = config.volume;
  }, [config.volume]);

  const clearVolumeCommitTimer = useCallback(() => {
    if (volumeCommitTimerRef.current === null) return;
    clearTimeout(volumeCommitTimerRef.current);
    volumeCommitTimerRef.current = null;
  }, []);

  const setGlobalEnabled = (enabled: boolean) => {
    updateConfig((prev) => ({ ...prev, globalEnabled: enabled }));
  };
  const commitVolume = useCallback(
    (volume: number) => {
      updateConfig((prev) => ({ ...prev, volume }));
    },
    [updateConfig],
  );

  const flushVolume = useCallback(
    (value?: number) => {
      clearVolumeCommitTimer();
      const next = value ?? pendingVolumeRef.current;
      pendingVolumeRef.current = null;
      if (next === null) return;
      if (next !== configVolumeRef.current) commitVolume(next);
      setDraftVolume(null);
    },
    [clearVolumeCommitTimer, commitVolume],
  );
  const flushVolumeRef = useRef(flushVolume);

  useEffect(() => {
    flushVolumeRef.current = flushVolume;
  }, [flushVolume]);

  useEffect(
    () => () => {
      flushVolumeRef.current();
    },
    [assistantId],
  );

  const updateDraftVolume = useCallback(
    (next: number) => {
      setDraftVolume(next);
      pendingVolumeRef.current = next;
      clearVolumeCommitTimer();
      volumeCommitTimerRef.current = setTimeout(
        () => flushVolume(),
        VOLUME_COMMIT_DELAY_MS,
      );
    },
    [clearVolumeCommitTimer, flushVolume],
  );

  const displayVolume = draftVolume ?? config.volume;

  const setEventEnabled = (event: SoundEventId, enabled: boolean) => {
    updateConfig((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [event]: {
          ...(prev.events[event] ?? { enabled: false, sounds: [] }),
          enabled,
        },
      },
    }));
  };

  const addSoundToEvent = (event: SoundEventId, filename: string) => {
    updateConfig((prev) => {
      const current = prev.events[event] ?? { enabled: true, sounds: [] };
      if (current.sounds.includes(filename)) return prev;
      return {
        ...prev,
        events: {
          ...prev.events,
          [event]: { ...current, sounds: [...current.sounds, filename] },
        },
      };
    });
  };

  const removeSoundFromEvent = (event: SoundEventId, filename: string) => {
    updateConfig((prev) => {
      const current = prev.events[event];
      if (!current) return prev;
      return {
        ...prev,
        events: {
          ...prev.events,
          [event]: {
            ...current,
            sounds: current.sounds.filter((s) => s !== filename),
          },
        },
      };
    });
  };

  const [previewFeedback, setPreviewFeedback] = useState<SoundPreviewFeedback>({
    state: "idle",
  });
  const previewMessage = soundPreviewMessage(previewFeedback);

  const previewDefault = async () => {
    const volume = displayVolume;
    setPreviewFeedback({ state: "starting", volume });
    setPreviewFeedback(
      await resolveSoundPreview(
        () => getSoundManager().previewFallbackBlip(volume),
        volume,
      ),
    );
  };
  const previewFile = (filename: string) => {
    return getSoundManager().previewSound(filename, displayVolume);
  };

  return (
    <div className="space-y-6">
      <Card>
        <ToggleRow
          label="Enable sound effects"
          description="Master switch for every event-driven sound."
          checked={config.globalEnabled}
          onChange={setGlobalEnabled}
        />
        <Divider />
        <div className="flex flex-wrap items-center gap-3 py-3">
          <label
            htmlFor="sound-effect-volume"
            className="text-body-medium-lighter text-[var(--content-default)]"
          >
            Volume
          </label>
          <input
            id="sound-effect-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={displayVolume}
            onChange={(event) =>
              updateDraftVolume(Number(event.currentTarget.value))
            }
            onPointerUp={(e) => {
              flushVolume(Number(e.currentTarget.value));
            }}
            onPointerCancel={(e) => {
              flushVolume(Number(e.currentTarget.value));
            }}
            onKeyUp={(e) => {
              flushVolume(Number(e.currentTarget.value));
            }}
            onBlur={(e) => {
              flushVolume(Number(e.currentTarget.value));
            }}
            className="h-6 w-full max-w-48 cursor-pointer accent-[var(--primary-base)]"
            disabled={!config.globalEnabled}
            aria-label="Sound effect volume"
            aria-valuetext={`${Math.round(displayVolume * 100)}%`}
          />
          <output
            htmlFor="sound-effect-volume"
            className="w-10 text-right tabular-nums text-body-small-default text-[var(--content-tertiary)]"
          >
            {Math.round(displayVolume * 100)}%
          </output>
        </div>
        <Divider />
        <div className="flex items-center justify-between py-3">
          <span className="text-body-medium-lighter text-[var(--content-default)]">
            Preview default blip
          </span>
          <button
            type="button"
            onClick={() => void previewDefault()}
            disabled={
              !config.globalEnabled || previewFeedback.state === "starting"
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-white px-3 py-1.5 text-body-medium-lighter text-[var(--content-default)] hover:bg-[var(--surface-base)] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[var(--surface-lift)] dark:hover:bg-[var(--ghost-hover)]"
          >
            <Play className="h-3.5 w-3.5" />
            Preview
          </button>
        </div>
        {previewMessage && (
          <p
            role="status"
            className="pb-1 text-body-small-default text-[var(--content-tertiary)]"
          >
            {previewMessage}
          </p>
        )}
      </Card>

      <Card>
        <div className="pb-2">
          <h3 className="text-title-small text-[var(--content-default)]">
            Sound Events
          </h3>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            Add one or more sounds per event. When multiple are configured, one
            plays at random.
          </p>
        </div>
        <div className="divide-y divide-[var(--border-base)]">
          {SOUND_EVENT_IDS.map((event) => (
            <SoundEventRow
              key={event}
              event={event}
              eventConfig={
                config.events[event] ?? { enabled: false, sounds: [] }
              }
              availableSounds={available}
              globalEnabled={config.globalEnabled}
              volume={displayVolume}
              onToggle={(enabled) => setEventEnabled(event, enabled)}
              onAddSound={(filename) => addSoundToEvent(event, filename)}
              onRemoveSound={(filename) =>
                removeSoundFromEvent(event, filename)
              }
              onPreview={previewFile}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
