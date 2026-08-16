import {
  AlertCircle,
  Check,
  Clock3,
  Loader2,
  Mail,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { ApiError } from "@/utils/api-errors";
import { createDraftConversationId } from "@/utils/conversation-selection";
import { routes } from "@/utils/routes";

import { WorkSectionNav } from "../work-section-nav";
import type {
  RetentionIntegrationStatus,
  RetentionStatus,
} from "./retention-api";
import { RetentionAudiences } from "./retention-audiences";
import { RetentionCampaignReview } from "./retention-campaign-review";
import { RetentionSetup } from "./retention-setup";
import { useRetentionStatus } from "./use-retention-status";
import { UNASSIGNED_BRAND_ID, useWorkData } from "../use-work-data";

const PROVIDERS = [
  { id: "shopify", label: "Shopify", icon: ShoppingBag },
  { id: "klaviyo", label: "Klaviyo", icon: Mail },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];
type SourceTone = "positive" | "warning" | "negative" | "neutral";

const SOURCE_STATUS: Record<string, { label: string; tone: SourceTone }> = {
  active: { label: "Connected", tone: "positive" },
  backfilling: { label: "Importing", tone: "warning" },
  pending: { label: "Connecting", tone: "neutral" },
  degraded: { label: "Needs attention", tone: "warning" },
  failed: { label: "Needs attention", tone: "negative" },
  revoked: { label: "Disconnected", tone: "negative" },
};

const TONE_DOT: Record<SourceTone, string> = {
  positive: "bg-[var(--system-positive-strong)]",
  warning: "bg-[var(--system-warning-strong)]",
  negative: "bg-[var(--system-negative-strong)]",
  neutral: "bg-[var(--content-tertiary)]",
};

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function latestSourceActivity(
  integration: RetentionIntegrationStatus,
): string | null {
  const values = [
    integration.lastWebhookAt,
    integration.lastPolledAt,
    integration.lastReconciledAt,
  ]
    .map((value) => ({ value, timestamp: validTimestamp(value) }))
    .filter(
      (item): item is { value: string; timestamp: number } =>
        item.timestamp !== null,
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  return values[0]?.value ?? null;
}

export function formatIngestionLag(
  activityAt: string | null,
  nowMs = Date.now(),
): string {
  const activityMs = validTimestamp(activityAt);
  if (activityMs === null) return "No activity yet";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - activityMs) / 1_000));
  if (elapsedSeconds < 60) return "Under a minute";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function statusForSource(integration?: RetentionIntegrationStatus) {
  if (!integration) return { label: "Not connected", tone: "neutral" } as const;
  return (
    SOURCE_STATUS[integration.status] ?? {
      label: "Status unavailable",
      tone: "neutral" as const,
    }
  );
}

