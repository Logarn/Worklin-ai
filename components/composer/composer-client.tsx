"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

type Customer = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  segment: string | null;
  lastOrderDate: string | null;
  totalOrders: number;
  totalSpent: number;
};

type GeneratedVariant =
  | { subject: string; preview: string; body: string }
  | { message: string };

const campaignTypes = [
  "win_back",
  "post_purchase",
  "replenishment",
  "browse_abandonment",
  "vip",
  "promotional",
];

const tones = ["Friendly", "Urgent", "Luxurious", "Playful", "Professional"];

export function ComposerClient() {
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [campaignType, setCampaignType] = useState("win_back");
  const [tone, setTone] = useState("Friendly");
  const [customerId, setCustomerId] = useState<string>("");
  const [brandVoice, setBrandVoice] = useState(
    "Confident, warm, and conversion-focused. Keep language clear and premium.",
  );
  const [manualName, setManualName] = useState("");
  const [manualSegment, setManualSegment] = useState("");
  const [manualRecentViews, setManualRecentViews] = useState("");
  const [variants, setVariants] = useState<GeneratedVariant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const { data: customersResponse } = useSWR<{ data: Customer[] }>("/api/customers?pageSize=50", fetcher);
  const customers = useMemo(() => customersResponse?.data ?? [], [customersResponse]);
  const selectedCustomer = useMemo(() => customers.find((c) => c.id === customerId), [customers, customerId]);

  async function generate() {
    setLoading(true);
    setError(null);
    setSaveMessage(null);
    try {
      const payload = {
        channel,
        campaignType,
        tone,
        brandVoice,
        customerContext: {
          name: selectedCustomer?.firstName || manualName || undefined,
          segment: selectedCustomer?.segment || manualSegment || undefined,
          lastPurchaseDate: selectedCustomer?.lastOrderDate || undefined,
          lastProduct: undefined,
          orderCount: selectedCustomer?.totalOrders ?? undefined,
          clv: selectedCustomer?.totalSpent ?? undefined,
          recentViews: manualRecentViews
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };

      const response = await fetch("/api/ai/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "Failed to generate variants");
      }
      setVariants(Array.isArray(json.variants) ? json.variants : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function saveVariantAsTemplate(index: number) {
    const variant = variants[index];
    if (!variant) return;

    setSavingTemplate(true);
    setSaveMessage(null);
    try {
      const payload =
        channel === "email" && "body" in variant
          ? {
              name: `${campaignType.replaceAll("_", " ")} variant ${index + 1}`,
              channel: "email",
              type: campaignType,
              subject: variant.subject,
              body: variant.body,
            }
          : {
              name: `${campaignType.replaceAll("_", " ")} sms ${index + 1}`,
              channel: "sms",
              type: campaignType,
              body: "message" in variant ? variant.message : "",
            };

      const response = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to save template");
      setSaveMessage("Template saved successfully.");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSavingTemplate(false);
    }
  }

  function copyText(text: string) {
    void navigator.clipboard.writeText(text);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">AI Message Composer</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Generate personalized retention copy with brand voice controls and variant testing.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Campaign inputs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Channel</label>
            <Select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Campaign type</label>
            <Select value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>
              {campaignTypes.map((type) => (
                <option key={type} value={type}>
                  {type.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Tone</label>
            <Select value={tone} onChange={(e) => setTone(e.target.value)}>
              {tones.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="md:col-span-2 xl:col-span-3">
            <label className="mb-1 block text-sm text-zinc-300">Select customer (optional)</label>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">No selected customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.email} ({c.segment || "unknown"})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Name fallback</label>
            <Input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Jane" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Segment fallback</label>
            <Input
              value={manualSegment}
              onChange={(e) => setManualSegment(e.target.value)}
              placeholder="at_risk"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-300">Recent views (comma-separated)</label>
            <Input
              value={manualRecentViews}
              onChange={(e) => setManualRecentViews(e.target.value)}
              placeholder="Hydrating Serum, Core Tee"
            />
          </div>
          <div className="md:col-span-2 xl:col-span-3">
            <label className="mb-1 block text-sm text-zinc-300">Brand voice</label>
            <textarea
              className="textarea-base min-h-24"
              value={brandVoice}
              onChange={(e) => setBrandVoice(e.target.value)}
            />
          </div>
          <div className="md:col-span-2 xl:col-span-3 flex items-center gap-3">
            <Button onClick={() => void generate()} disabled={loading}>
              {loading ? "Generating..." : "Generate 3 variants"}
            </Button>
            {error && <p className="text-sm text-red-300">{error}</p>}
            {saveMessage && <p className="text-sm text-zinc-300">{saveMessage}</p>}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {loading
          ? Array.from({ length: 3 }).map((_, idx) => <Skeleton key={idx} className="h-72" />)
          : variants.map((variant, idx) => (
              <Card key={idx}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>Variant {idx + 1}</span>
                    <Badge variant="outline">{channel.toUpperCase()}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {"body" in variant ? (
                    <>
                      <div>
                        <p className="text-xs text-zinc-400">Subject</p>
                        <Input
                          value={variant.subject}
                          onChange={(e) => {
                            const clone = [...variants];
                            clone[idx] = { ...variant, subject: e.target.value };
                            setVariants(clone);
                          }}
                        />
                      </div>
                      <div>
                        <p className="text-xs text-zinc-400">Preview</p>
                        <Input
                          value={variant.preview}
                          onChange={(e) => {
                            const clone = [...variants];
                            clone[idx] = { ...variant, preview: e.target.value };
                            setVariants(clone);
                          }}
                        />
                      </div>
                      <div>
                        <p className="text-xs text-zinc-400">Body</p>
                        <textarea
                          className="textarea-base min-h-36"
                          value={variant.body}
                          onChange={(e) => {
                            const clone = [...variants];
                            clone[idx] = { ...variant, body: e.target.value };
                            setVariants(clone);
                          }}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => copyText(`${variant.subject}\n${variant.preview}\n\n${variant.body}`)}
                        >
                          Copy
                        </Button>
                        <Button variant="outline" onClick={() => void saveVariantAsTemplate(idx)} disabled={savingTemplate}>
                          Save template
                        </Button>
                        <Button variant="outline" disabled title="Use the agent workflow to create QA-approved drafts.">
                          Live send disabled
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-xs text-zinc-400">Message</p>
                        <textarea
                          className="textarea-base min-h-36"
                          value={variant.message}
                          onChange={(e) => {
                            const clone = [...variants];
                            clone[idx] = { message: e.target.value };
                            setVariants(clone);
                          }}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => copyText(variant.message)}>
                          Copy
                        </Button>
                        <Button variant="outline" onClick={() => void saveVariantAsTemplate(idx)} disabled={savingTemplate}>
                          Save template
                        </Button>
                        <Button variant="outline" disabled title="Use the agent workflow to create QA-approved drafts.">
                          Live send disabled
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            ))}
      </div>
    </div>
  );
}
