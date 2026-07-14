import { useQuery } from "@tanstack/react-query";

import { fetchCopybook } from "./copybook-api";

export function copybookQueryKey(assistantId: string, copybookId: string) {
  return ["copybook", assistantId, copybookId] as const;
}

export function useCopybookData(assistantId: string, copybookId: string) {
  return useQuery({
    queryKey: copybookQueryKey(assistantId, copybookId),
    queryFn: () => fetchCopybook(assistantId, copybookId),
  });
}
