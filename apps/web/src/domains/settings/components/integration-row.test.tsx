import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { IntegrationRow } from "./integration-row";

afterEach(cleanup);

function renderRow({
  hostedManagedAvailable,
  advancedSetupAvailable,
  connectionStatusUnavailable = false,
  onConfigure,
}: {
  hostedManagedAvailable: boolean;
  advancedSetupAvailable: boolean;
  connectionStatusUnavailable?: boolean;
  onConfigure: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationRow
        assistantId="assistant-1"
        providerKey={hostedManagedAvailable ? "google" : "github"}
        displayName={hostedManagedAvailable ? "Google" : "GitHub"}
        description="Work account"
        logoUrl={null}
        connection={null}
        hostedManagedAvailable={hostedManagedAvailable}
        advancedSetupAvailable={advancedSetupAvailable}
        connectionStatusUnavailable={connectionStatusUnavailable}
        platformGate="full"
        onConfigure={onConfigure}
      />
    </QueryClientProvider>,
  );
}

describe("IntegrationRow setup availability", () => {
  test("offers the hosted one-click action", () => {
    let configured = false;
    renderRow({
      hostedManagedAvailable: true,
      advancedSetupAvailable: false,
      onConfigure: () => {
        configured = true;
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Enable Google" }));
    expect(configured).toBe(true);
  });

  test("offers developer setup on a dedicated assistant", () => {
    let configured = false;
    renderRow({
      hostedManagedAvailable: false,
      advancedSetupAvailable: true,
      onConfigure: () => {
        configured = true;
      },
    });

    expect(screen.getByText("Advanced setup")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage GitHub setup" }),
    );
    expect(configured).toBe(true);
  });

  test("does not open developer setup on a pooled assistant", () => {
    let configured = false;
    renderRow({
      hostedManagedAvailable: false,
      advancedSetupAvailable: false,
      onConfigure: () => {
        configured = true;
      },
    });

    expect(screen.getByText("Dedicated assistant needed")).toBeTruthy();
    const setupButton = screen.getByRole("button", {
      name: "Manage GitHub setup",
    }) as HTMLButtonElement;
    expect(setupButton.disabled).toBe(true);
    fireEvent.click(setupButton);
    expect(configured).toBe(false);
  });

  test("does not offer enable when hosted connection status is unavailable", () => {
    let configured = false;
    renderRow({
      hostedManagedAvailable: true,
      advancedSetupAvailable: false,
      connectionStatusUnavailable: true,
      onConfigure: () => {
        configured = true;
      },
    });

    expect(screen.getByText("Status unavailable")).toBeTruthy();
    const enableButton = screen.getByRole("button", {
      name: "Enable Google",
    }) as HTMLButtonElement;
    expect(enableButton.disabled).toBe(true);
    fireEvent.click(enableButton);
    expect(configured).toBe(false);
  });
});
