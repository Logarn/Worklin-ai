import { memo, type CSSProperties, type ReactNode } from "react";

import type { AssistantFaceBuilderConfig } from "@/types/assistant-character-profile";

interface FaceBuilderAvatarProps {
  config: AssistantFaceBuilderConfig;
  size?: number;
  className?: string;
  interactive?: boolean;
  animationEnabled?: boolean;
  selected?: boolean;
  label?: string;
}

const skinColors: Record<string, string> = {
  paper: "#F8F6EF",
  pale: "#E9D9B8",
  yellow: "#FFD84E",
  tan: "#DDA173",
  brown: "#8C5A3C",
  steel: "#B7C5CC",
  red: "#F17163",
  green: "#91D77B",
};

const hairColors: Record<string, string> = {
  none: "#111111",
  messy: "#111111",
  spiky: "#111111",
  short: "#111111",
  swoop: "#C7562D",
  tall: "#243B86",
  buns: "#111111",
  tentacles: "#C94940",
  tuft: "#D7D7D2",
  antenna: "#9AA8AE",
};

const backdropColors: Record<string, { bg: string; glow: string; accent: string }> = {
  white: { bg: "#F6F4EF", glow: "#E6E2D9", accent: "#111111" },
  black: { bg: "#080808", glow: "#343434", accent: "#FFFFFF" },
  navy: { bg: "#071827", glow: "#17364D", accent: "#FFFFFF" },
  portal: { bg: "#081410", glow: "#32F06D", accent: "#39FF88" },
  warm: { bg: "#FFF4D6", glow: "#F4B65E", accent: "#15110B" },
};

function getLineStyle(config: AssistantFaceBuilderConfig) {
  return {
    strokeWidth: config.lineStyle === "ink" ? 4.8 : 4,
    strokeDasharray: config.lineStyle === "halftone" ? "2 5" : undefined,
  };
}

function Hair({
  style,
  fill,
  ink,
}: {
  style: string;
  fill: string;
  ink: string;
}) {
  if (style === "none") return null;

  if (style === "spiky") {
    return (
      <path
        d="M29 36 L34 16 L39 35 L45 14 L50 36 L57 15 L62 36 L69 18 L70 39 C56 30 42 30 29 36 Z"
        fill={fill}
        stroke={ink}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
    );
  }

  if (style === "short") {
    return (
      <path
        d="M29 34 C35 21 63 21 70 35 C59 29 40 29 29 34 Z"
        fill={fill}
        stroke={ink}
        strokeWidth="3.5"
      />
    );
  }

  if (style === "swoop") {
    return (
      <path
        d="M27 38 C34 17 62 17 74 30 C59 29 54 44 35 43 C31 43 28 41 27 38 Z"
        fill={fill}
        stroke={ink}
        strokeWidth="3.5"
      />
    );
  }

  if (style === "tall") {
    return (
      <path
        d="M33 34 C30 14 35 2 49 2 C65 2 70 15 66 36 C57 30 43 29 33 34 Z"
        fill={fill}
        stroke={ink}
        strokeWidth="3.5"
      />
    );
  }

  if (style === "buns") {
    return (
      <>
        <circle cx="27" cy="38" r="9" fill={fill} stroke={ink} strokeWidth="3.5" />
        <circle cx="73" cy="38" r="9" fill={fill} stroke={ink} strokeWidth="3.5" />
        <path
          d="M32 35 C39 24 60 24 68 35"
          fill="none"
          stroke={fill}
          strokeWidth="10"
          strokeLinecap="round"
        />
      </>
    );
  }

  if (style === "tentacles") {
    return (
      <g fill="none" stroke={fill} strokeWidth="7" strokeLinecap="round">
        <path d="M32 32 C28 43 31 49 24 56" />
        <path d="M43 28 C39 43 43 48 37 59" />
        <path d="M55 28 C51 43 56 50 49 61" />
        <path d="M67 32 C62 44 67 49 61 58" />
      </g>
    );
  }

  if (style === "tuft") {
    return (
      <path
        d="M38 33 C38 20 49 17 47 31 C52 20 63 23 57 36 C50 31 44 31 38 33 Z"
        fill={fill}
        stroke={ink}
        strokeWidth="3.5"
      />
    );
  }

  if (style === "antenna") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="4">
        <path d="M50 24 V8" />
        <circle cx="50" cy="6" r="4" fill={fill} />
      </g>
    );
  }

  return (
    <path
      d="M28 37 C33 20 64 19 72 38 C58 31 41 31 28 37 Z"
      fill={fill}
      stroke={ink}
      strokeWidth="3.5"
    />
  );
}

