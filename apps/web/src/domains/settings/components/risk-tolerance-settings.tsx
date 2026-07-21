import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@vellumai/design-library/components/card";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

import {
  getGlobalThresholds,
  setGlobalThresholds,
  type GlobalThresholds,
} from "@/lib/threshold-api";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  THRESHOLD_PRESETS,
  presetFromThreshold,
} from "@/utils/threshold-presets";

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

const PRESET_OPTIONS = THRESHOLD_PRESETS.map((p) => ({
  value: p.id,
  label: p.label,
  icon: <p.icon className="h-3.5 w-3.5" />,
}));

interface PresetSelection {
  interactiveId: string;
  autonomousId: string;
  headlessId: string;
}

const DEFAULT_SELECTION: PresetSelection = {
  interactiveId: "relaxed",
  autonomousId: "conservative",
  headlessId: "strict",
};

function selectionFromThresholds(
  thresholds: GlobalThresholds,
): PresetSelection {
  return {
    interactiveId: presetFromThreshold(thresholds.interactive).id,
    autonomousId: presetFromThreshold(thresholds.autonomous).id,
    headlessId: presetFromThreshold(thresholds.headless).id,
  };
}

function thresholdValuesFromSelection(
  selection: PresetSelection,
): GlobalThresholds | null {
  const interactive = THRESHOLD_PRESETS.find(
    (preset) => preset.id === selection.interactiveId,
  )?.riskThreshold;
  const autonomous = THRESHOLD_PRESETS.find(
    (preset) => preset.id === selection.autonomousId,
  )?.riskThreshold;
  const headless = THRESHOLD_PRESETS.find(
    (preset) => preset.id === selection.headlessId,
  )?.riskThreshold;
  if (!interactive || !autonomous || !headless) return null;
  return { interactive, autonomous, headless };
}

