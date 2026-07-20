import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import {
  authInfoGetQueryKey,
  configGetQueryKey,
  inferenceProviderconnectionsGetQueryKey,
  secretsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse, ProviderConnection } from "@/generated/daemon/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-1",
}));

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    queryComplexityRouting: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { LanguageModelCard } = await import(
  "@/domains/settings/ai/language-model-card"
);

function Wrapper({
  children,
  hasKimiSecret = true,
  managedInferenceAvailable = true,
  activeProfile = "kimi-personal",
}: {
  children: ReactNode;
  hasKimiSecret?: boolean;
  managedInferenceAvailable?: boolean;
  activeProfile?: "balanced" | "kimi-personal";
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const config: ConfigGetResponse = {
    llm: {
      activeProfile,
      profileOrder: ["balanced", "kimi-personal"],
      profiles: {
        balanced: {
          source: "managed",
          label: "Balanced",
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
        "kimi-personal": {
          source: "user",
          label: "Kimi",
          provider: "kimi",
          model: "kimi-k2.6",
          provider_connection: "kimi-personal",
        },
      },
      callSites: {},
    },
  } as ConfigGetResponse;
  const connection: ProviderConnection = {
    name: "kimi-personal",
    label: "Kimi",
    provider: "kimi",
    auth: { type: "api_key", credential: "credential/kimi/api_key" },
    models: null,
  } as unknown as ProviderConnection;

  client.setQueryData(
    authInfoGetQueryKey({ path: { assistant_id: "asst-1" } }),
    {
      platformUrl: managedInferenceAvailable
        ? "https://platform.example.com"
        : null,
      assistantId: "asst-1",
      organizationId: null,
      userId: null,
      authenticated: managedInferenceAvailable,
    },
  );
  client.setQueryData(
    configGetQueryKey({ path: { assistant_id: "asst-1" } }),
    config,
  );
  client.setQueryData(
    inferenceProviderconnectionsGetQueryKey({
      path: { assistant_id: "asst-1" },
    }),
    { connections: [connection] },
  );
  client.setQueryData(
    secretsGetQueryKey({ path: { assistant_id: "asst-1" } }),
    {
      secrets: hasKimiSecret ? [{ type: "api_key", name: "kimi" }] : [],
      accounts: hasKimiSecret ? [{ type: "api_key", name: "kimi" }] : [],
    },
  );

  return createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ assistants: [] });
});

describe("LanguageModelCard", () => {
  test("shows the simplified BYOK model setup surface", () => {
    const { getAllByText, getByText } = render(
      <Wrapper>
        <LanguageModelCard />
      </Wrapper>,
    );

    expect(getByText("Use Worklin credits")).toBeTruthy();
    expect(getByText("Use my API key")).toBeTruthy();
    expect(getByText("Your assistant's main model")).toBeTruthy();
    expect(getAllByText("Kimi").length).toBeGreaterThan(0);
    expect(getByText("Kimi K2.6")).toBeTruthy();
    expect(getByText("Key connected")).toBeTruthy();
    expect(getByText("Available services")).toBeTruthy();
    expect(getByText("xAI")).toBeTruthy();
    expect(getByText("Advanced model settings")).toBeTruthy();
  });

  test("does not report a connection whose credential is missing", () => {
    const { getByText, queryByText } = render(
      <Wrapper hasKimiSecret={false}>
        <LanguageModelCard />
      </Wrapper>,
    );

    const keyRequired = getByText("Key required");
    expect(keyRequired).toBeTruthy();
    expect(keyRequired.querySelector("span")?.className).toContain(
      "content-disabled",
    );
    expect(queryByText("Key connected")).toBeNull();
  });

  test("uses the pooled vault-only settings surface for pooled assistants", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          name: "Pool assistant",
          isLocal: false,
          isPlatformHosted: true,
          runtimeProvider: "pooled_worker",
        },
      ],
    });

    const { getByText, queryByText } = render(
      <Wrapper>
        <LanguageModelCard />
      </Wrapper>,
    );

    expect(getByText("Your assistant's model")).toBeTruthy();
    expect(getByText("Replace API key")).toBeTruthy();
    expect(getByText("Remove API key")).toBeTruthy();
    expect(
      getByText(/custom endpoints, credential aliases, ChatGPT subscription/i),
    ).toBeTruthy();
    expect(queryByText("Use Worklin credits")).toBeNull();
    expect(queryByText("Manage providers")).toBeNull();
  });

  test("hides Worklin credits when managed inference is unavailable", () => {
    const { getByText, queryByText } = render(
      <Wrapper managedInferenceAvailable={false}>
        <LanguageModelCard />
      </Wrapper>,
    );

    expect(queryByText("Use Worklin credits")).toBeNull();
    expect(getByText("Use my API key")).toBeTruthy();
    expect(getByText("Key connected")).toBeTruthy();
  });

  test("does not present a stale managed active profile as usable", () => {
    const { getByText, queryByText } = render(
      <Wrapper
        managedInferenceAvailable={false}
        activeProfile="balanced"
      >
        <LanguageModelCard />
      </Wrapper>,
    );

    expect(queryByText("Use Worklin credits")).toBeNull();
    expect(getByText("No model selected")).toBeTruthy();
    expect(getByText("Key required")).toBeTruthy();
    expect(queryByText("Using Worklin credits")).toBeNull();
  });
});
