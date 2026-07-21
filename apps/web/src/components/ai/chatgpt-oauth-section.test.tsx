import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";

interface AssistantPathCall {
  path: { assistant_id: string };
  throwOnError?: boolean;
}

interface ExchangeCall extends AssistantPathCall {
  body: Record<string, unknown>;
}

let startAuthCalls: AssistantPathCall[] = [];
let exchangeCalls: ExchangeCall[] = [];
let providerConnectionsGetCalls: AssistantPathCall[] = [];
let configGetCalls: AssistantPathCall[] = [];
let configPatchCalls: Array<AssistantPathCall & { body: Record<string, unknown> }> = [];
let queryInvalidationCalls: unknown[] = [];
let connectedConnection: ProviderConnection | null = null;
let providerConnections: ProviderConnection[] = [];
let configPatchError: Error | null = null;

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    disabled,
    iconOnly,
    onClick,
    type = "button",
  }: {
    children?: ReactNode;
    disabled?: boolean;
    iconOnly?: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit";
  }) =>
    createElement("button", { disabled, onClick, type }, children ?? iconOnly),
}));

mock.module("@vellumai/design-library/components/input", () => ({
  Input: ({ fullWidth: _fullWidth, ...props }: Record<string, unknown>) =>
    createElement("input", props),
}));

mock.module("@vellumai/design-library/components/typography", () => ({
  Typography: ({
    as,
    children,
    className,
  }: {
    as?: string;
    children?: ReactNode;
    className?: string;
  }) => createElement(as ?? "span", { className }, children),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetQueryKey: (options: unknown) => ["configGet", options],
  secretsGetQueryKey: (options: unknown) => ["secretsGet", options],
}));

mock.module("@/generated/daemon/client.gen", () => ({
  client: {
    post: () =>
      Promise.resolve({
        data: { status: "pending", callback_listening: false },
        response: { ok: true },
      }),
  },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  inferenceChatgptsubscriptionAuthPost: (opts: AssistantPathCall) => {
    startAuthCalls.push(opts);
    return Promise.resolve({
      data: {
        authorize_url: "https://chatgpt.com/authorize",
        state: "state-1",
        mode: "loopback",
        callback_listening: false,
        code_verifier: "verifier-1",
      },
      response: { ok: true, status: 200 },
    });
  },
  inferenceChatgptsubscriptionAuthExchangePost: (opts: ExchangeCall) => {
    exchangeCalls.push(opts);
    return Promise.resolve({
      data: undefined,
      response: { ok: true, status: 200 },
    });
  },
  inferenceProviderconnectionsGet: (opts: AssistantPathCall) => {
    providerConnectionsGetCalls.push(opts);
    return Promise.resolve({
      data: { connections: providerConnections },
      response: { ok: true, status: 200 },
    });
  },
  secretsGet: () =>
    Promise.resolve({
      data: { secrets: [], accounts: [] },
      response: { ok: true, status: 200 },
    }),
  configGet: (opts: AssistantPathCall) => {
    configGetCalls.push(opts);
    return Promise.resolve({
      data: {
        llm: {
          activeProfile: "balanced",
          profileOrder: ["balanced"],
          profiles: {
            balanced: {
              source: "managed",
              label: "Balanced",
              provider: "anthropic",
              model: "claude-opus-4-8",
            },
          },
        },
      },
      response: { ok: true, status: 200 },
    });
  },
  configPatch: (
    opts: AssistantPathCall & { body: Record<string, unknown> },
  ) => {
    configPatchCalls.push(opts);
    if (configPatchError) {
      return Promise.reject(configPatchError);
    }
    return Promise.resolve({
      data: undefined,
      response: { ok: true, status: 200 },
    });
  },
}));

const { ChatgptOAuthSection } = await import(
  "@/components/ai/chatgpt-oauth-section"
);

const ASSISTANT_ID = "asst-1";

