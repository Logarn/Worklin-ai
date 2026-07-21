import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/api/client.gen";

export type BillingCapability =
  | {
      available: true;
      mode: "managed";
    }
  | {
      available: false;
      mode: "external_provider";
      reason: "managed_billing_not_configured";
    };

const BILLING_CAPABILITY_QUERY_KEY = [
  "organizations",
  "billing",
  "capability",
] as const;

function parseBillingCapability(value: unknown): BillingCapability | null {
  if (!value || typeof value !== "object") return null;

  const capability = value as Record<string, unknown>;
  if (capability.available === true && capability.mode === "managed") {
    return { available: true, mode: "managed" };
  }
  if (
    capability.available === false &&
    capability.mode === "external_provider" &&
    capability.reason === "managed_billing_not_configured"
  ) {
    return {
      available: false,
      mode: "external_provider",
      reason: "managed_billing_not_configured",
    };
  }
  return null;
}

export async function fetchBillingCapability(): Promise<BillingCapability> {
  const { data, response } = await client.get<
    BillingCapability,
    Record<string, unknown>,
    false
  >({
    url: "/v1/organizations/billing/capability/",
    throwOnError: false,
  });

  const capability = parseBillingCapability(data);
  if (!response?.ok || !capability) {
    throw new Error("Billing capability could not be verified.");
  }
  return capability;
}

export function useBillingCapability(enabled: boolean) {
  return useQuery({
    queryKey: BILLING_CAPABILITY_QUERY_KEY,
    queryFn: fetchBillingCapability,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
