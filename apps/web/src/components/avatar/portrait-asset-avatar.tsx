import { memo } from "react";
import { useReducedMotion } from "motion/react";

import { publicAsset } from "@/utils/public-asset";

interface PortraitAssetAvatarProps {
  src: string;
  poster?: string;
  alt?: string;
  size?: number;
  className?: string;
  animationEnabled?: boolean;
}

const VIDEO_EXTENSION_RE = /\.(mp4|webm|mov)(?:$|[?#])/i;

function resolveAssetUrl(src: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(src)) {
    return src;
  }
  return publicAsset(src);
}

function inferPosterUrl(src: string): string | undefined {
  if (!VIDEO_EXTENSION_RE.test(src)) {
    return undefined;
  }
  return src.replace(/\.(mp4|webm|mov)([?#].*)?$/i, "-poster.jpg$2");
}

function PortraitAssetAvatarComponent({
  src,
  poster,
  alt = "Assistant avatar",
  size = 28,
  className,
  animationEnabled = true,
}: PortraitAssetAvatarProps) {
  const reduce = useReducedMotion();
  const assetUrl = resolveAssetUrl(src);
  const posterUrl = poster ?? inferPosterUrl(src);
  const resolvedPosterUrl = posterUrl ? resolveAssetUrl(posterUrl) : undefined;
  const shouldAnimate = animationEnabled && !reduce && VIDEO_EXTENSION_RE.test(src);
  const sharedClassName = `rounded-full object-cover ${className ?? ""}`;
  const sharedStyle = {
    width: size,
    height: size,
    flexShrink: 0,
    backgroundColor: "#E9E9E5",
  };

  if (shouldAnimate) {
    return (
      <video
        src={assetUrl}
        poster={resolvedPosterUrl}
        width={size}
        height={size}
        className={sharedClassName}
        style={sharedStyle}
        autoPlay
        muted
        loop
        playsInline
        aria-label={alt}
      />
    );
  }

  return (
    <img
      src={resolvedPosterUrl ?? assetUrl}
      alt={alt}
      width={size}
      height={size}
      className={sharedClassName}
      style={sharedStyle}
    />
  );
}

export const PortraitAssetAvatar = memo(PortraitAssetAvatarComponent);
