import {
  AlertCircle,
  Check,
  Database,
  Loader2,
  Plus,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button, ConfirmDialog, Input } from "@vellumai/design-library";

import type {
  RetentionImportSummary,
  RetentionProgramSummary,
} from "./retention-api";
import { RetentionApiError } from "./retention-api";
import {
  useActivateRetentionProgram,
  useApproveRetentionImport,
  useConnectKlaviyo,
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

function normalizeWebsiteUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const candidate = /^https?:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid_website");
  }
  return url.toString();
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof RetentionApiError) {
    if (
      error.code === "invalid_klaviyo_credential" ||
      error.code === "klaviyo_credentials_rejected" ||
      error.code === "provider_unauthorized" ||
      error.status === 401
    ) {
      return "Klaviyo rejected this private key. Check the key and try again.";
    }
    if (
      error.code === "klaviyo_scope_missing" ||
      error.code === "klaviyo_read_scope_required" ||
      error.code === "provider_permission_missing"
    ) {
      return "This key is missing a required read permission. Update its Klaviyo access and try again.";
    }
    if (error.status === 403) {
      return "You do not have permission to connect Klaviyo for this workspace.";
    }
    if (error.status === 409) {
      return "Klaviyo is already connected to this brand.";
    }
    if (error.status === 429) {
      return "Klaviyo is receiving too many requests. Wait a moment, then try again.";
    }
    if (error.status === 503) {
      return "The secure connection service is not ready. Try again shortly.";
    }
  }
  return "Worklin could not connect Klaviyo. The key was cleared, so enter it again before retrying.";
}

function KlaviyoConnectionSection({
  assistantId,
  isConnected,
}: {
  assistantId: string;
  isConnected: boolean;
}) {
  const connection = useConnectKlaviyo(assistantId);
  const [brandName, setBrandName] = useState("");
  const [website, setWebsite] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [properties, setProperties] = useState([""]);
  const [formError, setFormError] = useState<string | null>(null);

  const connected = isConnected || connection.isSuccess;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = brandName.trim();
    const credential = apiKey.trim();
    if (!name || !credential) {
      setFormError("Enter the brand name and Klaviyo private key.");
      return;
    }

    let websiteUrl: string | undefined;
    try {
      websiteUrl = normalizeWebsiteUrl(website);
    } catch {
      setFormError("Enter a valid website, such as example.com.");
      return;
    }

    const propertyAllowlist = Array.from(
      new Set(properties.map((property) => property.trim()).filter(Boolean)),
    );
    setFormError(null);
    connection.mutate(
      {
        brandName: name,
        ...(websiteUrl ? { websiteUrl } : {}),
        credential,
        propertyAllowlist,
      },
      {
        onError: (error) => setFormError(connectionErrorMessage(error)),
        onSettled: () => setApiKey(""),
      },
    );
  }

  return (
    <section aria-labelledby="connect-klaviyo-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="connect-klaviyo-heading"
            className="text-title-small text-[var(--content-emphasised)]"
          >
            Connect Klaviyo
          </h2>
          <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
            Worklin reads customer and campaign history. It cannot change a
            profile, create a campaign, or send a message.
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-body-small-default text-[var(--content-success)]">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Read only
        </span>
      </div>

      {connected ? (
        <div className="mt-4 flex items-start gap-3 border-y border-[var(--border-base)] py-4">
          <Check
            className="mt-0.5 size-5 shrink-0 text-[var(--content-success)]"
            aria-hidden="true"
          />
          <div>
            <p className="text-body-medium-default text-[var(--content-emphasised)]">
              Klaviyo is connected
            </p>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Review the prepared history import below before any data is read.
            </p>
          </div>
        </div>
      ) : (
        <form className="mt-5" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Brand name"
              placeholder="Example Brand"
              value={brandName}
              onChange={(event) => {
                setBrandName(event.target.value);
                setFormError(null);
              }}
              disabled={connection.isPending}
              fullWidth
              required
            />
            <Input
              label="Website (optional)"
              placeholder="example.com"
              value={website}
              onChange={(event) => {
                setWebsite(event.target.value);
                setFormError(null);
              }}
              disabled={connection.isPending}
              fullWidth
            />
          </div>
          <div className="mt-4">
            <Input
              type="password"
              label="Klaviyo private API key"
              placeholder="Enter the read-only key"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setFormError(null);
              }}
              autoComplete="new-password"
              spellCheck={false}
              disabled={connection.isPending}
              helperText="The key is encrypted by Worklin and cleared from this form after the request."
              fullWidth
              required
            />
          </div>

          <fieldset className="mt-5">
            <legend className="text-body-small-default text-[var(--content-default)]">
              Approved profile properties
            </legend>
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Add only the Klaviyo fields Worklin may use, such as lead magnet
              or product interest.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {properties.map((property, index) => (
                <div key={index} className="flex min-w-0 items-end gap-2">
                  <Input
                    aria-label={`Approved property ${index + 1}`}
                    placeholder="Property name"
                    value={property}
                    onChange={(event) =>
                      setProperties((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? event.target.value : item,
                        ),
                      )
                    }
                    disabled={connection.isPending}
                    wrapperClassName="min-w-0 flex-1"
                    fullWidth
                  />
                  <button
                    type="button"
                    className="mb-px flex size-10 shrink-0 items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] disabled:opacity-50"
                    aria-label={`Remove approved property ${index + 1}`}
                    title="Remove property"
                    disabled={connection.isPending || properties.length === 1}
                    onClick={() =>
                      setProperties((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <Button
              className="mt-3"
              type="button"
              size="compact"
              variant="ghost"
              leftIcon={<Plus />}
              disabled={connection.isPending}
              onClick={() => setProperties((current) => [...current, ""])}
            >
              Add property
            </Button>
          </fieldset>

          {formError ? (
            <p
              className="mt-4 flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]"
              role="alert"
            >
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {formError}
            </p>
          ) : null}

          <Button
            className="mt-5 bg-[var(--content-emphasised)] text-[var(--surface-base)]"
            type="submit"
            variant="primary"
            leftIcon={
              connection.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ShieldCheck />
              )
            }
            disabled={connection.isPending}
          >
            {connection.isPending ? "Connecting" : "Connect securely"}
          </Button>
        </form>
      )}
    </section>
  );
}

export function RetentionSetup({ assistantId }: { assistantId: string }) {
  const setup = useRetentionSetup(assistantId);
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
      <KlaviyoConnectionSection
        assistantId={assistantId}
        isConnected={imports.some((item) => item.provider === "klaviyo")}
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
