import { Mail, MessageSquareMore } from "lucide-react";

import type { CopybookCampaign } from "../copybook-api";
import { CopybookStatus } from "../copybook-status";

export function CampaignOutlineItem({ campaign }: { campaign: CopybookCampaign }) {
  const ChannelIcon = campaign.channel === "sms" ? MessageSquareMore : Mail;

  return (
    <li className="rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] p-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <ChannelIcon
          size={14}
          className="mt-0.5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-small-emphasised text-[var(--content-default)]">
            {campaign.ordinal}. {campaign.title}
          </p>
          <div className="mt-1.5">
            <CopybookStatus status={campaign.status} />
          </div>
        </div>
      </div>
    </li>
  );
}