function SourceCard({
  label,
  icon: Icon,
  integration,
}: {
  label: string;
  icon: LucideIcon;
  integration?: RetentionIntegrationStatus;
}) {
  const sourceStatus = statusForSource(integration);
  const activityAt = integration ? latestSourceActivity(integration) : null;
  const lag = formatIngestionLag(activityAt);
  const needsAttention =
    integration?.status === "degraded" ||
    integration?.status === "failed" ||
    integration?.status === "revoked" ||
    Boolean(integration?.lastErrorCode);

  return (
    <article className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-secondary)]">
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-title-small text-[var(--content-emphasised)]">
              {label}
            </h3>
            <p className="mt-1 flex items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
              <span
                className={`size-2 shrink-0 rounded-full ${TONE_DOT[sourceStatus.tone]}`}
                aria-hidden="true"
              />
              {sourceStatus.label}
            </p>
          </div>
        </div>
        {needsAttention ? (
          <AlertCircle
            className="size-5 shrink-0 text-[var(--system-warning-strong)]"
            aria-label="Connection needs attention"
          />
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--border-base)] pt-4">
        <div>
          <dt className="text-label-small text-[var(--content-tertiary)]">
            INGESTION LAG
          </dt>
          <dd className="mt-1 text-body-small-default text-[var(--content-default)]">
            {lag}
          </dd>
        </div>
        <div>
          <dt className="text-label-small text-[var(--content-tertiary)]">
            LAST ACTIVITY
          </dt>
          <dd className="mt-1 text-body-small-default text-[var(--content-default)]">
            {activityAt
              ? new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(activityAt))
              : "None yet"}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function QueueState({ jobs }: { jobs: RetentionStatus["jobs"] }) {
  const waiting = jobs.queued ?? 0;
  const processing = jobs.running ?? 0;
  const needsAttention = (jobs.failed ?? 0) + (jobs.dead_letter ?? 0);
  const isClear = waiting + processing + needsAttention === 0;

  return (
    <section aria-labelledby="queue-heading">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2
            id="queue-heading"
            className="text-title-small text-[var(--content-emphasised)]"
          >
            Processing
          </h2>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Current customer-data workload
          </p>
        </div>
        {isClear ? (
          <span className="flex items-center gap-2 text-body-small-default text-[var(--content-success)]">
            <Check className="size-4" aria-hidden="true" />
            Queue is clear
          </span>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-base)] rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] py-4">
        {[
          { label: "Waiting", value: waiting },
          { label: "Processing", value: processing },
          { label: "Needs attention", value: needsAttention },
        ].map((item) => (
          <div key={item.label} className="min-w-0 px-4">
            <dt className="text-body-small-default text-[var(--content-tertiary)]">
              {item.label}
            </dt>
            <dd className="mt-1 text-title-medium tabular-nums text-[var(--content-emphasised)]">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SafetyControls({
  externalWritesEnabled,
  sendEnabled,
}: Pick<RetentionStatus, "externalWritesEnabled" | "sendEnabled">) {
  const controls = [
    {
      label: "External updates",
      description: externalWritesEnabled
        ? "Worklin can update connected services."
        : "Changes to connected services are blocked.",
      enabled: externalWritesEnabled,
    },
    {
      label: "Email sending",
      description: sendEnabled
        ? "Klaviyo delivery is enabled."
        : "Sending through Klaviyo is blocked.",
      enabled: sendEnabled,
    },
  ];

  return (
    <section aria-labelledby="safety-heading">
      <h2
        id="safety-heading"
        className="text-title-small text-[var(--content-emphasised)]"
      >
        Safety controls
      </h2>
      <div className="mt-4 divide-y divide-[var(--border-base)] border-y border-[var(--border-base)]">
        {controls.map((control) => {
          const Icon = control.enabled ? ShieldAlert : ShieldCheck;
          return (
            <div
              key={control.label}
              className="flex items-center justify-between gap-4 py-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Icon
                  className={`size-5 shrink-0 ${
                    control.enabled
                      ? "text-[var(--system-warning-strong)]"
                      : "text-[var(--content-success)]"
                  }`}
                  aria-hidden="true"
                />
                <div>
                  <h3 className="text-body-medium-default text-[var(--content-default)]">
                    {control.label}
                  </h3>
                  <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    {control.description}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-body-small-default text-[var(--content-secondary)]">
                {control.enabled ? "Enabled" : "Blocked"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RetentionLoadingState() {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center py-24 text-center"
      aria-label="Loading retention health"
    >
      <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
        Loading source health
      </p>
    </div>
  );
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "You do not have access to retention status for this workspace.";
    }
    if (error.status === 404 || error.status === 503) {
      return "Retention is not ready for this workspace yet.";
    }
  }
  return "Worklin could not load retention health right now.";
}

function RetentionErrorState({
  error,
  onRetry,
  isRetrying,
}: {
  error: unknown;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center py-24 text-center"
      role="alert"
    >
      <AlertCircle className="size-8 text-[var(--system-warning-strong)]" />
      <h2 className="mt-4 text-title-small text-[var(--content-emphasised)]">
        Retention status unavailable
      </h2>
      <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
        {friendlyError(error)}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="mt-5 inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw
          className={`size-4 ${isRetrying ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        Try again
      </button>
    </div>
  );
}

function RetentionSetupActions({
  onStartBrandOnboarding,
}: {
  onStartBrandOnboarding: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Link
        to={`${routes.settings.integrations}?provider=klaviyo`}
        className="inline-flex min-h-9 items-center gap-2 rounded-md bg-[var(--content-emphasised)] px-3 text-body-small-default text-[var(--surface-base)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <Mail className="size-4" aria-hidden="true" />
        Connect Klaviyo
      </Link>
      <button
        type="button"
        onClick={onStartBrandOnboarding}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <MessageSquarePlus className="size-4" aria-hidden="true" />
        Start brand onboarding
      </button>
    </div>
  );
}

function RetentionStartPanel({
  onStartBrandOnboarding,
}: {
  onStartBrandOnboarding: () => void;
}) {
  return (
    <section
      className="mx-auto w-full max-w-3xl border-y border-[var(--border-base)] py-8"
      aria-labelledby="retention-start-heading"
    >
      <p className="text-label-small text-[var(--content-tertiary)]">
        START HERE
      </p>
      <h2
        id="retention-start-heading"
        className="mt-2 text-title-small text-[var(--content-emphasised)]"
      >
        Connect the customer data first
      </h2>
      <p className="mt-2 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
        Worklin needs brand context and Klaviyo history before it can find
        micro-segments, write campaign ideas, and save review-only copy.
      </p>
      <RetentionSetupActions onStartBrandOnboarding={onStartBrandOnboarding} />
    </section>
  );
}

export function RetentionWorkPage() {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const selectedAssistantId =
    useResolvedAssistantsStore.use.selectedAssistantId();
  const assistantId = activeAssistantId ?? selectedAssistantId;

  if (!assistantId) {
    return (
      <PageShell className="flex items-center justify-center px-6 py-12">
        <div className="max-w-md text-center" role="status">
          <h1 className="text-title-small text-[var(--content-emphasised)]">
            Customer decisions is getting ready
          </h1>
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            Choose an assistant to open this workspace.
          </p>
        </div>
      </PageShell>
    );
  }

  return <RetentionWorkPageContent assistantId={assistantId} />;
}

function RetentionWorkPageContent({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const { brands, isLoading: isBrandsLoading } = useWorkData(assistantId);
  const storageKey = `worklin:last-retention-brand:${assistantId}`;
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const query = useRetentionStatus(assistantId, selectedBrandId);
  const selectableBrands = useMemo(() => {
    const byId = new Map<
      string,
      {
        id: string;
        name: string;
      }
    >();
    for (const brand of brands) {
      if (brand.id !== UNASSIGNED_BRAND_ID) {
        byId.set(brand.id, { id: brand.id, name: brand.name });
      }
    }
    for (const integration of query.data?.integrations ?? []) {
      if (!byId.has(integration.brandId)) {
        byId.set(integration.brandId, {
          id: integration.brandId,
          name: integration.brandName,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [brands, query.data?.integrations]);
  const initialBrandId = (() => {
    const savedBrandId =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(storageKey);

    if (
      savedBrandId &&
      savedBrandId !== UNASSIGNED_BRAND_ID &&
      selectableBrands.some((brand) => brand.id === savedBrandId)
    ) {
      return savedBrandId;
    }

    return selectableBrands[0]?.id ?? null;
  })();
  useEffect(() => {
    if (selectedBrandId === null && initialBrandId !== null) {
      setSelectedBrandId(initialBrandId);
    }
  }, [initialBrandId, selectedBrandId]);
  const [activeView, setActiveView] = useState<
    "campaigns" | "audiences" | "setup" | "health"
  >("campaigns");
  const selectedBrand = selectableBrands.find(
    (brand) => brand.id === selectedBrandId,
  );
  const selectedBrandIntegrations = selectedBrandId
    ? (query.data?.integrations ?? []).filter(
        (integration) => integration.brandId === selectedBrandId,
      )
    : (query.data?.integrations ?? []);

  useEffect(() => {
    if (isBrandsLoading) {
      return;
    }

    const preferredBrandId =
      typeof window === "undefined"
        ? null
        : selectableBrands.find(
            (brand) =>
              brand.id === window.localStorage.getItem(storageKey) &&
              brand.id !== UNASSIGNED_BRAND_ID,
          )?.id;
    const nextBrandId = preferredBrandId ?? selectableBrands[0]?.id ?? null;

    if (nextBrandId !== selectedBrandId) {
      setSelectedBrandId(nextBrandId);
      if (nextBrandId && typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, nextBrandId);
      }
    }
  }, [brands, isBrandsLoading, selectedBrandId, storageKey, selectableBrands]);

  useEffect(() => {
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        Work
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [setTopBarCenter]);

  const integrations = selectedBrandIntegrations;
  const sourceByProvider = new Map(
    integrations.map((integration) => [
      integration.provider.toLowerCase() as ProviderId,
      integration,
    ]),
  );
  const hasSources = PROVIDERS.some((provider) =>
    sourceByProvider.has(provider.id),
  );
  const startBrandOnboarding = () => {
    const draftConversationId = createDraftConversationId();
    useConversationStore
      .getState()
      .setActiveConversationId(draftConversationId);
    useViewerStore.getState().setMainView("chat");
    const prompt =
      "I want to onboard a new retention brand from scratch. Please help me collect the brand context, products, voice, competitors, offers, and Klaviyo setup we need before creating this week's micro-campaigns.";
    void navigate(
      `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
  };

  useEffect(() => {
    if (isBrandsLoading || query.isPending || query.isFetching) return;
    const needsSourceSetup = selectableBrands.length === 0 || !hasSources;
    if (needsSourceSetup && activeView === "campaigns") {
      setActiveView("setup");
    }
  }, [
    activeView,
    hasSources,
    isBrandsLoading,
    query.isFetching,
    query.isPending,
    selectableBrands.length,
  ]);

  return (
    <PageShell className="overflow-hidden px-0 py-0">
      <header className="border-b border-[var(--border-base)] px-6 py-5">
        <WorkSectionNav active="retention" />
        <div className="mt-6">
          <p className="text-label-small text-[var(--content-tertiary)]">
            RETENTION
          </p>
          <h1 className="mt-2 text-title-large text-[var(--content-emphasised)]">
            Customer decisions
          </h1>
          <p className="mt-2 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
            Find useful customer groups and review campaign ideas before
            anything is sent.
          </p>
        </div>
        <div className="mt-5">
          {selectableBrands.length > 0 ? (
            <>
              <label className="flex items-end gap-2 text-body-small-default text-[var(--content-secondary)]">
                Brand
                <select
                  value={selectedBrandId ?? ""}
                  onChange={(event) => {
                    const nextBrandId = event.currentTarget.value;
                    setSelectedBrandId(nextBrandId);
                    if (typeof window !== "undefined") {
                      window.localStorage.setItem(storageKey, nextBrandId);
                    }
                  }}
                  disabled={isBrandsLoading || selectableBrands.length === 0}
                  className="max-w-xs rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default text-[var(--content-default)]"
                  aria-label="Retention brand selector"
                >
                  {selectableBrands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedBrand ? (
                <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                  Retention context: {selectedBrand.name}
                </p>
              ) : (
                <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                  Choose a brand before running retention actions.
                </p>
              )}
            </>
          ) : (
            <div>
              <p className="max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
                Connect Klaviyo and add brand context before Worklin prepares
                micro-segments and review-only campaigns.
              </p>
              <RetentionSetupActions
                onStartBrandOnboarding={startBrandOnboarding}
              />
            </div>
          )}
        </div>
        <div
          className="mt-5 flex gap-5"
          role="tablist"
          aria-label="Retention workspace"
        >
          {[
            { id: "campaigns" as const, label: "Campaigns" },
            { id: "audiences" as const, label: "Audiences" },
            { id: "setup" as const, label: "Setup" },
            { id: "health" as const, label: "Data health" },
          ].map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={activeView === view.id}
              onClick={() => setActiveView(view.id)}
              className={`border-b-2 pb-2 text-body-small-default ${
                activeView === view.id
                  ? "border-[var(--content-emphasised)] text-[var(--content-emphasised)]"
                  : "border-transparent text-[var(--content-tertiary)] hover:text-[var(--content-default)]"
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
        {activeView === "campaigns" ? (
          <div className="mx-auto w-full max-w-6xl">
            {!query.data ? (
              <div className="mb-4 flex items-start gap-3 border-y border-[var(--border-base)] py-3">
                {query.isPending ? (
                  <Loader2
                    className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--content-tertiary)]"
                    aria-hidden="true"
                  />
                ) : (
                  <ShieldAlert
                    className="mt-0.5 size-4 shrink-0 text-[var(--system-warning-strong)]"
                    aria-hidden="true"
                  />
                )}
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {query.isPending
                    ? "Verifying workspace delivery controls. Sending stays locked until this completes."
                    : "Delivery controls are unavailable. Campaign review remains read-only and sending stays locked."}
                </p>
              </div>
            ) : null}
            <RetentionCampaignReview
              assistantId={assistantId}
              selectedBrandId={selectedBrandId}
              retentionStatus={query.data ?? null}
            />
          </div>
        ) : activeView === "audiences" ? (
          <RetentionAudiences
            assistantId={assistantId}
            selectedBrandId={selectedBrandId}
            selectedBrandName={selectedBrand?.name ?? null}
          />
        ) : activeView === "setup" ? (
          selectableBrands.length === 0 ? (
            <RetentionStartPanel
              onStartBrandOnboarding={startBrandOnboarding}
            />
          ) : (
            <RetentionSetup
              assistantId={assistantId}
              selectedBrandId={selectedBrandId}
            />
          )
        ) : (
          <>
            {query.isPending ? <RetentionLoadingState /> : null}
            {query.isError ? (
              <RetentionErrorState
                error={query.error}
                onRetry={() => void query.refetch()}
                isRetrying={query.isFetching}
              />
            ) : null}
            {query.data ? (
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
                <section aria-labelledby="sources-heading">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2
                        id="sources-heading"
                        className="text-title-small text-[var(--content-emphasised)]"
                      >
                        Sources
                      </h2>
                      <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                        Commerce and delivery activity
                      </p>
                    </div>
                    <Clock3
                      className="size-5 text-[var(--content-tertiary)]"
                      aria-hidden="true"
                    />
                  </div>

                  {!hasSources ? (
                    <div className="mt-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3">
                      <p className="text-body-medium-default text-[var(--content-default)]">
                        No sources connected
                      </p>
                      <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                        Shopify and Klaviyo activity will appear after
                        connection.
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    {PROVIDERS.map((provider) => (
                      <SourceCard
                        key={provider.id}
                        label={provider.label}
                        icon={provider.icon}
                        integration={sourceByProvider.get(provider.id)}
                      />
                    ))}
                  </div>
                </section>

                <QueueState jobs={query.data.jobs} />
                <SafetyControls
                  externalWritesEnabled={query.data.externalWritesEnabled}
                  sendEnabled={query.data.sendEnabled}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </PageShell>
  );
}
