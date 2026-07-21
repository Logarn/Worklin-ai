import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type {
  RuntimeActionCapabilities,
  RuntimeActionCapability,
} from "@/generated/api/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

let platformGate = "full";
let activeAssistantIsSelfHosted = false;

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => platformGate,
  useActiveAssistantHasSelfHostedRecord: () => activeAssistantIsSelfHosted,
}));

mock.module(
  "@/domains/settings/components/panels/debug-controls-panel",
  () => ({
    DebugControlsPanel: ({
      restartCapability,
    }: {
      restartCapability?: RuntimeActionCapability;
    }) => (
      <div data-testid="debug-controls">
        restart:{String(restartCapability?.supported)}
      </div>
    ),
  }),
);

mock.module(
  "@/domains/settings/components/panels/assistant-terminal-panel",
  () => ({ AssistantTerminalPanel: () => <div>terminal-panel</div> }),
);

mock.module("@/domains/settings/components/panels/doctor-panel", () => ({
  DoctorPanel: () => <div>doctor-panel</div>,
}));

const { DebugPage } = await import("./debug-page");

function capability(
  capabilityName: RuntimeActionCapability["capability"],
  supported: boolean,
  detail: string,
): RuntimeActionCapability {
  return {
    capability: capabilityName,
    supported,
    code: supported ? "supported" : "runtime_capability_unavailable",
    detail,
  };
}

const launchCapabilities: RuntimeActionCapabilities = {
  restart: capability("restart", true, "Restart this managed assistant."),
  terminal: capability("terminal", false, "Terminal is unavailable."),
  doctor: capability("doctor", false, "Doctor is unavailable."),
  update_window: capability(
    "update_window",
    false,
    "Update windows are unavailable.",
  ),
};

beforeEach(() => {
  platformGate = "full";
  activeAssistantIsSelfHosted = false;
  useResolvedAssistantsStore.setState({
    assistants: [
      {
        id: "assistant-1",
        isLocal: false,
        isPlatformHosted: true,
        runtimeActionCapabilities: launchCapabilities,
      },
    ],
    activeAssistantId: "assistant-1",
  });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

afterAll(() => {
  mock.restore();
});

describe("DebugPage runtime action capabilities", () => {
  test("hides unsupported tabs, explains why, and forwards restart support", () => {
    render(
      <MemoryRouter initialEntries={["/settings/debug?tab=terminal"]}>
        <DebugPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Doctor" })).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/Terminal is unavailable/)).toBeTruthy();
    expect(screen.getByText(/Doctor is unavailable/)).toBeTruthy();
    expect(screen.getByTestId("debug-controls").textContent).toBe(
      "restart:true",
    );
  });

  test("fails closed when a managed assistant has no capability field", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "assistant-1",
          isLocal: false,
          isPlatformHosted: true,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={["/settings/debug?tab=terminal"]}>
        <DebugPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Doctor" })).toBeNull();
    expect(screen.queryByText("terminal-panel")).toBeNull();
    expect(
      screen.getByText(/Terminal is unavailable while Worklin verifies/),
    ).toBeTruthy();
    expect(screen.getByTestId("debug-controls").textContent).toBe(
      "restart:false",
    );
  });

  test("fails closed when managed capability data is malformed", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "assistant-1",
          isLocal: false,
          isPlatformHosted: true,
          runtimeActionCapabilities: {
            restart: {
              capability: "restart",
              supported: "yes",
              code: "supported",
              detail: "Restart this managed assistant.",
            },
          } as unknown as RuntimeActionCapabilities,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={["/settings/debug?tab=doctor"]}>
        <DebugPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Doctor" })).toBeNull();
    expect(screen.getByTestId("debug-controls").textContent).toBe(
      "restart:false",
    );
  });

  test("keeps non-managed controls independent of managed capability discovery", () => {
    platformGate = "gated";
    activeAssistantIsSelfHosted = true;
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "assistant-1",
          isLocal: true,
          isPlatformHosted: false,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={["/settings/debug"]}>
        <DebugPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Doctor" })).toBeTruthy();
    expect(screen.getByTestId("debug-controls").textContent).toBe(
      "restart:undefined",
    );
  });

  test("fails closed while the active assistant hosting is unresolved", () => {
    useResolvedAssistantsStore.setState({
      assistants: [],
      activeAssistantId: "assistant-unresolved",
    });

    render(
      <MemoryRouter initialEntries={["/settings/debug?tab=terminal"]}>
        <DebugPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Doctor" })).toBeNull();
    expect(screen.getByTestId("debug-controls").textContent).toBe(
      "restart:false",
    );
  });
});
