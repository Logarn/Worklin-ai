import { Prisma } from "@prisma/client";
import {
  buildUnifiedCustomerIdentity,
  UNIFIED_CUSTOMER_IDENTITY_DEPTHS,
} from "@/lib/customers/unified-identity";
import { prisma } from "@/lib/prisma";

export const CUSTOMER_FEATURE_STORE_VERSION = "customer_feature_store_v0";
export const CUSTOMER_FEATURE_STATUSES = ["available", "partial", "unavailable"] as const;

type CustomerFeatureStatus = (typeof CUSTOMER_FEATURE_STATUSES)[number];

export type CustomerFeatureComputeInput = {
  timeframeDays?: number | string | null;
  limit?: number | string | null;
  identityId?: string | null;
  persist?: boolean | string | null;
};

export type CustomerFeatureListInput = {
  identityId?: string | null;
  timeframeDays?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
};

type ParsedComputeInput =
  | {
      ok: true;
      data: {
        timeframeDays: number;
        limit: number;
        identityId: string | null;
        persist: boolean;
      };
    }
  | { ok: false; issues: string[] };

type ParsedListInput =
  | {
      ok: true;
      data: {
        identityId: string | null;
        timeframeDays: number | null;
        status: CustomerFeatureStatus | null;
        limit: number;
      };
    }
  | { ok: false; issues: string[] };

type IdentityProfile = {
  identityId: string;
  confidence: string;
  confidenceReasons: string[];
  confidenceCaveats: string[];
  matchedSourceSystems: string[];
  sourceIds: {
    worklinCustomerId: string;
    shopifyCustomerExternalId: string | null;
    klaviyoProfileId: string | null;
    klaviyoProfileIdKnown: boolean;
  };
  dataCoverage: Record<string, unknown>;
};

const DEFAULT_TIMEFRAME_DAYS = 90;
const MAX_TIMEFRAME_DAYS = 730;
const DEFAULT_COMPUTE_LIMIT = 200;
const MAX_COMPUTE_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TOP_ITEM_LIMIT = 5;
const DAY_MS = 86_400_000;

const CUSTOMER_FEATURE_SELECT = {
  id: true,
  externalId: true,
  createdAt: true,
  totalOrders: true,
  totalSpent: true,
  avgOrderValue: true,
  lastOrderDate: true,
  firstOrderDate: true,
  orders: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      totalAmount: true,
      status: true,
      createdAt: true,
      deliveredAt: true,
      items: {
        select: {
          quantity: true,
          price: true,
          product: {
            select: {
              id: true,
              externalId: true,
              name: true,
              category: true,
              price: true,
              avgReplenishmentDays: true,
            },
          },
        },
      },
    },
  },
  events: {
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      eventType: true,
      createdAt: true,
    },
  },
  campaignReceipts: {
    orderBy: { sentAt: "desc" },
    take: 500,
    select: {
      id: true,
      channel: true,
      status: true,
      sentAt: true,
      openedAt: true,
      clickedAt: true,
      convertedAt: true,
      revenue: true,
      campaign: {
        select: {
          id: true,
          type: true,
          channel: true,
          status: true,
        },
      },
    },
  },
} satisfies Prisma.CustomerSelect;

type CustomerFeatureRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_FEATURE_SELECT }>;
type CustomerOrder = CustomerFeatureRow["orders"][number];
type CustomerOrderItem = CustomerOrder["items"][number];
type CustomerReceipt = CustomerFeatureRow["campaignReceipts"][number];
type CustomerEventRow = CustomerFeatureRow["events"][number];

type AccountThresholds = {
  customerCount: number;
  customersWithOrders: number;
  ltv: {
    p50: number;
    p75: number;
    p90: number;
  };
  aov: {
    p75: number;
  };
  caveats: string[];
};

type ShopifyFeatureFreshness = {
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  shopifyLastOrdersSyncAt: Date | null;
  shopifyLastProductsSyncAt: Date | null;
  shopifyLastCustomersSyncAt: Date | null;
} | null;

type CustomerFeatureSnapshot = {
  identityId: string;
  worklinCustomerId: string;
  shopifyCustomerId: string | null;
  klaviyoProfileId: string | null;
  klaviyoProfileIdKnown: boolean;
  identityConfidence: string;
  featureVersion: string;
  timeframeDays: number;
  computedAt: string;
  status: CustomerFeatureStatus;
  identityFeatures: Record<string, unknown>;
  sourceSystems: Record<string, unknown>;
  sourceCoverage: Record<string, unknown>;
  commerceFeatures: Record<string, unknown>;
  engagementFeatures: Record<string, unknown>;
  intentFeatures: Record<string, unknown>;
  lifecycleFeatures: Record<string, unknown>;
  cohortFeatures: Record<string, unknown>;
  derivedLabels: Record<string, unknown>;
  missingCapabilities: string[];
  caveats: string[];
  metadata: Record<string, unknown>;
  persistedRecordId?: string;
};

function cleanString(value: unknown, max = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseInteger(value: unknown, fallback: number | null, inputName: string, max: number) {
  if (value === undefined || value === null || value === "") {
    return fallback === null
      ? { ok: true as const, value: null }
      : { ok: true as const, value: fallback };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, issue: `${inputName} must be a positive whole number.` };
  }
  return { ok: true as const, value: Math.min(parsed, max) };
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") return { ok: true as const, value: fallback };
  if (typeof value === "boolean") return { ok: true as const, value };
  const cleaned = cleanString(value, 20)?.toLowerCase();
  if (["true", "1", "yes"].includes(cleaned ?? "")) return { ok: true as const, value: true };
  if (["false", "0", "no"].includes(cleaned ?? "")) return { ok: true as const, value: false };
  return { ok: false as const, issue: "persist must be true or false." };
}

function parseStatus(value: unknown) {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return CUSTOMER_FEATURE_STATUSES.includes(cleaned as CustomerFeatureStatus)
    ? (cleaned as CustomerFeatureStatus)
    : undefined;
}

export function parseCustomerFeatureComputeInput(input: CustomerFeatureComputeInput = {}): ParsedComputeInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, DEFAULT_TIMEFRAME_DAYS, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_COMPUTE_LIMIT, "limit", MAX_COMPUTE_LIMIT);
  const persist = parseBoolean(input.persist, true);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (!persist.ok) issues.push(persist.issue);

  return issues.length || !timeframeDays.ok || !limit.ok || !persist.ok
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          timeframeDays: timeframeDays.value ?? DEFAULT_TIMEFRAME_DAYS,
          limit: limit.value ?? DEFAULT_COMPUTE_LIMIT,
          identityId: cleanString(input.identityId, 220),
          persist: persist.value,
        },
      };
}

