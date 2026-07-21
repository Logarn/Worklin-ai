import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { OAuthConnection } from "@/generated/api/types.gen";
import { __resetForTesting as resetEventBus, publish } from "@/lib/event-bus";

interface StartCall {
  path: { assistant_id: string; provider: string };
  body: { requested_scopes: string[]; redirect_after_connect: string };
  throwOnError: boolean;
  signal?: AbortSignal;
}

interface ConnectionListCall {
  path: { assistant_id: string };
  throwOnError: boolean;
  signal?: AbortSignal;
}

interface SdkResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

let connections: OAuthConnection[] = [];
let startCalls: StartCall[] = [];
let connectionListCalls: ConnectionListCall[] = [];
let connectionListResult: SdkResult<OAuthConnection[]> | undefined;
let startResult: SdkResult<{ connect_url?: string }>;
let connectionListPending = false;
let startPending = false;
let connectionListThrownError: unknown;
let connectionListAbortCount = 0;
let startAbortCount = 0;
let toastErrors: string[] = [];
let popup: {
  closed: boolean;
  close: () => void;
  location: { href: string };
};
let openCalls: string[] = [];
let nativeOpenCalls: string[] = [];
let nativePlatform = false;
let electronPlatform = false;
let browserFinishedListener: (() => void) | null = null;
let browserFinishedUnsubscribeCount = 0;
let fireBrowserFinishedOnSubscribe = false;
let popupPollingIntervals = 0;
let startupDeadlineCallbacks: Array<() => void> = [];

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

mock.module("@/components/integrations/integration-icon", () => ({
  IntegrationIcon: ({ displayName }: { displayName: string }) =>
    createElement("span", null, displayName),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-connections"],
    queryFn: async () => connections,
  }),
  assistantsOauthConnectionsListQueryKey: () => ["oauth-connections"],
  assistantsOauthConnectionsListSetQueryData: () => {},
  useAssistantsOauthDisconnectByConnectionCreateMutation: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useAssistantsOauthStartCreateMutation: () => ({
    isPending: false,
    mutate: () => {},
  }),
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOauthConnectionsList: async (options: ConnectionListCall) => {
    connectionListCalls.push(options);
    if (connectionListThrownError) throw connectionListThrownError;
    if (connectionListPending) {
      return await new Promise<SdkResult<OAuthConnection[]>>(
        (_resolve, reject) => {
          const handleAbort = () => {
            connectionListAbortCount += 1;
            reject(new DOMException("The request was aborted.", "AbortError"));
          };
          if (options.signal?.aborted) {
            handleAbort();
          } else {
            options.signal?.addEventListener("abort", handleAbort, {
              once: true,
            });
          }
        },
      );
    }
    return (
      connectionListResult ?? {
        data: connections,
        response: new Response(null, { status: 200 }),
      }
    );
  },
  assistantsOauthStartCreate: async (options: StartCall) => {
    startCalls.push(options);
    if (startPending) {
      return await new Promise<SdkResult<{ connect_url?: string }>>(
        (_resolve, reject) => {
          const handleAbort = () => {
            startAbortCount += 1;
            reject(new DOMException("The request was aborted.", "AbortError"));
          };
          if (options.signal?.aborted) {
            handleAbort();
          } else {
            options.signal?.addEventListener("abort", handleAbort, {
              once: true,
            });
          }
        },
      );
    }
    return startResult;
  },
}));

mock.module("@/domains/settings/components/your-own-oauth-tab", () => ({
  YourOwnTab: () => createElement("div", null, "Your Own OAuth setup"),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
  useIsNativePlatform: () => nativePlatform,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronPlatform,
}));

