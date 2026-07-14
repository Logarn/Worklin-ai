import { useMemo } from "react";

export type WorklinOrbState =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "ending"
  | "failed";

export interface WorklinOrbProps {
  state?: WorklinOrbState;
  inputAmplitude?: number;
  outputAmplitude?: number;
  size?: number;
  barCount?: number;
  className?: string;
  decorative?: boolean;
  label?: string;
}

/** Royal-blue assistant presence shared by chat, identity, and live voice. */
export function WorklinOrb({
  state = "idle",
  inputAmplitude = 0,
  outputAmplitude = 0,
  size = 96,
  barCount = size < 32 ? 16 : 36,
  className,
  decorative = true,
  label = "Worklin assistant",
}: WorklinOrbProps) {
  const amplitude =
    state === "speaking" ? outputAmplitude : inputAmplitude;
  const bars = useMemo(
    () => Array.from({ length: barCount }, (_, index) => index),
    [barCount],
  );
  const active =
    state === "listening" ||
    state === "transcribing" ||
    state === "speaking" ||
    state === "interrupted";
  const radius = size / 2;
  const coreInset = size * 0.2;
  const barWidth = Math.max(1, size * 0.021);
  const minimumBarHeight = Math.max(2, size * 0.042);
  const maximumAmplitudeHeight = size * 0.2;

  return (
    <span
      className={`relative block shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
    >
      <span
        className={`absolute rounded-full border border-[#9ab2ff]/65 bg-[radial-gradient(circle_at_35%_30%,#e9efff,#4169e1_48%,#142f8f)] shadow-[0_0_30px_rgba(65,105,225,.58)] transition-transform duration-75 motion-reduce:transition-none ${
          state === "thinking" || state === "connecting"
            ? "animate-pulse motion-reduce:animate-none"
            : ""
        }`}
        style={{
          inset: coreInset,
          transform: `scale(${1 + Math.min(amplitude, 1) * 0.12})`,
        }}
      />
      {bars.map((index) => {
        const phase = Math.sin(index * 1.71) * 0.16 + 0.84;
        const height = active
          ? minimumBarHeight +
            Math.min(amplitude, 1) * maximumAmplitudeHeight * phase
          : minimumBarHeight;

        return (
          <span
            key={index}
            className={`absolute left-1/2 top-1/2 block rounded-full bg-gradient-to-t from-[#4169e1] to-[#9ab2ff] transition-[height,opacity] duration-75 motion-reduce:transition-none ${
              state === "thinking" ? "opacity-45" : "opacity-90"
            }`}
            style={{
              width: barWidth,
              height,
              transform: `translate(-50%, -${radius}px) rotate(${index * (360 / barCount)}deg)`,
              transformOrigin: `50% ${radius}px`,
            }}
          />
        );
      })}
    </span>
  );
}
