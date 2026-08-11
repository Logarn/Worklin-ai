import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";

interface AssistantIdentity {
  id: string;
  isLocal: boolean;
  isPlatformHosted: boolean;
  runtimeProvider?: string | null;
}

interface ProviderCatalogItem {
  provider_key: string;
  display_name: string;
  description: string | null;
  dashboard_url: string | null;
  client_id_placeholder: string | null;
  requires_client_secret: boolean;
  logo_url: string | null;
  supports_managed_mode: boolean;
  managed_service_is_paid: boolean;
  feature_flag: string | null;
}

interface QueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
}

interface IntegrationRowTestProps {
  providerKey: string;
  displayName: string;
  hostedManagedAvailable?: boolean;
  advancedSetupAvailable?: boolean;
  connectionStatusUnavailable?: boolean;
}

const navigate = mock(() => {});
const searchParams = new URLSearchParams();

let assistants: AssistantIdentity[] = [];
let providerQueryEnabled: boolean | undefined;
let providersQuery: QueryResult<ProviderCatalogItem[]>;
let connectionsQuery: QueryResult<unknown[]>;

function provider(providerKey: string): ProviderCatalogItem {
  return {
    provider_key: providerKey,
    display_name: providerKey === "github" ? "GitHub" : providerKey,
    description: null,
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: true,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
  };
}

function queryResult<T>(
  data: T | undefined,
  overrides: Partial<QueryResult<T>> = {},
): QueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    ...overrides,
  };
}

mock.module("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams],
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[]; enabled?: boolean }) => {
    if (options.queryKey?.[0] === "oauth-providers") {
      providerQueryEnabled = options.enabled;
      if (options.enabled === false) {
        return queryResult<ProviderCatalogItem[]>(undefined, {
          isSuccess: false,
        });
      }
      return providersQuery;
    }
    return connectionsQuery;
  },
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  oauthProvidersGetOptions: () => ({ queryKey: ["oauth-providers"] }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-connections"],
  }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  useActiveAssistantIsPlatformHosted: () =>
    assistants[0]?.isPlatformHosted === true,
  useActiveAssistantLifecycleIsLoading: () => false,
  usePlatformGate: () => "full",
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: {
      activeAssistantId: () => assistants[0]?.id ?? null,
      assistants: () => assistants,
    },
  },
}));

mock.module("@/domains/settings/hooks/use-klaviyo-integration", () => ({
  useKlaviyoIntegration: () => ({
    integration: null,
    status: { isPending: false, isError: false },
  }),
}));

mock.module("@/domains/settings/components/klaviyo-integration", () => ({
  isKlaviyoConnected: () => false,
  KlaviyoIntegrationModal: () => null,
  KlaviyoIntegrationRow: () => null,
}));

mock.module("@/domains/settings/components/integration-detail-modal", () => ({
  IntegrationDetailModal: () => null,
}));

mock.module("@/domains/settings/components/integration-row", () => ({
  IntegrationRow: ({
    providerKey,
    displayName,
    hostedManagedAvailable = true,
    advancedSetupAvailable = true,
    connectionStatusUnavailable = false,
  }: IntegrationRowTestProps) => {
    const actionLabel = hostedManagedAvailable ? "Enable" : "Manage setup";
    const actionDisabled = hostedManagedAvailable
      ? connectionStatusUnavailable
      : !advancedSetupAvailable;
    return (
      <article
        data-testid={`integration-${providerKey}`}
        data-advanced-setup={String(advancedSetupAvailable)}
        data-status-unavailable={String(connectionStatusUnavailable)}
      >
        <span>{displayName}</span>
        <button type="button" disabled={actionDisabled}>
          {actionLabel}
        </button>
      </article>
    );
  },
}));

mock.module("@/domains/settings/components/meeting-notes-section", () => ({
  filterMeetingSources: () => [],
  MeetingNotesSection: () => null,
}));

mock.module(
  "@/domains/settings/components/additional-integrations-section",
  () => ({
    filterAdditionalIntegrations: () => [],
    AdditionalIntegrationsSection: () => null,
  }),
);

mock.module("@vellumai/design-library/components/input", () => ({
  Input: ({
    value,
    onChange,
    ...props
  }: {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    [key: string]: unknown;
  }) => (
    <input
      aria-label={String(props["aria-label"] ?? "")}
      value={value}
      onChange={onChange}
    />
  ),
}));

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;

