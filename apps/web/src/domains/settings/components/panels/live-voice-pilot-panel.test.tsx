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
});
