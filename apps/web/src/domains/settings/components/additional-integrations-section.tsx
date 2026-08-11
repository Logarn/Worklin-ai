import { ChevronDown } from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { Button } from "@vellumai/design-library/components/button";

export type AdditionalIntegrationGroup =
  "communication" | "publishing" | "research";
export type AdditionalIntegrationAction =
  "contacts" | "email_settings" | "web_search_settings";

export interface AdditionalIntegration {
  id: string;
  group: AdditionalIntegrationGroup;
  displayName: string;
  description: string;
  statusLabel: string;
  requiresDedicatedAssistant?: boolean;
  action?: AdditionalIntegrationAction;
  actionLabel?: string;
}

const GROUP_LABELS: Record<AdditionalIntegrationGroup, string> = {
  communication: "Messaging and calls",
  publishing: "Publishing and collaboration",
  research: "Research sources",
};

const GROUP_ORDER: AdditionalIntegrationGroup[] = [
  "communication",
  "publishing",
  "research",
];

export const ADDITIONAL_INTEGRATIONS: readonly AdditionalIntegration[] = [
  {
    id: "slack_channel",
    group: "communication",
    displayName: "Slack messages",
    description:
      "Requires your own Slack app or bot on a dedicated assistant. This is separate from the Slack account connection above.",
    statusLabel: "Your Slack app · dedicated assistant",
    requiresDedicatedAssistant: true,
    action: "contacts",
    actionLabel: "Open channels",
  },
  {
    id: "telegram",
    group: "communication",
    displayName: "Telegram",
    description:
      "Receive commands and send updates through your Telegram bot on a dedicated assistant.",
    statusLabel: "Your bot · dedicated assistant",
    requiresDedicatedAssistant: true,
    action: "contacts",
    actionLabel: "Open channels",
  },
  {
    id: "twilio",
    group: "communication",
    displayName: "Phone calls",
    description:
      "Connect your Twilio number. Outbound calls require explicit authorization.",
    statusLabel: "Your Twilio account · dedicated assistant",
    requiresDedicatedAssistant: true,
    action: "contacts",
    actionLabel: "Open channels",
  },
  {
    id: "worklin_email",
    group: "communication",
    displayName: "Email",
    description:
      "Use a Worklin-managed inbox where available, or your own supported email provider.",
    statusLabel: "Private preview",
    action: "email_settings",
    actionLabel: "Manage",
  },
  {
    id: "whatsapp",
    group: "communication",
    displayName: "WhatsApp",
    description:
      "Worklin has a messaging foundation for Meta Cloud; customer setup is not self-service yet.",
    statusLabel: "Admin setup required",
  },
  {
    id: "vercel",
    group: "publishing",
    displayName: "Vercel",
    description:
      "Static Worklin app publishing is in developer preview and runs only after an explicit release.",
    statusLabel: "Developer preview",
  },
  {
    id: "sanity",
    group: "publishing",
    displayName: "Sanity",
    description:
      "Secure connection and workspace discovery are built; content use is still being completed.",
    statusLabel: "In development",
  },
  {
    id: "worklin_a2a",
    group: "publishing",
    displayName: "Other Worklin assistants",
    description:
      "Invite another Worklin assistant through the private-preview collaboration flow.",
    statusLabel: "Private preview",
  },
  {
    id: "custom_mcp",
    group: "publishing",
    displayName: "Custom tools",
    description:
      "Connect a private MCP tool on a supported dedicated assistant.",
    statusLabel: "Developer preview",
  },
  {
    id: "web_search",
    group: "research",
    displayName: "Web search",
    description:
      "Worklin-managed search is ready automatically. Custom provider setup needs a dedicated assistant.",
    statusLabel: "Managed search available",
    requiresDedicatedAssistant: true,
    action: "web_search_settings",
    actionLabel: "Custom setup",
  },
  {
    id: "trendtrack",
    group: "research",
    displayName: "Market Intelligence",
    description:
      "A workspace admin can enable the pilot and a budget for bounded competitor, offer, lifecycle, and market signals.",
    statusLabel: "Pilot · admin setup required",
  },
  {
    id: "meld",
    group: "research",
    displayName: "Meld",
    description:
      "Credential storage and the provider adapter exist; live research use is still being completed.",
    statusLabel: "In development",
  },
  {
    id: "instagram",
    group: "research",
    displayName: "Instagram research",
    description:
      "The read-only provider foundation exists; live brand research use is still being completed.",
    statusLabel: "In development",
  },
  {
    id: "facebook",
    group: "research",
    displayName: "Facebook research",
    description:
      "The read-only provider foundation exists; live brand research use is still being completed.",
    statusLabel: "In development",
  },
  {
    id: "linkedin",
    group: "research",
    displayName: "LinkedIn research",
    description:
      "The read-only provider foundation exists; live brand research use is still being completed.",
    statusLabel: "In development",
  },
  {
    id: "youtube",
    group: "research",
    displayName: "YouTube research",
    description:
      "The read-only provider foundation exists; live brand research use is still being completed.",
    statusLabel: "In development",
  },
] as const;