mock.module("@/runtime/browser", () => ({
  openUrl: async (url: string) => {
    nativeOpenCalls.push(url);
  },
  openUrlFinishedListener: (listener: () => void) => {
    browserFinishedListener = listener;
    if (fireBrowserFinishedOnSubscribe) listener();
    return () => {
      if (browserFinishedListener === listener) {
        browserFinishedListener = null;
      }
      browserFinishedUnsubscribeCount += 1;
    };
  },
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    "aria-label": ariaLabel,
    children,
    disabled,
    iconOnly,
    onClick,
    type = "button",
  }: {
    "aria-label"?: string;
    children?: ReactNode;
    disabled?: boolean;
    iconOnly?: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
  }) =>
    createElement(
      "button",
      { "aria-label": ariaLabel, disabled, onClick, type },
      children ?? iconOnly,
    ),
}));

mock.module("@vellumai/design-library/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: ({
    actions,
    children,
    title,
    tone,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    title?: ReactNode;
    tone?: string;
  }) =>
    createElement(
      "div",
      { role: tone === "error" ? "alert" : "status" },
      title,
      children,
      actions,
    ),
}));

const { IntegrationDetailModal } =
  await import("@/domains/settings/components/integration-detail-modal");
const {
  __TEST_ONLY__,
  fetchManagedOAuthConnectionBaseline,
  isManagedOAuthProviderUnsupported,
  ManagedOAuthStartError,
  startManagedOAuthAuthorization,
  verifyManagedOAuthConnection,
} = await import("@/lib/auth/managed-oauth-api");
const { getManagedOAuthPopupBootstrapUrl } =
  await import("@/lib/auth/oauth-popup-launcher");
const { connectManagedOAuth } = await import("@/lib/auth/managed-oauth-flow");
const { useOAuthConnect } =
  await import("@/domains/settings/hooks/use-oauth-connect");

function connectedGitHubAccount(): OAuthConnection {
  return {
    id: "connection-123",
    provider: "github",
    account_label: "GitHub account",
    connected: true,
    status: "ACTIVE",
    scopes_granted: [],
    expires_at: null,
  };
}

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationDetailModal
        assistantId="assistant-123"
        providerKey="github"
        displayName="GitHub"
        description="Repositories and issues"
        logoUrl={null}
        platformGate="full"
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

function OAuthConnectHarness({
  assistantId,
  providerKey,
}: {
  assistantId: string;
  providerKey: string;
}) {
  const { connectError, handleConnect, oauthInProgress } = useOAuthConnect({
    assistantId,
    providerKey,
    displayName: providerKey,
    managedAvailable: true,
    connectionsQueryKey: ["oauth-connections", assistantId],
  });

  return (
    <div>
      <button type="button" onClick={handleConnect}>
        Connect harness
      </button>
      <span>{oauthInProgress ? "Connecting" : "Idle"}</span>
      {connectError && <span role="alert">{connectError}</span>}
    </div>
  );
}

function renderOAuthConnectHarness(assistantId: string, providerKey: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderHarness = (nextAssistantId: string, nextProviderKey: string) => (
    <QueryClientProvider client={queryClient}>
      <OAuthConnectHarness
        assistantId={nextAssistantId}
        providerKey={nextProviderKey}
      />
    </QueryClientProvider>
  );
  const view = render(renderHarness(assistantId, providerKey));
  return { ...view, renderHarness };
}

function openedOAuthRequest(): { requestId: string; origin: string } {
  const bootstrapUrl = new URL(openCalls[0]!);
  return {
    requestId: bootstrapUrl.searchParams.get("requestId")!,
    origin: bootstrapUrl.origin,
  };
}

function dispatchOAuthMessage({
  requestId,
  origin,
  provider = "github",
  source = popup,
}: {
  requestId: string;
  origin: string;
  provider?: string;
  source?: unknown;
}): void {
  const event = new MessageEvent("message", {
    data: {
      type: "vellum:oauth-complete",
      requestId,
      oauthStatus: "connected",
      oauthProvider: provider,
      oauthCode: null,
    },
    origin,
  });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

function dispatchOAuthStorage({
  requestId,
  provider = "github",
}: {
  requestId: string;
  provider?: string;
}): void {
  const payload = JSON.stringify({
    type: "vellum:oauth-complete",
    requestId,
    oauthStatus: "connected",
    oauthProvider: provider,
    oauthCode: null,
  });
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: `vellum:oauth-complete:${requestId}`,
      newValue: payload,
    }),
  );
}