function chatgptConnection(): ProviderConnection {
  return {
    name: "chatgpt-subscription",
    provider: "openai",
    auth: {
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    },
    label: "ChatGPT Subscription",
    baseUrl: null,
    models: null,
    createdAt: 100,
    updatedAt: 200,
    isManaged: false,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.invalidateQueries = ((filters: unknown) => {
    queryInvalidationCalls.push(filters);
    return Promise.resolve();
  }) as QueryClient["invalidateQueries"];
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const match = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((input) => input.placeholder === placeholder);
  if (!match) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return match;
}

beforeEach(() => {
  startAuthCalls = [];
  exchangeCalls = [];
  providerConnectionsGetCalls = [];
  configGetCalls = [];
  configPatchCalls = [];
  queryInvalidationCalls = [];
  connectedConnection = null;
  providerConnections = [chatgptConnection()];
  configPatchError = null;
});

afterEach(() => {
  cleanup();
});

describe("ChatgptOAuthSection", () => {
  test("activating ChatGPT OAuth reroutes interactive calls immediately", async () => {
    render(
      <Wrapper>
        <ChatgptOAuthSection
          assistantId={ASSISTANT_ID}
          onConnected={(connection) => {
            connectedConnection = connection;
          }}
        />
      </Wrapper>,
    );

    fireEvent.click(getButton("Continue with ChatGPT"));

    await waitFor(() => {
      expect(startAuthCalls).toHaveLength(1);
    });
    expect(startAuthCalls[0].path.assistant_id).toBe(ASSISTANT_ID);

    fireEvent.change(
      getInputByPlaceholder("Paste backup callback URL here..."),
      {
        target: {
          value: "https://worklin.local/callback?code=code-1&state=state-1",
        },
      },
    );
    fireEvent.click(getButton("Complete Sign In"));

    await waitFor(() => {
      expect(exchangeCalls).toHaveLength(1);
    });
    expect(exchangeCalls[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: {
        code: "code-1",
        state: "state-1",
        code_verifier: "verifier-1",
      },
    });

    await waitFor(() => {
      expect(configPatchCalls).toHaveLength(1);
    });
    expect(configGetCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        callSites: {
          conversationTitle: { profile: "custom-balanced" },
          memoryExtraction: { profile: "custom-balanced" },
          subagentSpawn: { profile: "custom-balanced" },
        },
        profiles: {
          "custom-balanced": {
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.4-mini",
          },
        },
      },
    });
    expect(queryInvalidationCalls).toEqual([
      {
        queryKey: ["configGet", { path: { assistant_id: ASSISTANT_ID } }],
      },
    ]);
    expect(connectedConnection?.name).toBe("chatgpt-subscription");
    expect(providerConnectionsGetCalls[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID },
      throwOnError: true,
    });
    expect(document.body.textContent).toContain(
      "ChatGPT subscription connected successfully.",
    );
  });

  test("does not report completion when profile activation fails and retries setup without another sign-in", async () => {
    let onConnectedCalls = 0;
    configPatchError = new Error("profile activation failed");

    render(
      <Wrapper>
        <ChatgptOAuthSection
          assistantId={ASSISTANT_ID}
          onConnected={() => {
            onConnectedCalls += 1;
          }}
        />
      </Wrapper>,
    );

    fireEvent.click(getButton("Continue with ChatGPT"));
    await waitFor(() => expect(startAuthCalls).toHaveLength(1));

    fireEvent.change(
      getInputByPlaceholder("Paste backup callback URL here..."),
      {
        target: {
          value: "https://worklin.local/callback?code=code-1&state=state-1",
        },
      },
    );
    fireEvent.click(getButton("Complete Sign In"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "ChatGPT is connected, but Worklin could not finish setting it up for this assistant.",
      );
    });
    expect(onConnectedCalls).toBe(0);
    expect(document.body.textContent).not.toContain(
      "ChatGPT subscription connected successfully.",
    );
    expect(startAuthCalls).toHaveLength(1);

    configPatchError = null;
    fireEvent.click(getButton("Retry Setup"));

    await waitFor(() => expect(onConnectedCalls).toBe(1));
    expect(document.body.textContent).toContain(
      "ChatGPT subscription connected successfully.",
    );
    expect(startAuthCalls).toHaveLength(1);
  });
});