export function filterAdditionalIntegrations(
  searchText: string,
  selectedFilter: "all" | "enabled" | "not-enabled",
): AdditionalIntegration[] {
  // These connectors are backed by different services, so the page does not
  // claim a unified connected/disconnected state it cannot verify.
  if (selectedFilter !== "all") return [];
  const needle = searchText.trim().toLowerCase();
  return ADDITIONAL_INTEGRATIONS.filter((integration) => {
    if (!needle) return true;
    return [
      integration.id,
      integration.displayName,
      integration.description,
      integration.statusLabel,
      GROUP_LABELS[integration.group],
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

interface AdditionalIntegrationsSectionProps {
  integrations: AdditionalIntegration[];
  onOpen: (action: AdditionalIntegrationAction) => void;
  dedicatedSetupAvailable: boolean;
  searchActive?: boolean;
}

export function AdditionalIntegrationsSection({
  integrations,
  onOpen,
  dedicatedSetupAvailable,
  searchActive = false,
}: AdditionalIntegrationsSectionProps) {
  if (integrations.length === 0) return null;

  const groups = GROUP_ORDER.map((group) => ({
    group,
    integrations: integrations.filter(
      (integration) => integration.group === group,
    ),
  })).filter(({ integrations: groupIntegrations }) =>
    Boolean(groupIntegrations.length),
  );

  return (
    <section
      aria-labelledby="additional-integrations-heading"
      className="space-y-3"
    >
      <div>
        <h2
          id="additional-integrations-heading"
          className="text-title-small text-[var(--content-default)]"
        >
          More connections
        </h2>
        <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
          Every specialist connection Worklin can use now or is preparing, with
          its real current stage.
        </p>
      </div>

      <div className="space-y-2">
        {groups.map(({ group, integrations: groupIntegrations }) => (
          <details
            key={group}
            open={searchActive || undefined}
            className="group overflow-hidden rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)]"
          >
            <summary
              aria-label={GROUP_LABELS[group]}
              className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-body-medium-default text-[var(--content-default)]"
            >
              <span>{GROUP_LABELS[group]}</span>
              <span className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
                {groupIntegrations.length}
                <ChevronDown
                  className="h-4 w-4 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </span>
            </summary>
            <div role="list" aria-label={`${GROUP_LABELS[group]} connections`}>
              {groupIntegrations.map((integration) => (
                <div
                  key={integration.id}
                  role="listitem"
                  className="flex flex-wrap items-center gap-3 border-t border-[var(--border-element)] px-4 py-3"
                >
                  <IntegrationIcon
                    providerKey={integration.id}
                    displayName={integration.displayName}
                    logoUrl={null}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-title-small text-[var(--content-default)]">
                      {integration.displayName}
                    </p>
                    <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
                      {integration.description}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 rounded-full bg-[var(--surface-active)] px-2.5 py-1 text-label-small-default text-[var(--content-secondary)]">
                    {integration.statusLabel}
                  </span>
                  {integration.action && integration.actionLabel ? (
                    <Button
                      type="button"
                      variant="outlined"
                      size="compact"
                      className="shrink-0"
                      aria-label={`${integration.actionLabel} for ${integration.displayName}`}
                      disabled={
                        integration.requiresDedicatedAssistant === true &&
                        !dedicatedSetupAvailable
                      }
                      onClick={() => onOpen(integration.action!)}
                    >
                      {integration.actionLabel}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
