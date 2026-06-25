import { memo } from "react";

import {
  faceBuilderForCharacter,
} from "@/components/avatar/assistant-face-builder";
import type { AssistantCharacter } from "@/components/avatar/assistant-character-packs";
import { FaceBuilderAvatar } from "@/components/avatar/face-builder-avatar";

interface TvCharacterAvatarProps {
  character: AssistantCharacter;
  size?: number;
  className?: string;
  interactive?: boolean;
  animationEnabled?: boolean;
  selected?: boolean;
  label?: string;
}

function TvCharacterAvatarComponent({
  character,
  size = 28,
  className,
  interactive = false,
  animationEnabled = true,
  selected = false,
  label,
}: TvCharacterAvatarProps) {
  return (
    <FaceBuilderAvatar
      config={faceBuilderForCharacter(character.packId, character.id)}
      size={size}
      className={className}
      interactive={interactive}
      animationEnabled={animationEnabled}
      selected={selected}
      label={label ?? `${character.name} assistant avatar`}
    />
  );
}

export const TvCharacterAvatar = memo(TvCharacterAvatarComponent);
