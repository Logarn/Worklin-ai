import {
  AlertCircle,
  Check,
  Loader2,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { useKlaviyoIntegration } from "@/domains/settings/hooks/use-klaviyo-integration";
import { RetentionApiError } from "@/lib/retention/api-error";
import type { RetentionIntegrationStatus } from "@/lib/retention/status";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function isKlaviyoConnected(
  integration: RetentionIntegrationStatus | null,
): boolean {
  return integration !== null && integration.status !== "revoked";
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

export function KlaviyoIntegrationRow({
  integration,
  statusLoading,
  statusUnavailable,
  onConfigure,
}: {
  integration: RetentionIntegrationStatus | null;
  statusLoading: boolean;
  statusUnavailable: boolean;
  onConfigure: () => void;
}) {
  const connected = isKlaviyoConnected(integration);
  const description = statusLoading
    ? "Checking connection"
    : statusUnavailable
      ? "Connection service unavailable"
      : connected
        ? "Read-only customer and campaign data"
        : "Email delivery and customer activity";

  return (
    <Card.Root>
      <Card.Body padding="sm" className="flex items-center gap-4 px-4">
        <IntegrationIcon
          providerKey="klaviyo"
          displayName="Klaviyo"
          logoUrl={null}
          size={32}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-title-small text-[var(--content-default)]">
            Klaviyo
          </p>
          <p className="truncate text-body-medium-lighter text-[var(--content-tertiary)]">
            {description}
          </p>
        </div>
        <Button
          variant={connected ? "outlined" : "primary"}
          onClick={onConfigure}
          className="shrink-0"
        >
          {connected ? "View" : "Enable"}
        </Button>
      </Card.Body>
    </Card.Root>
  );
}

export function KlaviyoIntegrationModal({
  assistantId,
  onClose,
}: {
  assistantId: string;
  onClose: () => void;
}) {
  const { status, connect, integration } = useKlaviyoIntegration(assistantId);
  const [brandName, setBrandName] = useState("");
  const [website, setWebsite] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useAllProperties, setUseAllProperties] = useState(true);
  const [properties, setProperties] = useState([""]);
  const [formError, setFormError] = useState<string | null>(null);
  const connected = isKlaviyoConnected(integration) || connect.isSuccess;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

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
    connect.mutate(
      {
        brandName: name,
        ...(websiteUrl ? { websiteUrl } : {}),
        credential,
        propertyAccessMode: useAllProperties ? "all" : "allowlist",
        propertyAllowlist: useAllProperties ? [] : propertyAllowlist,
      },
      {
        onError: (error) => setFormError(connectionErrorMessage(error)),
        onSettled: () => setApiKey(""),
      },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="klaviyo-integration-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[620px] flex-col overflow-hidden rounded-lg bg-[var(--surface-base)] shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-base)] px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <IntegrationIcon
              providerKey="klaviyo"
              displayName="Klaviyo"
              logoUrl={null}
              size={32}
            />
            <div className="min-w-0">
              <h2
                id="klaviyo-integration-title"
                className="text-title-small text-[var(--content-default)]"
              >
                Klaviyo
              </h2>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                Email delivery and customer activity
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<X />}
            aria-label="Close"
            onClick={onClose}
          />
        </div>

        <div className="overflow-y-auto px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-body-medium-default text-[var(--content-emphasised)]">
                Read-only access
              </p>
              <p className="mt-1 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
                Worklin reads approved customer and campaign history. It cannot
                change a profile, create a campaign, or send a message.
              </p>
            </div>
            <ShieldCheck
              className="size-5 shrink-0 text-[var(--content-success)]"
              aria-label="Read only"
            />
          </div>

          {status.isPending ? (
            <p className="mt-6 flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Checking connection
            </p>
          ) : status.isError ? (
            <div className="mt-6 flex items-start gap-3 border-y border-[var(--border-base)] py-4">
              <AlertCircle
                className="mt-0.5 size-5 shrink-0 text-[var(--system-warning-strong)]"
                aria-hidden="true"
              />
              <div>
                <p className="text-body-medium-default text-[var(--content-emphasised)]">
                  Connection service unavailable
                </p>
                <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                  Worklin is not ready to store this connection yet. Try again
                  after the workspace data service is ready.
                </p>
              </div>
            </div>
          ) : connected ? (
            <div className="mt-6 flex items-start gap-3 border-y border-[var(--border-base)] py-4">
              <Check
                className="mt-0.5 size-5 shrink-0 text-[var(--content-success)]"
                aria-hidden="true"
              />
              <div>
                <p className="text-body-medium-default text-[var(--content-emphasised)]">
                  Klaviyo is connected
                </p>
                <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                  Customer decisions can now prepare a history import for your
                  review.
                </p>
              </div>
            </div>
          ) : (
            <form className="mt-6" onSubmit={submit} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Brand name"
                  placeholder="Example Brand"
                  value={brandName}
                  onChange={(event) => {
                    setBrandName(event.target.value);
                    setFormError(null);
                  }}
                  disabled={connect.isPending}
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
                  disabled={connect.isPending}
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
                  disabled={connect.isPending}
                  helperText="The key is encrypted by Worklin and cleared from this form after the request."
                  fullWidth
                  required
                />
              </div>

              <div className="mt-5 flex items-start justify-between gap-4 border-y border-[var(--border-base)] py-4">
                <div className="min-w-0">
                  <p className="text-body-small-default text-[var(--content-default)]">
                    Use all custom properties
                  </p>
                  <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    Gives Worklin the fullest read-only picture for finding
                    useful non-buyer audiences. Sensitive details remain
                    protected and cannot be sent from this review pilot.
                  </p>
                </div>
                <Toggle
                  aria-label="Use all custom properties"
                  checked={useAllProperties}
                  disabled={connect.isPending}
                  onChange={() => {
                    setUseAllProperties((current) => !current);
                    setFormError(null);
                  }}
                />
              </div>

              {!useAllProperties ? (
                <fieldset className="mt-5">
                  <legend className="text-body-small-default text-[var(--content-default)]">
                    Selected profile properties
                  </legend>
                  <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    Add the Klaviyo fields Worklin may read, such as lead magnet
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
                          disabled={connect.isPending}
                          wrapperClassName="min-w-0 flex-1"
                          fullWidth
                        />
                        <button
                          type="button"
                          className="mb-px flex size-10 shrink-0 items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] disabled:opacity-50"
                          aria-label={`Remove approved property ${index + 1}`}
                          title="Remove property"
                          disabled={
                            connect.isPending || properties.length === 1
                          }
                          onClick={() =>
                            setProperties((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
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
                    disabled={connect.isPending}
                    onClick={() => setProperties((current) => [...current, ""])}
                  >
                    Add property
                  </Button>
                </fieldset>
              ) : null}

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
                className="mt-5"
                type="submit"
                variant="primary"
                leftIcon={
                  connect.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ShieldCheck />
                  )
                }
                disabled={connect.isPending}
              >
                {connect.isPending ? "Connecting" : "Connect securely"}
              </Button>
            </form>
          )}
        </div>

        <div className="flex justify-end border-t border-[var(--border-base)] px-5 py-3">
          <Button variant="outlined" size="compact" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
