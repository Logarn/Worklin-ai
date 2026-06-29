import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { NativeSplash } from "@/components/native-splash";
import { DarkLoginShell, LoginCard, LoginErrorText } from "@/domains/account/components/login-shell";
import { PlatformLoginButtons } from "@/domains/account/components/platform-login-buttons";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
  resolvePostLoginDestination,
} from "@/domains/account/login-flow";
import { startAuthFlow, startNativeLogin, useIsNativePlatform } from "@/runtime/native-auth";
import { useIsAuthenticated } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_closed:
    "Sign-ups are currently closed. Visit vellum.ai/community to request access.",
};

/**
 * Capacitor iOS login: single "Sign in" button inside NativeSplash.
 * Opens a Safari sheet via `/accounts/native/start` with no provider
 * hint — WorkOS AuthKit handles Apple / Google / email selection.
 */
function NativeLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerAuth = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startNativeLogin({ returnTo: returnTo ?? null });
    } catch (err) {
      const errorCode =
        err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (errorCode === "USER_CANCELLED") {
        setLoading(false);
        return;
      }
      if (errorCode === "AUTH_ERROR") {
        const errorKey =
          err &&
          typeof err === "object" &&
          "data" in err &&
          err.data &&
          typeof err.data === "object" &&
          "authError" in err.data &&
          typeof err.data.authError === "string"
            ? err.data.authError
            : undefined;
        setErrorMessage(
          (errorKey && AUTH_ERROR_MESSAGES[errorKey]) ?? "Something went wrong. Please try again.",
        );
      } else {
        console.error("[native-auth] auth flow failed:", err);
        setErrorMessage("Something went wrong. Please try again.");
      }
      setLoading(false);
    }
  };

  const handleSignIn = () => {
    void triggerAuth();
  };

  return (
    <NativeSplash>
      <div className="z-10 mt-8 flex w-full max-w-[320px] flex-col items-center gap-3">
        {errorMessage && (
          <LoginErrorText className="max-w-[280px]">{errorMessage}</LoginErrorText>
        )}
        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={handleSignIn}
          disabled={loading}
          className="max-w-[300px]"
        >
          Sign in
        </Button>
      </div>
    </NativeSplash>
  );
}

/**
 * Web login form: three equal sign-in buttons routing through WorkOS.
 * Wraps itself in a forced-dark theme context with the branded
 * `LoginBackground` — the web login screen is always dark per Figma.
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const callbackUrl = buildProviderCallbackUrl(returnTo);

  const handleProvider = async (providerHint?: string) => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, callbackUrl, {
        ...(providerHint ? { providerHint } : {}),
        returnTo,
      });
    } catch (err) {
      console.error("[web-login] auth flow failed:", err);
      setErrorMessage("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <DarkLoginShell>
      <LoginCard>
        <PlatformLoginButtons
          returnTo={returnTo}
          loading={loading}
          errorMessage={errorMessage}
          onProviderClick={(hint) => {
            void handleProvider(hint);
          }}
        />
      </LoginCard>
    </DarkLoginShell>
  );
}

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `NativeLoginForm` (Capacitor iOS) or `WebLoginForm`
 * (standard browser / Electron) based on platform detection.
 */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNative = useIsNativePlatform();
  const isAuthenticated = useIsAuthenticated();
  const returnTo = searchParams.get("returnTo");

  useEffect(() => {
    if (!isAuthenticated) return;

    const { destination, requiresFullPageNavigation } =
      resolvePostLoginDestination(returnTo, routes.assistant);

    if (requiresFullPageNavigation) {
      window.location.replace(destination);
      return;
    }

    navigate(destination, { replace: true });
  }, [isAuthenticated, navigate, returnTo]);

  if (isAuthenticated) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <p className="text-center text-sm text-[var(--content-secondary)]">
            Redirecting you to Worklin...
          </p>
        </LoginCard>
      </DarkLoginShell>
    );
  }

  if (isNative) return <NativeLoginForm returnTo={returnTo} />;
  return <WebLoginForm returnTo={returnTo} />;
}
