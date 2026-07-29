/**
 * Onboarding preference public API.
 *
 * Boolean preferences are owned by `useOnboardingStore` — a
 * Zustand store with a custom per-key `persist` adapter that maps each
 * field to its existing localStorage key. This file exposes the hook +
 * non-React shim around the store.
 *
 * Storage keys are documented in `onboarding-store.ts`. The privacy
 * settings page and the Sentry consent gate read `device:share_*`
 * directly — that contract is preserved by the per-key adapter.
 */
import { useCallback } from "react";

import { getDeviceBool } from "@/utils/device-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// ---------------------------------------------------------------------------
// Public hooks — thin wrappers around the Zustand store
// ---------------------------------------------------------------------------

/**
 * Share anonymous product analytics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy` so onboarding
 * and settings are a single source of truth.
 */
export function useShareAnalytics(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.shareAnalytics();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setShareAnalytics(next);
  }, []);
  return [value, setter];
}

/**
 * Share crash reports and diagnostics. Defaults to `true`.
 * Backed by the SAME localStorage key as `/settings/privacy`.
 */
export function useShareDiagnostics(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.shareDiagnostics();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setShareDiagnostics(next);
  }, []);
  return [value, setter];
}

/**
 * SSR-safe, non-hook read for telemetry emitters.
 *
 * This treats an absent preference as no consent: direct analytics uploads
 * should only run after settings has persisted an explicit opt-in. The store must
 * also agree so a failed opt-out write cannot leave an older stored opt-in
 * authorizing a new event.
 */
export function readShareAnalytics(): boolean {
  return (
    useOnboardingStore.getState().shareAnalytics &&
    getDeviceBool("shareAnalytics", false)
  );
}