function Eyes({ style, ink }: { style: string; ink: string }) {
  const eyeClass = "face-builder-avatar__eye tv-character-avatar__eye";

  if (style === "one") {
    return <circle className={eyeClass} cx="50" cy="50" r="8" fill={ink} />;
  }

  if (style === "visor") {
    return (
      <rect
        className={eyeClass}
        x="31"
        y="45"
        width="38"
        height="12"
        rx="6"
        fill={ink}
      />
    );
  }

  if (style === "sleepy") {
    return (
      <g className={eyeClass} fill="none" stroke={ink} strokeLinecap="round" strokeWidth="4">
        <path d="M33 49 C38 45 43 45 47 49" />
        <path d="M53 49 C58 45 63 45 67 49" />
      </g>
    );
  }

  if (style === "spiral") {
    return (
      <g className={eyeClass} fill="none" stroke={ink} strokeLinecap="round" strokeWidth="2.7">
        <path d="M41 50 C34 47 35 39 42 39 C49 39 50 49 42 50" />
        <path d="M59 50 C52 47 53 39 60 39 C67 39 68 49 60 50" />
      </g>
    );
  }

  if (style === "heart") {
    return (
      <g className={eyeClass} fill={ink}>
        <path d="M34 43 C34 38 41 37 43 42 C45 37 52 38 52 43 C52 49 43 54 43 54 C43 54 34 49 34 43 Z" transform="scale(.55) translate(32 38)" />
        <path d="M34 43 C34 38 41 37 43 42 C45 37 52 38 52 43 C52 49 43 54 43 54 C43 54 34 49 34 43 Z" transform="scale(.55) translate(72 38)" />
      </g>
    );
  }

  const radius = style === "wide" ? 6 : style === "tiny" ? 2.6 : 4.2;
  return (
    <g className={eyeClass} fill={ink}>
      <circle cx="40" cy="49" r={radius} />
      <circle cx="60" cy="49" r={radius} />
    </g>
  );
}

function Brows({ style, ink }: { style: string; ink: string }) {
  if (style === "none") return null;
  const props = { fill: "none", stroke: ink, strokeLinecap: "round" as const, strokeWidth: 3.4 };

  if (style === "sharp") {
    return (
      <g {...props}>
        <path d="M31 39 L46 35" />
        <path d="M54 35 L69 39" />
      </g>
    );
  }

  if (style === "worried") {
    return (
      <g {...props}>
        <path d="M32 36 L46 41" />
        <path d="M54 41 L68 36" />
      </g>
    );
  }

  if (style === "flat") {
    return (
      <g {...props}>
        <path d="M31 38 H46" />
        <path d="M54 38 H69" />
      </g>
    );
  }

  if (style === "heavy") {
    return (
      <g stroke={ink} strokeLinecap="round" strokeWidth="5">
        <path d="M31 38 H47" />
        <path d="M53 38 H69" />
      </g>
    );
  }

  return (
    <g {...props}>
      <path d="M31 39 C36 35 42 35 47 39" />
      <path d="M53 39 C58 35 64 35 69 39" />
    </g>
  );
}

function Eyewear({ style, ink }: { style: string; ink: string }) {
  if (style === "none") return null;
  const props = { fill: "none", stroke: ink, strokeWidth: 3, strokeLinecap: "round" as const };

  if (style === "visor") {
    return <rect x="28" y="42" width="44" height="16" rx="8" fill="none" stroke={ink} strokeWidth="3" />;
  }

  if (style === "monocle") {
    return (
      <g {...props}>
        <circle cx="60" cy="49" r="10" />
        <path d="M68 56 L76 67" />
      </g>
    );
  }

  const rx = style === "square" ? 3 : 9;
  return (
    <g {...props}>
      <rect x="29" y="41" width="20" height="17" rx={rx} />
      <rect x="51" y="41" width="20" height="17" rx={rx} />
      <path d="M49 49 H51" />
    </g>
  );
}

function Nose({ style, ink }: { style: string; ink: string }) {
  if (style === "none") return null;
  const props = { fill: "none", stroke: ink, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 3.6 };

  if (style === "long") return <path {...props} d="M50 49 C49 58 45 61 53 64" />;
  if (style === "button") return <circle cx="50" cy="59" r="3.2" fill={ink} />;
  if (style === "hook") return <path {...props} d="M52 46 C48 55 49 62 57 63 C59 63 60 62 60 61" />;
  if (style === "angular") return <path {...props} d="M50 48 L47 61 H55" />;
  return <path {...props} d="M50 49 L48 61" />;
}

function Mouth({ style, ink }: { style: string; ink: string }) {
  const props = { fill: "none", stroke: ink, strokeLinecap: "round" as const, strokeWidth: 4 };

  if (style === "open") return <ellipse cx="50" cy="72" rx="10" ry="6" fill={ink} opacity="0.9" />;
  if (style === "smirk") return <path {...props} d="M39 70 C47 76 58 75 64 68" />;
  if (style === "flat") return <path {...props} d="M40 72 H60" />;
  if (style === "grimace") {
    return (
      <g>
        <rect x="39" y="66" width="22" height="10" rx="3" fill="none" stroke={ink} strokeWidth="3" />
        <path d="M40 71 H60" stroke={ink} strokeWidth="2" />
      </g>
    );
  }
  if (style === "beard") {
    return (
      <g {...props}>
        <path d="M38 70 C45 81 56 81 63 70" />
        <path d="M36 77 C44 88 56 88 64 77" strokeDasharray="2 5" />
      </g>
    );
  }
  if (style === "mustache") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="3.5">
        <path d="M38 67 C43 62 47 63 50 67" />
        <path d="M50 67 C53 63 58 62 63 67" />
        <path d="M40 73 C47 78 55 78 61 72" strokeWidth="3" />
      </g>
    );
  }
  return <path {...props} d="M38 68 C44 77 56 77 62 68" />;
}

