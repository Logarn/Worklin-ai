import { ChevronLeft, Globe, Search } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isElectron } from "@/runtime/is-electron";

interface BrandProfileScreenProps {
  brandName: string;
  websiteUrl: string;
  onBrandNameChange: (next: string) => void;
  onWebsiteUrlChange: (next: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

/** Collect the smallest useful seed for Worklin's automated brand research. */
export function BrandProfileScreen({
  brandName,
  websiteUrl,
  onBrandNameChange,
  onWebsiteUrlChange,
  onBack,
  onContinue,
  onSkip,
}: BrandProfileScreenProps) {
  const electron = isElectron();
  const canContinue =
    brandName.trim().length > 0 || websiteUrl.trim().length > 0;

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
            onClick={onBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1
            className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}
          >
            What brand should I learn?
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>

        <p
          className="mt-3 text-center text-body-medium-lighter text-[var(--content-secondary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          Give me a name, a public website, or both. I&apos;ll do the research
          and build a working brief for the rest of our work.
        </p>

        <div
          className={`${electron ? "mt-6" : "mt-8"} flex w-full flex-col gap-5`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.25s both" }}
        >
          <Input
            label="Brand name"
            placeholder="e.g. Acme Studio"
            value={brandName}
            onChange={(event) => onBrandNameChange(event.target.value)}
            fullWidth
          />
          <div className="relative">
            <Input
              label="Public website (optional)"
              placeholder="https://example.com"
              value={websiteUrl}
              onChange={(event) => onWebsiteUrlChange(event.target.value)}
              fullWidth
            />
            <Globe
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-9 h-4 w-4 text-[var(--content-tertiary)]"
            />
          </div>
          <div className="flex items-start gap-2 text-body-small-default text-[var(--content-tertiary)]">
            <Search aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Research stays read-only and evidence-based. You can correct or
              approve anything later.
            </span>
          </div>
        </div>

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            Start research
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            I&apos;ll add a brand later
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
