import { useQuery } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import { fetchRetentionStatus } from "./status";

export function useRetentionStatus(
  assistantId: string | null,
  selectedBrandId: string | null = null,
  options: { global?: boolean } = {},
) {
  const isOrgReady = useIsOrgReady();
  const brandId = selectedBrandId;
  const global = options.global === true;

  return useQuery({
    queryKey: [
      "retention",
      "status",
      assistantId,
      global ? "global" : selectedBrandId,
    ],
    queryFn: () =>
      fetchRetentionStatus(
        assistantId as string,
        global ? null : (brandId as string),
      ),
    enabled: isOrgReady && assistantId !== null && (global || brandId !== null),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
