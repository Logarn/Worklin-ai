import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

import { resolveAssistantCharacter } from "@/components/avatar/assistant-character-packs";
import { FaceBuilderAvatar } from "@/components/avatar/face-builder-avatar";
import { TvCharacterAvatar } from "@/components/avatar/tv-character-avatar";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { AnimatedAvatar } from "./animated-avatar";

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
 * uploaded-image avatars — character avatars already signal streaming through
 * their morph animation. The arc + rotation live in CSS (`.avatar-streaming-ring`);
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
 * 1. Saved TV-character identity profile
 * 2. Animated character avatar from saved traits
 * 3. Custom uploaded image
 * 4. Default animated character avatar from first component of each type
 * 5. Worklin "W" fallback
 *
 * Animation:
 *   - Mount plays an entrance spring (scale 0.6 → 1, opacity 0 → 1).
 *   - When `interactive`, click triggers a spring bounce.
 *   - `prefers-reduced-motion` short-circuits both.
 *   - For custom uploaded-image avatars, a spinning semicircular ring traces
 *     just outside the avatar's edge while `isStreaming`/`isProcessing` is on
 *     (character avatars already signal streaming via their morph animation).
 */
function ChatAvatarComponent({
  components,
  traits,
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

  const effectiveTraits = useMemo(() => {
    if (traits) return traits;
    if (!components) return null;
    const body = components.bodyShapes[0];
    const eyes = components.eyeStyles[0];
    const color = components.colors[0];
    if (!body || !eyes || !color) return null;
    return { bodyShape: body.id, eyeStyle: eyes.id, color: color.id };
  }, [traits, components]);

  const hasCharacter = !!components && !!effectiveTraits;
  const preferCharacter = hasCharacter && (!!traits || !customImageUrl);

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

  if (
    characterProfile?.avatarStyle === "portrait_asset" &&
    characterProfile.portraitAssetUrl
  ) {
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
          src={characterProfile.portraitAssetUrl}
          alt={characterProfile.assistantName || "Assistant avatar"}
          width={size}
          height={size}
          className={`rounded-full object-cover ${className ?? ""}`}
          style={{ width: size, height: size, flexShrink: 0 }}
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

  if (preferCharacter) {
    return (
      <motion.div
        className={className}
        style={wrapperStyle}
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
      >
        <AnimatedAvatar
          components={components}
          traits={effectiveTraits}
          size={size}
          isStreaming={isStreaming}
        />
      </motion.div>
    );
  }

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

  return (
    <motion.div
      className={`flex items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--content-inset)] ${className ?? ""}`}
      style={{ ...wrapperStyle, fontSize: size * 0.45 }}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      W
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
