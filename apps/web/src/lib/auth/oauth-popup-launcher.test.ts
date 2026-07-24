import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { openDetachedOAuthPopup } from "@/lib/auth/oauth-popup-launcher";

const originalOpen = window.open;
let popup: {
  closed: boolean;
  close: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  location: { href: string };
};
let openedUrl = "";

function dispatchReady({
  source = popup,
  provider,
}: {
  source?: unknown;
  provider?: string;
} = {}): void {
  const bootstrapUrl = new URL(openedUrl);
  const event = new MessageEvent("message", {
    data: {
      type: "vellum:oauth-popup-ready",
      requestId: bootstrapUrl.searchParams.get("requestId"),
      oauthProvider:
        provider ?? bootstrapUrl.searchParams.get("oauth_provider"),
    },
    origin: bootstrapUrl.origin,
  });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

beforeEach(() => {
  openedUrl = "";
  popup = {
    closed: false,
    close: mock(() => {
      popup.closed = true;
    }),
    focus: mock(() => undefined),
    location: { href: "" },
  };
  Object.defineProperty(window, "open", {
    configurable: true,
    value: mock((url: string) => {
      openedUrl = url;
      popup.location.href = url;
      return popup;
    }),
  });
});

afterEach(() => {
  Object.defineProperty(window, "open", {
    configurable: true,
    value: originalOpen,
  });
});

describe("openDetachedOAuthPopup", () => {
  test("waits for a source-, origin-, request-, and provider-scoped detached bootstrap", () => {
    const externalUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=example";

    expect(openDetachedOAuthPopup(externalUrl)).toBe(true);
    expect(new URL(openedUrl).pathname).toBe("/account/oauth/popup-complete");
    expect(popup.location.href).toBe(openedUrl);

    dispatchReady({ source: window });
    dispatchReady({ provider: "wrong-provider" });
    expect(popup.location.href).toBe(openedUrl);
    expect(popup.focus).not.toHaveBeenCalled();

    dispatchReady();
    expect(popup.location.href).toBe(externalUrl);
    expect(popup.focus).toHaveBeenCalledTimes(1);
  });

  test("reports a blocked bootstrap without navigating externally", () => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: mock(() => null),
    });

    expect(openDetachedOAuthPopup("https://example.com/oauth/authorize")).toBe(
      false,
    );
  });
});
