import { ComposerClient } from "@/components/composer/composer-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function ComposerPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy composer">
        This manual composer is retained for copy experiments only. Live Klaviyo sending is disabled; use agent
        workflows for QA and draft-only creation.
      </LegacySurfaceNotice>
      <ComposerClient />
    </div>
  );
}
