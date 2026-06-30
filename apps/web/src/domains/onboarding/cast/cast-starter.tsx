/**
 * Worklin onboarding avatar picker.
 *
 * This is the first durable assistant-choice moment in onboarding. Keep it
 * simple: the user sees the six supplied Worklin video avatars, picks one, and
 * the hatch flow persists that same avatar profile for the new assistant.
 */

import { useEffect, useMemo, useState } from "react";

import {
  WORKLIN_AVATAR_CHOICES,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";
import { WorklinAssistantPicker } from "@/domains/onboarding/components/worklin-assistant-picker";
import {
  buildCharacter,
  type CastCharacter,
} from "@/domains/onboarding/cast/cast-roster";
import type { StarterResume } from "@/domains/onboarding/cast/screens/screen-slot";

const CAST_PLACEHOLDERS: Record<
  string,
  { bodyShape: string; eyeStyle: string; color: string }
> = {
  spiky_spark: { bodyShape: "sprout", eyeStyle: "goofy", color: "yellow" },
  tin_grin: { bodyShape: "stack", eyeStyle: "grumpy", color: "teal" },
  dr_pinch: { bodyShape: "urchin", eyeStyle: "quirky", color: "orange" },
  sunny_square: { bodyShape: "star", eyeStyle: "curious", color: "yellow" },
  mystery_mutt: { bodyShape: "cloud", eyeStyle: "gentle", color: "green" },
  orbit_wink: { bodyShape: "ninja", eyeStyle: "bashful", color: "purple" },
};

function castCharacterForAvatar(avatar: AssistantCharacter): CastCharacter {
  const preset =
    CAST_PLACEHOLDERS[avatar.id] ?? CAST_PLACEHOLDERS.spiky_spark;
  return {
    ...buildCharacter(preset.bodyShape, preset.eyeStyle, preset.color),
    id: `worklin-${avatar.id}`,
    name: avatar.name,
  };
}

export function CastStarter({
  resume,
  onChoose,
  onCustomizing,
}: {
  resume?: StarterResume | null;
  onChoose: (
    character: CastCharacter,
    name: string,
    assistantAvatar?: AssistantCharacter | null,
  ) => void;
  onCustomizing?: (active: boolean) => void;
}) {
  const initialId =
    WORKLIN_AVATAR_CHOICES.find((avatar) => avatar.name === resume?.name)?.id ??
    WORKLIN_AVATAR_CHOICES[0]?.id ??
    "";
  const [selectedId, setSelectedId] = useState(initialId);
  const [assistantName, setAssistantName] = useState(
    resume?.name || WORKLIN_AVATAR_CHOICES[0]?.shortName || "",
  );

  useEffect(() => {
    onCustomizing?.(false);
  }, [onCustomizing]);

  const selectedAvatar = useMemo(
    () =>
      WORKLIN_AVATAR_CHOICES.find((avatar) => avatar.id === selectedId) ??
      WORKLIN_AVATAR_CHOICES[0] ??
      null,
    [selectedId],
  );

  const handleContinue = () => {
    if (!selectedAvatar) return;
    onChoose(
      castCharacterForAvatar(selectedAvatar),
      assistantName.trim() || selectedAvatar.shortName,
      selectedAvatar,
    );
  };

  const handleSelectAvatar = (avatar: AssistantCharacter) => {
    setSelectedId(avatar.id);
    setAssistantName(avatar.shortName);
  };

  return (
    <div className="cast-worklin-starter">
      <header className="cast-worklin-starter__header">
        <p className="cast-worklin-starter__eyebrow">Choose your assistant</p>
        <h1 className="cast-panel__title">Who should run Worklin with you?</h1>
        <p className="cast-panel__subtitle">
          Pick one avatar for your assistant, then rename them if you want. You
          can change it later.
        </p>
      </header>

      <WorklinAssistantPicker
        selectedAvatarId={selectedAvatar?.id ?? ""}
        assistantName={assistantName}
        onSelectAvatar={handleSelectAvatar}
        onAssistantNameChange={setAssistantName}
      />

      <button
        type="button"
        className="cast-worklin-starter__continue"
        disabled={!selectedAvatar}
        onClick={handleContinue}
      >
        Continue with {assistantName.trim() || selectedAvatar?.shortName || "this avatar"}
      </button>
    </div>
  );
}
