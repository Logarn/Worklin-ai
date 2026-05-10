"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function NewCampaignPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState("one_time");
  const [channel, setChannel] = useState("email");
  const [status, setStatus] = useState("draft");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          channel,
          status,
          subject: subject || undefined,
          body: body || undefined,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { details?: string };
        throw new Error(payload.details || "Failed to create campaign");
      }
      const campaign = (await response.json()) as { id: string };
      router.push(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy campaign CRUD">
        Local campaign creation is retained for internal review only. New production campaign work should start from
        the agent planner, brief QA, approval, and draft-only flow.
      </LegacySurfaceNotice>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Create New Campaign</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid max-w-2xl gap-4" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-300">Campaign Name</label>
              <Input value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Type</label>
                <Select value={type} onChange={(event) => setType(event.target.value)}>
                  <option value="one_time">One-time</option>
                  <option value="automated_flow">Automated flow</option>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Channel</label>
                <Select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="multi">Multi</option>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Status</label>
                <Select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-300">Subject (optional)</label>
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-zinc-300">Body (optional)</label>
              <textarea
                className="textarea-base h-40"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-red-300">{error}</p> : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Campaign"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
