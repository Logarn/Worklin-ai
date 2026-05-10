"use client";

import { TemplatesClient } from "@/components/templates/templates-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function TemplatesPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy template library">
        This template library is retained as an internal asset surface. New reusable campaign content should flow
        through agent planning, briefs, and QA.
      </LegacySurfaceNotice>
      <TemplatesClient />
    </div>
  );
}
