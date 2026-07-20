import { useQuery } from "@tanstack/react-query";

import { authInfoGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export interface ManagedInferenceAvailability {
  available: boolean;
  unavailable: boolean;
  isLoading: boolean;
}

/**
 * The daemon's auth-info response is backed by `resolveManagedProxyContext`,
 * which requires both a platform URL and an assistant API key.
 *
 * `available` fails closed for UI rendering. `unavailable` becomes true only
 * after an explicit daemon response, so transient request failures cannot
 * trigger a configuration repair.
 */
export function useManagedInferenceAvailability(
  assistantId: string | null,
  enabled = true,
): ManagedInferenceAvailability {
  const query = useQuery({
    ...authInfoGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: enabled && !!assistantId,
    staleTime: 30_000,
  });

  return {
    available: query.data?.authenticated === true,
    unavailable: query.isSuccess && query.data?.authenticated === false,
    isLoading: query.isLoading,
  };
}
