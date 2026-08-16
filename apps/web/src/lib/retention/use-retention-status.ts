import { useQuery } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import { fetchRetentionStatus } from "./status";

export function useRetentionStatus(
  assistantId: string | null,
  selectedBrandId: string | null = null,
) {
  const isOrgReady = useIsOrgReady();
  const brandId = selectedBrandId;

  return useQuery({
    queryKey: ["retention", "status", assistantId, selectedBrandId],
    queryFn: () =>
      fetchRetentionStatus(
        assistantId as string,
        brandId as string,
      ),
    enabled: isOrgReady && assistantId !== null && brandId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
