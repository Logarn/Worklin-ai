import { WORKLIN_AVATAR_CHOICES } from "@/components/avatar/assistant-character-packs";
import { publicAsset } from "@/utils/public-asset";

const AVATAR_FRAME_CLASSES = [
  "h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24",
  "h-[4.5rem] w-[4.5rem] sm:h-24 sm:w-24 md:h-28 md:w-28",
  "h-20 w-20 sm:h-28 sm:w-28 md:h-32 md:w-32",
  "h-20 w-20 sm:h-28 sm:w-28 md:h-32 md:w-32",
  "h-[4.5rem] w-[4.5rem] sm:h-24 sm:w-24 md:h-28 md:w-28",
  "h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24",
] as const;

const AVATAR_TRANSFORMS = [
  "translate-y-7 -rotate-[10deg]",
  "translate-y-3 -rotate-[5deg]",
  "translate-y-10 -rotate-[2deg]",
  "translate-y-10 rotate-[2deg]",
  "translate-y-3 rotate-[5deg]",
  "translate-y-7 rotate-[10deg]",
] as const;

export function WorklinAvatarRosterArt({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={`pointer-events-none relative overflow-hidden ${className}`}>
      <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-[var(--surface-base)] via-[rgba(8,8,8,0.82)] to-transparent" />
      <div className="absolute bottom-[-4.5rem] left-1/2 h-36 w-[min(92vw,48rem)] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.16),rgba(255,255,255,0))] blur-3xl" />
      <div className="relative mx-auto flex w-full max-w-[920px] items-end justify-center gap-2 px-4 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-10 sm:gap-3 sm:px-6 sm:pt-14">
        {WORKLIN_AVATAR_CHOICES.map((avatar, index) => {
          const posterUrl = avatar.portraitPosterUrl ?? avatar.portraitAssetUrl;
          if (!posterUrl) return null;
          return (
            <div
              key={avatar.id}
              className={`relative shrink-0 ${AVATAR_TRANSFORMS[index] ?? ""}`}
              style={{ zIndex: WORKLIN_AVATAR_CHOICES.length - index }}
            >
              <div className="absolute inset-[-10%] rounded-full bg-white/10 blur-md" />
              <img
                src={publicAsset(posterUrl)}
                alt=""
                width={128}
                height={128}
                className={`relative rounded-full border border-white/14 bg-[#E9E9E5] object-cover shadow-[0_22px_45px_rgba(0,0,0,0.45)] ring-1 ring-black/35 ${AVATAR_FRAME_CLASSES[index] ?? AVATAR_FRAME_CLASSES[0]}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
