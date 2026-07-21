import { Loader2, SearchCheck, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { listBrandResearchRuns } from "@/lib/brand-research";

const STATUS_COPY = {
  queued: "Research queued",
  running: "Research in progress",
  partial: "Research partially complete",
  complete: "Research complete",
  failed: "Research needs attention",
  cancelled: "Research cancelled",
} as const;

export function BrandResearchStatus({ assistantId }: { assistantId: string }) {
  const { data: runs = [] } = useQuery({
    queryKey: ["brand-research-runs"],
    queryFn: listBrandResearchRuns,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const latest = query.state.data?.find(
        (run) => run.assistant_id === assistantId,
      );
      return latest && ["queued", "running", "partial"].includes(latest.status)
        ? 5_000
        : false;
    },
  });
  const run = runs.find((candidate) => candidate.assistant_id === assistantId);

  if (!run) return null;

  const isActive = ["queued", "running", "partial"].includes(run.status);
  const Icon = run.status === "failed" ? TriangleAlert : SearchCheck;

  return (
    <div className="mt-5 flex items-start gap-3 border-y border-[var(--border-base)] py-3 text-body-small-default">
      {isActive ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--content-secondary)]" />
      ) : (
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]" />
      )}
      <div className="min-w-0">
        <p className="text-[var(--content-default)]">
          {STATUS_COPY[run.status]} for {run.brand_name}
        </p>
        <p className="mt-0.5 text-[var(--content-tertiary)]">
          {run.evidence_count > 0
            ? `${run.evidence_count} evidence items collected`
            : "Worklin is gathering evidence across the brand research tracks."}
        </p>
        {run.error ? (
          <p className="mt-0.5 text-[var(--content-secondary)]">{run.error}</p>
        ) : null}
      </div>
    </div>
  );
}
