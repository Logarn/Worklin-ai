import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router";

mock.module("@/components/detail-card", () => ({
  DetailCard: ({
    children,
    subtitle,
    title,
  }: {
    children: ReactNode;
    subtitle?: string;
    title?: string;
  }) => (
    <section>
      {title && <h2>{title}</h2>}
      {subtitle && <p>{subtitle}</p>}
      {children}
    </section>
  ),
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
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
    "aria-label": string;
    onChange: (next: string) => void;
    options: ReadonlyArray<{ label: string; value: string }>;
    value: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

mock.module("@vellumai/design-library/components/toggle", () => ({
  Toggle: ({
    checked,
    label,
    onChange,
  }: {
    checked: boolean;
    label: string;
    onChange: (next: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  ),
}));

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

const unlabeledMicrophone = {
  deviceId: "microphone-1",
  groupId: "",
  kind: "audioinput",
  label: "",
  toJSON: () => ({}),
} as MediaDeviceInfo;
const labeledMicrophone = {
  ...unlabeledMicrophone,
  label: "Built-in Microphone",
} as MediaDeviceInfo;

function setMediaDevices(mediaDevices: {
  enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <VoicePage />
    </MemoryRouter>,
  );
}

const { VoicePage } = await import("@/domains/settings/pages/voice-page");

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  mock.restore();
});

describe("VoicePage microphone permission", () => {
  test("reports granted access after stopping the permission stream", async () => {
    let permissionGranted = false;
    const stopMock = mock(() => {});
    const getUserMediaMock = mock(async () => {
      permissionGranted = true;
      return {
        getTracks: () => [{ stop: stopMock }],
      } as unknown as MediaStream;
    });
    setMediaDevices({
      enumerateDevices: async () => [
        permissionGranted ? labeledMicrophone : unlabeledMicrophone,
      ],
      getUserMedia: getUserMediaMock,
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Allow Microphone Access" }),
    );

    expect(await screen.findByText("Microphone access granted.")).toBeTruthy();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  test("keeps recovery visible when devices cannot be listed after permission", async () => {
    let enumerationCount = 0;
    setMediaDevices({
      enumerateDevices: async () => {
        enumerationCount += 1;
        if (enumerationCount === 1) return [unlabeledMicrophone];
        throw new Error("Enumeration failed");
      },
      getUserMedia: async () =>
        ({ getTracks: () => [] }) as unknown as MediaStream,
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Allow Microphone Access" }),
    );

    expect(
      await screen.findByText("A microphone is unavailable or already in use."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try Microphone Again" }),
    ).toBeTruthy();
  });

  test("reports denied access without hiding the retry action", async () => {
    const getUserMediaMock = mock(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    setMediaDevices({
      enumerateDevices: async () => [unlabeledMicrophone],
      getUserMedia: getUserMediaMock,
    });
    renderPage();

    const button = await screen.findByRole("button", {
      name: "Allow Microphone Access",
    });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        "Microphone access was denied. Update your browser settings to allow it.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Allow Microphone Access" }),
    ).toBeTruthy();
  });

  test("reports unsupported access when getUserMedia is unavailable", async () => {
    setMediaDevices({
      enumerateDevices: async () => [unlabeledMicrophone],
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Allow Microphone Access" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("Microphone access is not supported in this browser."),
      ).toBeTruthy(),
    );
  });
});