function dispatchOAuthReady(url: string): void {
  const bootstrapUrl = new URL(url);
  const event = new MessageEvent("message", {
    data: {
      type: "vellum:oauth-popup-ready",
      requestId: bootstrapUrl.searchParams.get("requestId"),
      oauthProvider: bootstrapUrl.searchParams.get("oauth_provider"),
    },
    origin: bootstrapUrl.origin,
  });
  Object.defineProperty(event, "source", { value: popup });
  window.dispatchEvent(event);
}

function triggerStartupDeadline(): void {
  for (const callback of [...startupDeadlineCallbacks]) callback();
}

function startedCallbackUrl(): URL {
  return new URL(startCalls[0]!.body.redirect_after_connect);
}

beforeEach(() => {
  __TEST_ONLY__.resetUnsupportedManagedProviders();
  connections = [];
  startCalls = [];
  connectionListCalls = [];
  openCalls = [];
  connectionListResult = undefined;
  connectionListPending = false;
  startPending = false;
  connectionListThrownError = undefined;
  connectionListAbortCount = 0;
  startAbortCount = 0;
  toastErrors = [];
  nativeOpenCalls = [];
  nativePlatform = false;
  electronPlatform = false;
  resetEventBus();
  browserFinishedListener = null;
  browserFinishedUnsubscribeCount = 0;
  fireBrowserFinishedOnSubscribe = false;
  popupPollingIntervals = 0;
  startupDeadlineCallbacks = [];
  startResult = {
    data: {
      connect_url: "https://github.com/login/oauth/authorize?client_id=example",
    },
    response: new Response(null, { status: 200 }),
  };
  popup = {
    closed: false,
    close() {
      this.closed = true;
    },
    location: { href: "" },
  };
  Object.defineProperty(window, "open", {
    configurable: true,
    value: (url: string) => {
      openCalls.push(url);
      popup.closed = false;
      popup.location.href = url;
      queueMicrotask(() => dispatchOAuthReady(url));
      return popup;
    },
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: ((callback: () => void, delay?: number) => {
      if (delay === 30_000) {
        startupDeadlineCallbacks.push(callback);
        return 987_654 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: ((timer: ReturnType<typeof setTimeout>) => {
      if ((timer as unknown as number) === 987_654) {
        startupDeadlineCallbacks = [];
        return;
      }
      realClearTimeout(timer);
    }) as typeof clearTimeout,
  });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: ((callback: () => void, delay?: number) => {
      if (delay === 100) popupPollingIntervals += 1;
      return realSetInterval(callback, delay);
    }) as typeof setInterval,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: realSetTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: realClearTimeout,
  });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: realSetInterval,
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    value: realClearInterval,
  });
});

