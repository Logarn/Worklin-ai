import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";

interface PatchConnectionCall {
  path: { assistant_id: string; name: string };
  body: Record<string, unknown>;
}

let patchConnectionCalls: PatchConnectionCall[] = [];
let configGetCalls: Array<{ path: { assistant_id: string } }> = [];
let configPatchCalls: Array<{
  path: { assistant_id: string };
  body: Record<string, unknown>;
}> = [];
let savedConnection: ProviderConnection | null = null;
let updatedConnection: ProviderConnection;
let apiKeySectionProps: Record<string, unknown> | null = null;

mock.module("@vellumai/design-library/components/modal", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Modal: {
      Content: passthrough,
      Header: passthrough,
      Title: passthrough,
      Description: passthrough,
      Body: passthrough,
      Footer: passthrough,
    },
  };
});

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

mock.module("@vellumai/design-library/components/dropdown", () => ({
  Dropdown: ({
    "aria-label": ariaLabel,
    disabled,
    options,
    value,
  }: {
    "aria-label"?: string;
    disabled?: boolean;
    options: Array<{ value: string; label: string }>;
    value?: string;
  }) => {
    const selected = options.find((option) => option.value === value);
    return createElement(
      "button",
      {
        "aria-label": ariaLabel,
        disabled,
        role: "combobox",
        type: "button",
      },
      selected?.label ?? "",
    );
  },
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

mock.module("@/components/ai/chatgpt-oauth-section", () => ({
  ChatgptOAuthSection: () => null,
}));

mock.module("@/domains/settings/ai/provider-create-form", () => ({
  ProviderCreateForm: () => null,
}));

mock.module("@/domains/settings/ai/provider-editor-api-key-section", () => ({
  ProviderEditorApiKeySection: (props: Record<string, unknown>) => {
    apiKeySectionProps = props;
    return null;
  },
}));

mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  credentialPresenceQueryKey: (
    assistantId: string,
    kind: string,
    name: string,
  ) => ["credentialPresence", assistantId, kind, name] as const,
  useStoredCredentialPresence: () => ({
    hasStoredCredential: true,
    isLoading: false,
  }),
}));

mock.module("@/domains/settings/ai/use-provider-credentials-list", () => ({
  useProviderCredentialsList: () => ({
    credentials: [],
    isLoading: false,
  }),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetQueryKey: (options: unknown) => ["configGet", options],
  inferenceProviderconnectionsGetQueryKey: (options: unknown) => [
    "inferenceProviderconnectionsGet",
    options,
  ],
  secretsGetQueryKey: (options: unknown) => ["secretsGet", options],
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  inferenceProviderconnectionsGet: () =>
    Promise.resolve({
      data: { connections: [] },
      response: { ok: true, status: 200 },
    }),
  secretsGet: () =>
    Promise.resolve({
      data: { secrets: [], accounts: [] },
      response: { ok: true, status: 200 },
    }),
  inferenceProviderconnectionsByNamePatch: (opts: PatchConnectionCall) => {
    patchConnectionCalls.push(opts);
    return Promise.resolve({
      data: updatedConnection,
      response: { ok: true, status: 200 },
    });
  },
  secretsPost: () =>
    Promise.resolve({
      data: undefined,
      response: { ok: true, status: 200 },
    }),
  configGet: (opts: { path: { assistant_id: string } }) => {
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
  configPatch: (opts: {
    path: { assistant_id: string };
    body: Record<string, unknown>;
  }) => {
    configPatchCalls.push(opts);
    return Promise.resolve({
      data: undefined,
      response: { ok: true, status: 200 },
    });
  },
}));

const { ProviderEditorContent } = await import(
  "@/domains/settings/ai/provider-editor-modal"
);

const ASSISTANT_ID = "asst-1";

function makeConnection(): ProviderConnection {
  return {
    name: "anthropic-personal",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    label: "Anthropic",
    baseUrl: null,
    models: null,
    createdAt: 100,
    updatedAt: 200,
    isManaged: false,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
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

beforeEach(() => {
  patchConnectionCalls = [];
  configGetCalls = [];
  configPatchCalls = [];
  savedConnection = null;
  updatedConnection = makeConnection();
  apiKeySectionProps = null;
});

afterEach(() => {
  cleanup();
});

describe("ProviderEditorContent", () => {
  test("editing xAI keeps the xAI credential namespace", () => {
    const xaiConnection: ProviderConnection = {
      ...makeConnection(),
      name: "xai-personal",
      provider: "openai-compatible",
      auth: {
        type: "api_key",
        credential: "credential/xai/api_key",
      },
      label: "xAI",
      baseUrl: "https://api.x.ai/v1",
      models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
    };

    render(
      <Wrapper>
        <ProviderEditorContent
          mode="edit"
          connection={xaiConnection}
          assistantId={ASSISTANT_ID}
          existingNames={["xai-personal"]}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    expect(apiKeySectionProps?.credentialService).toBe("xai");
  });

  test("editing a user-owned connection selects a runnable provider profile", async () => {
    render(
      <Wrapper>
        <ProviderEditorContent
          mode="edit"
          connection={makeConnection()}
          assistantId={ASSISTANT_ID}
          existingNames={["anthropic-personal"]}
          onSave={(connection) => {
            savedConnection = connection;
          }}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    fireEvent.click(getButton("Save"));

    await waitFor(() => {
      expect(patchConnectionCalls).toHaveLength(1);
    });
    expect(patchConnectionCalls[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: "anthropic-personal" },
      body: {
        auth: {
          type: "api_key",
          credential: "credential/anthropic/api_key",
        },
        label: "Anthropic",
      },
    });

    await waitFor(() => {
      expect(configPatchCalls).toHaveLength(1);
    });
    expect(configGetCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    expect(savedConnection?.name).toBe("anthropic-personal");
  });
});
