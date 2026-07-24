import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type {
  ManagedOAuthConnectOptions,
  ManagedOAuthConnectResult,
} from "@/lib/auth/managed-oauth-flow";

let connectCalls: ManagedOAuthConnectOptions[] = [];
let connectResult: ManagedOAuthConnectResult;
let connectError: unknown;
let connectImplementation: (
  options: ManagedOAuthConnectOptions,
) => Promise<ManagedOAuthConnectResult>;

mock.module("@/lib/auth/managed-oauth-flow", () => ({
  connectManagedOAuth: async (options: ManagedOAuthConnectOptions) => {
    connectCalls.push(options);
    return connectImplementation(options);
  },
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) =>
    createElement("main", null, children),
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
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
  }) => createElement("button", { disabled, onClick }, children),
}));

const { GoogleConnectScreen } =
  await import("@/domains/onboarding/screens/google-connect-screen");

function googleConnection(): OAuthConnection {
  return {
    id: "connection-google",
    provider: "google",
    account_label: "Google account",
    connected: true,
    status: "ACTIVE",
    scopes_granted: ["gmail.readonly", "calendar.readonly"],
    expires_at: null,
  };
}

function renderScreen(
  onConnect = mock((_scopes: string[]) => undefined),
  onSkip = mock(() => undefined),
) {
  const view = render(
    <GoogleConnectScreen
      assistantId="assistant-123"
      assistantName="Duke"
      onConnect={onConnect}
      onSkip={onSkip}
      onBack={() => undefined}
    />,
  );
  return { ...view, onConnect, onSkip };
}

beforeEach(() => {
  connectCalls = [];
  connectError = undefined;
  connectResult = {
    status: "connected",
    connection: googleConnection(),
  };
  connectImplementation = async () => {
    if (connectError) throw connectError;
    return connectResult;
  };
});

afterEach(() => cleanup());

describe("GoogleConnectScreen managed OAuth", () => {
  test("does not advance when authorization returns without an active connection", async () => {
    connectResult = {
      status: "error",
      message:
        "Google authorization finished, but no new or updated account was found. Try again.",
    };
    const view = renderScreen();

    fireEvent.click(view.getByRole("button", { name: "Connect Google" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "no new or updated account was found",
      );
    });
    expect(view.onConnect).not.toHaveBeenCalled();
    expect(connectCalls[0]).toMatchObject({
      assistantId: "assistant-123",
      providerKey: "google",
    });
  });

  test("surfaces a managed OAuth failure instead of advancing", async () => {
    connectError = new Error("Google connection service unavailable.");
    const view = renderScreen();

    fireEvent.click(view.getByRole("button", { name: "Connect Google" }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain(
        "connection service unavailable",
      );
    });
    expect(view.onConnect).not.toHaveBeenCalled();
  });

  test("advances with scopes only after the verified connection is returned", async () => {
    const view = renderScreen();

    fireEvent.click(view.getByRole("button", { name: "Connect Google" }));

    await waitFor(() => {
      expect(view.onConnect).toHaveBeenCalledWith([
        "gmail.readonly",
        "calendar.readonly",
      ]);
    });
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("aborts pending authorization when the user skips onboarding", async () => {
    let capturedSignal: AbortSignal | undefined;
    connectImplementation = async (options) =>
      await new Promise((resolve) => {
        capturedSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => resolve({ status: "cancelled" }),
          { once: true },
        );
      });
    const view = renderScreen();

    fireEvent.click(view.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(capturedSignal).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "Skip for now" }));

    expect(capturedSignal?.aborted).toBe(true);
    expect(view.onSkip).toHaveBeenCalledTimes(1);
    expect(view.onConnect).not.toHaveBeenCalled();
  });
});
