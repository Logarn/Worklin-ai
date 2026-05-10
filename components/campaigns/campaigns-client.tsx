"use client";

import Link from "next/link";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type Campaign = {
  id: string;
  name: string;
  type: string;
  channel: string;
  status: string;
  metrics?: {
    sent: number;
    converted: number;
    revenue: number;
  } | null;
};

export function CampaignsClient() {
  const { data, isLoading } = useSWR<Campaign[]>("/api/campaigns", fetcher);
  const campaigns = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Campaigns</h1>
        <Link href="/campaigns/new">
          <Button>Create campaign</Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="grid gap-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>{campaign.name}</span>
                  <Badge variant={campaign.status === "active" ? "success" : "outline"}>
                    {campaign.status}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="text-zinc-400">
                  {campaign.type} · {campaign.channel}
                </div>
                <div className="text-zinc-400">
                  Sent: {campaign.metrics?.sent ?? 0} · Converted: {campaign.metrics?.converted ?? 0} · Revenue: $
                  {(campaign.metrics?.revenue ?? 0).toFixed(2)}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled
                    title="Legacy local status controls are disabled in the primary product path."
                  >
                    Status controls disabled
                  </Button>
                  <Link href={`/campaigns/${campaign.id}`}>
                    <Button variant="ghost">View</Button>
                  </Link>
                  <Link href={`/campaigns/${campaign.id}/edit`}>
                    <Button variant="ghost">Edit</Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
