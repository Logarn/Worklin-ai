import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, waitFor } from "@testing-library/react";

import type { OAuthConnection } from "@/generated/api/types.gen";
import { __resetForTesting as resetEventBus, publish } from "@/lib/event-bus";

interface StartCall {
  path: { assistant_id: string; provider: string };
  body: { requested_scopes: string[]; redirect_after_connect: string };
  signal?: AbortSignal;
}

let connections: OAuthConnection[] = [];
let startCalls: StartCall[] = [];
let nativePlatform = false;
let nativeOpenCalls: string[] = [];
let popup: {
  closed: boolean;
  close: () => void;
  location: { href: string };
};

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOauthConnectionsList: async () => ({
    data: connections,
    response: new Response(null, { status: 200 }),
  }),
  assistantsOauthStartCreate: async (options: StartCall) => {
    startCalls.push(options);
    return {
      data: {
        connect_url:
          "https://github.com/login/oauth/authorize?client_id=example",
      },
      response: new Response(null, { status: 200 }),
    };
  },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  oauthProvidersGet: async () => ({ data: { providers: [] } }),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
  useIsNativePlatform: () => nativePlatform,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/runtime/browser", () => ({
  openUrl: async (url: string) => {
    nativeOpenCalls.push(url);
  },
  openUrlFinishedListener: () => () => undefined,
}));

const { connectManagedOAuthProvider } =
  await import("@/domains/chat/api/managed-oauth");

function connectedGitHubAccount(): OAuthConnection {
  return {
    id: "connection-123",
    provider: "github",
    account_label: "GitHub account",
    connected: true,
    status: "ACTIVE",
    scopes_granted: ["repo"],
    expires_at: null,
  };
}

function dispatchReady(url: string): void {
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

function dispatchCompletion({
  requestId,
  provider = "github",
  source = popup,
}: {
  requestId: string;
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
    origin: window.location.origin,
  });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

beforeEach(() => {
  resetEventBus();
  connections = [];
  startCalls = [];
  nativePlatform = false;
  nativeOpenCalls = [];
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
      popup.closed = false;
      popup.location.href = url;
      queueMicrotask(() => dispatchReady(url));
      return popup;
    },
  });
});

afterEach(() => {
  cleanup();
  resetEventBus();
});

describe("in-chat managed OAuth", () => {
  test("ignores the wrong popup source and provider before accepting completion", async () => {
    let settled = false;
    const resultPromise = connectManagedOAuthProvider({
      assistantId: "assistant-chat",
      providerKey: "github",
      providerLabel: "GitHub",
    }).then((result) => {
      settled = true;
      return result;
    });

    await waitFor(() => expect(startCalls).toHaveLength(1));
    const callbackUrl = new URL(startCalls[0]!.body.redirect_after_connect);
    const requestId = callbackUrl.searchParams.get("requestId")!;
    connections = [connectedGitHubAccount()];

    dispatchCompletion({ requestId, source: window });
    dispatchCompletion({ requestId, provider: "slack" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    dispatchCompletion({ requestId });

    await expect(resultPromise).resolves.toEqual({
      status: "connected",
      connection: connectedGitHubAccount(),
    });
    expect(startCalls[0]!.path).toEqual({
      assistant_id: "assistant-chat",
      provider: "github",
    });
  });

  test("receives scoped Capacitor denial detail through the typed event bus", async () => {
    nativePlatform = true;
    let settled = false;
    const resultPromise = connectManagedOAuthProvider({
      assistantId: "assistant-chat",
      providerKey: "github",
      providerLabel: "GitHub",
    }).then((result) => {
      settled = true;
      return result;
    });

    await waitFor(() => expect(nativeOpenCalls).toHaveLength(1));
    const callbackUrl = new URL(startCalls[0]!.body.redirect_after_connect);
    const requestId = callbackUrl.searchParams.get("requestId")!;

    publish("oauth.complete", {
      requestId,
      oauthStatus: "denied",
      oauthProvider: "slack",
      oauthCode: "wrong_provider",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    publish("oauth.complete", {
      requestId,
      oauthStatus: "denied",
      oauthProvider: "github",
      oauthCode: "access_denied",
    });

    await expect(resultPromise).resolves.toEqual({
      status: "error",
      message: "GitHub authorization failed: access_denied",
    });
    expect(callbackUrl.searchParams.get("handoff")).toBe("deep-link");
  });
});
