import { ChevronLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { connectManagedOAuth } from "@/lib/auth/managed-oauth-flow";
import { isElectron } from "@/runtime/is-electron";
import { publicAsset } from "@/utils/public-asset";
import { Button } from "@vellumai/design-library/components/button";

const GOOGLE_PROVIDER_KEY = "google";
const GOOGLE_CONNECT_ITEMS = [
  {
    id: "gmail",
    label: "Gmail",
    logoSrc: publicAsset("/images/integrations/gmail.svg"),
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    logoSrc: publicAsset("/images/integrations/google-calendar.svg"),
  },
  {
    id: "google-drive",
    label: "Google Drive",
    logoSrc: publicAsset("/images/integrations/google-drive.svg"),
  },
];

interface GoogleConnectScreenProps {
  assistantId: string;
  assistantName: string;
  onConnect: (scopes: string[]) => void;
  onSkip: () => void;
  onBack: () => void;
}

export function GoogleConnectScreen({
  assistantId,
  assistantName,
  onConnect,
  onSkip,
  onBack,
}: GoogleConnectScreenProps) {
  const electron = isElectron();
  const activeRequestRef = useRef<AbortController | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setOAuthInProgress(false);
    setConnectError(null);

    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [assistantId]);

  const cancelActiveRequest = useCallback(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setOAuthInProgress(false);
  }, []);

  const handleBack = useCallback(() => {
    cancelActiveRequest();
    onBack();
  }, [cancelActiveRequest, onBack]);

  const handleSkip = useCallback(() => {
    cancelActiveRequest();
    onSkip();
  }, [cancelActiveRequest, onSkip]);

  const handleConnect = useCallback(() => {
    if (activeRequestRef.current) return;

    const controller = new AbortController();
    activeRequestRef.current = controller;
    setOAuthInProgress(true);
    setConnectError(null);

    void connectManagedOAuth({
      assistantId,
      providerKey: GOOGLE_PROVIDER_KEY,
      providerLabel: "Google",
      signal: controller.signal,
    })
      .then((result) => {
        if (activeRequestRef.current !== controller) return;
        activeRequestRef.current = null;
        setOAuthInProgress(false);

        if (result.status === "connected") {
          onConnect(result.connection.scopes_granted);
          return;
        }

        setConnectError(
          result.message ??
            "Google authorization was cancelled before an account connected.",
        );
      })
      .catch((error: unknown) => {
        if (
          activeRequestRef.current !== controller ||
          controller.signal.aborted
        ) {
          return;
        }
        activeRequestRef.current = null;
        setOAuthInProgress(false);
        setConnectError(
          error instanceof Error
            ? error.message
            : "Worklin could not connect Google. Try again.",
        );
      });
  }, [assistantId, onConnect]);

  const assistantInlineName = assistantName || "your assistant";
  const assistantSentenceName = assistantName || "Your assistant";

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-md flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}
      >
        <div
          className="grid w-full grid-cols-[auto_1fr_auto] items-center"
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1
            className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}
          >
            Connect Google
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className="mt-4 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          {`If you use Google, ${assistantInlineName} can use Gmail, Calendar, and Drive with your permission.`}
        </p>

        <div
          className="mt-6 flex items-stretch justify-center gap-3"
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {GOOGLE_CONNECT_ITEMS.map((item) => (
            <div
              key={item.id}
              className="flex w-24 flex-col items-center gap-2.5 rounded-2xl bg-[var(--surface-lift)] px-3 pb-3 pt-4"
            >
              <img
                src={item.logoSrc}
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 object-contain"
                loading="eager"
              />
              <span className="text-center text-xs leading-tight text-[var(--content-tertiary)]">
                {item.label}
              </span>
            </div>
          ))}
        </div>

        <p
          className="mt-8 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.25s both" }}
        >
          {`${assistantSentenceName} will never send email, change calendar events, or edit files without your permission. You can disconnect at any time.`}
        </p>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.35s both" }}
        >
          {connectError && (
            <p
              role="alert"
              className="mb-2 text-center text-sm text-[var(--content-negative)]"
            >
              {connectError}
            </p>
          )}
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={handleConnect}
            disabled={oauthInProgress}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            {oauthInProgress ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Waiting for authorization...
              </span>
            ) : (
              "Connect Google"
            )}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={handleSkip}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Skip for now
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
