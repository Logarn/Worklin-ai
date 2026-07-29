import { useQuery } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import { fetchRetentionStatus } from "./retention-api";

export function useRetentionStatus(assistantId: string) {
  const isOrgReady = useIsOrgReady();

  return useQuery({
    queryKey: ["retention", "status", assistantId],
    queryFn: () => fetchRetentionStatus(assistantId),
    enabled: isOrgReady,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
