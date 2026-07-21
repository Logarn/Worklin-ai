import { KeyRound, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { Link, Navigate, useNavigate, useSearchParams } from "react-router";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { useBillingCapability } from "@/domains/settings/billing/use-billing-capability";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { ReferralPanel } from "@/domains/settings/components/referral-panel";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { routes } from "@/utils/routes";

function BillingUnavailableState({
  externalProvider,
  onRetry,
}: {
  externalProvider: boolean;
  onRetry?: () => void;
}) {
  const Icon = externalProvider ? KeyRound : TriangleAlert;
  const title = externalProvider
    ? "Worklin credit billing isn't used here"
    : "Billing controls are unavailable";
  const description = externalProvider
    ? "This assistant is set up to use an AI provider you connect. Any model charges are handled by that provider. Worklin credit balances, payment methods, auto top-up, referrals, and credit-usage reports aren't available for this assistant."
    : "Worklin couldn't verify billing for this assistant, so payment and credit actions are disabled. Try again before making any billing changes.";

  return (
    <Card padding="lg">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]"
        >
          <Icon className="h-5 w-5 text-[var(--content-secondary)]" />
        </span>
        <div className="min-w-0 flex-1">
          <Typography
            as="h2"
            variant="title-medium"
            className="text-[var(--content-default)]"
          >
            {title}
          </Typography>
          <Typography
            as="p"
            variant="body-small-default"
            className="mt-2 max-w-2xl text-[var(--content-tertiary)]"
          >
            {description}
          </Typography>
          <div className="mt-4">
            {externalProvider ? (
              <Button asChild variant="outlined">
                <Link to={routes.settings.ai}>Manage AI provider</Link>
              </Button>
            ) : (
              <Button
                variant="outlined"
                leftIcon={<RefreshCw aria-hidden />}
                onClick={onRetry}
              >
                Try again
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Handles the `billing_status` query parameter that Stripe redirects back with
 * after checkout completes (success) or is cancelled.
 */
function BillingStatusHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const billingStatus = searchParams.get("billing_status");
    if (!billingStatus) return;

    if (billingStatus === "success") {
      toast.success("Payment received! Your credit balance will update shortly.", {
        id: "billing-status",
      });
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
      });
    } else if (billingStatus === "cancel") {
      toast.info("Checkout was cancelled. No credits were added.", {
        id: "billing-status",
      });
    }

    // Clean up billing params from the URL.
    navigate(routes.settings.billing, { replace: true });
  }, [searchParams, navigate, queryClient]);

  return null;
}

export function BillingPage() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const isOrgReady = useIsOrgReady();
  const billingCapabilityQuery = useBillingCapability(
    billingGate === "full" && isPlatformHosted && isOrgReady,
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const openPlanModal = useCallback(() => setPlanModalOpen(true), []);
  const closePlanModal = useCallback(() => setPlanModalOpen(false), []);
  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const onTierUpgraded = useCallback(() => setResizeModalOpen(true), []);

  useEffect(() => {
    if (searchParams.has("adjust_plan")) {
      setPlanModalOpen(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("adjust_plan");
        return next;
      }, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const hasSessionId = searchParams.has("session_id");
  const closeOnboarding = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("session_id");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  if (billingGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }

  if (billingGate === "disabled") {
    return (
      <div className="space-y-4">
        <Notice tone="info">
          Log in to the Worklin platform to manage billing and usage.
        </Notice>
      </div>
    );
  }

  if (
    isLifecycleLoading ||
    (isPlatformHosted &&
      (!isOrgReady || billingCapabilityQuery.isLoading))
  ) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading billing…
        </div>
      </div>
    );
  }

  if (!isPlatformHosted && platformGate !== "gated") {
    return (
      <div className="space-y-4">
        <Notice tone="warning">
          Billing isn&apos;t available for the current assistant state.
        </Notice>
      </div>
    );
  }

  if (billingCapabilityQuery.isError || !billingCapabilityQuery.data) {
    return (
      <BillingUnavailableState
        externalProvider={false}
        onRetry={() => {
          void billingCapabilityQuery.refetch();
        }}
      />
    );
  }

  if (!billingCapabilityQuery.data.available) {
    return <BillingUnavailableState externalProvider />;
  }

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <BillingStatusHandler />
        <BillingPortalReturnHandler />
      </Suspense>
      <GracePeriodBanner />
      <PlanCard onManage={openPlanModal} />
      <AdjustPlanModal
        open={planModalOpen}
        onClose={closePlanModal}
        onTierUpgraded={onTierUpgraded}
      />
      <PaymentMethodsCard />
      <Suspense fallback={null}>
        <BillingPanel />
      </Suspense>
      <ReferralPanel />
      <BillingUsagePanel />
      <BillingOnboardingModal open={hasSessionId} onClose={closeOnboarding} />
      <TierUpgradeResizeModal
        open={resizeModalOpen}
        onClose={() => setResizeModalOpen(false)}
      />
    </div>
  );
}
