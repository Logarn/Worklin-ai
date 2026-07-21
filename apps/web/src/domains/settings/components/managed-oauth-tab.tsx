import { ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

export interface ManagedTabProps {
  displayName: string;
  providerKey: string;
  logoUrl: string | null;
  connections: OAuthConnection[];
  connectionsLoading: boolean;
  startPending: boolean;
  oauthInProgress: boolean;
  connectError: string | null;
  managedUnsupported: boolean;
  disconnectingId: string | null;
  onConnect: () => void;
  onDisconnect: (connection: OAuthConnection) => void;
  onUseYourOwn: () => void;
}

export function ManagedTab({
  displayName,
  providerKey,
  logoUrl,
  connections,
  connectionsLoading,
  startPending,
  oauthInProgress,
  connectError,
  managedUnsupported,
  disconnectingId,
  onConnect,
  onDisconnect,
  onUseYourOwn,
}: ManagedTabProps) {
  if (connectionsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  if (connections.length === 0) {
    if (startPending || oauthInProgress) {
      return (
        <div className="flex flex-col items-center gap-3 py-10">
          <IntegrationIcon
            providerKey={providerKey}
            displayName={displayName}
            logoUrl={logoUrl}
            size={48}
          />
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <IntegrationIcon
          providerKey={providerKey}
          displayName={displayName}
          logoUrl={logoUrl}
          size={48}
        />
        {connectError ? (
          <ManagedOAuthErrorNotice
            displayName={displayName}
            message={connectError}
            onUseYourOwn={onUseYourOwn}
          />
        ) : (
          <p className="text-body-medium-default text-[var(--content-secondary)]">
            Connect Account to continue
          </p>
        )}
        {!managedUnsupported ? (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<Plus />}
            onClick={onConnect}
            disabled={startPending || oauthInProgress}
          >
            {connectError ? "Try again" : "Connect Account"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-base)]">
      {connectError ? (
        <div className="p-3">
          <ManagedOAuthErrorNotice
            displayName={displayName}
            message={connectError}
            onUseYourOwn={onUseYourOwn}
          />
        </div>
      ) : null}
      <ul className="divide-y divide-[var(--border-base)]">
        {connections.map((connection) => {
          const isDisconnecting = disconnectingId === connection.id;
          return (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <IntegrationIcon
                providerKey={providerKey}
                displayName={displayName}
                logoUrl={logoUrl}
                size={20}
              />
              <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                {connection.account_label ?? `${displayName} Account`}
              </span>
              <Button
                variant="dangerOutline"
                size="compact"
                iconOnly={
                  isDisconnecting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )
                }
                onClick={() => onDisconnect(connection)}
                disabled={isDisconnecting}
                aria-label={`Disconnect ${connection.account_label ?? `${displayName} account`}`}
              />
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
        {startPending || oauthInProgress ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        ) : !managedUnsupported ? (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<ExternalLink />}
            onClick={onConnect}
            disabled={startPending || oauthInProgress}
          >
            Connect account
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ManagedOAuthErrorNotice({
  displayName,
  message,
  onUseYourOwn,
}: {
  displayName: string;
  message: string;
  onUseYourOwn: () => void;
}) {
  return (
    <Notice
      tone="error"
      title={`Could not connect ${displayName}`}
      className="text-left"
      actions={
        <Button
          type="button"
          variant="outlined"
          size="compact"
          onClick={onUseYourOwn}
        >
          Use Your Own
        </Button>
      }
    >
      {message}
    </Notice>
  );
}
