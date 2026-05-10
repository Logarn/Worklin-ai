"use client";

import useSWR from "swr";
import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolved = use(params);
  const id = encodeURIComponent(resolved.id);
  const { data, isLoading } = useSWR(`/api/customers/${id}`, fetcher);
  const customer = data;

  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy raw customer detail">
        This page exposes the older raw customer record. Agent tools should use the PII-safe identity, feature,
        scoring, and micro-segment APIs.
      </LegacySurfaceNotice>
      {isLoading || !customer ? (
        <>
          <Skeleton className="h-24" />
          <Skeleton className="h-72" />
        </>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-zinc-100">
                {customer.firstName} {customer.lastName}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm text-zinc-300 md:grid-cols-3">
              <p>
                <span className="text-zinc-500">Email:</span> {customer.email}
              </p>
              <p>
                <span className="text-zinc-500">Total Orders:</span> {customer.totalOrders}
              </p>
              <p>
                <span className="text-zinc-500">Total Spent:</span> ${customer.totalSpent?.toFixed?.(2) ?? "0.00"}
              </p>
              <p>
                <span className="text-zinc-500">Segment:</span>{" "}
                <Badge variant="outline">{customer.segment || "unknown"}</Badge>
              </p>
              <p>
                <span className="text-zinc-500">Churn Risk:</span> {customer.churnRiskScore ?? 0}
              </p>
              <p>
                <span className="text-zinc-500">Last Order:</span>{" "}
                {customer.lastOrderDate ? new Date(customer.lastOrderDate).toLocaleDateString() : "-"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(customer.orders ?? []).slice(0, 20).map(
                (order: { id: string; orderNumber: string; createdAt: string; totalAmount: number }) => (
                  <div
                    key={order.id}
                    className="flex justify-between rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-sm"
                  >
                    <span className="text-zinc-200">{order.orderNumber}</span>
                    <span className="text-zinc-400">
                      {new Date(order.createdAt).toLocaleDateString()} · ${order.totalAmount.toFixed(2)}
                    </span>
                  </div>
                ),
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
