import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import {
  getOAuthCompletionDeepLink,
  OAuthPopupCompletePage,
} from "@/domains/account/pages/oauth-popup-complete-page";

const originalWindowClose = window.close;
const originalWindowOpener = Object.getOwnPropertyDescriptor(window, "opener");

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "close", {
    configurable: true,
    value: originalWindowClose,
  });
  if (originalWindowOpener) {
    Object.defineProperty(window, "opener", originalWindowOpener);
  } else {
    Reflect.deleteProperty(window, "opener");
  }
  window.localStorage.clear();
});

describe("OAuthPopupCompletePage", () => {
  test("builds the packaged desktop handoff with denial detail intact", () => {
    expect(
      getOAuthCompletionDeepLink("www.vellum.ai", {
        requestId: "req-desktop",
        oauthStatus: "denied",
        oauthProvider: "github",
        oauthCode: "access_denied",
      }),
    ).toBe(
      "vellum-assistant://oauth-complete?requestId=req-desktop&oauth_status=denied&oauth_provider=github&oauth_code=access_denied",
    );
  });

  test("keeps the bootstrap page neutral and open while authorization starts", () => {
    let closeCalls = 0;
    Object.defineProperty(window, "close", {
      configurable: true,
      value: () => {
        closeCalls += 1;
      },
    });

    const view = render(
      <MemoryRouter
        initialEntries={[
          "/account/oauth/popup-complete?requestId=req-bootstrap&oauth_provider=github&oauth_pending=1",
        ]}
      >
        <Routes>
          <Route
            path="/account/oauth/popup-complete"
            element={<OAuthPopupCompletePage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(view.getByText("Preparing authorization")).toBeTruthy();
    expect(view.queryByText(/Connected to/i)).toBeNull();
    expect(view.queryByText(/Authorization Successful/i)).toBeNull();
    expect(closeCalls).toBe(0);
  });

  test("severs the opener before reporting that the bootstrap is ready", async () => {
    const messages: Array<{ payload: unknown; targetOrigin: string }> = [];
    const opener = {
      postMessage(payload: unknown, targetOrigin: string) {
        messages.push({ payload, targetOrigin });
      },
    };
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: opener,
    });

    render(
      <MemoryRouter
        initialEntries={[
          "/account/oauth/popup-complete?requestId=req-secure&oauth_provider=github&oauth_pending=1",
        ]}
      >
        <Routes>
          <Route
            path="/account/oauth/popup-complete"
            element={<OAuthPopupCompletePage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(messages).toHaveLength(1));
    expect(window.opener).toBeNull();
    expect(messages[0]).toEqual({
      payload: {
        type: "vellum:oauth-popup-ready",
        requestId: "req-secure",
        oauthProvider: "github",
      },
      targetOrigin: "*",
    });
  });

  test("uses same-origin storage for web completion without messaging an opener", async () => {
    let postMessageCalls = 0;
    let closeCalls = 0;
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: {
        postMessage() {
          postMessageCalls += 1;
        },
      },
    });
    Object.defineProperty(window, "close", {
      configurable: true,
      value: () => {
        closeCalls += 1;
      },
    });

    render(
      <MemoryRouter
        initialEntries={[
          "/account/oauth/popup-complete?requestId=req-complete&oauth_status=denied&oauth_provider=github&oauth_code=access_denied",
        ]}
      >
        <Routes>
          <Route
            path="/account/oauth/popup-complete"
            element={<OAuthPopupCompletePage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(closeCalls).toBe(1));
    expect(postMessageCalls).toBe(0);
    expect(
      JSON.parse(
        window.localStorage.getItem("vellum:oauth-complete:req-complete")!,
      ),
    ).toMatchObject({
      requestId: "req-complete",
      oauthStatus: "denied",
      oauthProvider: "github",
      oauthCode: "access_denied",
    });
  });
});
