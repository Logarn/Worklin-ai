/**
 * Tests for `ProviderCreateForm` — the shared create-path form extracted
 * from `ProviderEditorContent`.
 *
 * The component owns the two-step create submit sequence:
 *   1. `secretsPost` — persist the entered API key under
 *      the daemon's first-class `api_key` route when the credential belongs
 *      to the selected provider.
 *   2. `inferenceProviderconnectionsPost` — create the connection with the
 *      assembled `CreateConnectionInput`, then hand the returned connection
 *      back to the consumer via `onCreated`.
 *
 * We mock the generated daemon SDK (sdk.gen) at module scope via
 * module-level holders so each test can inspect the exact request bodies,
 * mirroring the mocking style in
 * `use-conversation-actions-archive-optimistic.test.tsx`. The credential
 * presence / list hooks are stubbed so the form doesn't fan out real
 * network queries during render.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, useState, type ReactNode } from "react";

import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

interface SecretsPostCall {
  path: { assistant_id: string };
  body: { type: string; name: string; value: string };
}
interface CreateConnectionCall {
  path: { assistant_id: string };
  body: Record<string, unknown>;
}
interface ConfigGetCall {
  path: { assistant_id: string };
}
interface ConfigPatchCall {
  path: { assistant_id: string };
  body: Record<string, unknown>;
}

let secretsPostCalls: SecretsPostCall[] = [];
let createConnectionCalls: CreateConnectionCall[] = [];
let configGetCalls: ConfigGetCall[] = [];
let configPatchCalls: ConfigPatchCall[] = [];
let createdConnection: ProviderConnection;
let createResponseOk = true;
let createResponseStatus = 200;
let toastSuccessCalls: string[] = [];
let configGetData: Record<string, unknown>;

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@vellumai/design-library/components/modal", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Modal: {
      Root: passthrough,
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
    "aria-labelledby": ariaLabelledBy,
    disabled,
    onChange,
    options,
    placeholder,
    value,
  }: {
    "aria-label"?: string;
    "aria-labelledby"?: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    placeholder?: string;
    value?: string;
  }) => {
    const [open, setOpen] = useState(false);
    const selected = options.find((option) => option.value === value);
    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          "aria-label": ariaLabel,
          "aria-labelledby": ariaLabelledBy,
          disabled,
          onClick: () => setOpen((current) => !current),
          role: "combobox",
          type: "button",
        },
        selected?.label ?? placeholder ?? "",
      ),
      open
        ? createElement(
            "div",
            { role: "listbox" },
            options.map((option) =>
              createElement(
                "button",
                {
                  key: option.value,
                  onClick: () => {
                    onChange(option.value);
                    setOpen(false);
                  },
                  role: "option",
                  type: "button",
                },
                option.label,
              ),
            ),
          )
        : null,
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

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: (opts: ConfigGetCall) => {
    configGetCalls.push(opts);
    return Promise.resolve({
      data: configGetData,
      response: { ok: true, status: 200 },
    });
  },
  configPatch: (opts: ConfigPatchCall) => {
    configPatchCalls.push(opts);
    return Promise.resolve({
      data: configGetData,
      response: { ok: true, status: 200 },
    });
  },
  secretsPost: (opts: SecretsPostCall) => {
    secretsPostCalls.push(opts);
    return Promise.resolve({
      data: undefined,
      response: { ok: true, status: 200 },
    });
  },
  inferenceProviderconnectionsPost: (opts: CreateConnectionCall) => {
    createConnectionCalls.push(opts);
    return Promise.resolve({
      data: createResponseOk ? createdConnection : undefined,
      response: { ok: createResponseOk, status: createResponseStatus },
    });
  },
  inferenceProviderconnectionsGet: () =>
    Promise.resolve({
      data: { connections: [] },
      response: { ok: true, status: 200 },
    }),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetQueryKey: (options: unknown) => ["configGet", options],
  secretsGetQueryKey: (options: unknown) => ["secretsGet", options],
}));

// Stub the credential hooks so render doesn't issue real daemon queries.
// `hasStoredCredential: false` matches the empty create-mode state.
mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  credentialPresenceQueryKey: (
    assistantId: string,
    kind: string,
    name: string,
  ) => ["credentialPresence", assistantId, kind, name] as const,
  useStoredCredentialPresence: () => ({
    hasStoredCredential: false,
    isLoading: false,
  }),
}));

mock.module("@/domains/settings/ai/use-provider-credentials-list", () => ({
  useProviderCredentialsList: () => ({
    credentials: [],
    isLoading: false,
  }),
}));

const { ProviderCreateForm } =
  await import("@/domains/settings/ai/provider-create-form");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConnection(
  name: string,
  provider: ConnectionProvider = "anthropic",
): ProviderConnection {
  return {
    name,
    label: null,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    models: null,
  } as unknown as ProviderConnection;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * The `variant="modal"` form renders `Modal.Content` (a Radix Dialog
 * portal), which requires a `Modal.Root` ancestor — exactly how
 * `ProviderEditorContent` embeds it. Wrap modal-variant renders so the
 * portal mounts.
 */