export function parseCustomerFeatureListInput(input: CustomerFeatureListInput = {}): ParsedListInput {
  const issues: string[] = [];
  const timeframeDays = parseInteger(input.timeframeDays, null, "timeframeDays", MAX_TIMEFRAME_DAYS);
  const limit = parseInteger(input.limit, DEFAULT_LIST_LIMIT, "limit", MAX_LIST_LIMIT);
  const status = parseStatus(input.status);

  if (!timeframeDays.ok) issues.push(timeframeDays.issue);
  if (!limit.ok) issues.push(limit.issue);
  if (status === undefined) issues.push("status must be available, partial, or unavailable.");

  return issues.length || !timeframeDays.ok || !limit.ok || status === undefined
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          identityId: cleanString(input.identityId, 220),
          timeframeDays: timeframeDays.value,
          status,
          limit: limit.value ?? DEFAULT_LIST_LIMIT,
        },
      };
}

function money(value: number | null | undefined) {
  return Number((value ?? 0).toFixed(2));
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY_MS));
}

function daysSince(value: Date | null | undefined, now: Date) {
  return value ? daysBetween(value, now) : null;
}

function startOfWindow(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}

function inWindow(value: Date | null | undefined, now: Date, days: number) {
  if (!value) return false;
  return value >= startOfWindow(now, days) && value <= now;
}

