import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const postMock = mock(async (_args: unknown) => ({
  response: new Response(null, { status: 200 }),
}));
const patchMock = mock(async (_args: unknown) => ({
  response: new Response(null, { status: 200 }),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/generated/api/client.gen", () => ({
  client: { post: postMock, patch: patchMock },
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
}));
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: { use: { voiceMode: () => true } },
}));
mock.module("react-router", () => ({ useNavigate: () => mock(() => {}) }));
mock.module("@/components/detail-card", () => ({
  DetailCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@vellumai/design-library/components/dropdown", () => ({
  Dropdown: ({
    "aria-label": ariaLabel,
    onChange,
    options,
    value,
  }: {
    "aria-label"?: string;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
    value: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const { LiveVoicePilotPanel } = await import("./live-voice-pilot-panel");

describe("LiveVoicePilotPanel", () => {
  beforeEach(() => {
    postMock.mockClear();
    patchMock.mockClear();
  });

  afterEach(cleanup);

  test("allows the Hume config voice and scopes the pilot to the signed-in user", async () => {
    render(<LiveVoicePilotPanel />);

    fireEvent.change(screen.getByLabelText("Hume API key"), {
      target: { value: "test-api-key" },
    });
    fireEvent.change(screen.getByLabelText("Hume secret key"), {
      target: { value: "test-secret-key" },
    });
    fireEvent.change(screen.getByLabelText("EVI config ID"), {
      target: { value: "config-1" },
    });

    const configureButton = screen.getByText("Configure Hume") as HTMLButtonElement;
    expect(configureButton.disabled).toBe(false);
    fireEvent.click(configureButton);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(2);
      expect(patchMock).toHaveBeenCalledTimes(1);
    });

    expect(patchMock.mock.calls[0]?.[0]).toMatchObject({
      url: "/v1/assistants/assistant-1/config",
      body: {
        services: {
          voice: {
            engine: "hume",
            pilotAllowlist: ["user-1"],
            providers: { hume: { configId: "config-1", voiceId: "" } },
          },
        },
      },
    });
  });

  test("configures ElevenLabs with one server-side key and an agent ID", async () => {
    render(<LiveVoicePilotPanel />);

    fireEvent.change(screen.getByLabelText("Live Voice provider"), {
      target: { value: "elevenlabs" },
    });
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), {
      target: { value: "eleven-api-key" },
    });
    fireEvent.change(screen.getByLabelText("ElevenLabs agent ID"), {
      target: { value: "agent-1" },
    });

    fireEvent.click(screen.getByText("Configure ElevenLabs"));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(patchMock).toHaveBeenCalledTimes(1);
    });

    expect(postMock.mock.calls[0]?.[0]).toMatchObject({
      body: {
        service: "elevenlabs",
        field: "api_key",
        value: "eleven-api-key",
      },
    });
    expect(patchMock.mock.calls[0]?.[0]).toMatchObject({
      body: {
        services: {
          voice: {
            engine: "elevenlabs",
            pilotAllowlist: ["user-1"],
            providers: {
              elevenlabs: { agentId: "agent-1", voiceId: "" },
            },
          },
        },
      },
    });
  });
});
