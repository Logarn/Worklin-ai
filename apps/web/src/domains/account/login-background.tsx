import { WorklinAvatarRosterArt } from "@/components/avatar/worklin-avatar-roster-art";
import { publicAsset } from "@/utils/public-asset";

/**
 * Decorative background for the branded `/account/login` screen.
 *
 * Renders the full-white Worklin wordmark and the Worklin assistant portraits
 * anchored to the bottom edge. Purely presentational (`pointer-events-none`)
 * so the form above stays fully interactive.
 */
export function LoginBackground() {
  return (
    <>
      <div className="pointer-events-none absolute top-14 left-1/2 z-0 -translate-x-1/2 sm:top-[4.5rem]">
        <img
          src={publicAsset("/brand/worklin-logo-header.png")}
          alt="Worklin AI"
          width={140}
          height={32}
        />
      </div>
      <WorklinAvatarRosterArt
        variant="authHero"
        className="pointer-events-none absolute top-[7.5rem] left-1/2 z-0 w-full max-w-[980px] -translate-x-1/2 sm:top-[9rem]"
      />
    </>
  );
}
