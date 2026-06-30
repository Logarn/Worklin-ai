import { Check, KeyRound, MessageCircle, Server } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    DEFAULT_ONBOARDING_PROVIDER,
    ONBOARDING_PROVIDERS,
    onboardingProvider,
    type OnboardingProviderOptionId,
} from "@/domains/onboarding/provider-catalog";
import {
    pendingProviderAuthType,
    peekPendingProviderKey,
    setPendingProviderKey,
} from "@/domains/onboarding/provider-key";
import { isElectron } from "@/runtime/is-electron";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

export function ApiKeyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hosting = searchParams.get("hosting");
  const next = searchParams.get("next");
  const electron = isElectron();
  const pending = peekPendingProviderKey();

  const [providerOption, setProviderOption] = useState<OnboardingProviderOptionId>(
    () => {
      if (pending && pendingProviderAuthType(pending) === "oauth_subscription") {
        return "chatgpt-subscription";
      }
      if (pending?.providerOptionId && onboardingProvider(pending.providerOptionId)) {
        return pending.providerOptionId;
      }
      return (
        ONBOARDING_PROVIDERS.find((p) => p.provider === pending?.provider)?.id ??
        DEFAULT_ONBOARDING_PROVIDER.id
      );
    },
  );
  const [apiKey, setApiKey] = useState(
    () => pending?.key ?? "",
  );

  const entry = onboardingProvider(providerOption) ?? DEFAULT_ONBOARDING_PROVIDER;
  const requiresKey = entry.requiresKey;
  const canContinue = !requiresKey || apiKey.trim().length > 0;

  const onContinue = () => {
    if (!canContinue) return;
    setPendingProviderKey({
      provider: entry.provider,
      providerOptionId: entry.id,
      authType: entry.authType,
      key: requiresKey ? apiKey.trim() : "",
      connectionName: entry.connectionName,
      credentialName: entry.credentialName,
      connectionLabel: entry.connectionLabel,
      baseUrl: entry.baseUrl ?? null,
      models: entry.models ? [...entry.models] : null,
      defaultModel: entry.defaultModel,
    });
    if (next === "hatching") {
      const params = new URLSearchParams();
      if (hosting) params.set("hosting", hosting);
      const qs = params.toString();
      void navigate(`${routes.onboarding.hatching}${qs ? `?${qs}` : ""}`);
      return;
    }
    void navigate(
      hosting
        ? `${routes.onboarding.privacy}?hosting=${hosting}`
        : routes.onboarding.privacy,
    );
  };

  const onBack = () => {
    if (next === "hatching") {
      void navigate(routes.onboarding.privacy);
      return;
    }
    void navigate(routes.onboarding.hosting);
  };

  return (
    <OnboardingLayout>
      <div className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}>
        <h1
          className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Connect Worklin to AI
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Choose how your assistant should answer. You can change this later in
          Settings.
        </p>

        <div
          className={`flex w-full flex-col gap-4 ${electron ? "mt-8" : "mt-10"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          <div className="grid w-full gap-2">
            {ONBOARDING_PROVIDERS.map((option) => {
              const selected = providerOption === option.id;
              const Icon =
                option.authType === "oauth_subscription"
                  ? MessageCircle
                  : option.authType === "none"
                    ? Server
                    : KeyRound;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setProviderOption(option.id);
                    setApiKey("");
                  }}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition ${
                    selected
                      ? "border-[var(--primary-base)] bg-[var(--surface-active)]"
                      : "border-[var(--border-base)] bg-[var(--surface-base)] hover:bg-[var(--surface-raised)]"
                  }`}
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-lift)]">
                    <Icon className="h-4 w-4 text-[var(--content-secondary)]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-body-medium-default text-[var(--content-default)]">
                        {option.displayName}
                      </span>
                      {option.badge && (
                        <span className="rounded-full bg-[var(--primary-base)] px-2 py-0.5 text-[11px] font-medium text-[var(--content-inset)]">
                          {option.badge}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
                      {option.subtitle}
                    </span>
                  </span>
                  {selected && (
                    <Check className="mt-1 h-4 w-4 shrink-0 text-[var(--primary-base)]" />
                  )}
                </button>
              );
            })}
          </div>

          {requiresKey && (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label={`${entry.displayName} API key`}
                placeholder={entry.apiKeyPlaceholder ?? "Enter your API key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                fullWidth
              />
              {entry.docsUrl && (
                <p className="self-start text-body-medium-lighter text-[var(--content-tertiary)]">
                  Don't have it?{" "}
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--content-default)] underline"
                  >
                    Get an API key here
                  </a>
                </p>
              )}
            </div>
          )}
          {entry.authType === "oauth_subscription" && (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              After your assistant is created, Worklin will ask you to sign in
              with ChatGPT before your first conversation starts.
            </p>
          )}
        </div>

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
            className={electron ? undefined : "h-11 text-base"}
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={onBack}
            className={electron ? undefined : "h-11 text-base"}
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