describe("IntegrationDetailModal managed OAuth", () => {
  test("starts authorization for a configured provider", async () => {
    const view = renderModal();
    const connectButton = await view.findByRole("button", {
      name: "Connect Account",
    });

    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(startCalls).toHaveLength(1);
      expect(popup.location.href).toBe(
        "https://github.com/login/oauth/authorize?client_id=example",
      );
    });
    const bootstrapUrl = new URL(openCalls[0]!);
    expect(["http:", "https:"]).toContain(bootstrapUrl.protocol);
    expect(bootstrapUrl.pathname).toBe("/account/oauth/popup-complete");
    expect(bootstrapUrl.searchParams.get("oauth_pending")).toBe("1");
    expect(
      startCalls[0]!.body.redirect_after_connect.startsWith(
        `${bootstrapUrl.origin}/account/oauth/popup-complete?`,
      ),
    ).toBe(true);
    expect(view.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  test("keeps waiting when COOP detaches the popup handle after authorization starts", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => {
      expect(popup.location.href).toContain("github.com/login/oauth");
    });

    const { requestId } = openedOAuthRequest();
    popup.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(view.getByText("Waiting for authorization...")).toBeTruthy();
    expect(view.queryByRole("alert")).toBeNull();

    connections = [connectedGitHubAccount()];
    act(() => dispatchOAuthStorage({ requestId }));

    expect(await view.findByText("GitHub account")).toBeTruthy();
  });

  test("shows an actionable error when managed OAuth is unavailable", async () => {
    startResult = {
      error: { error: { code: "NOT_FOUND", message: "Not found" } },
      response: new Response(null, { status: 501 }),
    };
    const view = renderModal();
    const connectButton = await view.findByRole("button", {
      name: "Connect Account",
    });

    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "Managed GitHub connections aren't available in this Worklin environment. Choose Your Own to connect with your OAuth app.",
      );
      expect(popup.closed).toBe(true);
    });

    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    view.unmount();

    const reopened = renderModal();
    expect(reopened.getByText("Your Own OAuth setup")).toBeTruthy();
    expect(reopened.queryByRole("tab", { name: "Managed" })).toBeNull();
  });

  test("preserves a typed authentication failure from connection preflight", async () => {
    connectionListResult = {
      error: { detail: "Authentication credentials were not provided." },
      response: new Response(null, { status: 401 }),
    };
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "Your Worklin session has expired",
      );
    });
    expect(startCalls).toHaveLength(0);
    expect(popup.closed).toBe(true);
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("remembers an unsupported connection preflight capability", async () => {
    connectionListResult = {
      error: { detail: "Method not allowed" },
      response: new Response(null, { status: 405 }),
    };
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "Managed GitHub connections aren't available",
      );
    });
    expect(startCalls).toHaveLength(0);
    expect(isManagedOAuthProviderUnsupported("assistant-123", "github")).toBe(
      true,
    );

    view.unmount();
    const reopened = renderModal();
    expect(reopened.getByText("Your Own OAuth setup")).toBeTruthy();
    expect(reopened.queryByRole("tab", { name: "Managed" })).toBeNull();
  });

  test("aborts connection preflight when its popup closes", async () => {
    connectionListPending = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(connectionListCalls).toHaveLength(1));
    expect(startCalls).toHaveLength(0);
    expect(popup.location.href).toBe(openCalls[0]!);

    popup.closed = true;

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "popup closed before it could start",
      );
      expect(connectionListAbortCount).toBe(1);
    });
    expect(startCalls).toHaveLength(0);
    expect(toastErrors).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(toastErrors).toHaveLength(1);
  });

  test("aborts authorization start when its popup closes", async () => {
    startPending = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(popup.location.href).toBe(openCalls[0]!);

    popup.closed = true;

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "popup closed before it could start",
      );
      expect(startAbortCount).toBe(1);
    });
    expect(popup.location.href).toBe(openCalls[0]!);
    expect(toastErrors).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(toastErrors).toHaveLength(1);
  });

  test("applies the 30 second startup deadline to native preflight without popup polling", async () => {
    nativePlatform = true;
    connectionListPending = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(connectionListCalls).toHaveLength(1));
    expect(openCalls).toHaveLength(0);
    expect(popupPollingIntervals).toBe(0);

    act(() => triggerStartupDeadline());

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "authorization took too long to start",
      );
      expect(connectionListAbortCount).toBe(1);
    });
    expect(startCalls).toHaveLength(0);
  });

  test("aborts a hanging native authorization start at the shared deadline", async () => {
    nativePlatform = true;
    startPending = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));
    expect(nativeOpenCalls).toHaveLength(0);
    expect(popupPollingIntervals).toBe(0);

    act(() => triggerStartupDeadline());

    await waitFor(() => {
      expect(startAbortCount).toBe(1);
      expect(view.getByRole("alert").textContent).toContain(
        "authorization took too long to start",
      );
    });
  });

  test("ignores a native browserFinished race before authorization starts", async () => {
    nativePlatform = true;
    fireBrowserFinishedOnSubscribe = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(nativeOpenCalls).toHaveLength(1));

    expect(connectionListCalls).toHaveLength(1);
    expect(view.getByText("Waiting for authorization...")).toBeTruthy();

    connections = [connectedGitHubAccount()];
    act(() => browserFinishedListener?.());

    expect(await view.findByText("GitHub account")).toBeTruthy();
    expect(browserFinishedUnsubscribeCount).toBe(1);
  });

  test("keeps native deep-link completion request and provider scoped", async () => {
    nativePlatform = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(nativeOpenCalls).toHaveLength(1));
    const callback = startedCallbackUrl();
    const requestId = callback.searchParams.get("requestId")!;

    act(() => {
      publish("oauth.complete", {
        requestId,
        oauthStatus: "denied",
        oauthProvider: "slack",
        oauthCode: "wrong_provider",
      });
    });
    expect(view.getByText("Waiting for authorization...")).toBeTruthy();

    act(() => {
      publish("oauth.complete", {
        requestId,
        oauthStatus: "denied",
        oauthProvider: "github",
        oauthCode: "access_denied",
      });
    });
    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("access_denied");
    });
    expect(browserFinishedUnsubscribeCount).toBe(1);
  });

  test("uses a scoped deep-link callback for packaged Electron completion", async () => {
    electronPlatform = true;
    const view = renderModal();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => {
      expect(startCalls).toHaveLength(1);
      expect(popup.location.href).toContain("github.com/login/oauth");
    });

    const callback = startedCallbackUrl();
    expect(callback.searchParams.get("handoff")).toBe("deep-link");
    const requestId = callback.searchParams.get("requestId")!;

    act(() => {
      publish("oauth.complete", {
        requestId,
        oauthStatus: "denied",
        oauthProvider: "github",
        oauthCode: "user_denied_access",
      });
    });

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "user_denied_access",
      );
    });
    expect(popup.closed).toBe(true);
  });

  test("shows success only after the provider connection changes", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));

    const request = openedOAuthRequest();
    connections = [connectedGitHubAccount()];
    dispatchOAuthMessage(request);

    expect(await view.findByText("GitHub account")).toBeTruthy();
    expect(popup.closed).toBe(true);
    expect(view.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  test("rejects a connected callback when no provider connection appears", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));

    dispatchOAuthMessage(openedOAuthRequest());

    await waitFor(
      () => {
        expect(view.getByRole("alert").textContent).toContain(
          "no new or updated account was found",
        );
      },
      { timeout: 8_000 },
    );
    expect(popup.closed).toBe(true);
    expect(view.queryByRole("button", { name: "Done" })).toBeNull();
  }, 10_000);

  test("reports verification server failures instead of claiming no account was found", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));

    connectionListResult = {
      error: { detail: "Connection service unavailable." },
      response: new Response(null, { status: 503 }),
    };
    dispatchOAuthMessage(openedOAuthRequest());

    await waitFor(() => {
      const message = view.getByRole("alert").textContent ?? "";
      expect(message).toContain("Connection service unavailable");
      expect(message).not.toContain("no new or updated account");
    });
  });

  test("aborts in-flight verification when the pending request is disposed", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));

    connectionListPending = true;
    dispatchOAuthMessage(openedOAuthRequest());
    await waitFor(() => expect(connectionListCalls).toHaveLength(2));

    view.unmount();
    await waitFor(() => expect(connectionListAbortCount).toBe(1));
  });

  test("ignores callbacks from the wrong window or provider", async () => {
    const view = renderModal();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect Account" }),
    );
    await waitFor(() => expect(startCalls).toHaveLength(1));

    const request = openedOAuthRequest();
    dispatchOAuthMessage({ ...request, source: window });
    dispatchOAuthMessage({ ...request, provider: "slack" });

    expect(popup.closed).toBe(false);
    expect(view.getByText("Waiting for authorization...")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Done" })).toBeNull();
  });

  test("shows Done only after a managed account exists", async () => {
    connections = [connectedGitHubAccount()];
    const view = renderModal();

    expect(await view.findByText("GitHub account")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(view.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});

describe("useOAuthConnect request identity", () => {
  test("aborts the captured assistant request when the selected assistant changes", async () => {
    connectionListPending = true;
    const view = renderOAuthConnectHarness("assistant-a", "github");

    fireEvent.click(view.getByRole("button", { name: "Connect harness" }));
    await waitFor(() => expect(connectionListCalls).toHaveLength(1));
    expect(connectionListCalls[0]!.path.assistant_id).toBe("assistant-a");

    view.rerender(view.renderHarness("assistant-b", "github"));

    await waitFor(() => expect(connectionListAbortCount).toBe(1));
    expect(view.getByText("Idle")).toBeTruthy();
    expect(startCalls).toHaveLength(0);
    expect(toastErrors).toHaveLength(0);
  });

  test("aborts the captured provider request when the provider changes", async () => {
    connectionListPending = true;
    const view = renderOAuthConnectHarness("assistant-a", "github");

    fireEvent.click(view.getByRole("button", { name: "Connect harness" }));
    await waitFor(() => expect(connectionListCalls).toHaveLength(1));

    view.rerender(view.renderHarness("assistant-a", "slack"));

    await waitFor(() => expect(connectionListAbortCount).toBe(1));
    expect(view.getByText("Idle")).toBeTruthy();
    expect(startCalls).toHaveLength(0);
    expect(toastErrors).toHaveLength(0);
  });
});

describe("managed OAuth popup bootstrap", () => {
  test("uses the configured HTTPS web route for a packaged Electron origin", () => {
    const url = getManagedOAuthPopupBootstrapUrl({
      requestId: "req-electron",
      providerKey: "github",
      currentOrigin: "app://vellum.ai",
      configuredWebUrl: "https://app.example.com/assistant",
    });

    expect(url).toBe(
      "https://app.example.com/account/oauth/popup-complete?requestId=req-electron&oauth_provider=github&oauth_pending=1",
    );
  });
});

describe("managed OAuth authorization deadline", () => {
  test("remains bounded after external COOP navigation hides the real popup state", async () => {
    const result = connectManagedOAuth({
      assistantId: "assistant-123",
      providerKey: "github",
      providerLabel: "GitHub",
      policy: {
        authorizationTimeoutMs: 20,
        verification: { attempts: 1, delayMs: 0, timeoutMs: 1_000 },
      },
    });

    await waitFor(() => {
      expect(startCalls).toHaveLength(1);
      expect(popup.location.href).toContain("github.com/login/oauth");
    });
    popup.closed = true;

    await expect(result).resolves.toEqual({
      status: "error",
      reason: "timeout",
      message:
        "GitHub authorization timed out before a connected account was found. Try again.",
    });
  });
});

describe("fetchManagedOAuthConnectionBaseline", () => {
  const options = {
    assistantId: "assistant-123",
    providerKey: "github",
    providerLabel: "GitHub",
  };

  for (const [status, error, reason, unsupported] of [
    [
      401,
      { detail: "Authentication credentials were not provided." },
      "unauthenticated",
      false,
    ],
    [403, { detail: "Permission denied." }, "forbidden", false],
    [404, { detail: "Assistant not found." }, "assistant_missing", false],
    [405, { detail: "Method not allowed." }, "unsupported", true],
    [501, { detail: "Not implemented." }, "unsupported", true],
    [503, { detail: "Service unavailable." }, "server_error", false],
  ] as const) {
    test(`classifies preflight HTTP ${status} as ${reason}`, async () => {
      connectionListResult = {
        error,
        response: new Response(null, { status }),
      };

      try {
        await fetchManagedOAuthConnectionBaseline(options);
        throw new Error("expected managed OAuth preflight to fail");
      } catch (caught) {
        expect(caught).toBeInstanceOf(ManagedOAuthStartError);
        expect(caught).toMatchObject({ reason });
      }
      expect(isManagedOAuthProviderUnsupported("assistant-123", "github")).toBe(
        unsupported,
      );
    });
  }

  test("keeps an ambiguous preflight 404 retryable", async () => {
    connectionListResult = {
      error: { detail: "Not found" },
      response: new Response(null, { status: 404 }),
    };

    await expect(
      fetchManagedOAuthConnectionBaseline(options),
    ).rejects.toMatchObject({ reason: "request_failed" });
    expect(isManagedOAuthProviderUnsupported("assistant-123", "github")).toBe(
      false,
    );

    connectionListResult = {
      data: [],
      response: new Response(null, { status: 200 }),
    };
    await expect(fetchManagedOAuthConnectionBaseline(options)).resolves.toEqual(
      [],
    );
  });
});

describe("verifyManagedOAuthConnection", () => {
  const options = {
    assistantId: "assistant-123",
    providerKey: "github",
    providerLabel: "GitHub",
    baselineConnectionSignatures: new Map<string, string>(),
  };
  const singleAttempt = { attempts: 1, delayMs: 0, timeoutMs: 1_000 };

  test("returns connected only for a new provider connection", async () => {
    connections = [connectedGitHubAccount()];

    await expect(
      verifyManagedOAuthConnection(options, singleAttempt),
    ).resolves.toEqual({
      outcome: "connected",
      connection: connectedGitHubAccount(),
    });
  });

  test("returns absent only after a successful connection response", async () => {
    await expect(
      verifyManagedOAuthConnection(options, singleAttempt),
    ).resolves.toEqual({ outcome: "absent" });
  });

  for (const [status, reason] of [
    [401, "unauthenticated"],
    [403, "forbidden"],
    [503, "server_error"],
  ] as const) {
    test(`returns failed for verification HTTP ${status}`, async () => {
      connectionListResult = {
        error: { detail: `Verification HTTP ${status}` },
        response: new Response(null, { status }),
      };

      await expect(
        verifyManagedOAuthConnection(options, singleAttempt),
      ).resolves.toMatchObject({ outcome: "failed", reason });
    });
  }

  test("returns failed for a verification network error", async () => {
    connectionListThrownError = new TypeError("Failed to fetch");

    await expect(
      verifyManagedOAuthConnection(options, singleAttempt),
    ).resolves.toMatchObject({
      outcome: "failed",
      reason: "request_failed",
    });
  });

  test("bounds and aborts a hanging verification request", async () => {
    connectionListPending = true;

    const result = await verifyManagedOAuthConnection(options, {
      attempts: 2,
      delayMs: 5,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ outcome: "failed", reason: "timeout" });
    expect(result.outcome === "failed" ? result.message : "").toContain(
      "result is unknown",
    );
    expect(connectionListAbortCount).toBe(1);
  });

  test("propagates caller cancellation through the active verification request", async () => {
    connectionListPending = true;
    const controller = new AbortController();
    const verification = verifyManagedOAuthConnection(
      { ...options, signal: controller.signal },
      { attempts: 2, delayMs: 5, timeoutMs: 1_000 },
    );
    await waitFor(() => expect(connectionListCalls).toHaveLength(1));

    controller.abort();

    await expect(verification).rejects.toMatchObject({ name: "AbortError" });
    expect(connectionListAbortCount).toBe(1);
  });
});

describe("startManagedOAuthAuthorization", () => {
  const options = {
    assistantId: "assistant-123",
    providerKey: "github",
    providerLabel: "GitHub",
    redirectAfterConnect:
      "/account/oauth/popup-complete?requestId=req-service-test",
  };

  test("returns a safe authorization URL for a configured provider", async () => {
    await expect(startManagedOAuthAuthorization(options)).resolves.toBe(
      "https://github.com/login/oauth/authorize?client_id=example",
    );
    expect(startCalls).toHaveLength(1);
  });

  test("classifies an explicitly unsupported platform route", async () => {
    startResult = {
      error: { detail: "Not implemented" },
      response: new Response(null, { status: 501 }),
    };

    await expect(startManagedOAuthAuthorization(options)).rejects.toMatchObject(
      {
        reason: "unsupported",
        message:
          "Managed GitHub connections aren't available in this Worklin environment. Choose Your Own to connect with your OAuth app.",
      },
    );
  });

  test("distinguishes assistant missing from an unsupported capability", async () => {
    startResult = {
      error: { detail: "Assistant not found." },
      response: new Response(null, { status: 404 }),
    };

    await expect(startManagedOAuthAuthorization(options)).rejects.toMatchObject(
      {
        reason: "assistant_missing",
        message:
          "Worklin could not find this assistant. Refresh the page before connecting GitHub.",
      },
    );
  });

  test("does not treat an ambiguous 404 as an unsupported capability", async () => {
    startResult = {
      error: { detail: "Not found" },
      response: new Response(null, { status: 404 }),
    };

    await expect(startManagedOAuthAuthorization(options)).rejects.toMatchObject(
      {
        reason: "request_failed",
      },
    );
  });

  test("rejects authorization URLs that cannot be opened safely", async () => {
    startResult = {
      data: { connect_url: "javascript:alert(document.domain)" },
      response: new Response(null, { status: 200 }),
    };

    await expect(startManagedOAuthAuthorization(options)).rejects.toMatchObject(
      {
        reason: "request_failed",
        message:
          "Worklin received an invalid GitHub authorization link. Try again, or choose Your Own to connect with your OAuth app.",
      },
    );
  });

  test("rejects non-loopback HTTP authorization URLs", async () => {
    startResult = {
      data: { connect_url: "http://oauth.example.com/authorize" },
      response: new Response(null, { status: 200 }),
    };

    await expect(startManagedOAuthAuthorization(options)).rejects.toMatchObject(
      {
        reason: "request_failed",
        message:
          "Worklin received an invalid GitHub authorization link. Try again, or choose Your Own to connect with your OAuth app.",
      },
    );
  });

  test("allows explicit loopback HTTP authorization URLs for local development", async () => {
    startResult = {
      data: { connect_url: "http://127.0.0.1:8787/authorize" },
      response: new Response(null, { status: 200 }),
    };

    await expect(startManagedOAuthAuthorization(options)).resolves.toBe(
      "http://127.0.0.1:8787/authorize",
    );
  });

  for (const [status, reason] of [
    [401, "unauthenticated"],
    [403, "forbidden"],
    [503, "server_error"],
  ] as const) {
    test(`classifies HTTP ${status} as ${reason}`, async () => {
      startResult = {
        error: { detail: `HTTP ${status} test failure` },
        response: new Response(null, { status }),
      };

      try {
        await startManagedOAuthAuthorization(options);
        throw new Error("expected managed OAuth start to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedOAuthStartError);
        expect(error).toMatchObject({ reason });
      }
    });
  }

  test("keeps transient start failures actionable", async () => {
    startResult = {
      error: { detail: "Authorization service is temporarily unavailable." },
      response: new Response(null, { status: 503 }),
    };

    try {
      await startManagedOAuthAuthorization(options);
      throw new Error("expected managed OAuth start to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedOAuthStartError);
      expect(error).toMatchObject({
        reason: "server_error",
        message:
          "Authorization service is temporarily unavailable. Try again, or choose Your Own to connect with your OAuth app.",
      });
    }
  });
});