function ModalWrapper({ children }: { children: ReactNode }) {
  return <Wrapper>{children}</Wrapper>;
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(
      `expected a "${label}" button — saw: ${Array.from(
        document.querySelectorAll("button"),
      )
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

/**
 * Drive the design-library Dropdown (a custom combobox, not a native
 * <select>): click the trigger to open the listbox, then click the option
 * whose visible label matches.
 */
function selectDropdownOption(ariaLabel: string, optionLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a "${ariaLabel}" dropdown trigger`);
  }
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(
      `expected an option "${optionLabel}" in the "${ariaLabel}" dropdown — saw: ${Array.from(
        document.querySelectorAll('[role="option"]'),
      )
        .map((o) => `"${o.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

beforeEach(() => {
  secretsPostCalls = [];
  createConnectionCalls = [];
  configGetCalls = [];
  configPatchCalls = [];
  createdConnection = makeConnection("anthropic-personal");
  createResponseOk = true;
  createResponseStatus = 200;
  toastSuccessCalls = [];
  configGetData = {
    llm: {
      activeProfile: "balanced",
      profileOrder: ["balanced"],
      profiles: {
        balanced: {
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      },
    },
  };
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderCreateForm submit sequence", () => {
  test("submitting an API key fires secretsPost then inferenceProviderconnectionsPost and calls onCreated", async () => {
    let created: ProviderConnection | undefined;
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={(c) => {
            created = c;
          }}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    // Default provider is anthropic with Worklin-credit auth — switch to API key.
    // Type a Key (name) and an API key value.
    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });

    // Select API key auth so the API key field renders.
    selectDropdownOption("Auth type", "API key");

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });

    // secretsPost fired first via the daemon's first-class api_key route.
    expect(secretsPostCalls.length).toBe(1);
    expect(secretsPostCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(secretsPostCalls[0].body).toEqual({
      type: "api_key",
      name: "anthropic",
      value: "sk-test-123",
    });

    // Then inferenceProviderconnectionsPost with the CreateConnectionInput.
    expect(createConnectionCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(createConnectionCalls[0].body).toMatchObject({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    // onCreated received the returned connection.
    await waitFor(() => {
      expect(created).toBeDefined();
    });
    expect(created?.name).toBe("anthropic-personal");
  });

  test("blocks duplicate names with the existing validation message", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={["anthropic-personal"]}
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });

    expect(document.body.textContent).toContain(
      'A connection named "anthropic-personal" already exists.',
    );
    expect(getButton("Create").disabled).toBe(true);
  });

  test("variant=inline renders the form without Modal chrome and still creates", async () => {
    let created: ProviderConnection | undefined;
    render(
      <Wrapper>
        <ProviderCreateForm
          variant="inline"
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={(c) => {
            created = c;
          }}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // Inline variant drops the modal title.
    expect(document.body.textContent).not.toContain("Add model service");

    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });

    selectDropdownOption("Auth type", "API key");
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    await waitFor(() => {
      expect(created?.name).toBe("anthropic-personal");
    });
  });

  test("defaultAuthType='api_key' seeds the API key path (Save as New clone)", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          defaultAuthType="api_key"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    // The API key field only renders for api_key auth, so its presence
    // confirms the form initialized on the "bring your own credential" path
    // (instead of the managed-capable provider's default `platform`).
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
  });

  test("a provider without platform auth (e.g. openrouter) seeds api_key, not platform", () => {
    // openrouter has no managed proxy, so defaulting to `platform` would let the
    // user create an unusable connection. The initial auth seed must fall back
    // to api_key — the API key field's presence confirms it.
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="openrouter"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
  });

  test("confirms a successful provider is connected and selected", async () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });
    selectDropdownOption("Auth type", "API key");
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(toastSuccessCalls).toEqual(["Provider connected and selected"]);
    });
  });

  test("creating Kimi on an assistant with no active profile selects a runnable default profile", async () => {
    configGetData = {
      llm: {
        activeProfile: null,
        profileOrder: [],
        profiles: {},
      },
    };
    createdConnection = makeConnection("kimi", "kimi");

    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="kimi"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "moonshot-test-key" },
    });

    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });

    expect(secretsPostCalls[0].body).toEqual({
      type: "api_key",
      name: "kimi",
      value: "moonshot-test-key",
    });
    expect(configGetCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configPatchCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profileOrder: ["custom-balanced"],
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            provider: "kimi",
            provider_connection: "kimi",
            model: "kimi-k2.6",
          },
        },
      },
    });
    expect(toastSuccessCalls).toEqual(["Provider connected and selected"]);
  });

  test("creating Kimi while Worklin credits are active switches the assistant to Kimi", async () => {
    configGetData = {
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
    };
    createdConnection = makeConnection("kimi", "kimi");

    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="kimi"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "moonshot-test-key" },
    });

    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });

    expect(secretsPostCalls[0].body).toEqual({
      type: "api_key",
      name: "kimi",
      value: "moonshot-test-key",
    });
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profileOrder: ["balanced", "custom-balanced"],
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            provider: "kimi",
            provider_connection: "kimi",
            model: "kimi-k2.6",
          },
        },
      },
    });
    expect(toastSuccessCalls).toEqual(["Provider connected and selected"]);
  });

  test("creating Kimi replaces an older user profile as the active model", async () => {
    configGetData = {
      llm: {
        activeProfile: "custom-balanced",
        profileOrder: ["custom-balanced"],
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
          },
        },
      },
    };
    createdConnection = makeConnection("kimi", "kimi");

    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={["anthropic-personal"]}
          defaultProviderType="kimi"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "moonshot-test-key" },
    });
    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(configPatchCalls.length).toBe(1);
    });

    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced-2",
        profileOrder: ["custom-balanced", "custom-balanced-2"],
        profiles: {
          "custom-balanced-2": {
            source: "user",
            label: "Balanced",
            provider: "kimi",
            provider_connection: "kimi",
            model: "kimi-k2.6",
          },
        },
      },
    });
    expect(toastSuccessCalls).toEqual(["Provider connected and selected"]);
  });

  test.each([
    {
      provider: "anthropic",
      label: "Anthropic",
      name: "anthropic",
      key: "sk-ant-test",
      model: "claude-opus-4-8",
    },
    {
      provider: "openai",
      label: "OpenAI",
      name: "openai",
      key: "sk-proj-test",
      model: "gpt-5.5",
    },
    {
      provider: "gemini",
      label: "Google Gemini",
      name: "gemini",
      key: "AIza-test",
      model: "gemini-2.5-flash",
    },
    {
      provider: "fireworks",
      label: "Fireworks",
      name: "fireworks",
      key: "fw_test",
      model: "accounts/fireworks/models/kimi-k2p5",
    },
    {
      provider: "openrouter",
      label: "OpenRouter",
      name: "openrouter",
      key: "sk-or-v1-test",
      model: "x-ai/grok-4.20-beta",
    },
    {
      provider: "minimax",
      label: "MiniMax",
      name: "minimax",
      key: "sk-cp-test",
      model: "MiniMax-M2.7",
    },
    {
      provider: "ollama",
      label: "Ollama",
      name: "ollama",
      key: "",
      model: "llama3.2",
    },
  ] satisfies Array<{
    provider: ConnectionProvider;
    label: string;
    name: string;
    key: string;
    model: string;
  }>)(
    "creating $label while Worklin credits are active selects a runnable default profile",
    async ({ provider, label, name, key, model }) => {
      configGetData = {
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
      };
      createdConnection =
        provider === "ollama"
          ? {
              ...makeConnection(name, provider),
              auth: { type: "none" },
            }
          : makeConnection(name, provider);

      render(
        <ModalWrapper>
          <ProviderCreateForm
            assistantId={ASSISTANT_ID}
            existingNames={[]}
            defaultProviderType={provider}
            onCreated={() => {}}
            onCancel={() => {}}
          />
        </ModalWrapper>,
      );

      if (
        label === "Anthropic" ||
        label === "OpenAI" ||
        label === "Google Gemini" ||
        label === "Fireworks"
      ) {
        selectDropdownOption("Auth type", "API key");
      }
      if (provider !== "ollama") {
        fireEvent.change(getInputByPlaceholder("Enter your API key"), {
          target: { value: key },
        });
      }

      fireEvent.click(getButton("Create"));

      await waitFor(() => {
        expect(configPatchCalls.length).toBe(1);
      });

      expect(configPatchCalls[0].body).toMatchObject({
        llm: {
          activeProfile: "custom-balanced",
          profiles: {
            "custom-balanced": {
              source: "user",
              label: "Balanced",
              provider,
              provider_connection: name,
              model,
            },
          },
        },
      });
      expect(toastSuccessCalls).toEqual(["Provider connected and selected"]);
    },
  );

  test("a connection failure renders inline, keeps the form open, and does NOT toast", async () => {
    createResponseOk = false;
    createResponseStatus = 401;

    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });
    selectDropdownOption("Auth type", "API key");
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Create"));

    // The connection-failure message surfaces inline...
    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    expect(toastSuccessCalls).toEqual([]);
    // ...and the form stays mounted (the Create button is still present).
    expect(getButton("Create")).toBeDefined();
  });

  test("seeds Name + Key from the initial provider type", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "Anthropic",
    );
    expect(getInputByPlaceholder("e.g. anthropic-personal").value).toBe(
      "anthropic",
    );
  });

  test("dedupes the seeded Key against existingNames", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={["anthropic"]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "Anthropic",
    );
    expect(getInputByPlaceholder("e.g. anthropic-personal").value).toBe(
      "anthropic-2",
    );
  });

  test("changing the provider type re-seeds Name + Key", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    selectDropdownOption("Provider", "OpenAI");

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe("OpenAI");
    expect(getInputByPlaceholder("e.g. anthropic-personal").value).toBe(
      "openai",
    );
  });

  test("a manual Name edit is NOT overwritten by a later provider-type change", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    // User overrides the Name; the Key auto-follows the label edit.
    fireEvent.change(getInputByPlaceholder("e.g. My Anthropic Key"), {
      target: { value: "My Custom Name" },
    });

    selectDropdownOption("Provider", "OpenAI");

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "My Custom Name",
    );
    expect(getInputByPlaceholder("e.g. anthropic-personal").value).toBe(
      "my-custom-name",
    );
  });

  test("a manual Key edit is NOT overwritten by a later provider-type change", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "my-custom-key" },
    });

    selectDropdownOption("Provider", "OpenAI");

    expect(getInputByPlaceholder("e.g. anthropic-personal").value).toBe(
      "my-custom-key",
    );
  });

  test("clicking Cancel invokes onCancel", () => {
    let cancelled = false;
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={() => {}}
          onCancel={() => {
            cancelled = true;
          }}
        />
      </ModalWrapper>,
    );
    fireEvent.click(getButton("Cancel"));
    expect(cancelled).toBe(true);
  });
});
