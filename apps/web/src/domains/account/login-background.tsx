import { publicAsset } from "@/utils/public-asset";

/**
 * Decorative background for the branded `/account/login` screen.
 *
 * Renders the full-white Worklin wordmark and the login background characters
 * SVG anchored to the bottom edge. Purely presentational (`pointer-events-none`)
 * so the form above stays fully interactive.
 */
export function LoginBackground() {
  return (
    <>
      <div className="pointer-events-none absolute top-[120px] left-1/2 z-0 -translate-x-1/2">
        <img
          src={publicAsset("/brand/worklin-logo-header.png")}
          alt="Worklin AI"
          width={140}
          height={32}
        />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 left-1/2 z-0 w-full max-w-[1100px] -translate-x-1/2"
      >
        <img
          src={publicAsset("/login-background-characters.svg")}
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </>
  );
}
