import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isManagedOAuthProviderUnsupported,
  type ManagedOAuthStartErrorReason,
} from "@/lib/auth/managed-oauth-api";
import { connectManagedOAuth } from "@/lib/auth/managed-oauth-flow";
import { toast } from "@vellumai/design-library/components/toast";

interface UseOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  displayName: string;
  managedAvailable: boolean;
  connectionsQueryKey: QueryKey;
}

interface UseOAuthConnectResult {
  handleConnect: () => void;
  oauthInProgress: boolean;
  startOAuthPending: boolean;
  connectError: string | null;
  managedUnsupported: boolean;
}

/** React state adapter for the shared request-scoped managed OAuth flow. */
export function useOAuthConnect({
  assistantId,
  providerKey,
  displayName,
  managedAvailable,
  connectionsQueryKey,
}: UseOAuthConnectOptions): UseOAuthConnectResult {
  const queryClient = useQueryClient();
  const activeRequestRef = useRef<AbortController | null>(null);
  const [oauthInProgress, setOAuthInProgress] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [managedUnsupported, setManagedUnsupported] = useState(() =>
    isManagedOAuthProviderUnsupported(assistantId, providerKey),
  );

  const showConnectError = useCallback((message: string) => {
    setConnectError(message);
    toast.error(message);
  }, []);

  useEffect(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setOAuthInProgress(false);
    setConnectError(null);
    setManagedUnsupported(
      isManagedOAuthProviderUnsupported(assistantId, providerKey),
    );

    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [assistantId, providerKey]);

  const handleConnect = useCallback(() => {
    if (!managedAvailable || managedUnsupported) {
      showConnectError(
        `Managed ${displayName} connections aren't available in this Worklin environment. Choose Your Own to connect with your OAuth app.`,
      );
      return;
    }
    if (activeRequestRef.current) return;

    const controller = new AbortController();
    activeRequestRef.current = controller;
    setConnectError(null);
    setOAuthInProgress(true);

    void connectManagedOAuth({
      assistantId,
      providerKey,
      providerLabel: displayName,
      signal: controller.signal,
    })
      .then((result) => {
        if (activeRequestRef.current !== controller) return;
        activeRequestRef.current = null;
        setOAuthInProgress(false);

        if (result.status === "connected") {
          setConnectError(null);
          void queryClient.invalidateQueries({
            queryKey: connectionsQueryKey,
          });
          toast.success(`${displayName} account connected.`);
          return;
        }

        if (result.status === "error" && result.reason === "unsupported") {
          setManagedUnsupported(true);
        }
        if (result.message) showConnectError(result.message);
      })
      .catch((error: unknown) => {
        if (
          activeRequestRef.current !== controller ||
          controller.signal.aborted
        ) {
          return;
        }
        activeRequestRef.current = null;
        setOAuthInProgress(false);
        showConnectError(
          error instanceof Error
            ? error.message
            : `Worklin could not start ${displayName} authorization. Try again, or choose Your Own to connect with your OAuth app.`,
        );
      });
  }, [
    assistantId,
    connectionsQueryKey,
    displayName,
    managedAvailable,
    managedUnsupported,
    providerKey,
    queryClient,
    showConnectError,
  ]);

  return {
    handleConnect,
    oauthInProgress,
    startOAuthPending: oauthInProgress,
    connectError,
    managedUnsupported,
  };
}

export type { ManagedOAuthStartErrorReason };
