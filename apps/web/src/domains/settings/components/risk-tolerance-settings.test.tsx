import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const getThresholdsMock = mock(async (_assistantId: string) => ({
  interactive: "medium",
  autonomous: "low",
  headless: "none",
}));
const setThresholdsMock = mock(
  async (
    _assistantId: string,
    thresholds: {
      interactive?: string;
      autonomous?: string;
      headless?: string;
    },
  ) => ({
    interactive: thresholds.interactive ?? "medium",
    autonomous: thresholds.autonomous ?? "low",
    headless: thresholds.headless ?? "none",
  }),
);

mock.module("@/lib/threshold-api", () => ({
  getGlobalThresholds: getThresholdsMock,
  setGlobalThresholds: setThresholdsMock,
}));

mock.module("@vellumai/design-library/components/card", () => ({
  Card: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

mock.module("@vellumai/design-library/components/dropdown", () => ({
  Dropdown: ({
    value,
    onChange,
    options,
    disabled,
    "aria-label": ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<{ value: string; label: string }>;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
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

const { RiskToleranceSettings } = await import(
  "@/domains/settings/components/risk-tolerance-settings"
);

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RiskToleranceSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getThresholdsMock.mockClear();
  setThresholdsMock.mockClear();
  getThresholdsMock.mockImplementation(async () => ({
    interactive: "medium",
    autonomous: "low",
    headless: "none",
  }));
  setThresholdsMock.mockImplementation(
    async (
      _assistantId: string,
      thresholds: {
        interactive?: string;
        autonomous?: string;
        headless?: string;
      },
    ) => ({
      interactive: thresholds.interactive ?? "medium",
      autonomous: thresholds.autonomous ?? "low",
      headless: thresholds.headless ?? "none",
    }),
  );
  useResolvedAssistantsStore.setState({
    activeAssistantId: "assistant-1",
  });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("RiskToleranceSettings", () => {
  test("starts the durable save immediately when a preset changes", async () => {
    const view = renderSettings();
    const conversations = await view.findByRole("combobox", {
      name: "Conversation risk tolerance",
    });
    await waitFor(() =>
      expect((conversations as HTMLSelectElement).disabled).toBe(false),
    );
    expect((conversations as HTMLSelectElement).value).toBe("relaxed");

    fireEvent.change(conversations, { target: { value: "conservative" } });

    await waitFor(
      () =>
        expect(setThresholdsMock).toHaveBeenCalledWith("assistant-1", {
          interactive: "low",
          autonomous: "low",
          headless: "none",
        }),
      { timeout: 200 },
    );
    await waitFor(() =>
      expect((conversations as HTMLSelectElement).value).toBe("conservative"),
    );
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  });

  test("rolls back the optimistic choice and shows a truthful save failure", async () => {
    setThresholdsMock.mockImplementation(async () => {
      throw new Error("write failed");
    });
    const view = renderSettings();
    const conversations = await view.findByRole("combobox", {
      name: "Conversation risk tolerance",
    });
    await waitFor(() =>
      expect((conversations as HTMLSelectElement).disabled).toBe(false),
    );

    fireEvent.change(conversations, { target: { value: "conservative" } });

    expect((await view.findByRole("alert")).textContent).toContain(
      "Could not save risk tolerance. Your previous setting is still active.",
    );
    expect((conversations as HTMLSelectElement).value).toBe("relaxed");
  });

  test("does not issue a write before the selected assistant has loaded", () => {
    getThresholdsMock.mockImplementation(
      () => new Promise(() => {}),
    );
    const view = renderSettings();
    const conversations = view.getByRole("combobox", {
      name: "Conversation risk tolerance",
    });

    expect((conversations as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(conversations, { target: { value: "conservative" } });
    expect(setThresholdsMock).not.toHaveBeenCalled();
  });
});
