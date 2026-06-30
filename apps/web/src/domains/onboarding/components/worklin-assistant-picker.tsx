import { Input } from "@vellumai/design-library/components/input";

import { PortraitAssetAvatar } from "@/components/avatar/portrait-asset-avatar";
import {
  WORKLIN_AVATAR_CHOICES,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";

interface WorklinAssistantPickerProps {
  selectedAvatarId: string;
  assistantName: string;
  onSelectAvatar: (avatar: AssistantCharacter) => void;
  onAssistantNameChange: (next: string) => void;
  renameLabel?: string;
  helperText?: string;
}

export function WorklinAssistantPicker({
  selectedAvatarId,
  assistantName,
  onSelectAvatar,
  onAssistantNameChange,
  renameLabel = "Want to rename them?",
  helperText = "Optional. You can change this later in chat.",
}: WorklinAssistantPickerProps) {
  const selectedAvatar =
    WORKLIN_AVATAR_CHOICES.find((avatar) => avatar.id === selectedAvatarId) ??
    WORKLIN_AVATAR_CHOICES[0] ??
    null;

  if (!selectedAvatar) return null;

  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-2xl border p-4"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
        }}
      >
        <p
          className="text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          Selected assistant
        </p>
        <div className="mt-3 flex items-center gap-4">
          <PortraitAssetAvatar
            src={selectedAvatar.portraitAssetUrl!}
            poster={selectedAvatar.portraitPosterUrl}
            alt={`${selectedAvatar.name} assistant avatar`}
            size={88}
            animationEnabled
          />
          <div className="min-w-0">
            <p
              className="text-body-large-default"
              style={{ color: "var(--content-default)" }}
            >
              {selectedAvatar.name}
            </p>
            <p
              className="text-body-small-default"
              style={{ color: "var(--content-secondary)" }}
            >
              {selectedAvatar.subtitle}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <Input
            label={renameLabel}
            placeholder={selectedAvatar.shortName}
            value={assistantName}
            onChange={(e) => onAssistantNameChange(e.target.value)}
            fullWidth
          />
          <p
            className="text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {helperText}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {WORKLIN_AVATAR_CHOICES.map((avatar) => {
          const selected = avatar.id === selectedAvatar.id;
          return (
            <button
              key={avatar.id}
              type="button"
              aria-pressed={selected}
              aria-label={`Select ${avatar.name}: ${avatar.subtitle}`}
              onClick={() => onSelectAvatar(avatar)}
              className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-center transition-colors"
              style={{
                backgroundColor: selected
                  ? "var(--surface-active)"
                  : "var(--surface-lift)",
                borderColor: selected
                  ? "var(--primary-base)"
                  : "var(--border-base)",
              }}
            >
              <PortraitAssetAvatar
                src={avatar.portraitAssetUrl!}
                poster={avatar.portraitPosterUrl}
                alt={`${avatar.name} assistant avatar`}
                size={80}
                animationEnabled
              />
              <div className="min-w-0">
                <p
                  className="text-body-medium-default"
                  style={{ color: "var(--content-default)" }}
                >
                  {avatar.name}
                </p>
                <p
                  className="text-body-small-default"
                  style={{ color: "var(--content-secondary)" }}
                >
                  {avatar.subtitle}
                </p>
              </div>
              <span
                className="text-label-small-default"
                style={{
                  color: selected
                    ? "var(--content-emphasised)"
                    : "var(--content-tertiary)",
                }}
              >
                {selected ? "Selected" : "Select"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
