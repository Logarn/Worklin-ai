import type { ReactNode } from "react";

import { publicAsset } from "@/utils/public-asset";

/**
 * Full-screen branded splash shown on native iOS during:
 * - Initial login (behind the ASWebAuthenticationSession Safari sheet)
 * - Biometric session recovery (while Face ID / Touch ID is prompting)
 * - Session validation (while checking if the user is still logged in)
 *
 * Centers the Worklin wordmark vertically and displays the character
 * illustrations flush at the bottom of the screen.
 */
export function NativeSplash({ children }: { children?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <img
        src={publicAsset("/brand/worklin-logo-header.png")}
        alt="Worklin AI"
        width={260}
        height={60}
        className="block"
      />
      {children}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 w-full max-w-[900px] -translate-x-1/2"
        style={{ bottom: 0 }}
      >
        <img
          src={publicAsset("/login-background-characters.svg")}
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}
