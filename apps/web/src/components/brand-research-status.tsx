import { Loader2, SearchCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

import {
  cancelBrandResearchRun,
  enqueueBrandResearchRun,
  listBrandResearchRuns,
  retryBrandResearchRun,
  type BrandResearchRun,
} from "@/lib/brand-research";

function trackLabel(track: string): string {
  const labels: Record<string, string> = {
    identity_and_offers: "Brand and offers",
    competitors: "Competitors",
    seo_and_content: "Website and search",
    social: "Social media",
    email_and_lifecycle: "Emails and follow-up",
    sms: "Text messages",
    products_and_launches: "Products and launches",
    customer_market_investor_trends: "Customers and market",
  };
  return labels[track] ?? "Other information";
}

function trackStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Waiting",
    running: "Checking now",
    complete: "Ready",
    partial: "Some results ready",
    unavailable: "Could not access",
    not_observable: "Nothing public found",
  };
  return labels[status] ?? "Needs checking";
}

function runTitle(run: BrandResearchRun): string {
  const titles: Record<BrandResearchRun["status"], string> = {
    queued: `${run.brand_name}: waiting to start`,
    running: `${run.brand_name}: Worklin is looking into it`,
    partial: `${run.brand_name}: some results are ready`,
    complete: `${run.brand_name}: research is ready`,
    failed: `${run.brand_name}: research needs another try`,
    cancelled: `${run.brand_name}: research stopped`,
  };
  return titles[run.status];
}

function runSummary(run: BrandResearchRun): string {
  if (run.evidence_count > 0) {
    return `${run.evidence_count} useful sources checked`;
  }
  const summaries: Record<BrandResearchRun["status"], string> = {
    queued: "Worklin will start shortly.",
    running:
      "Worklin is checking your brand, customers, market, products, competitors, and marketing.",
    partial: "Some areas are ready. Others still need more information.",
    complete: "The report is ready to use.",
    failed: "Worklin could not finish this time. Try again.",
    cancelled: "You stopped this research.",
  };
  return summaries[run.status];
}

function plainError(message: string): string {
  const normalized = message.toLocaleLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "This took too long and stopped. Please try again.";
  }
  if (
    normalized.includes("provider") ||
    normalized.includes("api") ||
    normalized.includes("credential") ||
    normalized.includes("connection")
  ) {
    return "One of the information sources did not respond. Please try again.";
  }
  return "Worklin could not finish this part. Please try again.";
}

