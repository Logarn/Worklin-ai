import {
  Image as ImageIcon,
  Shuffle,
  Sparkles,
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
  profileFromCharacter,
  resolveAssistantCharacter,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";
import { PortraitAssetAvatar } from "@/components/avatar/portrait-asset-avatar";
import { TvCharacterAvatar } from "@/components/avatar/tv-character-avatar";
import { WorklinOrb } from "@/components/worklin-orb";
import {
  saveAssistantCharacterProfile,
  uploadAvatarImage,
} from "@/assistant/avatar-api";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";

interface AvatarManagementModalProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  characterProfile: AssistantCharacterProfile | null;
  onUploadImage: () => void;
  onSaveProfile: () => void;
  onGenerateWithAI?: () => void;
}

const fallbackCharacter = DEFAULT_ASSISTANT_CHARACTER;

function resolveCharacterAvatarStyle(
  profile: AssistantCharacterProfile | null | undefined,
  characterItem: AssistantCharacter,
): AssistantCharacterProfile["avatarStyle"] {
  if (profile?.avatarStyle) {
    return profile.avatarStyle;
  }

  return characterItem.portraitAssetUrl ? "portrait_asset" : "face_builder";
}

function mergeProfileWithCharacter(
  characterItem: AssistantCharacter,
  profile: AssistantCharacterProfile | null,
): AssistantCharacterProfile {
  const baseProfile = profileFromCharacter(characterItem, profile);
  if (!profile) {
    return baseProfile;
  }

  return {
    ...profile,
    assistantName: profile.assistantName.trim() || baseProfile.assistantName,
    characterPackId: characterItem.packId,
    characterId: characterItem.id,
    avatarStyle: resolveCharacterAvatarStyle(profile, characterItem),
    faceBuilder: profile.faceBuilder ?? baseProfile.faceBuilder,
    portraitAssetUrl: profile.portraitAssetUrl ?? baseProfile.portraitAssetUrl,
    portraitPrompt: profile.portraitPrompt ?? baseProfile.portraitPrompt,
    accentColor: characterItem.visual.accent,
    voicePlaceholder: profile.voicePlaceholder ?? baseProfile.voicePlaceholder,
    updatedAt: profile.updatedAt || baseProfile.updatedAt,
  };
}

function createDraftProfile(
  profile: AssistantCharacterProfile | null,
): AssistantCharacterProfile {
  const characterItem = resolveAssistantCharacter(profile) ?? fallbackCharacter;
  return mergeProfileWithCharacter(characterItem, profile);
}