export function RiskToleranceSettings() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const queryClient = useQueryClient();
  const { data: thresholds, isError: loadError } = useQuery({
    queryKey: ["thresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId!),
    enabled: assistantId !== null,
    staleTime: 30_000,
    retry: false,
  });

  const [optimisticSelection, setOptimisticSelection] =
    useState<{
      assistantId: string;
      value: PresetSelection;
    } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveFailure, setSaveFailure] = useState<{
    assistantId: string;
    message: string;
  } | null>(null);

  const saveThresholds = useMutation({
    mutationFn: async ({
      targetAssistantId,
      next,
    }: {
      targetAssistantId: string;
      next: PresetSelection;
    }) => {
      const values = thresholdValuesFromSelection(next);
      if (!values) throw new Error("Invalid risk tolerance selection.");
      return setGlobalThresholds(targetAssistantId, values);
    },
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(
        ["thresholds", variables.targetAssistantId],
        updated,
      );
      setOptimisticSelection((current) =>
        current?.assistantId === variables.targetAssistantId ? null : current,
      );
      setSaveFailure((current) =>
        current?.assistantId === variables.targetAssistantId ? null : current,
      );
    },
    onError: (_error, variables) => {
      setOptimisticSelection((current) =>
        current?.assistantId === variables.targetAssistantId ? null : current,
      );
      setSaveFailure({
        assistantId: variables.targetAssistantId,
        message:
          "Could not save risk tolerance. Your previous setting is still active.",
      });
    },
  });

  const confirmedSelection = thresholds
    ? selectionFromThresholds(thresholds)
    : DEFAULT_SELECTION;
  const visibleSelection =
    optimisticSelection?.assistantId === assistantId
      ? optimisticSelection.value
      : confirmedSelection;
  const saveError =
    saveFailure?.assistantId === assistantId ? saveFailure.message : null;

  const persistSelection = useCallback(
    (next: PresetSelection) => {
      if (!assistantId || !thresholds || saveThresholds.isPending) return;
      setOptimisticSelection({ assistantId, value: next });
      setSaveFailure(null);
      saveThresholds.mutate({
        targetAssistantId: assistantId,
        next,
      });
    },
    [assistantId, saveThresholds, thresholds],
  );

  const handleInteractiveChange = useCallback(
    (presetId: string) => {
      persistSelection({ ...visibleSelection, interactiveId: presetId });
    },
    [persistSelection, visibleSelection],
  );

  const handleAutonomousChange = useCallback(
    (presetId: string) => {
      persistSelection({ ...visibleSelection, autonomousId: presetId });
    },
    [persistSelection, visibleSelection],
  );

  const handleHeadlessChange = useCallback(
    (presetId: string) => {
      persistSelection({ ...visibleSelection, headlessId: presetId });
    },
    [persistSelection, visibleSelection],
  );

  const interactivePreset = THRESHOLD_PRESETS.find(
    (preset) => preset.id === visibleSelection.interactiveId,
  );
  const autonomousPreset = THRESHOLD_PRESETS.find(
    (preset) => preset.id === visibleSelection.autonomousId,
  );
  const headlessPreset = THRESHOLD_PRESETS.find(
    (preset) => preset.id === visibleSelection.headlessId,
  );
  const dropdownsDisabled =
    !assistantId || !thresholds || saveThresholds.isPending;

  return (
    <Card>
      <h2 className="text-title-medium text-[var(--content-default)]">
        Risk Tolerance
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        Control which actions your assistant can take without asking first. Each
        action is classified by risk level — your tolerance determines which
        levels auto-approve.
      </p>
      {loadError && (
        <p className="mt-2 text-body-small-default text-[var(--system-negative-strong)]">
          Could not load threshold settings. Check your connection and reload.
        </p>
      )}
      {saveThresholds.isPending && (
        <p
          className="mt-2 text-body-small-default text-[var(--content-tertiary)]"
          role="status"
        >
          Saving risk tolerance…
        </p>
      )}
      {saveError && (
        <p
          className="mt-2 text-body-small-default text-[var(--system-negative-strong)]"
          role="alert"
        >
          {saveError}
        </p>
      )}
      <div className="mt-4 space-y-4">
        <div>
          <div className="text-body-medium-default text-[var(--content-default)]">
            Conversations
          </div>
          <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            When you&apos;re chatting with your assistant directly.
          </p>
          <div className="mt-2" style={{ maxWidth: 280 }}>
            <Dropdown
              aria-label="Conversation risk tolerance"
              value={visibleSelection.interactiveId}
              onChange={handleInteractiveChange}
              options={PRESET_OPTIONS}
              disabled={dropdownsDisabled}
            />
          </div>
          {interactivePreset && (
            <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
              {interactivePreset.description}
            </p>
          )}
        </div>

        <Divider />

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-1 text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <span className="text-body-medium-default">Advanced</span>
          </button>

          <div className={advancedOpen ? "mt-4 space-y-4" : "hidden"}>
            <div>
              <div className="text-body-medium-default text-[var(--content-default)]">
                Background
              </div>
              <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                When your assistant acts without you — scheduled tasks,
                background jobs, and external triggers.
              </p>
              <div className="mt-2" style={{ maxWidth: 280 }}>
                <Dropdown
                  aria-label="Background risk tolerance"
                  value={visibleSelection.autonomousId}
                  onChange={handleAutonomousChange}
                  options={PRESET_OPTIONS}
                  disabled={dropdownsDisabled}
                />
              </div>
              {autonomousPreset && (
                <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                  {autonomousPreset.description}
                </p>
              )}
            </div>

            <Divider />

            <div>
              <div className="text-body-medium-default text-[var(--content-default)]">
                Headless
              </div>
              <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                When triggered externally with no interactive client.
              </p>
              <div className="mt-2" style={{ maxWidth: 280 }}>
                <Dropdown
                  aria-label="Headless risk tolerance"
                  value={visibleSelection.headlessId}
                  onChange={handleHeadlessChange}
                  options={PRESET_OPTIONS}
                  disabled={dropdownsDisabled}
                />
              </div>
              {headlessPreset && (
                <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                  {headlessPreset.description}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
