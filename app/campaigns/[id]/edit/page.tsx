"use client";

import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";
import { FLOW_TEMPLATES } from "@/lib/constants";

export default function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy flow template editor">
        This hardcoded template editor is retained for internal reference only. Real flow work should use read-only
        flow audits and future agent-side flow definition packages.
      </LegacySurfaceNotice>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Edit Campaign Flow</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Campaign ID: <span className="font-mono">{id}</span>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Flow Builder (Template Editor)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-zinc-300">
            Drag-and-drop flow editing can be layered on top of this data model. For now, select from pre-built
            templates and update node content via AI composer.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {FLOW_TEMPLATES.map((template) => (
              <div key={template.name} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <p className="text-sm font-medium text-zinc-100">{template.name}</p>
                <p className="text-xs text-zinc-400">
                  {template.nodes.length} nodes · {template.edges.length} edges
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