function Accessories({
  style,
  ink,
  accent,
}: {
  style: string;
  ink: string;
  accent: string;
}) {
  if (style === "none") return null;

  if (style === "lab") {
    return (
      <g>
        <path d="M33 82 L28 98 H72 L67 82 Z" fill="#FFFFFF" stroke={ink} strokeWidth="3" />
        <path d="M46 82 L50 94 L54 82" fill="none" stroke={ink} strokeWidth="2.5" />
      </g>
    );
  }

  if (style === "crown") {
    return <path d="M34 28 L40 14 L50 26 L60 14 L66 28 Z" fill={accent} stroke={ink} strokeWidth="3" />;
  }

  if (style === "antenna") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="3">
        <path d="M50 22 C53 15 59 12 64 8" />
        <circle cx="66" cy="7" r="3.5" fill={accent} />
      </g>
    );
  }

  if (style === "earring") {
    return <circle cx="75" cy="61" r="3.8" fill={accent} stroke={ink} strokeWidth="2" />;
  }

  if (style === "tie") {
    return <path d="M50 84 L44 96 L50 103 L56 96 Z" fill={accent} stroke={ink} strokeWidth="2.8" />;
  }

  return null;
}

function Halftone({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  const dots: ReactNode[] = [];
  for (let y = 36; y <= 80; y += 7) {
    for (let x = 31; x <= 69; x += 7) {
      dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="#000000" opacity="0.15" />);
    }
  }
  return <g>{dots}</g>;
}

function FaceBuilderAvatarComponent({
  config,
  size = 28,
  className,
  interactive = false,
  animationEnabled = true,
  selected = false,
  label,
}: FaceBuilderAvatarProps) {
  const skin = skinColors[config.skinTone] ?? skinColors.paper;
  const hair = hairColors[config.hair] ?? hairColors.messy;
  const backdrop = backdropColors[config.background] ?? backdropColors.white;
  const ink = config.background === "black" || config.background === "navy" ? "#070707" : "#111111";
  const line = getLineStyle(config);
  const cssVars = {
    "--tv-bg": backdrop.bg,
    "--tv-face": skin,
    "--tv-accent": backdrop.accent,
    "--tv-secondary": backdrop.glow,
    "--tv-ink": ink,
  } as CSSProperties;

  return (
    <span
      className={[
        "tv-character-avatar face-builder-avatar relative inline-flex shrink-0 items-center justify-center rounded-full",
        interactive ? "tv-character-avatar--interactive" : "",
        selected ? "tv-character-avatar--selected" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-animated={animationEnabled ? "true" : "false"}
      style={{ ...cssVars, width: size, height: size }}
      aria-label={label ?? "Assistant avatar"}
    >
      <svg viewBox="0 0 100 100" role="img" aria-hidden="true" className="h-full w-full overflow-visible">
        <circle cx="50" cy="50" r="48" fill={backdrop.bg} />
        <circle cx="50" cy="42" r="34" fill={backdrop.glow} opacity="0.35" />
        {config.background === "portal" && (
          <path
            d="M22 52 C18 30 35 17 56 21 C76 24 86 41 80 61 C73 81 45 86 29 70"
            fill="none"
            stroke={backdrop.accent}
            strokeWidth="4"
            strokeDasharray="5 5"
            opacity="0.8"
          />
        )}
        <ellipse cx="27" cy="55" rx="7" ry="10" fill={skin} stroke={ink} strokeWidth="3" />
        <ellipse cx="73" cy="55" rx="7" ry="10" fill={skin} stroke={ink} strokeWidth="3" />
        <path
          d="M28 40 C30 22 70 22 72 40 L72 64 C72 82 61 91 50 91 C39 91 28 82 28 64 Z"
          fill={skin}
          stroke={ink}
          strokeWidth={line.strokeWidth}
          strokeDasharray={line.strokeDasharray}
          strokeLinejoin="round"
        />
        <Halftone enabled={config.lineStyle === "halftone"} />
        <Hair style={config.hair} fill={hair} ink={ink} />
        <Brows style={config.brows} ink={ink} />
        <Eyes style={config.eyes} ink={ink} />
        <Eyewear style={config.eyewear} ink={ink} />
        <Nose style={config.nose} ink={ink} />
        <Mouth style={config.mouth} ink={ink} />
        <Accessories style={config.accessories} ink={ink} accent={backdrop.accent} />
      </svg>
    </span>
  );
}

export const FaceBuilderAvatar = memo(FaceBuilderAvatarComponent);
