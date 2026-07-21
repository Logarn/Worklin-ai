import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

const getMock = mock();

mock.module("@/generated/api/client.gen", () => ({
  client: {
    get: getMock,
  },
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: ["billing-summary"],
  }),
}));

mock.module(
  "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal",
  () => ({
    BillingOnboardingModal: () => (
      <div data-testid="billing-onboarding-modal" />
    ),
  }),
);
mock.module("@/domains/settings/components/adjust-plan-modal", () => ({
  AdjustPlanModal: () => <div data-testid="adjust-plan-modal" />,
}));
mock.module("@/domains/settings/components/billing-panel", () => ({
  BillingPanel: () => <div data-testid="billing-panel">Add Credits</div>,
}));
mock.module(
  "@/domains/settings/components/billing-portal-return-handler",
  () => ({
    BillingPortalReturnHandler: () => (
      <div data-testid="billing-portal-return-handler" />
    ),
  }),
);
mock.module(
  "@/domains/settings/components/billing-usage/billing-usage-panel",
  () => ({
    BillingUsagePanel: () => <div data-testid="billing-usage-panel" />,
  }),
);
mock.module("@/domains/settings/components/grace-period-banner", () => ({
  GracePeriodBanner: () => <div data-testid="grace-period-banner" />,
}));
mock.module("@/domains/settings/components/payment-methods-card", () => ({
  PaymentMethodsCard: () => <div data-testid="payment-methods-card" />,
}));
mock.module("@/domains/settings/components/plan-card", () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));
mock.module("@/domains/settings/components/referral-panel", () => ({
  ReferralPanel: () => <div data-testid="referral-panel" />,
}));
mock.module(
  "@/domains/settings/components/tier-upgrade-resize-modal",
  () => ({
    TierUpgradeResizeModal: () => (
      <div data-testid="tier-upgrade-resize-modal" />
    ),
  }),
);
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    info: () => {},
  },
}));

const { BillingPage } = await import(
  "@/domains/settings/billing/billing-page"
);
const { fetchBillingCapability } = await import(
  "@/domains/settings/billing/use-billing-capability"
);

function renderBillingPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/settings/billing"]}>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({
    data: {
      available: false,
      mode: "external_provider",
      reason: "managed_billing_not_configured",
    },
    response: new Response(null, { status: 200 }),
  });
});

afterEach(() => {
  cleanup();
});

describe("BillingPage capability state", () => {
  test("shows one external-provider state and mounts no money surfaces", async () => {
    const view = renderBillingPage();

    await waitFor(() => {
      expect(
        view.getByText("Worklin credit billing isn't used here"),
      ).toBeTruthy();
    });
    expect(
      view.getByText(/Any model charges are handled by that provider/),
    ).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Manage AI provider" }).getAttribute(
        "href",
      ),
    ).toBe("/assistant/settings/ai");
    expect(view.queryByTestId("plan-card")).toBeNull();
    expect(view.queryByTestId("payment-methods-card")).toBeNull();
    expect(view.queryByTestId("billing-panel")).toBeNull();
    expect(view.queryByTestId("referral-panel")).toBeNull();
    expect(view.queryByTestId("billing-usage-panel")).toBeNull();
    expect(view.queryByText("Add Credits")).toBeNull();
    expect(getMock).toHaveBeenCalledWith({
      url: "/v1/organizations/billing/capability/",
      throwOnError: false,
    });
  });

  test("fails closed on capability errors and offers only a retry", async () => {
    getMock.mockResolvedValue({
      data: undefined,
      response: new Response(null, { status: 500 }),
    });

    const view = renderBillingPage();
    await waitFor(() => {
      expect(view.getByText("Billing controls are unavailable")).toBeTruthy();
    });
    expect(view.queryByTestId("billing-panel")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(2);
    });
  });

  test("preserves the full billing page when managed billing is available", async () => {
    getMock.mockResolvedValue({
      data: { available: true, mode: "managed" },
      response: new Response(null, { status: 200 }),
    });

    const view = renderBillingPage();
    await waitFor(() => {
      expect(view.getByTestId("plan-card")).toBeTruthy();
    });
    expect(view.getByTestId("payment-methods-card")).toBeTruthy();
    expect(view.getByTestId("billing-panel")).toBeTruthy();
    expect(view.getByTestId("referral-panel")).toBeTruthy();
    expect(view.getByTestId("billing-usage-panel")).toBeTruthy();
    expect(
      view.queryByText("Worklin credit billing isn't used here"),
    ).toBeNull();
  });
});

describe("fetchBillingCapability", () => {
  test("returns the explicit external-provider capability", async () => {
    await expect(fetchBillingCapability()).resolves.toEqual({
      available: false,
      mode: "external_provider",
      reason: "managed_billing_not_configured",
    });
  });

  test("fails closed when capability discovery is missing", async () => {
    getMock.mockResolvedValue({
      data: undefined,
      response: new Response(null, { status: 404 }),
    });

    await expect(fetchBillingCapability()).rejects.toThrow(
      "Billing capability could not be verified.",
    );
  });

  test("fails closed when the capability response is malformed", async () => {
    getMock.mockResolvedValue({
      data: { available: true },
      response: new Response(null, { status: 200 }),
    });

    await expect(fetchBillingCapability()).rejects.toThrow(
      "Billing capability could not be verified.",
    );
  });
});
