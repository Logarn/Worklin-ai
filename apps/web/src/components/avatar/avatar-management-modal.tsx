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
  DEFAULT_ASSISTANT_CHARACTER,
  WORKLIN_AVATAR_CHOICES,
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
import { PortraitAssetAvatar } from "@/components/avatar/portrait-asset-avatar";
import { TvCharacterAvatar } from "@/components/avatar/tv-character-avatar";
import {
  saveAssistantCharacterProfile,
  uploadAvatarImage,
} from "@/assistant/avatar-api";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";
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

function isWorklinAvatar(characterItem: AssistantCharacter | null): boolean {
  return !!characterItem && WORKLIN_AVATAR_CHOICES.includes(characterItem);
}

function createDraftProfile(
  profile: AssistantCharacterProfile | null,
): AssistantCharacterProfile {
  const characterItem = resolveAssistantCharacter(profile) ?? fallbackCharacter;
  if (!characterItem) {
    return {
      assistantName: "Spiky Spark",
      characterPackId: "worklin",
      characterId: "spiky_spark",
      avatarStyle: "portrait_asset",
      faceBuilder: faceBuilderForCharacter("worklin", "spiky_spark"),
      portraitAssetUrl: "/images/avatars/spiky-spark.mp4",
      portraitPrompt: buildCharacterPortraitPrompt("Spiky Spark", "Worklin"),
      personalityPreset: "playful",
      personalityText:
        "Respond with playful confidence, quick wit, and a slightly rebellious edge. Challenge weak assumptions, keep answers useful, and avoid being mean or chaotic. Use short sharp lines when appropriate.",
      role: "creative partner",
      tone: "Playful, confident, and sharp.",
      bio: "A mischievous challenger who keeps the work useful while poking holes in weak assumptions.",
      animationEnabled: true,
      accentColor: "#F36B3D",
      voicePlaceholder: "Quick, playful, lightly rebellious.",
      updatedAt: new Date().toISOString(),
    };
  }

  if (profile && isWorklinAvatar(resolveAssistantCharacter(profile))) {
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
  return (
    WORKLIN_AVATAR_CHOICES[
      Math.floor(Math.random() * WORKLIN_AVATAR_CHOICES.length)
    ] ??
    fallbackCharacter ??
    WORKLIN_AVATAR_CHOICES[0]!
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

function modalShellStyle() {
  return {
    backgroundColor: "rgba(11, 11, 10, 0.98)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    boxShadow: "0 32px 120px rgba(0, 0, 0, 0.5)",
  };
}

function modalPanelStyle() {
  return {
    backgroundColor: "rgba(15, 15, 14, 0.95)",
    borderColor: "rgba(255, 255, 255, 0.12)",
  };
}

function modalRaisedPanelStyle() {
  return {
    backgroundColor: "rgba(22, 22, 21, 0.98)",
    borderColor: "rgba(255, 255, 255, 0.12)",
  };
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
      const next = profileFromCharacter(characterItem, current);
      return {
        ...next,
        assistantName: characterItem.shortName,
      };
    });
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
      portraitAssetUrl: selectedCharacter.portraitAssetUrl,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 backdrop-blur-md p-3"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div
        className="flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border shadow-xl"
        style={{
          ...modalShellStyle(),
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
                style={modalPanelStyle()}
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
                            ...modalRaisedPanelStyle(),
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
                style={modalPanelStyle()}
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
                style={modalPanelStyle()}
              >
                <div className="flex min-h-[340px] items-center justify-center rounded-xl border p-5"
                  style={modalRaisedPanelStyle()}
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
            <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
              <section
                className="flex flex-col gap-4 rounded-xl border p-4"
                style={modalPanelStyle()}
              >
                <div>
                  <p
                    className="text-title-small"
                    style={{ color: "var(--content-default)" }}
                  >
                    Selected avatar
                  </p>
                  <p
                    className="mt-1 text-body-small-default"
                    style={labelStyle()}
                  >
                    {selectedCharacter?.subtitle ?? "Choose one style"}
                  </p>
                </div>

                <div className="flex justify-center py-3">
                  {draftProfile.avatarStyle === "portrait_asset" &&
                  draftProfile.portraitAssetUrl ? (
                    <PortraitAssetAvatar
                      src={draftProfile.portraitAssetUrl}
                      alt={`${draftProfile.assistantName} assistant avatar`}
                      size={164}
                      animationEnabled={draftProfile.animationEnabled}
                    />
                  ) : draftProfile.faceBuilder ? (
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

                <div
                  className="rounded-lg border p-3"
                  style={modalRaisedPanelStyle()}
                >
                  <p
                    className="text-title-small"
                    style={{ color: "var(--content-default)" }}
                  >
                    {selectedCharacter?.name ?? draftProfile.assistantName}
                  </p>
                  <p
                    className="mt-1 text-body-small-default"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    {selectedCharacter?.defaults.tone ?? draftProfile.tone}
                  </p>
                </div>

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
                    Customize face
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
                    {isUploading ? "Uploading..." : "Upload image"}
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
                    {isSavingProfile ? "Saving..." : "Save avatar"}
                  </button>
                </div>
              </section>

              <section className="min-w-0">
                <div className="mb-4">
                  <p
                    className="text-title-medium"
                    style={{ color: "var(--content-default)" }}
                  >
                    Choose your avatar
                  </p>
                  <p
                    className="mt-1 text-body-small-default"
                    style={labelStyle()}
                  >
                    Pick one assistant style. You can change it anytime.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {WORKLIN_AVATAR_CHOICES.map((characterItem) => {
                    const selected =
                      draftProfile.characterPackId === characterItem.packId &&
                      draftProfile.characterId === characterItem.id;
                    return (
                      <button
                        key={characterItem.id}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`Choose ${characterItem.name}: ${characterItem.subtitle}`}
                        onClick={() => handleCharacterSelect(characterItem)}
                        className="group flex min-h-48 flex-col items-center rounded-xl border p-4 text-center outline-none transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--content-default)]"
                        style={{
                          borderColor: selected
                            ? characterItem.visual.accent
                            : "rgba(255, 255, 255, 0.12)",
                          backgroundColor: selected
                            ? `color-mix(in oklab, ${characterItem.visual.accent} 16%, rgba(18, 18, 17, 0.98))`
                            : "rgba(18, 18, 17, 0.98)",
                        }}
                      >
                        {characterItem.portraitAssetUrl ? (
                          <PortraitAssetAvatar
                            src={characterItem.portraitAssetUrl}
                            poster={characterItem.portraitPosterUrl}
                            alt={`${characterItem.name} assistant avatar`}
                            size={88}
                            animationEnabled={draftProfile.animationEnabled}
                          />
                        ) : (
                          <TvCharacterAvatar
                            character={characterItem}
                            size={88}
                            interactive
                            selected={selected}
                            animationEnabled={draftProfile.animationEnabled}
                          />
                        )}
                        <span className="mt-3 min-w-0">
                          <span
                            className="block text-body-medium-default"
                            style={{ color: "var(--content-default)" }}
                          >
                            {characterItem.name}
                          </span>
                          <span
                            className="mt-1 block text-body-small-default"
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