function normalizeBrandName(brandName: string): string {
  return brandName.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function selectBrandResearchRun(
  runs: BrandResearchRun[],
  assistantId: string,
  brandName?: string,
): BrandResearchRun | undefined {
  const normalizedBrandName =
    brandName === undefined ? null : normalizeBrandName(brandName);
  const candidates = runs.filter(
    (run) =>
      run.assistant_id === assistantId &&
      (normalizedBrandName === null ||
        normalizeBrandName(run.brand_name) === normalizedBrandName),
  );

  return candidates.reduce<BrandResearchRun | undefined>(
    (latest, candidate) => {
      if (!latest) return candidate;
      return Date.parse(candidate.updated_at) > Date.parse(latest.updated_at)
        ? candidate
        : latest;
    },
    undefined,
  );
}

export function BrandResearchStatus({
  assistantId,
  brandName: requestedBrandName,
}: {
  assistantId: string;
  brandName?: string;
}) {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<
    "cancel" | "retry" | "start" | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [seedBrandName, setSeedBrandName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const { data: runs = [] } = useQuery({
    queryKey: ["brand-research-runs"],
    queryFn: listBrandResearchRuns,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const latest = selectBrandResearchRun(
        query.state.data ?? [],
        assistantId,
        requestedBrandName,
      );
      return latest && ["queued", "running"].includes(latest.status)
        ? 5_000
        : false;
    },
  });
  const run = selectBrandResearchRun(runs, assistantId, requestedBrandName);

  if (!run) return null;

  const needsSeed =
    run.seed_missing_reason === "seedMissing" && run.evidence_count === 0;
  const isActive = !needsSeed && ["queued", "running"].includes(run.status);
  const canRetry =
    !needsSeed && ["partial", "failed", "cancelled"].includes(run.status);
  const Icon = run.status === "failed" ? TriangleAlert : SearchCheck;
  const trackProgress =
    !needsSeed && run.track_progress
      ? run.tracks
          .map((track) => run.track_progress?.[track])
          .filter((track): track is NonNullable<typeof track> => !!track)
      : [];
  const accountedTracks = trackProgress.filter((track) =>
    ["complete", "partial", "unavailable", "not_observable"].includes(
      track.status,
    ),
  ).length;

  const performAction = async (
    action: "cancel" | "retry",
    currentRun: BrandResearchRun,
  ) => {
    setPendingAction(action);
    setActionError(null);
    try {
      if (action === "cancel") {
        await cancelBrandResearchRun(currentRun.id);
      } else {
        await retryBrandResearchRun(currentRun.id);
      }
      await queryClient.invalidateQueries({
        queryKey: ["brand-research-runs"],
      });
    } catch (error) {
      setActionError(
        error instanceof Error
          ? plainError(error.message)
          : "Research status could not be updated.",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const startResearch = async () => {
    const cleanBrandName = seedBrandName.trim();
    const cleanWebsiteUrl = websiteUrl.trim();
    if (!cleanBrandName && !cleanWebsiteUrl) {
      setActionError("Add a brand name or public website to start research.");
      return;
    }
    setPendingAction("start");
    setActionError(null);
    try {
      await enqueueBrandResearchRun({
        assistantId,
        ...(cleanBrandName ? { brandName: cleanBrandName } : {}),
        ...(cleanWebsiteUrl ? { websiteUrl: cleanWebsiteUrl } : {}),
      });
      setSeedBrandName("");
      setWebsiteUrl("");
      await queryClient.invalidateQueries({
        queryKey: ["brand-research-runs"],
      });
    } catch (error) {
      setActionError(
        error instanceof Error
          ? plainError(error.message)
          : "Brand research could not be started.",
      );
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="mt-5 flex items-start gap-3 border-y border-[var(--border-base)] py-3 text-body-small-default">
      {isActive ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--content-secondary)]" />
      ) : (
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]" />
      )}
      <div className="min-w-0">
        <p className="text-[var(--content-default)]">
          {needsSeed
            ? "Brand research is ready"
            : runTitle(run)}
        </p>
        <p className="mt-0.5 text-[var(--content-tertiary)]">
          {needsSeed
            ? "Add a brand name or public website whenever you want Worklin to begin."
            : runSummary(run)}
        </p>
        {needsSeed ? (
          <form
            className="mt-3 grid max-w-3xl gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              void startResearch();
            }}
          >
            <label className="sr-only" htmlFor="brand-research-name">
              Brand name
            </label>
            <Input
              id="brand-research-name"
              fullWidth
              value={seedBrandName}
              onChange={(event) => setSeedBrandName(event.target.value)}
              placeholder="Brand name"
            />
            <label className="sr-only" htmlFor="brand-research-website">
              Public website
            </label>
            <Input
              id="brand-research-website"
              fullWidth
              inputMode="url"
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              placeholder="Public website"
            />
            <Button
              type="submit"
              variant="primary"
              size="compact"
              disabled={
                pendingAction !== null ||
                (!seedBrandName.trim() && !websiteUrl.trim())
              }
            >
              {pendingAction === "start" ? "Starting" : "Start research"}
            </Button>
          </form>
        ) : null}
        {trackProgress.length > 0 ? (
          <div className="mt-2">
            <p className="text-[var(--content-tertiary)]">
              {accountedTracks} of {trackProgress.length} areas checked
            </p>
            <ul className="mt-1 space-y-1 text-[var(--content-secondary)]">
              {trackProgress.map((track) => (
                <li key={track.track}>
                  {trackLabel(track.track)}: {trackStatusLabel(track.status)}
                  {track.provider_gaps.length
                    ? " - Some information could not be found."
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {run.error ? (
          <p className="mt-0.5 text-[var(--content-secondary)]">
            {plainError(run.error)}
          </p>
        ) : null}
        {actionError ? (
          <p className="mt-0.5 text-[var(--content-secondary)]">
            {actionError}
          </p>
        ) : null}
        {isActive || canRetry ? (
          <div className="mt-2 flex items-center gap-2">
            {isActive ? (
              <Button
                variant="outlined"
                size="compact"
                disabled={pendingAction !== null}
                onClick={() => void performAction("cancel", run)}
              >
                {pendingAction === "cancel" ? "Cancelling" : "Cancel"}
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                variant="outlined"
                size="compact"
                disabled={pendingAction !== null}
                onClick={() => void performAction("retry", run)}
              >
                {pendingAction === "retry" ? "Retrying" : "Retry"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
