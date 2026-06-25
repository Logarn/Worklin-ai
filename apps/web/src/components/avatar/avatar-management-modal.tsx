import {
  ChevronLeft,
  Image as ImageIcon,
  Shuffle,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  ASSISTANT_CHARACTER_PACKS,
  DEFAULT_ASSISTANT_CHARACTER,
  getAssistantCharacterPack,
  profileFromCharacter,
  resolveAssistantCharacter,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";
import {
  buildCharacterPortraitPrompt,
  DEFAULT_FACE_BUILDER,
  FACE_BUILDER_CATEGORIES,
  faceBuilderForCharacter,
  type FaceBuilderCategoryId,
} from "@/components/avatar/assistant-face-builder";
import { AvatarCustomizationPanel } from "@/components/avatar/avatar-customization-panel";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { FaceBuilderAvatar } from "@/components/avatar/face-builder-avatar";
import { TvCharacterAvatar } from "@/components/avatar/tv-character-avatar";
import {
  saveAssistantCharacterProfile,
  uploadAvatarImage,
} from "@/assistant/avatar-api";
import {
  ASSISTANT_PERSONALITY_PRESETS,
  ASSISTANT_ROLE_PRESETS,
  type AssistantCharacterPackId,
  type AssistantCharacterProfile,
} from "@/types/assistant-character-profile";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

type ModalView = "identity-studio" | "face-builder" | "character-builder";

interface AvatarManagementModalProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  characterProfile: AssistantCharacterProfile | null;
  onSaveCharacter: (traits: CharacterTraits) => void;
  onUploadImage: () => void;
  onSaveProfile: () => void;
  onGenerateWithAI?: () => void;
}

const fallbackCharacter = DEFAULT_ASSISTANT_CHARACTER;

function createDraftProfile(
  profile: AssistantCharacterProfile | null,
): AssistantCharacterProfile {
  const characterItem = resolveAssistantCharacter(profile) ?? fallbackCharacter;
  if (!characterItem) {
    return {
      assistantName: "Worklin",
      characterPackId: "futurama",
      characterId: "bender",
      avatarStyle: "face_builder",
      faceBuilder: faceBuilderForCharacter("futurama", "bender"),
      portraitPrompt: buildCharacterPortraitPrompt("Bender", "Futurama"),
      personalityPreset: "strategic",
      personalityText:
        "Strategic, direct, and useful for turning messy retention work into next actions.",
      role: "growth lead",
      tone: "Clear, confident, and practical.",
      bio: "A Worklin retention assistant for audits, opportunities, campaign packages, and QA.",
      animationEnabled: true,
      accentColor: "#111111",
      voicePlaceholder: "Clear, direct, and useful.",
      updatedAt: new Date().toISOString(),
    };
  }

  if (profile && resolveAssistantCharacter(profile)) {
    const packLabel =
      getAssistantCharacterPack(characterItem.packId)?.label ?? "Worklin";
    return {
      ...profile,
      avatarStyle: profile.avatarStyle ?? "face_builder",
      faceBuilder:
        profile.faceBuilder ??
        faceBuilderForCharacter(characterItem.packId, characterItem.id),
      portraitPrompt:
        profile.portraitPrompt ??
        buildCharacterPortraitPrompt(characterItem.name, packLabel),
      accentColor: characterItem.visual.accent,
      updatedAt: profile.updatedAt || new Date().toISOString(),
    };
  }

  return profileFromCharacter(characterItem, profile);
}

function pickRandomCharacter(): AssistantCharacter {
  const allCharacters = ASSISTANT_CHARACTER_PACKS.flatMap(
    (pack) => pack.characters,
  );
  return (
    allCharacters[Math.floor(Math.random() * allCharacters.length)] ??
    fallbackCharacter ??
    ASSISTANT_CHARACTER_PACKS[0]!.characters[0]!
  );
}

function inputStyle() {
  return {
    backgroundColor: "var(--surface-base)",
    borderColor: "var(--border-base)",
    color: "var(--content-default)",
  };
}

function labelStyle() {
  return { color: "var(--content-tertiary)" };
}

