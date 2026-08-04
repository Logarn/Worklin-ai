import { useQuery } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import { fetchRetentionStatus } from "./status";

export function useRetentionStatus(assistantId: string | null) {
  const isOrgReady = useIsOrgReady();

  return useQuery({
    queryKey: ["retention", "status", assistantId],
    queryFn: () => fetchRetentionStatus(assistantId!),
    enabled: isOrgReady && assistantId !== null,
    staleTime: 30_000,
    retry: false,
  });
}
