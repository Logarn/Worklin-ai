import { CampaignsClient } from "@/components/campaigns/campaigns-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function CampaignsPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy campaign CRUD">
        This local campaign manager is retained as an internal surface. New campaign work should use agent workflows,
        brief QA, approvals, and draft-only Klaviyo creation.
      </LegacySurfaceNotice>
      <CampaignsClient />
    </div>
  );
}
