import { useQuery } from "@tanstack/react-query";

import { authInfoGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export interface ManagedInferenceCapabilityStatus {
  configured: boolean;
  notConfigured: boolean;
  isLoading: boolean;
}

/**
 * The daemon's auth-info response confirms that managed-proxy routing has the
 * required platform URL and assistant API key. It does not probe the platform
 * or validate that the configured key can complete inference.
 *
 * `configured` fails closed for UI rendering. `notConfigured` becomes true
 * only after an explicit assistant response, so transient request failures
 * cannot trigger a configuration repair.
 */
export function useManagedInferenceCapability(
  assistantId: string | null,
  enabled = true,
): ManagedInferenceCapabilityStatus {
  const query = useQuery({
    ...authInfoGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
    staleTime: 30_000,
  });

  return {
    configured: query.data?.authenticated === true,
    notConfigured: query.isSuccess && query.data?.authenticated === false,
    isLoading: query.isLoading,
  };
}