export function AvatarManagementModal({
  open,
  onClose,
  assistantId,
  components,
  traits,
  customImageUrl,
  characterProfile,
  onSaveCharacter,
  onUploadImage,
  onSaveProfile,
  onGenerateWithAI,
}: AvatarManagementModalProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<ModalView>("identity-studio");
  const [draftProfile, setDraftProfile] = useState<AssistantCharacterProfile>(
    () => createDraftProfile(characterProfile),
  );
  const [activePackId, setActivePackId] =
    useState<AssistantCharacterPackId>(draftProfile.characterPackId);
  const [activeFaceCategoryId, setActiveFaceCategoryId] =
    useState<FaceBuilderCategoryId>("skinTone");
  const [isUploading, setIsUploading] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextDraft = createDraftProfile(characterProfile);
    setDraftProfile(nextDraft);
    setActivePackId(nextDraft.characterPackId);
    setActiveFaceCategoryId("skinTone");
    setView("identity-studio");
    setSaveError(null);
    closeButtonRef.current?.focus();
  }, [characterProfile, open]);

  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  const selectedCharacter = useMemo(
    () => resolveAssistantCharacter(draftProfile) ?? fallbackCharacter,
    [draftProfile],
  );

  const activePack = useMemo(
    () =>
      getAssistantCharacterPack(activePackId) ??
      ASSISTANT_CHARACTER_PACKS[0]!,
    [activePackId],
  );

  const activeFaceCategory = useMemo(
    () =>
      FACE_BUILDER_CATEGORIES.find(
        (category) => category.id === activeFaceCategoryId,
      ) ?? FACE_BUILDER_CATEGORIES[0]!,
    [activeFaceCategoryId],
  );

  const faceBuilderConfig = useMemo(
    () =>
      draftProfile.faceBuilder ??
      (selectedCharacter
        ? faceBuilderForCharacter(
            selectedCharacter.packId,
            selectedCharacter.id,
          )
        : DEFAULT_FACE_BUILDER),
    [draftProfile.faceBuilder, selectedCharacter],
  );

  const handleClose = useCallback(() => {
    setView("identity-studio");
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view !== "identity-studio") {
          setView("identity-studio");
        } else {
          handleClose();
        }
      }
    },
    [handleClose, view],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleBack = useCallback(() => {
    setView("identity-studio");
  }, []);

  const handleBuildCharacter = useCallback(() => {
    setView("character-builder");
  }, []);

  const handleCustomizeFace = useCallback(() => {
    setDraftProfile((current) => ({
      ...current,
      avatarStyle: "face_builder",
      faceBuilder:
        current.faceBuilder ??
        (selectedCharacter
          ? faceBuilderForCharacter(
              selectedCharacter.packId,
              selectedCharacter.id,
            )
          : DEFAULT_FACE_BUILDER),
    }));
    setView("face-builder");
  }, [selectedCharacter]);

  const handleFaceOptionSelect = useCallback(
    (optionId: string) => {
      setDraftProfile((current) => ({
        ...current,
        avatarStyle: "face_builder",
        faceBuilder: {
          ...(current.faceBuilder ??
            (selectedCharacter
              ? faceBuilderForCharacter(
                  selectedCharacter.packId,
                  selectedCharacter.id,
                )
              : DEFAULT_FACE_BUILDER)),
          [activeFaceCategoryId]: optionId,
        },
      }));
      setSaveError(null);
    },
    [activeFaceCategoryId, selectedCharacter],
  );

  const handleProfileChange = useCallback(
    <K extends keyof AssistantCharacterProfile>(
      key: K,
      value: AssistantCharacterProfile[K],
    ) => {
      setDraftProfile((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const handleCharacterSelect = useCallback((characterItem: AssistantCharacter) => {
    setDraftProfile((current) => {
      const currentCharacter = resolveAssistantCharacter(current);
      const hasCustomName =
        current.assistantName.trim().length > 0 &&
        current.assistantName !== currentCharacter?.shortName;
      const next = profileFromCharacter(characterItem, current);
      return {
        ...next,
        assistantName: hasCustomName
          ? current.assistantName
          : characterItem.shortName,
      };
    });
    setActivePackId(characterItem.packId);
    setSaveError(null);
  }, []);

  const handleRandomize = useCallback(() => {
    handleCharacterSelect(pickRandomCharacter());
  }, [handleCharacterSelect]);

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      setIsUploading(true);
      const ok = await uploadAvatarImage(assistantId, file);
      setIsUploading(false);

      if (ok) {
        onUploadImage();
        handleClose();
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [assistantId, onUploadImage, handleClose],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    handleClose();
    onGenerateWithAI?.();
  }, [handleClose, onGenerateWithAI]);

  const handleCharacterSave = useCallback(
    (savedTraits: CharacterTraits) => {
      onSaveCharacter(savedTraits);
      handleClose();
    },
    [onSaveCharacter, handleClose],
  );

  const handleSaveProfile = useCallback(async () => {
    if (!selectedCharacter) {
      return;
    }
    const packLabel =
      getAssistantCharacterPack(selectedCharacter.packId)?.label ?? "Worklin";
    const profile: AssistantCharacterProfile = {
      ...draftProfile,
      assistantName: draftProfile.assistantName.trim() || selectedCharacter.shortName,
      avatarStyle: draftProfile.avatarStyle ?? "face_builder",
      faceBuilder:
        draftProfile.faceBuilder ??
        faceBuilderForCharacter(selectedCharacter.packId, selectedCharacter.id),
      portraitPrompt:
        draftProfile.portraitPrompt ??
        buildCharacterPortraitPrompt(selectedCharacter.name, packLabel),
      personalityText: draftProfile.personalityText.trim(),
      role: draftProfile.role.trim() || selectedCharacter.defaults.role,
      tone: draftProfile.tone.trim(),
      bio: draftProfile.bio.trim(),
      accentColor: selectedCharacter.visual.accent,
      voicePlaceholder:
        draftProfile.voicePlaceholder?.trim() ||
        selectedCharacter.defaults.voicePlaceholder,
      updatedAt: new Date().toISOString(),
    };

    setIsSavingProfile(true);
    setSaveError(null);
    const ok = await saveAssistantCharacterProfile(assistantId, profile);
    setIsSavingProfile(false);
    if (!ok) {
      setSaveError("Could not save the assistant identity.");
      return;
    }
    onSaveProfile();
    handleClose();
  }, [
    assistantId,
    draftProfile,
    handleClose,
    onSaveProfile,
    selectedCharacter,
  ]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div
        className="flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border shadow-xl"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
          maxHeight: "92vh",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--border-base)" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            {view !== "identity-studio" && (
              <button
                type="button"
                onClick={handleBack}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-base)]"
                aria-label="Back"
              >
                <ChevronLeft
                  className="h-4 w-4"
                  style={{ color: "var(--content-secondary)" }}
                />
              </button>
            )}
            <div className="min-w-0">
              <h2
                id={titleId}
                className="truncate text-title-small"
                style={{ color: "var(--content-default)" }}
              >
                {view === "face-builder"
                  ? "Customize Face"
                  : view === "character-builder"
                    ? "Classic Builder"
                    : "Assistant Identity"}
              </h2>
              {view === "face-builder" && (
                <p
                  className="truncate text-body-small-default"
                  style={labelStyle()}
                >
                  Pick each face part, then save the assistant identity.
                </p>
              )}
              {view === "identity-studio" && (
                <p
                  className="truncate text-body-small-default"
                  style={labelStyle()}
                >
                  {selectedCharacter
                    ? `${selectedCharacter.name} · ${selectedCharacter.subtitle}`
                    : "Choose a character"}
                </p>
              )}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-base)]"
            aria-label="Close"
          >
            <X
              className="h-4 w-4"
              style={{ color: "var(--content-secondary)" }}
            />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          {view === "character-builder" ? (
            <AvatarCustomizationPanel
              assistantId={assistantId}
              initialTraits={traits}
              onSave={handleCharacterSave}
              onCancel={handleBack}
            />
          ) : view === "face-builder" ? (
            <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,380px)_minmax(320px,1fr)]">
              <aside
                className="rounded-xl border p-2"
                style={{
                  backgroundColor: "var(--surface-base)",
                  borderColor: "var(--border-base)",
                }}
              >
                <div className="px-2 py-2">
                  <p
                    className="text-label-medium-default"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    Face controls
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  {FACE_BUILDER_CATEGORIES.map((category) => {
                    const active = category.id === activeFaceCategoryId;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        aria-label={category.label}
                        onClick={() => setActiveFaceCategoryId(category.id)}
                        className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-body-medium-default transition-colors"
                        style={{
                          backgroundColor: active
                            ? "var(--surface-active)"
                            : "transparent",
                          color: active
                            ? "var(--content-default)"
                            : "var(--content-secondary)",
                        }}
                      >
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-body-small-default"
                          style={{
                            borderColor: "var(--border-base)",
                            backgroundColor: "var(--surface-lift)",
                          }}
                        >
                          {category.icon}
                        </span>
                        <span className="truncate">{category.label}</span>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section
                className="rounded-xl border p-4"
                style={{
                  backgroundColor: "var(--surface-base)",
                  borderColor: "var(--border-base)",
                }}
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p
                      className="text-title-small"
                      style={{ color: "var(--content-default)" }}
                    >
                      {activeFaceCategory.label}
                    </p>
                    <p
                      className="mt-1 text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      Choose one. The preview updates instantly.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRandomize}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{
                      borderColor: "var(--border-base)",
                      color: "var(--content-default)",
                    }}
                  >
                    <Shuffle className="h-4 w-4" />
                    Random
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {activeFaceCategory.options.map((option) => {
                    const selected =
                      faceBuilderConfig[activeFaceCategory.id] === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-label={option.label}
                        onClick={() => handleFaceOptionSelect(option.id)}
                        className="group flex aspect-square flex-col items-center justify-center gap-3 rounded-xl border p-3 text-center transition-all hover:-translate-y-0.5 hover:shadow-md"
                        style={{
                          borderColor: selected
                            ? "var(--content-default)"
                            : "var(--border-base)",
                          backgroundColor: selected
                            ? "var(--surface-active)"
                            : "var(--surface-lift)",
                          color: "var(--content-default)",
                        }}
                      >
                        <span className="text-title-large">
                          {option.preview}
                        </span>
                        <span className="text-label-medium-default">
                          {option.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section
                className="flex flex-col gap-4 rounded-xl border p-5"
                style={{
                  backgroundColor: "var(--surface-base)",
                  borderColor: "var(--border-base)",
                }}
              >
                <div className="flex min-h-[340px] items-center justify-center rounded-xl border p-5"
                  style={{
                    backgroundColor: "var(--surface-lift)",
                    borderColor: "var(--border-base)",
                  }}
                >
                  <FaceBuilderAvatar
                    config={faceBuilderConfig}
                    size={300}
                    interactive
                    animationEnabled={draftProfile.animationEnabled}
                    label={draftProfile.assistantName}
                  />
                </div>

                <label className="flex flex-col gap-1">
                  <span
                    className="text-label-medium-default"
                    style={labelStyle()}
                  >
                    Portrait generation prompt
                  </span>
                  <textarea
                    value={draftProfile.portraitPrompt ?? ""}
                    onChange={(event) =>
                      handleProfileChange("portraitPrompt", event.target.value)
                    }
                    rows={5}
                    className="resize-none rounded-lg border px-3 py-2 text-body-small-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  />
                </label>

                {saveError && (
                  <p
                    className="text-body-small-default"
                    style={{ color: "var(--system-negative-strong)" }}
                  >
                    {saveError}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleBack}
                    className="rounded-lg px-4 py-2 text-body-medium-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{ color: "var(--content-secondary)" }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={isSavingProfile}
                    className="rounded-lg px-4 py-2 text-body-medium-default transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      backgroundColor: "var(--content-default)",
                      color: "var(--content-inset)",
                    }}
                  >
                    {isSavingProfile ? "Saving..." : "Save Identity"}
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
              <section
                className="flex flex-col gap-4 rounded-xl border p-4"
                style={{
                  backgroundColor: "var(--surface-base)",
                  borderColor: "var(--border-base)",
                }}
              >
                <div className="flex justify-center py-3">
                  {draftProfile.faceBuilder ? (
                    <FaceBuilderAvatar
                      config={faceBuilderConfig}
                      size={164}
                      interactive
                      animationEnabled={draftProfile.animationEnabled}
                      label={draftProfile.assistantName}
                    />
                  ) : selectedCharacter ? (
                    <TvCharacterAvatar
                      character={selectedCharacter}
                      size={164}
                      interactive
                      animationEnabled={draftProfile.animationEnabled}
                      label={draftProfile.assistantName}
                    />
                  ) : (
                    <ChatAvatar
                      components={components}
                      traits={traits}
                      customImageUrl={customImageUrl}
                      size={164}
                      interactive
                    />
                  )}
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Display name
                  </span>
                  <input
                    value={draftProfile.assistantName}
                    onChange={(event) =>
                      handleProfileChange("assistantName", event.target.value)
                    }
                    className="h-10 rounded-lg border px-3 text-body-medium-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Role
                  </span>
                  <select
                    value={draftProfile.role}
                    onChange={(event) =>
                      handleProfileChange("role", event.target.value)
                    }
                    className="h-10 rounded-lg border px-3 text-body-medium-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  >
                    {ASSISTANT_ROLE_PRESETS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Personality
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {ASSISTANT_PERSONALITY_PRESETS.map((preset) => {
                      const active = draftProfile.personalityPreset === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            const defaultText =
                              selectedCharacter?.defaults.personalityPreset === preset
                                ? selectedCharacter.defaults.personalityText
                                : `${preset[0]!.toUpperCase()}${preset.slice(1)} and useful.`;
                            setDraftProfile((current) => ({
                              ...current,
                              personalityPreset: preset,
                              personalityText: defaultText,
                            }));
                          }}
                          className="rounded-full border px-3 py-1.5 text-label-medium-default capitalize transition-colors"
                          style={{
                            borderColor: active
                              ? "var(--content-default)"
                              : "var(--border-base)",
                            backgroundColor: active
                              ? "var(--content-default)"
                              : "transparent",
                            color: active
                              ? "var(--content-inset)"
                              : "var(--content-default)",
                          }}
                        >
                          {preset}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Personality notes
                  </span>
                  <textarea
                    value={draftProfile.personalityText}
                    onChange={(event) =>
                      setDraftProfile((current) => ({
                        ...current,
                        personalityPreset: "custom",
                        personalityText: event.target.value,
                      }))
                    }
                    rows={3}
                    className="resize-none rounded-lg border px-3 py-2 text-body-small-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Tone
                  </span>
                  <input
                    value={draftProfile.tone}
                    onChange={(event) =>
                      handleProfileChange("tone", event.target.value)
                    }
                    className="h-10 rounded-lg border px-3 text-body-medium-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-label-medium-default" style={labelStyle()}>
                    Bio
                  </span>
                  <textarea
                    value={draftProfile.bio}
                    onChange={(event) =>
                      handleProfileChange("bio", event.target.value)
                    }
                    rows={3}
                    className="resize-none rounded-lg border px-3 py-2 text-body-small-default outline-none focus:border-[var(--border-active)]"
                    style={inputStyle()}
                  />
                </label>

                <label
                  className="flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2"
                  style={{ borderColor: "var(--border-base)" }}
                >
                  <span
                    className="text-body-medium-default"
                    style={{ color: "var(--content-default)" }}
                  >
                    Subtle animation
                  </span>
                  <input
                    type="checkbox"
                    checked={draftProfile.animationEnabled}
                    onChange={(event) =>
                      handleProfileChange(
                        "animationEnabled",
                        event.target.checked,
                      )
                    }
                    className="h-4 w-4 accent-[var(--content-default)]"
                  />
                </label>

                {saveError && (
                  <p
                    className="text-body-small-default"
                    style={{ color: "var(--system-negative-strong)" }}
                  >
                    {saveError}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleRandomize}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{
                      borderColor: "var(--border-base)",
                      color: "var(--content-default)",
                    }}
                  >
                    <Shuffle className="h-4 w-4" />
                    Randomize
                  </button>
                  <button
                    type="button"
                    onClick={handleCustomizeFace}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{
                      borderColor: "var(--border-base)",
                      color: "var(--content-default)",
                    }}
                  >
                    <Wrench className="h-4 w-4" />
                    Customize
                  </button>
                  <button
                    type="button"
                    onClick={handleBuildCharacter}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{
                      borderColor: "var(--border-base)",
                      color: "var(--content-secondary)",
                    }}
                  >
                    Classic
                  </button>
                  <button
                    type="button"
                    onClick={handleUploadClick}
                    disabled={isUploading}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      borderColor: "var(--border-base)",
                      color: "var(--content-default)",
                    }}
                  >
                    <ImageIcon className="h-4 w-4" />
                    {isUploading ? "Uploading..." : "Upload"}
                  </button>
                  {onGenerateWithAI && (
                    <button
                      type="button"
                      onClick={handleGenerateWithAI}
                      className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                      style={{
                        borderColor: "var(--border-base)",
                        color: "var(--content-default)",
                      }}
                    >
                      <Sparkles className="h-4 w-4" />
                      Generate
                    </button>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-lg px-4 py-2 text-body-medium-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{ color: "var(--content-secondary)" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={isSavingProfile}
                    className="rounded-lg px-4 py-2 text-body-medium-default transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                    style={{
                      backgroundColor: "var(--content-default)",
                      color: "var(--content-inset)",
                    }}
                  >
                    {isSavingProfile ? "Saving..." : "Save Identity"}
                  </button>
                </div>
              </section>

              <section className="min-w-0">
                <div className="mb-4 flex flex-wrap gap-2">
                  {ASSISTANT_CHARACTER_PACKS.map((pack) => {
                    const active = activePackId === pack.id;
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        onClick={() => setActivePackId(pack.id)}
                        className="rounded-full border px-4 py-2 text-body-small-default transition-colors"
                        style={{
                          borderColor: active
                            ? "var(--content-default)"
                            : "var(--border-base)",
                          backgroundColor: active
                            ? "var(--content-default)"
                            : "var(--surface-base)",
                          color: active
                            ? "var(--content-inset)"
                            : "var(--content-default)",
                        }}
                      >
                        {pack.label}
                      </button>
                    );
                  })}
                </div>

                <div
                  className="mb-4 rounded-xl border p-4"
                  style={{
                    borderColor: "var(--border-base)",
                    backgroundColor: "var(--surface-base)",
                  }}
                >
                  <p
                    className="text-title-small"
                    style={{ color: "var(--content-default)" }}
                  >
                    {activePack.label}
                  </p>
                  <p
                    className="mt-1 text-body-small-default"
                    style={labelStyle()}
                  >
                    {activePack.description}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {activePack.characters.map((characterItem) => {
                    const selected =
                      draftProfile.characterPackId === characterItem.packId &&
                      draftProfile.characterId === characterItem.id;
                    return (
                      <button
                        key={characterItem.id}
                        type="button"
                        onClick={() => handleCharacterSelect(characterItem)}
                        className="group flex min-h-24 items-center gap-3 rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
                        style={{
                          borderColor: selected
                            ? characterItem.visual.accent
                            : "var(--border-base)",
                          backgroundColor: selected
                            ? "color-mix(in oklab, var(--surface-active) 72%, var(--surface-lift))"
                            : "var(--surface-base)",
                        }}
                      >
                        <TvCharacterAvatar
                          character={characterItem}
                          size={58}
                          interactive
                          selected={selected}
                          animationEnabled={draftProfile.animationEnabled}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-body-medium-default"
                            style={{ color: "var(--content-default)" }}
                          >
                            {characterItem.name}
                          </span>
                          <span
                            className="mt-0.5 block line-clamp-2 text-body-small-default"
                            style={{ color: "var(--content-tertiary)" }}
                          >
                            {characterItem.subtitle}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>,
    document.body,
  );
}
