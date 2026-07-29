export interface RetentionSourceNotice {
  title: string;
  body: string;
  tone: "neutral" | "blocked";
}

export function getRetentionSourceNotice(
  sourceMode: string,
): RetentionSourceNotice | null {
  if (sourceMode === "live_readonly") return null;

  if (sourceMode === "klaviyo_l365") {
    return {
      title: "Live audit: Klaviyo L365 account scope.",
      body: "This artifact uses a live read-only Klaviyo L365 snapshot. Shopify can add commerce context for orders, value, replenishment, and revenue reconciliation.",
      tone: "neutral",
    };
  }

  if (sourceMode === "klaviyo_inventory") {
    return {
      title: "Partial live audit: Klaviyo inventory only.",
      body: "This artifact uses a live read-only Klaviyo inventory snapshot. The full commerce audit remains blocked until Shopify and deeper Klaviyo history are connected.",
      tone: "neutral",
    };
  }

  return {
    title: "Blocked artifact: live data required.",
    body: "This artifact was not produced from an approved live-data source. It must be regenerated after current Shopify and Klaviyo data are available.",
    tone: "blocked",
  };
}
