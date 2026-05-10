"use client";

import useSWR from "swr";
import { use } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const encodedId = encodeURIComponent(id);
  const { data, isLoading } = useSWR(`/api/campaigns/${encodedId}`, fetcher);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy campaign record">
        This is a local campaign record from the older manual workflow. Use the agent campaign workflow for new
        draft-only campaign work.
      </LegacySurfaceNotice>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{data.name}</h1>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{data.channel}</Badge>
          <Badge variant="secondary">{data.status}</Badge>
          <Link href={`/campaigns/${encodedId}/edit`}>
            <Button variant="outline">Edit</Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Campaign Metrics</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3 lg:grid-cols-6 text-sm">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Sent</p>
            <p className="text-xl font-semibold text-zinc-100">{data.metrics?.sent ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Delivered</p>
            <p className="text-xl font-semibold text-zinc-100">{data.metrics?.delivered ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Opened</p>
            <p className="text-xl font-semibold text-zinc-100">{data.metrics?.opened ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Clicked</p>
            <p className="text-xl font-semibold text-zinc-100">{data.metrics?.clicked ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Converted</p>
            <p className="text-xl font-semibold text-zinc-100">{data.metrics?.converted ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-zinc-400">Revenue</p>
            <p className="text-xl font-semibold text-zinc-100">${(data.metrics?.revenue ?? 0).toFixed(2)}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
