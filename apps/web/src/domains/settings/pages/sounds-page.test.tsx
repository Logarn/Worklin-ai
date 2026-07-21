import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, type ReactNode } from "react";

import {
  defaultSoundsConfig,
  type SoundsConfig,
} from "@/domains/settings/types/sounds";

let config: SoundsConfig;

const saveConfigMock = mock(
  async (variables: { body: SoundsConfig }) => variables.body,
);
const previewFallbackMock = mock(async () => "blocked" as const);
const previewSoundMock = mock(async () => "blocked" as const);
const setAssistantIdMock = mock((_assistantId: string | null) => {});
const setConfigMock = mock((_config: SoundsConfig) => {});
const setFeatureEnabledMock = mock((_enabled: boolean) => {});

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@vellumai/design-library/components/card", () => ({
  Card: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

mock.module("@vellumai/design-library/components/toggle", () => ({
  Toggle: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    label: string;
    onChange: (next: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  ),
}));

mock.module("@/domains/settings/utils/sound-manager", () => ({
  getSoundManager: () => ({
    previewFallbackBlip: previewFallbackMock,
    previewSound: previewSoundMock,
    setAssistantId: setAssistantIdMock,
    setConfig: setConfigMock,
    setFeatureEnabled: setFeatureEnabledMock,
  }),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  soundsAvailableGetOptions: () => ({
    queryKey: ["sounds-available", "assistant-1"],
    queryFn: async () => ({ sounds: [] }),
  }),
  soundsConfigGetOptions: () => ({
    queryKey: ["sounds-config", "assistant-1"],
    queryFn: async () => config,
  }),
  soundsConfigGetSetQueryData: (
    queryClient: QueryClient,
    _options: unknown,
    next: SoundsConfig,
  ) => {
    queryClient.setQueryData(["sounds-config", "assistant-1"], next);
  },
  soundsConfigPutMutation: () => ({ mutationFn: saveConfigMock }),
}));

const { SoundsPage } = await import("@/domains/settings/pages/sounds-page");

function renderPage(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Infinity },
    },
  });
  queryClient.setQueryData(["sounds-config", "assistant-1"], config);
  queryClient.setQueryData(["sounds-available", "assistant-1"], {
    sounds: [],
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  config = defaultSoundsConfig();
  config.globalEnabled = true;
  saveConfigMock.mockClear();
  previewFallbackMock.mockClear();
  previewSoundMock.mockClear();
  setAssistantIdMock.mockClear();
  setConfigMock.mockClear();
  setFeatureEnabledMock.mockClear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

describe("SoundsPage", () => {
  test("persists a range input value even when no release event follows", async () => {
    renderPage(<SoundsPage />);

    const slider = screen.getByRole("slider", {
      name: "Sound effect volume",
    });
    fireEvent.input(slider, { target: { value: "0.4" } });

    expect((slider as HTMLInputElement).value).toBe("0.4");
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0]![0].body.volume).toBe(0.4);
  });

  test("persists the final pointer value on pointer release", async () => {
    renderPage(<SoundsPage />);

    const slider = screen.getByRole("slider", {
      name: "Sound effect volume",
    });
    fireEvent.input(slider, { target: { value: "0.5" } });
    fireEvent.pointerUp(slider);

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0]![0].body.volume).toBe(0.5);
  });

  test("persists the final keyboard value on key release", async () => {
    renderPage(<SoundsPage />);

    const slider = screen.getByRole("slider", {
      name: "Sound effect volume",
    });
    fireEvent.input(slider, { target: { value: "0.75" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0]![0].body.volume).toBe(0.75);
  });

  test("persists a pending volume change when the page unmounts", async () => {
    const page = renderPage(<SoundsPage />);

    fireEvent.input(
      screen.getByRole("slider", { name: "Sound effect volume" }),
      { target: { value: "0.65" } },
    );
    page.unmount();

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0]![0].body.volume).toBe(0.65);
  });

  test("reports when the browser blocks the default preview", async () => {
    previewFallbackMock.mockResolvedValueOnce("blocked");
    renderPage(<SoundsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      await screen.findByText(
        "Your browser blocked the audio preview. Allow audio and try again.",
      ),
    ).toBeTruthy();
  });
});
