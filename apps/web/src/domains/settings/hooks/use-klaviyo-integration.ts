import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  connectRetentionKlaviyo,
  type ConnectKlaviyoInput,
} from "@/lib/retention/klaviyo";
import { useRetentionStatus } from "@/lib/retention/use-retention-status";

export function useKlaviyoIntegration(assistantId: string | null) {
  const queryClient = useQueryClient();
  const status = useRetentionStatus(assistantId, null, { global: true });
  const statusLoading = status.fetchStatus !== "idle" && status.isPending;
  const connect = useMutation({
    mutationFn: (input: ConnectKlaviyoInput) =>
      connectRetentionKlaviyo(assistantId!, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["retention", "imports", assistantId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["retention", "status", assistantId],
        }),
      ]);
    },
  });
  const integration =
    status.data?.integrations.find(
      (candidate) => candidate.provider.toLowerCase() === "klaviyo",
    ) ?? null;

  return { status, statusLoading, connect, integration };
}
