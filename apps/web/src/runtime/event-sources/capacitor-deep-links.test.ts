import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let native = true;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => native,
  useIsNativePlatform: () => native,
}));

let appUrlOpenHandler: ((payload: { url: string }) => void) | null = null;
let resolveListener:
  ((handle: { remove: () => Promise<void> }) => void) | null = null;
const removeMock = mock(async () => {});
const addListenerMock = mock(
  (_event: "appUrlOpen", handler: (payload: { url: string }) => void) => {
    appUrlOpenHandler = handler;
    return new Promise<{ remove: () => Promise<void> }>((resolve) => {
      resolveListener = resolve;
    });
  },
);
mock.module("@capacitor/app", () => ({
  App: { addListener: addListenerMock },
}));

const captureExceptionMock = mock(() => {});
mock.module("@sentry/browser", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));
mock.module("@sentry/react", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));

import * as eventBus from "@/lib/event-bus";

const publishSpy = spyOn(eventBus, "publish");
const { publishCapacitorDeepLinksSource } =
  await import("@/runtime/event-sources/capacitor-deep-links");

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function finishRegistration(): Promise<void> {
  await flushMicrotasks();
  resolveListener?.({ remove: removeMock });
  await flushMicrotasks();
}

beforeEach(() => {
  native = true;
  appUrlOpenHandler = null;
  resolveListener = null;
  addListenerMock.mockClear();
  removeMock.mockClear();
  publishSpy.mockClear();
});

describe("publishCapacitorDeepLinksSource", () => {
  test("is a no-op outside Capacitor", () => {
    native = false;

    publishCapacitorDeepLinksSource()();

    expect(addListenerMock).not.toHaveBeenCalled();
  });

  test("publishes a parsed and scoped OAuth completion", async () => {
    publishCapacitorDeepLinksSource();
    await finishRegistration();

    appUrlOpenHandler?.({
      url: "vellum-assistant://oauth-complete?requestId=req-native&oauth_status=denied&oauth_provider=github&oauth_code=access_denied",
    });

    expect(publishSpy).toHaveBeenCalledWith("oauth.complete", {
      requestId: "req-native",
      oauthStatus: "denied",
      oauthProvider: "github",
      oauthCode: "access_denied",
    });
  });

  test("drops malformed or foreign callback URLs", async () => {
    publishCapacitorDeepLinksSource();
    await finishRegistration();

    appUrlOpenHandler?.({ url: "https://example.com/oauth-complete" });
    appUrlOpenHandler?.({
      url: "vellum-assistant://oauth-complete?oauth_provider=github",
    });
    appUrlOpenHandler?.({
      url: "vellum-assistant://oauth-complete?requestId=req-native",
    });

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("removes a listener that resolves after teardown", async () => {
    const unsubscribe = publishCapacitorDeepLinksSource();
    unsubscribe();
    await finishRegistration();

    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
