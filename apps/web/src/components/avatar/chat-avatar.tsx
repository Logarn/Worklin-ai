import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

import { resolveAssistantCharacter } from "@/components/avatar/assistant-character-packs";
import { FaceBuilderAvatar } from "@/components/avatar/face-builder-avatar";
import { PortraitAssetAvatar } from "@/components/avatar/portrait-asset-avatar";
import { TvCharacterAvatar } from "@/components/avatar/tv-character-avatar";
import { WorklinOrb } from "@/components/worklin-orb";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

export interface ChatAvatarProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  characterProfile?: AssistantCharacterProfile | null;
  size?: number;
  className?: string;
  interactive?: boolean;
  isStreaming?: boolean;
  isProcessing?: boolean;
}

/** Ring geometry. Thickness is a fixed 1px hairline; gap scales with size. */
const RING_THICKNESS = 1; // border thickness in px
const RING_GAP_RATIO = 0.04; // gap between avatar edge and ring inner edge / size

/**
 * Spinning semicircular ring traced just outside the avatar's circular edge,
 * shown while the assistant is streaming/loading. Only used for custom
 * uploaded-image avatars. The arc + rotation live in CSS (`.avatar-streaming-ring`);
 * thickness/inset are inline so the ring scales with `size`. It sits in a gap
 * outside the image (negative inset) so it reads as a ring around the avatar
 * rather than covering the picture.
 */
function AvatarStreamingRing({ size }: { size: number }) {
  const thickness = RING_THICKNESS;
  const gap = Math.max(1, Math.round(size * RING_GAP_RATIO));
  const inset = -(thickness + gap);
  return (
    <span
      aria-hidden="true"
      className="avatar-streaming-ring pointer-events-none absolute"
      style={{
        top: inset,
        right: inset,
        bottom: inset,
        left: inset,
        borderWidth: thickness,
        boxSizing: "border-box",
      }}
    />
  );
}

/**
 * Displays the assistant's avatar in chat messages.
 *
 * Priority:
 * 1. Custom uploaded image
 * 2. Saved Worklin portrait asset from the identity profile
 * 3. Saved character-rendered avatar from the identity profile
 * 4. Royal-blue Worklin orb for legacy abstract profiles and default identity
 *
 * Animation:
 *   - Mount plays an entrance spring (scale 0.6 → 1, opacity 0 → 1).
 *   - When `interactive`, click triggers a spring bounce.
 *   - `prefers-reduced-motion` short-circuits both.
 *   - For custom uploaded-image avatars, a spinning semicircular ring traces
 *     just outside the avatar's edge while `isStreaming`/`isProcessing` is on.
 */
function ChatAvatarComponent({
  customImageUrl,
  characterProfile,
  size = 28,
  className,
  interactive = false,
  isStreaming = false,
  isProcessing = false,
}: ChatAvatarProps) {
  const reduce = useReducedMotion();
  const [isPoking, setIsPoking] = useState(false);
  const tvCharacter = useMemo(
    () => resolveAssistantCharacter(characterProfile),
    [characterProfile],
  );

  const triggerBounce = useCallback(() => {
    if (reduce) return;
    setIsPoking(true);
    window.setTimeout(() => setIsPoking(false), 360);
  }, [reduce]);

  const handleClick = interactive ? triggerBounce : undefined;

  const wrapperStyle: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    cursor: interactive ? "pointer" : undefined,
    transformOrigin: "center",
    position: "relative",
  };

  const transition = reduce
    ? { duration: 0 }
    : { type: "spring" as const, visualDuration: 0.3, bounce: 0.5 };

  const initial = reduce
    ? { scale: 1, opacity: 1 }
    : { scale: 0.6, opacity: 0 };
  const animate = { scale: isPoking ? 1.15 : 1, opacity: 1 };

  if (customImageUrl) {
    return (
      <motion.div
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
        style={{
          cursor: interactive ? "pointer" : undefined,
          transformOrigin: "center",
          position: "relative",
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <img
          src={customImageUrl}
          alt="Assistant avatar"
          width={size}
          height={size}
          className={`rounded-full object-cover ${className ?? ""}`}
          style={{ width: size, height: size, flexShrink: 0 }}
        />
        {(isStreaming || isProcessing) && <AvatarStreamingRing size={size} />}
      </motion.div>
    );
  }

  if (characterProfile?.avatarStyle === "abstract") {
    return (
      <motion.div
        className={className}
        style={wrapperStyle}
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
      >
        <WorklinOrb
          state={isStreaming ? "speaking" : isProcessing ? "thinking" : "idle"}
          outputAmplitude={isStreaming ? 0.45 : 0}
          size={size}
          decorative={false}
        />
      </motion.div>
    );
  }

  if (characterProfile?.portraitAssetUrl) {
    return (
      <motion.div
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
        style={{
          cursor: interactive ? "pointer" : undefined,
          transformOrigin: "center",
          position: "relative",
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <PortraitAssetAvatar
          src={characterProfile.portraitAssetUrl}
          alt={characterProfile.assistantName || "Assistant avatar"}
          size={size}
          className={className}
          animationEnabled={characterProfile.animationEnabled ?? true}
        />
        {(isStreaming || isProcessing) && <AvatarStreamingRing size={size} />}
      </motion.div>
    );
  }

  if (characterProfile?.faceBuilder) {
    return (
      <motion.div
        className={className}
        style={wrapperStyle}
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
      >
        <FaceBuilderAvatar
          config={characterProfile.faceBuilder}
          size={size}
          interactive={interactive}
          animationEnabled={characterProfile.animationEnabled ?? true}
          label={characterProfile.assistantName}
        />
      </motion.div>
    );
  }

  if (tvCharacter) {
    return (
      <motion.div
        className={className}
        style={wrapperStyle}
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
      >
        <TvCharacterAvatar
          character={tvCharacter}
          size={size}
          interactive={interactive}
          animationEnabled={characterProfile?.animationEnabled ?? true}
          label={characterProfile?.assistantName}
        />
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      style={wrapperStyle}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      <WorklinOrb
        state={isStreaming ? "speaking" : isProcessing ? "thinking" : "idle"}
        outputAmplitude={isStreaming ? 0.45 : 0}
        size={size}
        decorative={false}
      />
    </motion.div>
  );
}

/**
 * Memoized so the avatar subtree only re-renders when its own props change
 * (components/traits/image, size, the streaming/processing flags) rather than
 * on every parent transcript re-render. `Transcript` is a `forwardRef` (not
 * memoized) and re-renders frequently during streaming, while the avatar runs
 * per-frame animation work — so skipping unrelated re-renders matters. All
 * props are primitives or stable references (avatar data is React-Query-cached
 * with `staleTime: Infinity`), so the default shallow comparison is correct.
 */
export const ChatAvatar = memo(ChatAvatarComponent);
