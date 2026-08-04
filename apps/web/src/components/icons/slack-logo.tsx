import type { CSSProperties } from "react";

interface SlackLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function SlackLogo({ size = 24, className, style }: SlackLogoProps) {
  return (
    <img
      src="/images/integrations/slack.svg"
      alt=""
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden
    />
  );
}
