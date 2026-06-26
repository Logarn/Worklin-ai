/**
 * Unit tests for `useBackgroundHatch` — the cast onboarding flow's
 * background-hatch primitive. It must hatch at most once per instance
 * (ref-guarded), flip `ready` only after a health check passes, and resolve
 * `awaitReady()` with the assistant id (or reject on terminal failure).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type {
  GetAssistantResult,
  GetHealthzResult,
  HatchResult,
} from "@/assistant/api";

let hatchResult: HatchResult = {
  ok: true,
  status: 201,
  data: { id: "ast-cast" } as never,
};
let getAssistantResult: GetAssistantResult = {
  ok: true,
  status: 200,
  data: { id: "ast-cast", status: "active", is_local: false } as never,
};
let healthzResult: GetHealthzResult = {
  ok: true,
  status: 200,
  data: {} as never,
};

const hatchAssistantMock = mock(async (): Promise<HatchResult> => hatchResult);
const getAssistantMock = mock(
  async (_id?: string): Promise<GetAssistantResult> => getAssistantResult,
);
const getAssistantHealthzMock = mock(
  async (_id: string): Promise<GetHealthzResult> => healthzResult,
);

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

// Avatar seeding is fire-and-forget and tested separately; stub it and the
// avatar write path so the hook can exercise the real QueryClient dependency
// without hitting the network-facing side effect.
const seedHatchAvatarMock = mock(async (..._args: unknown[]) => {});
mock.module("@/assistant/seed-hatch-avatar", () => ({
  seedHatchAvatar: seedHatchAvatarMock,
}));
mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (
    e: unknown,
    _r: unknown,
    fallback?: string,
  ) =>
    e && typeof e === "object" && typeof (e as { detail?: unknown }).detail === "string"
      ? (e as { detail: string }).detail
      : (fallback ?? "error"),
}));

const { useBackgroundHatch } = await import("./use-background-hatch");
const { WORKLIN_AVATAR_CHOICES } = await import(
  "@/components/avatar/assistant-character-packs"
);

beforeEach(() => {
  hatchResult = { ok: true, status: 201, data: { id: "ast-cast" } as never };
  getAssistantResult = {
    ok: true,
    status: 200,
    data: { id: "ast-cast", status: "active", is_local: false } as never,
  };
  healthzResult = { ok: true, status: 200, data: {} as never };
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
  seedHatchAvatarMock.mockClear();
});

function renderUseBackgroundHatch() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return renderHook(() => useBackgroundHatch(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}

describe("useBackgroundHatch", () => {
  test("start() called twice hatches once", async () => {
    const { result } = renderUseBackgroundHatch();

    act(() => {
      result.current.start();
      result.current.start();
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("awaitReady() resolves to the id after health passes", async () => {
    const { result } = renderUseBackgroundHatch();

    let resolved: string | undefined;
    act(() => {
      void result.current.awaitReady().then((id) => {
        resolved = id;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.assistantId).toBe("ast-cast");
    await waitFor(() => expect(resolved).toBe("ast-cast"));
    // ready flips only after the health check passes, not on hatch return.
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
  });

  test("terminal hatch failure surfaces error and rejects awaitReady()", async () => {
    hatchResult = {
      ok: false,
      status: 400,
      error: { detail: "Bad hatch request" },
    };

    const { result } = renderUseBackgroundHatch();

    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().catch((err: Error) => {
        rejection = err;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe("Bad hatch request"));
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(rejection?.message).toBe("Bad hatch request"));
    // A terminal (non-5xx) hatch failure must not fall through to polling.
    expect(getAssistantMock).not.toHaveBeenCalled();
  });

  test("seeds the chosen avatar for a freshly created (201) assistant", async () => {
    const { result } = renderUseBackgroundHatch();

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(seedHatchAvatarMock).not.toHaveBeenCalled();
    const preferredAvatar = WORKLIN_AVATAR_CHOICES.find(
      (avatar) => avatar.id === "tin_grin",
    );
    await act(async () => {
      await result.current.seedAvatar(preferredAvatar);
    });
    expect(seedHatchAvatarMock).toHaveBeenCalledTimes(1);
    expect(seedHatchAvatarMock.mock.calls[0]?.[0]).toBe("ast-cast");
    expect(seedHatchAvatarMock.mock.calls[0]?.[3]).toBe(preferredAvatar);
  });

  test("does not seed the avatar for an existing (200) assistant", async () => {
    hatchResult = {
      ok: true,
      status: 200,
      data: { id: "ast-cast" } as never,
    };

    const { result } = renderUseBackgroundHatch();

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.seedAvatar(WORKLIN_AVATAR_CHOICES[0]);
    });
    // A 200 returned an existing assistant — its avatar must not be clobbered.
    expect(seedHatchAvatarMock).not.toHaveBeenCalled();
  });
});
