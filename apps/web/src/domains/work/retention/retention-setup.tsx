import {
  AlertCircle,
  Cable,
  Check,
  Database,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import type { RetentionIntegrationStatus } from "@/lib/retention/status";
import { useRetentionStatus } from "@/lib/retention/use-retention-status";
import { routes } from "@/utils/routes";
import { Button, ConfirmDialog } from "@vellumai/design-library";

import type {
  RetentionImportSummary,
  RetentionProgramSummary,
} from "./retention-api";
import {
  useActivateRetentionProgram,
  useApproveRetentionImport,
  usePauseRetentionProgram,
  useRetentionProgramApprovalPreview,
  useRetentionSetup,
} from "./use-retention-setup";

function label(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function policySummary(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { objective?: unknown }).objective === "string"
  ) {
    return (value as { objective: string }).objective;
  }
  return "The full frozen policy will be bound to this approval.";
}

function ProgramRow({
  program,
  onReview,
  onPause,
}: {
  program: RetentionProgramSummary;
  onReview: () => void;
  onPause: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border-base)] py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-body-medium-default text-[var(--content-emphasised)]">
          {program.name}
        </p>
        <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          {label(program.type)} · Policy {program.policyVersion}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`text-body-small-default ${
            program.status === "active"
              ? "text-[var(--content-success)]"
              : "text-[var(--content-secondary)]"
          }`}
        >
          {label(program.status)}
        </span>
        {program.status === "active" ? (
          <Button
            size="compact"
            variant="outlined"
            leftIcon={<Pause />}
            onClick={onPause}
            aria-label={`Pause ${program.name}`}
          >
            Pause
          </Button>
        ) : program.status !== "archived" ? (
          <Button size="compact" variant="outlined" onClick={onReview}>
            Review
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ImportRow({
  item,
  onApprove,
}: {
  item: RetentionImportSummary;
  onApprove: () => void;
}) {
  const canApprove = ["preview", "failed", "paused"].includes(item.status);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border-base)] py-4 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        <Database
          className="size-5 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-body-medium-default text-[var(--content-emphasised)]">
            {label(item.provider)} history
          </p>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            {item.importedCount.toLocaleString()} imported
            {item.rejectedCount > 0
              ? ` · ${item.rejectedCount.toLocaleString()} rejected`
              : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-body-small-default text-[var(--content-secondary)]">
          {label(item.status)}
        </span>
        {canApprove ? (
          <Button size="compact" variant="outlined" onClick={onApprove}>
            Start import
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DataConnectionsSection({
  integration,
  isPending,
  isUnavailable,
}: {
  integration: RetentionIntegrationStatus | null;
  isPending: boolean;
  isUnavailable: boolean;
}) {
  const navigate = useNavigate();
  const isConnected = integration !== null && integration.status !== "revoked";
  const statusLabel = isPending
    ? "Checking Klaviyo connection"
    : isUnavailable
      ? "Klaviyo connection unavailable"
      : isConnected
        ? "Klaviyo connected"
        : "Klaviyo not connected";

  return (
    <section aria-labelledby="data-connections-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="data-connections-heading"
            className="text-title-small text-[var(--content-emphasised)]"
          >
            Data connections
          </h2>
          <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
            Connect and manage Klaviyo from Integrations. Customer decisions
            uses that connection for imports, audiences, and campaign review.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-y border-[var(--border-base)] py-4">
        <p className="flex items-center gap-2 text-body-small-default text-[var(--content-secondary)]">
          {isConnected ? (
            <Check
              className="size-4 text-[var(--content-success)]"
              aria-hidden="true"
            />
          ) : (
            <Cable
              className="size-4 text-[var(--content-tertiary)]"
              aria-hidden="true"
            />
          )}
          {statusLabel}
        </p>
        <Button
          variant="outlined"
          size="compact"
          leftIcon={<Cable />}
          onClick={() =>
            navigate(`${routes.settings.integrations}?provider=klaviyo`)
          }
        >
          {isConnected ? "View integration" : "Connect Klaviyo"}
        </Button>
      </div>
    </section>
  );
}

export function RetentionSetup({ assistantId }: { assistantId: string }) {
  const setup = useRetentionSetup(assistantId);
  const retentionStatus = useRetentionStatus(assistantId);
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(
    null,
  );
  const [pauseTarget, setPauseTarget] =
    useState<RetentionProgramSummary | null>(null);
  const [importTarget, setImportTarget] =
    useState<RetentionImportSummary | null>(null);
  const policy = useRetentionProgramApprovalPreview(
    assistantId,
    selectedProgramId,
  );
  const activate = useActivateRetentionProgram(assistantId);
  const pause = usePauseRetentionProgram(assistantId);
  const approveImport = useApproveRetentionImport(assistantId);

  const loading = setup.programs.isPending || setup.imports.isPending;
  const loadError = setup.programs.isError || setup.imports.isError;
  const programs = setup.programs.data ?? [];
  const imports = setup.imports.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
      <DataConnectionsSection
        integration={
          retentionStatus.data?.integrations.find(
            (integration) => integration.provider === "klaviyo",
          ) ?? null
        }
        isPending={retentionStatus.isPending}
        isUnavailable={retentionStatus.isError}
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-body-small-default text-[var(--content-tertiary)]">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading retention setup
        </div>
      ) : loadError ? (
        <div
          className="flex flex-col items-center py-16 text-center"
          role="alert"
        >
          <AlertCircle className="size-7 text-[var(--system-warning-strong)]" />
          <p className="mt-3 text-body-medium-default text-[var(--content-default)]">
            Retention setup is unavailable
          </p>
          <Button
            className="mt-4"
            size="compact"
            variant="outlined"
            leftIcon={<RefreshCw />}
            onClick={() => {
              void setup.programs.refetch();
              void setup.imports.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <section aria-labelledby="programs-heading">
            <h2
              id="programs-heading"
              className="text-title-small text-[var(--content-emphasised)]"
            >
              Programs
            </h2>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Approved programs can make new customer decisions.
            </p>
            <div className="mt-4 border-y border-[var(--border-base)]">
              {programs.length > 0 ? (
                programs.map((program) => (
                  <ProgramRow
                    key={program.id}
                    program={program}
                    onReview={() => setSelectedProgramId(program.id)}
                    onPause={() => setPauseTarget(program)}
                  />
                ))
              ) : (
                <p className="py-5 text-body-small-default text-[var(--content-tertiary)]">
                  No retention programs have been prepared yet.
                </p>
              )}
            </div>
            {selectedProgramId ? (
              <div className="mt-5 border-l-2 border-[var(--content-success)] pl-4">
                {policy.isPending ? (
                  <p className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    Loading frozen policy
                  </p>
                ) : policy.data ? (
                  <>
                    <div className="flex items-start gap-3">
                      <ShieldCheck
                        className="mt-0.5 size-5 shrink-0 text-[var(--content-success)]"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-body-medium-default text-[var(--content-emphasised)]">
                          {policy.data.material.name}
                        </p>
                        <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-secondary)]">
                          {policySummary(policy.data.material.policy)}
                        </p>
                        <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                          Policy {policy.data.material.policyVersion} ·{" "}
                          {label(policy.data.material.program)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <Button
                        size="compact"
                        variant="primary"
                        leftIcon={
                          activate.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Play />
                          )
                        }
                        disabled={activate.isPending}
                        onClick={() =>
                          activate.mutate(
                            {
                              programId: policy.data.programId,
                              expectedPolicySha256: policy.data.snapshotSha256,
                            },
                            {
                              onSuccess: () => setSelectedProgramId(null),
                            },
                          )
                        }
                      >
                        Activate program
                      </Button>
                      <Button
                        size="compact"
                        variant="ghost"
                        onClick={() => setSelectedProgramId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                    {activate.isError ? (
                      <p className="mt-3 text-body-small-default text-[var(--system-negative-strong)]">
                        Worklin could not activate this policy. Refresh it
                        before trying again.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-body-small-default text-[var(--system-negative-strong)]">
                    The frozen policy could not be loaded.
                  </p>
                )}
              </div>
            ) : null}
          </section>

          <section aria-labelledby="imports-heading">
            <h2
              id="imports-heading"
              className="text-title-small text-[var(--content-emphasised)]"
            >
              Imports
            </h2>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Historical reads begin only after approval. Connected services are
              not changed.
            </p>
            <div className="mt-4 border-y border-[var(--border-base)]">
              {imports.length > 0 ? (
                imports.map((item) => (
                  <ImportRow
                    key={item.id}
                    item={item}
                    onApprove={() => setImportTarget(item)}
                  />
                ))
              ) : (
                <p className="py-5 text-body-small-default text-[var(--content-tertiary)]">
                  No imports are waiting for review.
                </p>
              )}
            </div>
            {approveImport.isSuccess ? (
              <p className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--content-success)]">
                <Check className="size-4" aria-hidden="true" />
                Import started.
              </p>
            ) : null}
          </section>

          <ConfirmDialog
            open={pauseTarget !== null}
            title="Pause this program?"
            message="Worklin will stop creating new recipient decisions for this program. Existing campaigns are not sent or deleted."
            confirmLabel="Pause program"
            isPending={pause.isPending}
            onConfirm={() => {
              if (!pauseTarget) return;
              pause.mutate(
                {
                  programId: pauseTarget.id,
                  reason: "Paused from Work by an authorized operator.",
                },
                { onSuccess: () => setPauseTarget(null) },
              );
            }}
            onCancel={() => {
              if (!pause.isPending) setPauseTarget(null);
            }}
          />
          <ConfirmDialog
            open={importTarget !== null}
            title="Start this historical import?"
            message="Worklin will read approved history into this workspace. It will not change Shopify or Klaviyo."
            confirmLabel="Start import"
            isPending={approveImport.isPending}
            onConfirm={() => {
              if (!importTarget) return;
              approveImport.mutate(importTarget.id, {
                onSuccess: () => setImportTarget(null),
              });
            }}
            onCancel={() => {
              if (!approveImport.isPending) setImportTarget(null);
            }}
          />
        </>
      )}
    </div>
  );
}