function monthKey(value: Date | null | undefined) {
  if (!value) return null;
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function cleanList(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function countBy(values: Array<string | null | undefined>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value?.trim() || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function percentile(values: number[], p: number) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isIdentityProfile(value: unknown): value is IdentityProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.identityId === "string" && Boolean(record.sourceIds);
}

function orderCountBand(totalOrders: number) {
  if (totalOrders <= 0) return "zero_orders";
  if (totalOrders === 1) return "one_order";
  if (totalOrders === 2) return "two_orders";
  if (totalOrders <= 4) return "three_to_four_orders";
  return "five_plus_orders";
}

function ltvBand(value: number, thresholds: AccountThresholds) {
  if (value <= 0) return "none";
  if (value >= thresholds.ltv.p90 && thresholds.ltv.p90 > 0) return "vip";
  if (value >= thresholds.ltv.p75 && thresholds.ltv.p75 > 0) return "high";
  if (value >= thresholds.ltv.p50 && thresholds.ltv.p50 > 0) return "mid";
  return "low";
}

function repeatBuyerStatus(totalOrders: number) {
  if (totalOrders <= 0) return "no_purchase";
  if (totalOrders === 1) return "one_time_buyer";
  return "repeat_buyer";
}

function confidenceFor(status: CustomerFeatureStatus, caveats: string[]) {
  if (status === "available" && caveats.length === 0) return "high";
  if (status === "unavailable") return "low";
  return "medium";
}

function primaryEntry(order: CustomerOrder | null) {
  const items = [...(order?.items ?? [])];
  if (!items.length) {
    return {
      item: null as CustomerOrderItem | null,
      entryType: "unknown_product_entry",
      selectionMethod: "no_line_items",
      caveat: "First order has no usable local line items.",
    };
  }

  const maxRevenue = Math.max(...items.map((item) => item.quantity * item.price));
  const revenueTies = items.filter((item) => item.quantity * item.price === maxRevenue);
  if (maxRevenue > 0 && revenueTies.length === 1) {
    return { item: revenueTies[0], entryType: "single_product_entry", selectionMethod: "highest_line_revenue", caveat: null };
  }
  if (maxRevenue > 0 && revenueTies.length > 1) {
    return { item: revenueTies[0], entryType: "multi_product_entry", selectionMethod: "line_revenue_tie", caveat: "Multiple first-order products tied on line revenue." };
  }

  const maxQuantity = Math.max(...items.map((item) => item.quantity));
  const quantityTies = items.filter((item) => item.quantity === maxQuantity);
  if (maxQuantity > 0 && quantityTies.length === 1) {
    return { item: quantityTies[0], entryType: "single_product_entry", selectionMethod: "highest_quantity", caveat: null };
  }
  if (maxQuantity > 0 && quantityTies.length > 1) {
    return { item: quantityTies[0], entryType: "multi_product_entry", selectionMethod: "quantity_tie", caveat: "Multiple first-order products tied on quantity." };
  }

  return {
    item: items[0],
    entryType: "unknown_product_entry",
    selectionMethod: "first_line_item_fallback",
    caveat: "Line revenue and quantity were not usable; first line item was used as a directional fallback.",
  };
}

function compactProduct(item: CustomerOrderItem, revenue: number, quantity: number) {
  return {
    productId: item.product.id,
    shopifyProductId: item.product.externalId,
    name: item.product.name,
    category: item.product.category,
    revenue: money(revenue),
    quantity,
    avgReplenishmentDays: item.product.avgReplenishmentDays,
  };
}

function topProducts(orders: CustomerOrder[], mode: "revenue" | "quantity") {
  const products = new Map<string, { item: CustomerOrderItem; revenue: number; quantity: number }>();
  for (const order of orders) {
    for (const item of order.items) {
      const current = products.get(item.product.id) ?? { item, revenue: 0, quantity: 0 };
      current.quantity += item.quantity;
      current.revenue += item.quantity * item.price;
      products.set(item.product.id, current);
    }
  }
  return Array.from(products.values())
    .sort((a, b) => mode === "revenue" ? b.revenue - a.revenue : b.quantity - a.quantity)
    .slice(0, TOP_ITEM_LIMIT)
    .map((entry) => compactProduct(entry.item, entry.revenue, entry.quantity));
}

function productAffinity(orders: CustomerOrder[]) {
  const byRevenue = topProducts(orders, "revenue");
  return {
    primaryProductId: byRevenue[0]?.productId ?? null,
    primaryProductName: byRevenue[0]?.name ?? null,
    topProductCount: byRevenue.length,
    confidence: byRevenue.length ? "medium" : "low",
  };
}

function categoryAffinity(orders: CustomerOrder[]) {
  const categories = new Map<string, { category: string; revenue: number; quantity: number }>();
  for (const order of orders) {
    for (const item of order.items) {
      const category = item.product.category ?? "unknown";
      const current = categories.get(category) ?? { category, revenue: 0, quantity: 0 };
      current.quantity += item.quantity;
      current.revenue += item.quantity * item.price;
      categories.set(category, current);
    }
  }
  return Array.from(categories.values())
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity)
    .slice(0, TOP_ITEM_LIMIT)
    .map((entry) => ({
      category: entry.category,
      revenue: money(entry.revenue),
      quantity: entry.quantity,
    }));
}

async function accountThresholds(): Promise<AccountThresholds> {
  const customers = await prisma.customer.findMany({
    select: {
      totalOrders: true,
      totalSpent: true,
      avgOrderValue: true,
    },
  });
  const customersWithOrders = customers.filter((customer) => customer.totalOrders > 0);
  const spent = customersWithOrders.map((customer) => customer.totalSpent).filter((value) => value > 0);
  const aov = customersWithOrders.map((customer) => customer.avgOrderValue).filter((value) => value > 0);
  const caveats = customersWithOrders.length >= 20
    ? []
    : ["Account-relative LTV and AOV bands are directional because fewer than 20 local purchasing customers are available."];

  return {
    customerCount: customers.length,
    customersWithOrders: customersWithOrders.length,
    ltv: {
      p50: money(percentile(spent, 0.5)),
      p75: money(percentile(spent, 0.75)),
      p90: money(percentile(spent, 0.9)),
    },
    aov: {
      p75: money(percentile(aov, 0.75)),
    },
    caveats,
  };
}

function commerceFeatures(customer: CustomerFeatureRow, now: Date, thresholds: AccountThresholds) {
  const orders = [...customer.orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const orderCountFromRows = orders.length;
  const orderCount = Math.max(customer.totalOrders, orderCountFromRows);
  const revenueFromRows = money(orders.reduce((sum, order) => sum + order.totalAmount, 0));
  const totalRevenue = customer.totalSpent > 0 ? money(customer.totalSpent) : revenueFromRows;
  const firstOrderAt = customer.firstOrderDate ?? orders[0]?.createdAt ?? null;
  const lastOrderAt = customer.lastOrderDate ?? orders[orders.length - 1]?.createdAt ?? null;
  const aov = orderCount ? money(totalRevenue / orderCount) : money(customer.avgOrderValue);
  const caveats = cleanList([
    "Revenue uses local Order.totalAmount and Customer.totalSpent; refunds, discounts, taxes, and shipping are not separately normalized in v0.",
    orderCountFromRows !== customer.totalOrders
      ? "Customer.totalOrders and local Order row count differ; lifetime metrics use the higher local count and should be treated as directional."
      : null,
    Math.abs(revenueFromRows - customer.totalSpent) > 0.01 && customer.totalSpent > 0
      ? "Customer.totalSpent and summed local Order.totalAmount differ; totalSpent was treated as the denormalized lifetime value."
      : null,
    ...thresholds.caveats,
  ]);

  const ordersInWindow = (days: number) => orders.filter((order) => inWindow(order.createdAt, now, days));
  const revenueInWindow = (days: number) => money(ordersInWindow(days).reduce((sum, order) => sum + order.totalAmount, 0));
  const band = ltvBand(totalRevenue, thresholds);
  const highAovCustomer = aov > 0 && thresholds.aov.p75 > 0 && aov >= thresholds.aov.p75;

  return {
    status: orderCount > 0 ? "available" as CustomerFeatureStatus : "partial" as CustomerFeatureStatus,
    metricScope: {
      lifetime: ["totalOrdersLifetime", "totalRevenueLifetime", "averageOrderValueLifetime"],
      windowed: ["orders30d", "orders60d", "orders90d", "revenue30d", "revenue60d", "revenue90d"],
    },
    totalOrdersLifetime: orderCount,
    totalRevenueLifetime: totalRevenue,
    averageOrderValueLifetime: aov,
    firstOrderAt: iso(firstOrderAt),
    lastOrderAt: iso(lastOrderAt),
    daysSinceFirstOrder: daysSince(firstOrderAt, now),
    daysSinceLastOrder: daysSince(lastOrderAt, now),
    orders30d: ordersInWindow(30).length,
    orders60d: ordersInWindow(60).length,
    orders90d: ordersInWindow(90).length,
    revenue30d: revenueInWindow(30),
    revenue60d: revenueInWindow(60),
    revenue90d: revenueInWindow(90),
    hasPurchased: orderCount > 0,
    oneTimeBuyer: orderCount === 1,
    repeatBuyer: orderCount >= 2,
    orderCountBand: orderCountBand(orderCount),
    ltvBand: band,
    highAovCustomer,
    accountRelativeThresholds: {
      ltvP50: thresholds.ltv.p50,
      ltvP75: thresholds.ltv.p75,
      ltvP90: thresholds.ltv.p90,
      aovP75: thresholds.aov.p75,
      customersWithOrders: thresholds.customersWithOrders,
    },
    caveats,
  };
}

function cohortFeatures(customer: CustomerFeatureRow) {
  const orders = [...customer.orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const firstOrder = orders[0] ?? null;
  const lastOrder = orders[orders.length - 1] ?? null;
  const entry = primaryEntry(firstOrder);
  const entryProduct = entry.item?.product ?? null;
  const firstPurchaseMonth = monthKey(customer.firstOrderDate ?? firstOrder?.createdAt ?? null);
  const topByRevenue = topProducts(orders, "revenue");
  const topByQuantity = topProducts(orders, "quantity");
  const categories = categoryAffinity(orders);
  const caveats = cleanList([
    entry.caveat,
    entryProduct ? null : "First product cohort is unknown because local first-order product data is unavailable.",
    categories.length ? null : "Category affinity is unavailable because local product category data is missing or no order items exist.",
  ]);

  return {
    status: orders.length && entryProduct ? "available" as CustomerFeatureStatus : "partial" as CustomerFeatureStatus,
    firstProductCohort: entryProduct?.name ?? entry.entryType,
    firstProductCohortConfidence: entry.selectionMethod === "highest_line_revenue" ? "high" : entryProduct ? "medium" : "low",
    firstCategoryCohort: entryProduct?.category ?? null,
    lastProductPurchased: lastOrder ? primaryEntry(lastOrder).item?.product.name ?? null : null,
    topProductsByRevenue: topByRevenue,
    topProductsByQuantity: topByQuantity,
    productAffinity: productAffinity(orders),
    categoryAffinity: categories,
    firstPurchaseMonth,
    firstPurchaseCohort: firstPurchaseMonth,
    productEntryCohort: {
      productId: entryProduct?.id ?? null,
      shopifyProductId: entryProduct?.externalId ?? null,
      name: entryProduct?.name ?? null,
      category: entryProduct?.category ?? null,
      entryType: entry.entryType,
      selectionMethod: entry.selectionMethod,
    },
    productEntryCohortCaveats: caveats,
  };
}

function receiptDate(receipt: CustomerReceipt) {
  return receipt.clickedAt ?? receipt.openedAt ?? receipt.convertedAt ?? receipt.sentAt ?? null;
}

function localEmailReceipt(receipt: CustomerReceipt) {
  const channel = `${receipt.channel ?? ""} ${receipt.campaign.channel ?? ""}`.toLowerCase();
  return !channel || channel.includes("email");
}

function engagementFeatures(
  customer: CustomerFeatureRow,
  now: Date,
  missingCapabilities: Set<string>,
) {
  const receipts = customer.campaignReceipts;
  const events = customer.events;
  const emailReceipts = receipts.filter(localEmailReceipt);
  const openDates = emailReceipts.map((receipt) => receipt.openedAt).filter((value): value is Date => Boolean(value));
  const clickDates = emailReceipts.map((receipt) => receipt.clickedAt).filter((value): value is Date => Boolean(value));
  const activeDates = [
    ...events.map((event) => event.createdAt),
    ...receipts.map(receiptDate).filter((value): value is Date => Boolean(value)),
  ].sort((a, b) => a.getTime() - b.getTime());
  const campaignEngaged30d = receipts.filter((receipt) =>
    [receipt.openedAt, receipt.clickedAt, receipt.convertedAt].some((date) => inWindow(date, now, 30)),
  ).length;
  const flowEngaged30d = receipts.filter((receipt) =>
    receipt.campaign.type.toLowerCase().includes("flow") &&
    [receipt.openedAt, receipt.clickedAt, receipt.convertedAt].some((date) => inWindow(date, now, 30)),
  ).length;
  const smsEngaged30d = receipts.filter((receipt) =>
    `${receipt.channel} ${receipt.campaign.channel}`.toLowerCase().includes("sms") &&
    [receipt.openedAt, receipt.clickedAt, receipt.convertedAt].some((date) => inWindow(date, now, 30)),
  ).length;
  const hasLocalEngagement = receipts.length > 0 || events.length > 0;
  const caveats = cleanList([
    "Engagement v0 uses local Worklin campaign receipts and CustomerEvent rows only.",
    "Klaviyo profile ids are not linked in the local schema, so profile-level engagement attribution is caveated.",
    emailReceipts.length
      ? null
      : "Local email receipt opens/clicks are unavailable for this customer.",
  ]);

  missingCapabilities.add("klaviyo.profile_id.local_linkage");
  missingCapabilities.add("klaviyo.events.local_ingest");
  if (!emailReceipts.length) missingCapabilities.add("klaviyo.email_engagement.local_read");

  return {
    status: hasLocalEngagement ? "partial" as CustomerFeatureStatus : "unavailable" as CustomerFeatureStatus,
    lastActiveAt: iso(activeDates[activeDates.length - 1]),
    firstActiveAt: iso(activeDates[0]),
    lastEmailOpenAt: iso(openDates.sort((a, b) => a.getTime() - b.getTime())[openDates.length - 1]),
    lastEmailClickAt: iso(clickDates.sort((a, b) => a.getTime() - b.getTime())[clickDates.length - 1]),
    emailOpens30d: openDates.filter((date) => inWindow(date, now, 30)).length,
    emailClicks30d: clickDates.filter((date) => inWindow(date, now, 30)).length,
    emailOpens60d: openDates.filter((date) => inWindow(date, now, 60)).length,
    emailClicks60d: clickDates.filter((date) => inWindow(date, now, 60)).length,
    emailOpens90d: openDates.filter((date) => inWindow(date, now, 90)).length,
    emailClicks90d: clickDates.filter((date) => inWindow(date, now, 90)).length,
    campaignEngaged30d,
    flowEngaged30d,
    smsEngaged30d,
    membershipSummary: {
      status: "unavailable",
      listsKnown: 0,
      segmentsKnown: 0,
      caveat: "Local list/segment membership by customer is not available in the current schema.",
    },
    caveats,
  };
}

function eventMatches(event: CustomerEventRow, terms: string[]) {
  const type = event.eventType.toLowerCase();
  return terms.some((term) => type.includes(term));
}

function intentFeatures(
  customer: CustomerFeatureRow,
  now: Date,
  missingCapabilities: Set<string>,
) {
  const events = customer.events;
  const activeTerms = ["active", "site", "session", "view", "cart", "checkout"];
  const viewedTerms = ["viewed_product", "viewed product", "product_view", "product view", "browse"];
  const cartTerms = ["add_to_cart", "added to cart", "cart"];
  const checkoutTerms = ["checkout", "started_checkout", "started checkout"];
  const active = events.filter((event) => eventMatches(event, activeTerms));
  const viewed = events.filter((event) => eventMatches(event, viewedTerms));
  const carts = events.filter((event) => eventMatches(event, cartTerms));
  const checkouts = events.filter((event) => eventMatches(event, checkoutTerms));
  const lastOrderAt = customer.lastOrderDate ?? customer.orders[customer.orders.length - 1]?.createdAt ?? null;
  const recentCheckoutWithoutPurchase = checkouts.some((event) =>
    inWindow(event.createdAt, now, 30) && (!lastOrderAt || lastOrderAt < event.createdAt),
  );

  if (!events.length) {
    missingCapabilities.add("klaviyo.events.local_ingest");
    missingCapabilities.add("shopify.customer_events.local_intent_ingest");
  }

  return {
    status: events.length ? "partial" as CustomerFeatureStatus : "unavailable" as CustomerFeatureStatus,
    activeOnSite7d: active.some((event) => inWindow(event.createdAt, now, 7)),
    activeOnSite30d: active.some((event) => inWindow(event.createdAt, now, 30)),
    viewedProduct7d: viewed.some((event) => inWindow(event.createdAt, now, 7)),
    viewedProduct30d: viewed.some((event) => inWindow(event.createdAt, now, 30)),
    addedToCart7d: carts.some((event) => inWindow(event.createdAt, now, 7)),
    addedToCart30d: carts.some((event) => inWindow(event.createdAt, now, 30)),
    startedCheckout7d: checkouts.some((event) => inWindow(event.createdAt, now, 7)),
    startedCheckout30d: checkouts.some((event) => inWindow(event.createdAt, now, 30)),
    abandonedCheckoutSignal: recentCheckoutWithoutPurchase,
    checkoutStartedWithoutPurchase: recentCheckoutWithoutPurchase,
    productViewedRecently: viewed.some((event) => inWindow(event.createdAt, now, 30)),
    intentCaveats: cleanList([
      "Intent v0 only uses local CustomerEvent.eventType names and timestamps.",
      events.length
        ? "Intent events are directional because event payload properties are not exposed or required for v0."
        : "No local event-level intent rows are available; intent signals are unavailable.",
    ]),
  };
}

function lifecycleFeatures(input: {
  customer: CustomerFeatureRow;
  commerce: Record<string, unknown>;
  engagement: Record<string, unknown>;
  intent: Record<string, unknown>;
  cohort: Record<string, unknown>;
  now: Date;
}) {
  const totalOrders = Number(input.commerce.totalOrdersLifetime ?? 0);
  const totalRevenue = Number(input.commerce.totalRevenueLifetime ?? 0);
  const daysSinceLastOrder = typeof input.commerce.daysSinceLastOrder === "number"
    ? input.commerce.daysSinceLastOrder
    : null;
  const ltv = typeof input.commerce.ltvBand === "string" ? input.commerce.ltvBand : "none";
  const repeatStatus = repeatBuyerStatus(totalOrders);
  const replenishmentProduct = Array.isArray(input.cohort.topProductsByRevenue)
    ? input.cohort.topProductsByRevenue.find((item) =>
        item && typeof item === "object" && "avgReplenishmentDays" in item && Boolean(item.avgReplenishmentDays),
      ) as { avgReplenishmentDays?: number } | undefined
    : undefined;
  const replenishmentCandidate = Boolean(
    replenishmentProduct?.avgReplenishmentDays &&
    daysSinceLastOrder !== null &&
    daysSinceLastOrder >= Math.floor(replenishmentProduct.avgReplenishmentDays * 0.8),
  );
  const winbackCandidate = Boolean(totalOrders > 0 && daysSinceLastOrder !== null && daysSinceLastOrder >= 90);
  const dormant = Boolean(totalOrders > 0 && daysSinceLastOrder !== null && daysSinceLastOrder >= 180);
  const vipCandidate = Boolean(totalRevenue > 0 && (ltv === "vip" || ltv === "high"));
  const crossSellCandidate = totalOrders >= 1 && !replenishmentCandidate;
  const lifecycleStage =
    totalOrders <= 0 && (input.engagement.status === "partial" || input.intent.status === "partial")
      ? "no_purchase_profile"
      : totalOrders <= 0
        ? "prospect_unknown"
        : dormant
          ? "dormant_customer"
          : winbackCandidate
            ? "winback_candidate"
            : replenishmentCandidate
              ? "replenishment_candidate"
              : vipCandidate
                ? "vip_candidate"
                : totalOrders === 1
                  ? "first_time_buyer"
                  : totalOrders >= 2
                    ? "repeat_buyer"
                    : "unknown";
  const churnSignalReason = dormant
    ? "last_purchase_180_plus_days"
    : winbackCandidate
      ? "last_purchase_90_plus_days"
      : "no_churn_signal_from_feature_store_v0";

  return {
    status: totalOrders > 0 ? "available" as CustomerFeatureStatus : "partial" as CustomerFeatureStatus,
    lifecycleStage,
    repeatBuyerStatus: repeatStatus,
    vipCandidateSignal: vipCandidate,
    winbackCandidateSignal: winbackCandidate,
    replenishmentCandidateSignal: replenishmentCandidate,
    crossSellCandidateSignal: crossSellCandidate,
    churnSignalReason,
    lifecycleCaveats: [
      "Lifecycle fields are local rule signals, not predictive scores or final segment definitions.",
      "Rule-Based Customer Scoring, Segment Definition Builder, and Segment/Profile Sync are intentionally not implemented in this feature.",
    ],
  };
}

function label(value: unknown, source: string, confidence: string, caveats: string[]) {
  return {
    value,
    source,
    confidence,
    caveats,
    syncStatus: "not_synced",
    externalActionTaken: false,
  };
}

function derivedLabels(input: {
  commerce: Record<string, unknown>;
  cohort: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
}) {
  const commerceCaveats = Array.isArray(input.commerce.caveats) ? input.commerce.caveats.filter((item): item is string => typeof item === "string") : [];
  const cohortCaveats = Array.isArray(input.cohort.productEntryCohortCaveats)
    ? input.cohort.productEntryCohortCaveats.filter((item): item is string => typeof item === "string")
    : [];
  const lifecycleCaveats = Array.isArray(input.lifecycle.lifecycleCaveats)
    ? input.lifecycle.lifecycleCaveats.filter((item): item is string => typeof item === "string")
    : [];
  const firstProductConfidence = typeof input.cohort.firstProductCohortConfidence === "string"
    ? input.cohort.firstProductCohortConfidence
    : "low";

  return {
    worklin_ltv_band: label(input.commerce.ltvBand ?? "unknown", "customer_feature_store_v0.commerce", confidenceFor(input.commerce.status as CustomerFeatureStatus, commerceCaveats), commerceCaveats),
    worklin_order_count_band: label(input.commerce.orderCountBand ?? "unknown", "customer_feature_store_v0.commerce", confidenceFor(input.commerce.status as CustomerFeatureStatus, commerceCaveats), commerceCaveats),
    worklin_first_purchase_cohort: label(input.cohort.firstPurchaseCohort ?? "unknown", "customer_feature_store_v0.cohort", confidenceFor(input.cohort.status as CustomerFeatureStatus, cohortCaveats), cohortCaveats),
    worklin_first_product_cohort: label(input.cohort.firstProductCohort ?? "unknown_product_entry", "customer_feature_store_v0.cohort", firstProductConfidence, cohortCaveats),
    worklin_repeat_buyer_status: label(input.lifecycle.repeatBuyerStatus ?? "unknown", "customer_feature_store_v0.lifecycle", "medium", lifecycleCaveats),
    worklin_vip_candidate: label(Boolean(input.lifecycle.vipCandidateSignal), "customer_feature_store_v0.lifecycle", "medium", lifecycleCaveats),
    worklin_replenishment_candidate: label(Boolean(input.lifecycle.replenishmentCandidateSignal), "customer_feature_store_v0.lifecycle", "medium", lifecycleCaveats),
    worklin_high_aov_customer: label(Boolean(input.commerce.highAovCustomer), "customer_feature_store_v0.commerce", confidenceFor(input.commerce.status as CustomerFeatureStatus, commerceCaveats), commerceCaveats),
    worklin_churn_signal: label(input.lifecycle.churnSignalReason ?? "unknown", "customer_feature_store_v0.lifecycle", "medium", lifecycleCaveats),
  };
}

function featureStatus(sections: Array<{ status?: unknown }>) {
  const statuses = sections.map((section) => section.status);
  if (statuses.every((status) => status === "available")) return "available" as CustomerFeatureStatus;
  if (statuses.some((status) => status === "available" || status === "partial")) return "partial" as CustomerFeatureStatus;
  return "unavailable" as CustomerFeatureStatus;
}

function sourceCoverage(input: {
  customer: CustomerFeatureRow;
  identity: IdentityProfile;
  commerceStatus: CustomerFeatureStatus;
  engagementStatus: CustomerFeatureStatus;
  intentStatus: CustomerFeatureStatus;
  lifecycleStatus: CustomerFeatureStatus;
  integrationState: ShopifyFeatureFreshness;
  missingCapabilities: string[];
  caveats: string[];
}) {
  const sourceSystemsUsed = cleanList([
    ...input.identity.matchedSourceSystems,
    input.customer.orders.length ? "shopify_local_orders" : null,
    input.customer.orders.some((order) => order.items.length) ? "shopify_local_order_items" : null,
    input.customer.events.length ? "worklin_customer_events" : null,
    input.customer.campaignReceipts.length ? "worklin_campaign_receipts" : null,
  ]);
  const sourceSystemsMissing = cleanList([
    input.identity.sourceIds.klaviyoProfileIdKnown ? null : "klaviyo_profile_id_local_linkage",
    input.engagementStatus === "unavailable" ? "klaviyo_event_level_email_engagement" : null,
    input.intentStatus === "unavailable" ? "local_intent_events" : null,
  ]);

  return {
    sourceSystemsUsed,
    sourceSystemsMissing,
    dataFreshness: {
      shopifyLastSyncAt: iso(input.integrationState?.lastSyncAt),
      shopifyLastOrdersSyncAt: iso(input.integrationState?.shopifyLastOrdersSyncAt),
      shopifyLastProductsSyncAt: iso(input.integrationState?.shopifyLastProductsSyncAt),
      shopifyLastCustomersSyncAt: iso(input.integrationState?.shopifyLastCustomersSyncAt),
      shopifyLastSyncStatus: input.integrationState?.lastSyncStatus ?? null,
      latestLocalOrderAt: iso(input.customer.orders[input.customer.orders.length - 1]?.createdAt),
      latestLocalEventAt: iso(input.customer.events[0]?.createdAt),
      latestCampaignReceiptAt: iso(input.customer.campaignReceipts[0]?.sentAt),
    },
    identityConfidence: input.identity.confidence,
    commerceStatus: input.commerceStatus,
    engagementStatus: input.engagementStatus,
    intentStatus: input.intentStatus,
    lifecycleStatus: input.lifecycleStatus,
    counts: {
      localOrders: input.customer.orders.length,
      localOrderItems: input.customer.orders.reduce((sum, order) => sum + order.items.length, 0),
      localCustomerEvents: input.customer.events.length,
      localCampaignReceipts: input.customer.campaignReceipts.length,
    },
    missingCapabilities: input.missingCapabilities,
    caveats: input.caveats,
    rawContactFieldsReturned: false,
    rawPayloadsReturned: false,
  };
}

function sourceStatusesForOutput(input: {
  customerCount: number;
  persistedCount: number;
  missingCapabilities: string[];
}) {
  return [
    {
      source: "worklin_local_customer",
      status: input.customerCount ? "available" : "unavailable",
      rowsAnalyzed: input.customerCount,
      readOnly: true,
    },
    {
      source: "shopify_local_commerce",
      status: input.customerCount ? "available" : "partial",
      route: "local Customer/Order/OrderItem/Product tables",
      readOnly: true,
    },
    {
      source: "klaviyo_local_profile_linkage",
      status: "unavailable",
      missingCapability: "klaviyo.profile_id.local_linkage",
      readOnly: true,
    },
    {
      source: "klaviyo_local_event_engagement",
      status: input.missingCapabilities.includes("klaviyo.events.local_ingest") ? "partial" : "available",
      caveat: "Uses local Worklin events/receipts only; no live Klaviyo API read is performed.",
      readOnly: true,
    },
    {
      source: "customer_feature_store",
      status: input.persistedCount ? "available" : "partial",
      persistedCount: input.persistedCount,
      readOnlyExternally: true,
    },
  ];
}

function buildFeatureRecord(input: {
  customer: CustomerFeatureRow;
  identity: IdentityProfile;
  now: Date;
  timeframeDays: number;
  thresholds: AccountThresholds;
  integrationState: ShopifyFeatureFreshness;
}): CustomerFeatureSnapshot {
  const missing = new Set<string>();
  const commerce = commerceFeatures(input.customer, input.now, input.thresholds);
  const cohort = cohortFeatures(input.customer);
  const engagement = engagementFeatures(input.customer, input.now, missing);
  const intent = intentFeatures(input.customer, input.now, missing);
  const lifecycle = lifecycleFeatures({
    customer: input.customer,
    commerce,
    engagement,
    intent,
    cohort,
    now: input.now,
  });
  const labels = derivedLabels({ commerce, cohort, lifecycle });
  const missingCapabilities = Array.from(missing).sort();
  const caveats = cleanList([
    ...input.identity.confidenceCaveats,
    ...(commerce.caveats as string[]),
    ...(engagement.caveats as string[]),
    ...((intent.intentCaveats as string[]) ?? []),
    ...((lifecycle.lifecycleCaveats as string[]) ?? []),
    "Customer Feature Store v0 computes local facts/signals only; it does not create predictive scores or final segments.",
  ]);
  const status = featureStatus([commerce, cohort, engagement, intent, lifecycle]);
  const coverage = sourceCoverage({
    customer: input.customer,
    identity: input.identity,
    commerceStatus: commerce.status,
    engagementStatus: engagement.status,
    intentStatus: intent.status,
    lifecycleStatus: lifecycle.status,
    integrationState: input.integrationState,
    missingCapabilities,
    caveats,
  });
  const sourceSystems = {
    used: coverage.sourceSystemsUsed,
    missing: coverage.sourceSystemsMissing,
    readOnly: true,
    externalActionTaken: false,
  };
  const identityFeatures = {
    identityId: input.identity.identityId,
    worklinCustomerId: input.identity.sourceIds.worklinCustomerId,
    shopifyCustomerId: input.identity.sourceIds.shopifyCustomerExternalId,
    klaviyoProfileId: input.identity.sourceIds.klaviyoProfileId,
    klaviyoProfileIdKnown: input.identity.sourceIds.klaviyoProfileIdKnown,
    matchedSourceSystems: input.identity.matchedSourceSystems,
    identityConfidence: input.identity.confidence,
    identityReasons: input.identity.confidenceReasons,
    identityCaveats: input.identity.confidenceCaveats,
    rawContactFieldsReturned: false,
  };

  return {
    identityId: input.identity.identityId,
    worklinCustomerId: input.identity.sourceIds.worklinCustomerId,
    shopifyCustomerId: input.identity.sourceIds.shopifyCustomerExternalId,
    klaviyoProfileId: input.identity.sourceIds.klaviyoProfileId,
    klaviyoProfileIdKnown: input.identity.sourceIds.klaviyoProfileIdKnown,
    identityConfidence: input.identity.confidence,
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: input.timeframeDays,
    computedAt: input.now.toISOString(),
    status,
    identityFeatures,
    sourceSystems,
    sourceCoverage: coverage,
    commerceFeatures: commerce,
    engagementFeatures: engagement,
    intentFeatures: intent,
    lifecycleFeatures: lifecycle,
    cohortFeatures: cohort,
    derivedLabels: labels,
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/features/compute",
      featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      externalActionTaken: false,
      shopifyWritesAllowed: false,
      klaviyoWritesAllowed: false,
      scoringCreated: false,
      segmentDefinitionCreated: false,
      segmentProfileSyncPerformed: false,
    },
  };
}

async function persistFeature(feature: CustomerFeatureSnapshot) {
  return prisma.customerFeatureStore.upsert({
    where: {
      identityId_timeframeDays_featureVersion: {
        identityId: feature.identityId,
        timeframeDays: feature.timeframeDays,
        featureVersion: feature.featureVersion,
      },
    },
    create: {
      identityId: feature.identityId,
      worklinCustomerId: feature.worklinCustomerId,
      shopifyCustomerId: feature.shopifyCustomerId,
      klaviyoProfileId: feature.klaviyoProfileId,
      identityConfidence: feature.identityConfidence,
      featureVersion: feature.featureVersion,
      timeframeDays: feature.timeframeDays,
      computedAt: new Date(feature.computedAt),
      status: feature.status,
      sourceSystems: asJson(feature.sourceSystems),
      sourceCoverage: asJson(feature.sourceCoverage),
      commerceFeatures: asJson(feature.commerceFeatures),
      engagementFeatures: asJson(feature.engagementFeatures),
      intentFeatures: asJson(feature.intentFeatures),
      lifecycleFeatures: asJson(feature.lifecycleFeatures),
      cohortFeatures: asJson(feature.cohortFeatures),
      derivedLabels: asJson(feature.derivedLabels),
      missingCapabilities: asJson(feature.missingCapabilities),
      caveats: asJson(feature.caveats),
      metadata: asJson(feature.metadata),
    },
    update: {
      worklinCustomerId: feature.worklinCustomerId,
      shopifyCustomerId: feature.shopifyCustomerId,
      klaviyoProfileId: feature.klaviyoProfileId,
      identityConfidence: feature.identityConfidence,
      computedAt: new Date(feature.computedAt),
      status: feature.status,
      sourceSystems: asJson(feature.sourceSystems),
      sourceCoverage: asJson(feature.sourceCoverage),
      commerceFeatures: asJson(feature.commerceFeatures),
      engagementFeatures: asJson(feature.engagementFeatures),
      intentFeatures: asJson(feature.intentFeatures),
      lifecycleFeatures: asJson(feature.lifecycleFeatures),
      cohortFeatures: asJson(feature.cohortFeatures),
      derivedLabels: asJson(feature.derivedLabels),
      missingCapabilities: asJson(feature.missingCapabilities),
      caveats: asJson(feature.caveats),
      metadata: asJson(feature.metadata),
    },
  });
}

function compactFeature(feature: CustomerFeatureSnapshot) {
  return {
    identityId: feature.identityId,
    worklinCustomerId: feature.worklinCustomerId,
    shopifyCustomerId: feature.shopifyCustomerId,
    klaviyoProfileId: feature.klaviyoProfileId,
    klaviyoProfileIdKnown: feature.klaviyoProfileIdKnown,
    identityConfidence: feature.identityConfidence,
    featureVersion: feature.featureVersion,
    timeframeDays: feature.timeframeDays,
    computedAt: feature.computedAt,
    status: feature.status,
    identityFeatures: feature.identityFeatures,
    sourceSystems: feature.sourceSystems,
    sourceCoverage: feature.sourceCoverage,
    commerceFeatures: feature.commerceFeatures,
    engagementFeatures: feature.engagementFeatures,
    intentFeatures: feature.intentFeatures,
    lifecycleFeatures: feature.lifecycleFeatures,
    cohortFeatures: feature.cohortFeatures,
    derivedLabels: feature.derivedLabels,
    missingCapabilities: feature.missingCapabilities,
    caveats: feature.caveats,
    metadata: feature.metadata,
    ...(feature.persistedRecordId ? { persistedRecordId: feature.persistedRecordId } : {}),
  };
}

function compactStoredRecord(record: Awaited<ReturnType<typeof prisma.customerFeatureStore.findMany>>[number]) {
  return {
    id: record.id,
    identityId: record.identityId,
    worklinCustomerId: record.worklinCustomerId,
    shopifyCustomerId: record.shopifyCustomerId,
    klaviyoProfileId: record.klaviyoProfileId,
    identityConfidence: record.identityConfidence,
    featureVersion: record.featureVersion,
    timeframeDays: record.timeframeDays,
    computedAt: record.computedAt.toISOString(),
    status: record.status,
    sourceSystems: record.sourceSystems,
    sourceCoverage: record.sourceCoverage,
    commerceFeatures: record.commerceFeatures,
    engagementFeatures: record.engagementFeatures,
    intentFeatures: record.intentFeatures,
    lifecycleFeatures: record.lifecycleFeatures,
    cohortFeatures: record.cohortFeatures,
    derivedLabels: record.derivedLabels,
    missingCapabilities: record.missingCapabilities,
    caveats: record.caveats,
    metadata: {
      featureVersion: record.featureVersion,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function computeCustomerFeatureStore(input: CustomerFeatureComputeInput = {}) {
  const parsed = parseCustomerFeatureComputeInput(input);
  if (!parsed.ok) return parsed;

  const now = new Date();
  const seedRecord = parsed.data.identityId
    ? await prisma.customerFeatureStore.findFirst({
        where: { identityId: parsed.data.identityId },
        select: { worklinCustomerId: true },
        orderBy: { computedAt: "desc" },
      })
    : null;
  const identityResult = await buildUnifiedCustomerIdentity({
    customerId: seedRecord?.worklinCustomerId ?? null,
    depth: UNIFIED_CUSTOMER_IDENTITY_DEPTHS[0],
    limit: parsed.data.identityId ? MAX_COMPUTE_LIMIT : parsed.data.limit,
    includeProfiles: true,
    includeMergeCandidates: false,
  });

  if (!identityResult.ok) {
    return { ok: false as const, issues: identityResult.issues };
  }

  const identityProfiles = identityResult.profiles
    .filter(isIdentityProfile)
    .filter((profile) => !parsed.data.identityId || profile.identityId === parsed.data.identityId)
    .slice(0, parsed.data.limit);

  if (parsed.data.identityId && !identityProfiles.length) {
    return {
      ok: false as const,
      reason: "customer_feature_identity_not_found",
      issues: ["identityId was not found in local unified identity records."],
      status: 404,
    };
  }

  const customerIds = identityProfiles.map((profile) => profile.sourceIds.worklinCustomerId);
  const [customers, thresholds, integrationState] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: CUSTOMER_FEATURE_SELECT,
    }),
    accountThresholds(),
    prisma.integrationState.findUnique({
      where: { provider: "shopify" },
      select: {
        lastSyncAt: true,
        lastSyncStatus: true,
        shopifyLastOrdersSyncAt: true,
        shopifyLastProductsSyncAt: true,
        shopifyLastCustomersSyncAt: true,
      },
    }),
  ]);
  const customersById = new Map(customers.map((customer) => [customer.id, customer]));
  const features = identityProfiles
    .map((identity) => {
      const customer = customersById.get(identity.sourceIds.worklinCustomerId);
      return customer
        ? buildFeatureRecord({
            customer,
            identity,
            now,
            timeframeDays: parsed.data.timeframeDays,
            thresholds,
            integrationState,
          })
        : null;
    })
    .filter((feature): feature is CustomerFeatureSnapshot => Boolean(feature));

  const persisted = parsed.data.persist
    ? await Promise.all(features.map(persistFeature))
    : [];
  const persistedByIdentity = new Map(persisted.map((record) => [record.identityId, record]));
  const outputFeatures = features.map((feature) => {
    const persistedRecord = persistedByIdentity.get(feature.identityId);
    return compactFeature({
      ...feature,
      ...(persistedRecord ? { persistedRecordId: persistedRecord.id } : {}),
    });
  });
  const missingCapabilities = cleanList(features.flatMap((feature) => feature.missingCapabilities));
  const caveats = cleanList([
    ...features.flatMap((feature) => feature.caveats),
    features.length ? null : "No local customer identities were available to compute feature records.",
  ]);

  return {
    ok: true as const,
    readOnlyExternally: true,
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    timeframeDays: parsed.data.timeframeDays,
    computedAt: now.toISOString(),
    persisted: parsed.data.persist,
    summary: {
      identitiesRequested: parsed.data.identityId ? 1 : parsed.data.limit,
      identitiesMatched: identityProfiles.length,
      featuresComputed: features.length,
      featuresPersisted: persisted.length,
      statusCounts: countBy(features.map((feature) => feature.status)),
    },
    features: outputFeatures,
    sourceStatuses: sourceStatusesForOutput({
      customerCount: customers.length,
      persistedCount: persisted.length,
      missingCapabilities,
    }),
    missingCapabilities,
    caveats,
    metadata: {
      route: "POST /api/customers/features/compute",
      featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
      limit: parsed.data.limit,
      identityIdProvided: Boolean(parsed.data.identityId),
      persist: parsed.data.persist,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
      shopifyWritesAllowed: false,
      klaviyoWritesAllowed: false,
      scoringCreated: false,
      segmentDefinitionCreated: false,
      segmentProfileSyncPerformed: false,
    },
  };
}

export async function listCustomerFeatureStore(input: CustomerFeatureListInput = {}) {
  const parsed = parseCustomerFeatureListInput(input);
  if (!parsed.ok) return parsed;

  const where: Prisma.CustomerFeatureStoreWhereInput = {
    ...(parsed.data.identityId ? { identityId: parsed.data.identityId } : {}),
    ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
  };
  const [total, records] = await Promise.all([
    prisma.customerFeatureStore.count({ where }),
    prisma.customerFeatureStore.findMany({
      where,
      orderBy: { computedAt: "desc" },
      take: parsed.data.limit,
    }),
  ]);

  return {
    ok: true as const,
    readOnly: true,
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    summary: {
      totalMatchingRecords: total,
      returnedRecords: records.length,
      statusCounts: countBy(records.map((record) => record.status)),
    },
    features: records.map(compactStoredRecord),
    metadata: {
      route: "GET /api/customers/features",
      limit: parsed.data.limit,
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function getCustomerFeatureStoreRecord(identityId: string, input: Omit<CustomerFeatureListInput, "identityId"> = {}) {
  const parsed = parseCustomerFeatureListInput({ ...input, identityId, limit: 1 });
  if (!parsed.ok) return parsed;

  const record = await prisma.customerFeatureStore.findFirst({
    where: {
      identityId,
      ...(parsed.data.timeframeDays ? { timeframeDays: parsed.data.timeframeDays } : {}),
      featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    },
    orderBy: { computedAt: "desc" },
  });

  if (!record) {
    return {
      ok: false as const,
      reason: "customer_feature_record_not_found",
      issues: ["No persisted customer feature record was found for this identityId."],
      status: 404,
    };
  }

  return {
    ok: true as const,
    readOnly: true,
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    feature: compactStoredRecord(record),
    metadata: {
      route: "GET /api/customers/features/[identityId]",
      externalActionTaken: false,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}

export async function customerFeatureStoreContextSummary() {
  const [total, latest, byStatus] = await Promise.all([
    prisma.customerFeatureStore.count({
      where: { featureVersion: CUSTOMER_FEATURE_STORE_VERSION },
    }),
    prisma.customerFeatureStore.findFirst({
      where: { featureVersion: CUSTOMER_FEATURE_STORE_VERSION },
      orderBy: { computedAt: "desc" },
      select: {
        computedAt: true,
        timeframeDays: true,
        status: true,
        missingCapabilities: true,
        caveats: true,
      },
    }),
    prisma.customerFeatureStore.groupBy({
      by: ["status"],
      where: { featureVersion: CUSTOMER_FEATURE_STORE_VERSION },
      _count: { status: true },
    }),
  ]);

  return {
    available: total > 0,
    status: !total ? "unavailable" : latest?.status ?? "partial",
    route: "/api/customers/features",
    computeRoute: "/api/customers/features/compute",
    featureVersion: CUSTOMER_FEATURE_STORE_VERSION,
    totalRecords: total,
    latestComputedAt: latest?.computedAt.toISOString() ?? null,
    latestTimeframeDays: latest?.timeframeDays ?? null,
    countsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count.status])),
    missingCapabilities: Array.isArray(latest?.missingCapabilities)
      ? latest.missingCapabilities.slice(0, 8)
      : [],
    caveats: Array.isArray(latest?.caveats)
      ? latest.caveats.slice(0, 4)
      : total
        ? []
        : ["Customer Feature Store has not been computed yet."],
    externalActionTaken: false,
    rawContactFieldsReturned: false,
  };
}