mock.module("@vellumai/design-library/components/popover", () => ({
  Popover: {
    Root: Passthrough,
    Trigger: Passthrough,
    Content: Passthrough,
  },
}));

mock.module("@/utils/local-settings", () => ({
  getLocalSetting: () => "true",
  setLocalSetting: () => {},
}));

const { IntegrationsPage } = await import("./integrations-page");

function setAssistant(
  identity: Omit<AssistantIdentity, "id" | "isPlatformHosted"> & {
    isPlatformHosted?: boolean;
  },
) {
  assistants = [
    {
      id: "assistant-1",
      ...identity,
      isPlatformHosted: identity.isPlatformHosted ?? !identity.isLocal,
    },
  ];
}

beforeEach(() => {
  navigate.mockClear();
  providerQueryEnabled = undefined;
  providersQuery = queryResult([provider("github")]);
  connectionsQuery = queryResult([]);
  setAssistant({ isLocal: false, runtimeProvider: "pooled_worker" });
});

afterEach(cleanup);

describe("IntegrationsPage runtime and status boundaries", () => {
  for (const [label, runtimeProvider] of [
    ["pooled", "pooled_worker"],
    ["concurrent", "concurrent_service"],
    ["unknown", undefined],
  ] as const) {
    test(`${label} runtimes use the static fallback and keep advanced setup non-actionable`, () => {
      setAssistant({ isLocal: false, runtimeProvider });
      render(<IntegrationsPage />);

      const github = screen.getByTestId("integration-github");
      expect(providerQueryEnabled).toBe(false);
      expect(github.getAttribute("data-advanced-setup")).toBe("false");
      expect(
        (
          within(github).getByRole("button", {
            name: "Manage setup",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        within(screen.getByTestId("integration-google")).getByRole("button", {
          name: "Enable",
        }),
      ).toBeTruthy();
    });
  }

  test("keeps hosted Google primary on Railway and uses advanced setup for local Google", () => {
    setAssistant({ isLocal: false, runtimeProvider: "railway" });
    const railwayView = render(<IntegrationsPage />);
    expect(
      within(screen.getByTestId("integration-google")).getByRole("button", {
        name: "Enable",
      }),
    ).toBeTruthy();

    railwayView.unmount();
    setAssistant({ isLocal: true, runtimeProvider: undefined });
    render(<IntegrationsPage />);
    expect(
      within(screen.getByTestId("integration-google")).getByRole("button", {
        name: "Manage setup",
      }),
    ).toBeTruthy();
  });

  for (const [label, identity] of [
    ["Railway", { isLocal: false, runtimeProvider: "railway" }],
    ["local", { isLocal: true, runtimeProvider: undefined }],
  ] as const) {
    test(`${label} assistants expose advanced setup`, () => {
      setAssistant(identity);
      render(<IntegrationsPage />);

      const github = screen.getByTestId("integration-github");
      expect(providerQueryEnabled).toBe(true);
      expect(github.getAttribute("data-advanced-setup")).toBe("true");
      expect(
        (
          within(github).getByRole("button", {
            name: "Manage setup",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
  }

  test("keeps hosted Google visible when the assistant catalog is unavailable", () => {
    setAssistant({ isLocal: false, runtimeProvider: "railway" });
    providersQuery = queryResult<ProviderCatalogItem[]>(undefined, {
      isError: true,
      isSuccess: false,
    });

    render(<IntegrationsPage />);

    expect(screen.getByTestId("integration-google")).toBeTruthy();
    expect(
      (
        within(screen.getByTestId("integration-github")).getByRole("button", {
          name: "Manage setup",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Some work apps could not be loaded/iu),
    ).toBeTruthy();
  });

  test("fails connection status closed and leaves Google out of status filters", () => {
    providersQuery = queryResult<ProviderCatalogItem[]>(undefined, {
      isError: true,
      isSuccess: false,
    });
    connectionsQuery = queryResult<unknown[]>(undefined, {
      isError: true,
      isSuccess: false,
    });

    render(<IntegrationsPage />);

    const google = screen.getByTestId("integration-google");
    expect(
      screen.getByText(/Connection status is temporarily unavailable/iu),
    ).toBeTruthy();
    expect(google.getAttribute("data-status-unavailable")).toBe("true");
    expect(
      (
        within(google).getByRole("button", {
          name: "Enable",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("option", { name: "Enabled" }));
    expect(screen.queryByTestId("integration-google")).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Not Enabled" }));
    expect(screen.queryByTestId("integration-google")).toBeNull();
  });
});