function buildSavedProfile(
  selectedCharacter: AssistantCharacter,
  draftProfile: AssistantCharacterProfile,
): AssistantCharacterProfile {
  const baseProfile = profileFromCharacter(selectedCharacter, draftProfile);

  return {
    ...baseProfile,
    ...draftProfile,
    assistantName:
      draftProfile.assistantName.trim() || selectedCharacter.shortName,
    avatarStyle: draftProfile.avatarStyle ?? baseProfile.avatarStyle,
    faceBuilder: draftProfile.faceBuilder ?? baseProfile.faceBuilder,
    portraitAssetUrl:
      selectedCharacter.portraitAssetUrl ??
      draftProfile.portraitAssetUrl ??
      baseProfile.portraitAssetUrl,
    portraitPrompt:
      draftProfile.portraitPrompt ?? baseProfile.portraitPrompt,
    personalityText:
      draftProfile.personalityText.trim() ||
      selectedCharacter.defaults.personalityText,
    role: draftProfile.role.trim() || selectedCharacter.defaults.role,
    tone: draftProfile.tone.trim() || selectedCharacter.defaults.tone,
    bio: draftProfile.bio.trim() || selectedCharacter.defaults.bio,
    accentColor: selectedCharacter.visual.accent,
    voicePlaceholder:
      draftProfile.voicePlaceholder?.trim() ||
      selectedCharacter.defaults.voicePlaceholder,
    updatedAt: new Date().toISOString(),
  };
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
  characterProfile,
  onUploadImage,
  onSaveProfile,
  onGenerateWithAI,
}: AvatarManagementModalProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draftProfile, setDraftProfile] = useState<AssistantCharacterProfile>(
    () => createDraftProfile(characterProfile),
  );
  const [isUploading, setIsUploading] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraftProfile(createDraftProfile(characterProfile));
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

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        handleClose();
      }
    },
    [handleClose],
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

  const handleCharacterSelect = useCallback(
    (characterItem: AssistantCharacter) => {
      setDraftProfile((current) => ({
        ...profileFromCharacter(characterItem, current),
        assistantName: characterItem.shortName,
      }));
      setSaveError(null);
    },
    [],
  );

  const handleRandomize = useCallback(() => {
    handleCharacterSelect(pickRandomCharacter());
  }, [handleCharacterSelect]);

  const handleUseWorklinOrb = useCallback(() => {
    setDraftProfile((current) => ({
      ...current,
      avatarStyle: "abstract",
    }));
    setSaveError(null);
  }, []);

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
    [assistantId, handleClose, onUploadImage],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    handleClose();
    onGenerateWithAI?.();
  }, [handleClose, onGenerateWithAI]);

  const handleSaveProfile = useCallback(async () => {
    setIsSavingProfile(true);
    setSaveError(null);
    const ok = await saveAssistantCharacterProfile(
      assistantId,
      buildSavedProfile(selectedCharacter, draftProfile),
    );
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 p-3 backdrop-blur-md"
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
            <div className="min-w-0">
              <h2
                id={titleId}
                className="truncate text-title-small"
                style={{ color: "var(--content-default)" }}
              >
                Assistant Identity
              </h2>
              <p
                className="truncate text-body-small-default"
                style={labelStyle()}
              >
                {draftProfile.avatarStyle === "abstract"
                  ? "Worklin orb · Royal blue"
                  : selectedCharacter
                    ? `${selectedCharacter.name} · ${selectedCharacter.subtitle}`
                    : "Choose a character"}
              </p>
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
                    {draftProfile.avatarStyle === "abstract"
                      ? "Worklin orb"
                      : selectedCharacter?.subtitle ?? "Choose one style"}
                  </p>
                </div>

                <div className="flex justify-center py-3">
                  {draftProfile.avatarStyle === "abstract" ? (
                    <WorklinOrb
                      size={164}
                      decorative={false}
                    />
                  ) : draftProfile.portraitAssetUrl ? (
                    <PortraitAssetAvatar
                      src={draftProfile.portraitAssetUrl}
                      alt={`${draftProfile.assistantName} assistant avatar`}
                      size={164}
                      animationEnabled={draftProfile.animationEnabled}
                    />
                  ) : (
                    <TvCharacterAvatar
                      character={selectedCharacter}
                      size={164}
                      interactive
                      animationEnabled={draftProfile.animationEnabled}
                      label={draftProfile.assistantName}
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
                    {draftProfile.avatarStyle === "abstract"
                      ? "Worklin orb"
                      : selectedCharacter?.name ?? draftProfile.assistantName}
                  </p>
                  <p
                    className="mt-1 text-body-small-default"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    {draftProfile.avatarStyle === "abstract"
                      ? "Royal-blue Worklin assistant presence."
                      : selectedCharacter?.defaults.tone ?? draftProfile.tone}
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
                    onClick={handleUseWorklinOrb}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-body-small-default transition-colors hover:bg-[var(--surface-lift)]"
                    style={{
                      borderColor:
                        draftProfile.avatarStyle === "abstract"
                          ? "#4169e1"
                          : "var(--border-base)",
                      color: "var(--content-default)",
                    }}
                  >
                    <WorklinOrb size={16} />
                    Worklin orb
                  </button>
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
                    Keep the royal-blue Worklin orb or choose a character.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {WORKLIN_AVATAR_CHOICES.map((characterItem) => {
                    const selected =
                      draftProfile.characterPackId === characterItem.packId &&
                      draftProfile.characterId === characterItem.id &&
                      draftProfile.avatarStyle !== "abstract";
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
