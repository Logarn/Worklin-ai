import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

const useClientFeatureFlagSyncMock = mock(() => {});

mock.module("@vellumai/design-library", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  Toaster: () => null,
}));

mock.module("@/components/profile-quick-add-provider", () => ({
  ProfileQuickAddProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/hooks/use-client-feature-flag-sync", () => ({
  useClientFeatureFlagSync: useClientFeatureFlagSyncMock,
}));

const { AppProviders } = await import("./providers");

describe("AppProviders", () => {
  afterEach(() => {
    cleanup();
    useClientFeatureFlagSyncMock.mockClear();
  });

  test("bootstraps client feature-flag sync before router-owned layouts mount", () => {
    render(
      <AppProviders>
        <div>child</div>
      </AppProviders>,
    );

    expect(useClientFeatureFlagSyncMock).toHaveBeenCalledWith(true);
    expect(useClientFeatureFlagSyncMock).toHaveBeenCalledTimes(1);
  });
});
