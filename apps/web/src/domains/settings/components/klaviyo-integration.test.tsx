import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let connectError: unknown = null;
const connectMutate = mock(
  (
    _input: unknown,
    options?: {
      onError?: (error: unknown) => void;
      onSettled?: () => void;
    },
  ) => {
    if (connectError) options?.onError?.(connectError);
    options?.onSettled?.();
  },
);

mock.module("@/domains/settings/hooks/use-klaviyo-integration", () => ({
  useKlaviyoIntegration: () => ({
    status: { isPending: false, isError: false },
    connect: {
      mutate: connectMutate,
      isPending: false,
      isSuccess: false,
    },
    integration: null,
  }),
}));

const { RetentionApiError } = await import("@/lib/retention/api-error");
const { KlaviyoIntegrationModal, KlaviyoIntegrationRow } = await import(
  "./klaviyo-integration"
);

afterEach(() => {
  cleanup();
  connectMutate.mockClear();
  connectError = null;
});

describe("Klaviyo integration", () => {
  test("appears as an ordinary integration row", () => {
    const configure = mock(() => {});
    render(
      <KlaviyoIntegrationRow
        integration={null}
        statusLoading={false}
        statusUnavailable={false}
        onConfigure={configure}
      />,
    );

    expect(
      screen.getByText("Email delivery and customer activity"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(configure).toHaveBeenCalledTimes(1);
  });

  test("connects with approved properties and clears the private key", () => {
    render(
      <KlaviyoIntegrationModal assistantId="assistant-1" onClose={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Example Brand" },
    });
    fireEvent.change(screen.getByLabelText("Website (optional)"), {
      target: { value: "drrachael.example" },
    });
    const keyInput = screen.getByLabelText(
      "Klaviyo private API key",
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "pk_private" } });
    fireEvent.change(screen.getByLabelText("Approved property 1"), {
      target: { value: "Lead Magnet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    fireEvent.change(screen.getByLabelText("Approved property 2"), {
      target: { value: "Product Interest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(connectMutate).toHaveBeenCalledWith(
      {
        brandName: "Example Brand",
        websiteUrl: "https://drrachael.example/",
        credential: "pk_private",
        propertyAllowlist: ["Lead Magnet", "Product Interest"],
      },
      expect.any(Object),
    );
    expect(keyInput.value).toBe("");
  });

  test("does not expose a rejected private key in the error", () => {
    connectError = new RetentionApiError(
      401,
      "provider response contained private detail",
      "klaviyo_credentials_rejected",
    );
    render(
      <KlaviyoIntegrationModal assistantId="assistant-1" onClose={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Example Brand" },
    });
    const keyInput = screen.getByLabelText(
      "Klaviyo private API key",
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "pk_rejected" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(
      screen.getByText(
        "Klaviyo rejected this private key. Check the key and try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("provider response contained private detail"),
    ).toBeNull();
    expect(screen.queryByText("pk_rejected")).toBeNull();
    expect(keyInput.value).toBe("");
  });
});
