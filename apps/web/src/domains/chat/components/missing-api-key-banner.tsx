
import { X } from "lucide-react";

import { Button } from "@vellumai/design-library";

export interface MissingApiKeyBannerProps {
  kind?: "missing" | "invalid";
  onOpenSettings: () => void;
  onDismiss: () => void;
}

export function MissingApiKeyBanner({
  kind = "missing",
  onOpenSettings,
  onDismiss,
}: MissingApiKeyBannerProps) {
  const copy =
    kind === "invalid"
      ? {
          ariaLabel: "API key rejected",
          dismissLabel: "Dismiss API key rejected alert",
          title: "API key rejected",
          body: "Your AI provider rejected this key. Update it in Settings → Models & Services to keep chatting.",
        }
      : {
          ariaLabel: "API key required",
          dismissLabel: "Dismiss API key required alert",
          title: "API key required",
          body: "Add an API key in Settings → Models & Services to start chatting.",
        };

  return (
    <div
      className="relative flex flex-col gap-3 bg-[var(--surface-active)] p-4"
      style={{ borderRadius: "10px 10px 0 0" }}
      role="status"
      aria-label={copy.ariaLabel}
      data-testid="missing-api-key-banner"
    >
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          tooltip="Dismiss"
          aria-label={copy.dismissLabel}
          onClick={onDismiss}
        />
      </div>

      <div className="flex flex-col gap-2 pr-8">
        <p className="text-body-small-emphasised text-[var(--content-default)]">
          {copy.title}
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {copy.body}
        </p>
      </div>

      <Button variant="primary" onClick={onOpenSettings}>
        Open Settings
      </Button>
    </div>
  );
}
