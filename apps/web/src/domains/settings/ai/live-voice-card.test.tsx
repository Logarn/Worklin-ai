import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router";

const patchConfig = mock(async (_args: unknown) => ({
  services: { voice: { engine: "elevenlabs" } },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => true,
      settingsDeveloperNav: () => true,
    },
  },
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["assistant-config"],
    queryFn: async () => ({ services: { voice: { engine: "hume" } } }),
  }),
  configGetSetQueryData: () => undefined,
  useConfigPatchMutation: () => ({ mutateAsync: patchConfig }),
}));
mock.module("@vellumai/design-library/components/dropdown", () => ({
  findEnabledIndex: () => 0,
  resolveDropdownMenuPosition: () => ({ left: 0, top: 0, width: 0 }),
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
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { LiveVoiceCard } = await import("./live-voice-card");

afterEach(() => {
  cleanup();
  patchConfig.mockClear();
});

describe("LiveVoiceCard", () => {
  test("shows Hume and ElevenLabs as continuous Live Voice providers", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LiveVoiceCard />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const provider = (await screen.findByLabelText(
      "Live Voice provider",
    )) as HTMLSelectElement;
    expect(provider.value).toBe("hume");
    expect(screen.getByText("Hume")).toBeTruthy();
    expect(screen.getByText("ElevenLabs")).toBeTruthy();

    fireEvent.change(provider, { target: { value: "elevenlabs" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(patchConfig).toHaveBeenCalledTimes(1));
    expect(patchConfig.mock.calls[0]?.[0]).toMatchObject({
      body: { services: { voice: { engine: "elevenlabs" } } },
    });
    expect(
      screen.getByText("Configure ElevenLabs credentials"),
    ).toBeTruthy();
  });
});
