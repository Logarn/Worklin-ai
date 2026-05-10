import type { SourceConnector } from "@/lib/sources/connectors";
import {
  listSourceConnectors,
  sourceStatusForArtifactSource,
  summarizeConnectorForContext,
} from "@/lib/sources/connectors";
import { prisma } from "@/lib/prisma";

export const SHOPIFY_SOURCE_SNAPSHOT_DEPTHS = ["compact", "standard", "full"] as const;
export const SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES = [30, 60, 90] as const;

export type ShopifySourceSnapshotDepth = (typeof SHOPIFY_SOURCE_SNAPSHOT_DEPTHS)[number];
export type ShopifySourceSnapshotTimeframeDays = (typeof SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES)[number];

export type ShopifySourceSnapshotInput = {
  depth?: ShopifySourceSnapshotDepth | string | null;
  timeframeDays?: ShopifySourceSnapshotTimeframeDays | string | number | null;
  includeCohorts?: boolean | string | null;
};

type ParsedShopifySourceSnapshotInput =
  | {
      ok: true;
      data: {
        depth: ShopifySourceSnapshotDepth;
        timeframeDays: ShopifySourceSnapshotTimeframeDays;
        includeCohorts: boolean;
      };
    }
  | { ok: false; issues: string[] };

type SnapshotSectionStatus =
  | "available"
  | "partial"
  | "directional"
  | "insufficient_data"
  | "unavailable"
  | "local_only"
  | "not_requested";

const MIN_USEFUL_COHORT_SIZE = 10;

type SafeOrderItem = {
  quantity: number;
  price: number;
  product: {
    id: string;
    externalId: string | null;
    name: string;
    category: string | null;
    price: number;
    avgReplenishmentDays: number | null;
  };
};

type SafeOrder = {
  id: string;
  customerId: string;
  totalAmount: number;
  status: string;
  createdAt: Date;
  items: SafeOrderItem[];
};

type SafeCustomer = {
  id: string;
  createdAt: Date;
  totalOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  lastOrderDate: Date | null;
  firstOrderDate: Date | null;
  recencyScore: number | null;
  frequencyScore: number | null;
  monetaryScore: number | null;
  segment: string | null;
  churnRiskScore: number | null;
  orders: SafeOrder[];
};

type ProductMetric = {
  productId: string;
  externalId: string | null;
  name: string;
  category: string | null;
  price: number;
  avgReplenishmentDays: number | null;
  revenue: number;
  orders: Set<string>;
  customers: Set<string>;
  unitsSold: number;
  purchaseDatesByCustomer: Map<string, Date[]>;
};

const DEPTH_LIMITS = {
  compact: {
    sample: 3,
    cohortLimit: 3,
    productLimit: 3,
  },
  standard: {
    sample: 5,
    cohortLimit: 5,
    productLimit: 5,
  },
  full: {
    sample: 8,
    cohortLimit: 8,
    productLimit: 8,
  },
} as const;

function normalizeDepth(value: unknown): ShopifySourceSnapshotDepth | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return SHOPIFY_SOURCE_SNAPSHOT_DEPTHS.includes(normalized as ShopifySourceSnapshotDepth)
    ? (normalized as ShopifySourceSnapshotDepth)
    : null;
}

function normalizeTimeframeDays(value: unknown): ShopifySourceSnapshotTimeframeDays | null {
  if (typeof value === "number" && SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES.includes(value as ShopifySourceSnapshotTimeframeDays)) {
    return value as ShopifySourceSnapshotTimeframeDays;
  }
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES.includes(parsed as ShopifySourceSnapshotTimeframeDays)
    ? (parsed as ShopifySourceSnapshotTimeframeDays)
    : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

export function parseShopifySourceSnapshotInput(input: ShopifySourceSnapshotInput = {}): ParsedShopifySourceSnapshotInput {
  const issues: string[] = [];
  const depth = input.depth == null ? "compact" : normalizeDepth(input.depth);
  const timeframeDays = input.timeframeDays == null ? 60 : normalizeTimeframeDays(input.timeframeDays);
  const includeCohorts = input.includeCohorts == null ? true : normalizeBoolean(input.includeCohorts);

  if (!depth) issues.push("depth must be one of compact, standard, or full.");
  if (!timeframeDays) issues.push("timeframeDays must be one of 30, 60, or 90.");
  if (includeCohorts === null) issues.push("includeCohorts must be true or false.");

  return issues.length
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          depth: depth ?? "compact",
          timeframeDays: timeframeDays ?? 60,
          includeCohorts: includeCohorts ?? true,
        },
      };
}

function money(value: number | null | undefined) {
  return Number((value ?? 0).toFixed(2));
}

function rate(value: number | null | undefined) {
  return value == null ? null : Number(value.toFixed(4));
}

function compactText(value: string | null | undefined, max = 160) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function cleanCaveats(caveats: Array<string | null | undefined>) {
  return Array.from(new Set(caveats.filter((item): item is string => Boolean(item?.trim()))))
    .map((item) => compactText(item, 240))
    .filter((item): item is string => Boolean(item));
}

function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? money((sorted[mid - 1] + sorted[mid]) / 2) : money(sorted[mid]);
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

function countBy(values: Array<string | null | undefined>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value?.trim() || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function orderCountBands(customers: SafeCustomer[]) {
  return {
    zero: customers.filter((customer) => customer.totalOrders <= 0).length,
    one: customers.filter((customer) => customer.totalOrders === 1).length,
    two: customers.filter((customer) => customer.totalOrders === 2).length,
    threeToFour: customers.filter((customer) => customer.totalOrders >= 3 && customer.totalOrders <= 4).length,
    fivePlus: customers.filter((customer) => customer.totalOrders >= 5).length,
  };
}

function valueBands(customers: SafeCustomer[]) {
  const values = customers.map((customer) => customer.totalSpent).filter((value) => value > 0);
  const p50 = percentile(values, 0.5);
  const p75 = percentile(values, 0.75);
  const p90 = percentile(values, 0.9);

  return {
    thresholds: {
      mid: money(p50),
      high: money(p75),
      vip: money(p90),
    },
    counts: {
      zero: customers.filter((customer) => customer.totalSpent <= 0).length,
      low: customers.filter((customer) => customer.totalSpent > 0 && customer.totalSpent <= p50).length,
      mid: customers.filter((customer) => customer.totalSpent > p50 && customer.totalSpent <= p75).length,
      high: customers.filter((customer) => customer.totalSpent > p75 && customer.totalSpent <= p90).length,
      vip: customers.filter((customer) => customer.totalSpent > p90).length,
    },
  };
}

function sortedOrders(customer: SafeCustomer) {
  return [...customer.orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

function primaryEntry(order: SafeOrder) {
  const items = [...order.items];
  if (!items.length) {
    return {
      item: null,
      entryType: "unknown_product_entry",
      selectionMethod: "no_line_items",
    };
  }

  const revenueValues = items.map((item) => item.quantity * item.price);
  const maxRevenue = Math.max(...revenueValues);
  const revenueTies = items.filter((item) => item.quantity * item.price === maxRevenue);

  if (maxRevenue > 0 && revenueTies.length === 1) {
    return {
      item: revenueTies[0],
      entryType: "single_product_entry",
      selectionMethod: "highest_line_revenue",
    };
  }

  if (maxRevenue > 0 && revenueTies.length > 1) {
    return {
      item: revenueTies[0],
      entryType: "multi_product_entry",
      selectionMethod: "line_revenue_tie",
    };
  }

  const maxQuantity = Math.max(...items.map((item) => item.quantity));
  const quantityTies = items.filter((item) => item.quantity === maxQuantity);
  if (maxQuantity > 0 && quantityTies.length === 1) {
    return {
      item: quantityTies[0],
      entryType: "single_product_entry",
      selectionMethod: "highest_quantity",
    };
  }

  if (maxQuantity > 0 && quantityTies.length > 1) {
    return {
      item: quantityTies[0],
      entryType: "multi_product_entry",
      selectionMethod: "quantity_tie",
    };
  }

  return {
    item: items[0],
    entryType: "unknown_product_entry",
    selectionMethod: "first_line_item_fallback",
  };
}

function dataCoverage(input: Awaited<ReturnType<typeof loadLocalSnapshotData>>) {
  const ordersWithItems = input.allOrders.filter((order) => order.items.length > 0).length;
  const observedProductIds = new Set(
    input.allOrders.flatMap((order) => order.items.map((item) => item.product.id)),
  );

  return {
    customersAnalyzed: input.customers.length,
    ordersAnalyzed: input.allOrders.length,
    timeframeOrdersAnalyzed: input.timeframeOrders.length,
    orderItemsAnalyzed: input.orderItemCount,
    timeframeOrderItemsAnalyzed: input.timeframeOrderItemCount,
    productsAnalyzed: input.productCount,
    productsObservedInOrders: observedProductIds.size,
    customersWithFirstOrderDate: input.customers.filter((customer) => Boolean(customer.firstOrderDate)).length,
    customersWithTotalSpent: input.customers.filter((customer) => customer.totalSpent > 0).length,
    ordersWithItems,
  };
}

function compactProduct(metric: ProductMetric) {
  const orderCount = metric.orders.size;
  const customerCount = metric.customers.size;
  const repeatCustomers = Array.from(metric.purchaseDatesByCustomer.values()).filter((dates) => dates.length >= 2).length;
  const reorderGaps = Array.from(metric.purchaseDatesByCustomer.values()).flatMap((dates) => {
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    return sorted.slice(1).map((date, index) => daysBetween(sorted[index], date));
  });

  return {
    productId: metric.productId,
    externalId: metric.externalId,
    name: compactText(metric.name, 140),
    category: compactText(metric.category, 80),
    price: money(metric.price),
    revenue: money(metric.revenue),
    orders: orderCount,
    unitsSold: metric.unitsSold,
    customers: customerCount,
    aov: orderCount ? money(metric.revenue / orderCount) : 0,
    repeatBuyerRate: customerCount ? rate(repeatCustomers / customerCount) : 0,
    avgReplenishmentDays: metric.avgReplenishmentDays,
    observedMedianReorderDays: median(reorderGaps),
  };
}

async function loadLocalSnapshotData(input: { timeframeStart: Date; timeframeEnd: Date }) {
  const [customers, productCount, integrationState] = await Promise.all([
    prisma.customer.findMany({
      select: {
        id: true,
        createdAt: true,
        totalOrders: true,
        totalSpent: true,
        avgOrderValue: true,
        lastOrderDate: true,
        firstOrderDate: true,
        recencyScore: true,
        frequencyScore: true,
        monetaryScore: true,
        segment: true,
        churnRiskScore: true,
        orders: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            customerId: true,
            totalAmount: true,
            status: true,
            createdAt: true,
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
      },
    }),
    prisma.product.count(),
    prisma.integrationState.findUnique({
      where: { provider: "shopify" },
      select: {
        connected: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        syncInProgress: true,
        shopifyLastOrdersSyncAt: true,
        shopifyLastProductsSyncAt: true,
        shopifyLastCustomersSyncAt: true,
        shopifyLastRunId: true,
      },
    }),
  ]);

  const safeCustomers = customers as SafeCustomer[];
  const allOrders = safeCustomers.flatMap((customer) => customer.orders);
  const timeframeOrders = allOrders.filter((order) =>
    order.createdAt >= input.timeframeStart && order.createdAt <= input.timeframeEnd,
  );
  const orderItemCount = allOrders.reduce((sum, order) => sum + order.items.length, 0);
  const timeframeOrderItemCount = timeframeOrders.reduce((sum, order) => sum + order.items.length, 0);

  return {
    customers: safeCustomers,
    allOrders,
    timeframeOrders,
    orderItemCount,
    timeframeOrderItemCount,
    productCount,
    integrationState,
  };
}

function commerceSummary(input: {
  customers: SafeCustomer[];
  timeframeOrders: SafeOrder[];
  timeframeStart: Date;
  timeframeEnd: Date;
  timeframeDays: ShopifySourceSnapshotTimeframeDays;
  integrationState: Awaited<ReturnType<typeof loadLocalSnapshotData>>["integrationState"];
}) {
  const caveats = ["Net revenue, returns, refunds, taxes, shipping, and discounts are not available in the current local schema."];
  const customerIds = new Set(input.timeframeOrders.map((order) => order.customerId));
  const totalRevenue = input.timeframeOrders.reduce((sum, order) => sum + order.totalAmount, 0);
  const repeatCustomers = input.customers.filter((customer) => customer.totalOrders >= 2).length;
  const purchasingCustomers = input.customers.filter((customer) => customer.totalOrders > 0).length;
  const newCustomers = input.customers.filter((customer) => {
    const firstOrderDate = customer.firstOrderDate;
    return Boolean(firstOrderDate && firstOrderDate >= input.timeframeStart && firstOrderDate <= input.timeframeEnd);
  }).length;
  const returningCustomers = Array.from(customerIds).filter((customerId) => {
    const customer = input.customers.find((item) => item.id === customerId);
    return Boolean(customer?.firstOrderDate && customer.firstOrderDate < input.timeframeStart);
  }).length;

  if (!input.integrationState?.lastSyncAt) {
    caveats.push("Shopify sync freshness is unknown; snapshot uses current local database rows only.");
  }

  return {
    status: input.timeframeOrders.length ? "available" as SnapshotSectionStatus : "partial" as SnapshotSectionStatus,
    label: "timeframeCommerceSummary",
    metricScope: "timeframe",
    timeframe: {
      days: input.timeframeDays,
      start: input.timeframeStart.toISOString(),
      end: input.timeframeEnd.toISOString(),
    },
    totalRevenue: money(totalRevenue),
    revenueDefinition: "Sum of Order.totalAmount for local orders created inside the requested timeframe.",
    netRevenue: null,
    orderCount: input.timeframeOrders.length,
    customerCount: customerIds.size,
    localCustomerCount: input.customers.length,
    aov: input.timeframeOrders.length ? money(totalRevenue / input.timeframeOrders.length) : 0,
    repeatPurchaseRate: purchasingCustomers ? rate(repeatCustomers / purchasingCustomers) : 0,
    repeatPurchaseRateDefinition: "Lifetime repeat buyers divided by lifetime customers with at least one local order.",
    newVsReturningCustomers: {
      new: newCustomers,
      returning: returningCustomers,
      unknown: Math.max(0, customerIds.size - newCustomers - returningCustomers),
    },
    dataFreshness: {
      lastSyncAt: input.integrationState?.lastSyncAt?.toISOString() ?? null,
      lastOrdersSyncAt: input.integrationState?.shopifyLastOrdersSyncAt?.toISOString() ?? null,
      lastProductsSyncAt: input.integrationState?.shopifyLastProductsSyncAt?.toISOString() ?? null,
      lastCustomersSyncAt: input.integrationState?.shopifyLastCustomersSyncAt?.toISOString() ?? null,
      lastSyncStatus: input.integrationState?.lastSyncStatus ?? null,
      syncInProgress: input.integrationState?.syncInProgress ?? false,
      lastRunId: input.integrationState?.shopifyLastRunId ?? null,
    },
    caveats: cleanCaveats(caveats),
  };
}

function customerValue(input: { customers: SafeCustomer[] }) {
  const customersWithOrders = input.customers.filter((customer) => customer.totalOrders > 0);
  const totalSpentValues = customersWithOrders.map((customer) => customer.totalSpent);
  const avgOrderValues = customersWithOrders.map((customer) => customer.avgOrderValue).filter((value) => value > 0);
  const p75Aov = percentile(avgOrderValues, 0.75);
  const p90Spent = percentile(totalSpentValues, 0.9);
  const vipCandidates = input.customers.filter((customer) =>
    customer.totalSpent >= p90Spent || (customer.monetaryScore ?? 0) >= 4,
  ).length;
  const highAovCustomers = input.customers.filter((customer) => customer.avgOrderValue >= p75Aov && customer.avgOrderValue > 0).length;
  const churnRiskCustomers = input.customers.filter((customer) => (customer.churnRiskScore ?? 0) >= 60).length;

  return {
    status: input.customers.length ? "available" as SnapshotSectionStatus : "unavailable" as SnapshotSectionStatus,
    label: "lifetimeCustomerValue",
    metricScope: "lifetime",
    customersWithOrders: customersWithOrders.length,
    averageAmountSpent: customersWithOrders.length
      ? money(customersWithOrders.reduce((sum, customer) => sum + customer.totalSpent, 0) / customersWithOrders.length)
      : 0,
    averageAmountSpentDefinition: "Average Customer.totalSpent across local customers with at least one order.",
    oneTimeBuyerCount: input.customers.filter((customer) => customer.totalOrders === 1).length,
    repeatBuyerCount: input.customers.filter((customer) => customer.totalOrders >= 2).length,
    valueBands: valueBands(input.customers),
    orderCountBands: orderCountBands(input.customers),
    signals: {
      vipCandidateCount: vipCandidates,
      highAovCustomerCount: highAovCustomers,
      churnRiskCustomerCount: churnRiskCustomers,
      p75Aov: money(p75Aov),
      p90AmountSpent: money(p90Spent),
    },
    caveats: input.customers.length
      ? []
      : ["No local customer rows were available for customer value analysis."],
  };
}

function acquisitionCohorts(input: {
  customers: SafeCustomer[];
  timeframeStart: Date;
  limits: (typeof DEPTH_LIMITS)[ShopifySourceSnapshotDepth];
  includeCohorts: boolean;
}) {
  if (!input.includeCohorts) {
    return {
      status: "not_requested" as SnapshotSectionStatus,
      count: 0,
      minimumUsefulCohortSize: MIN_USEFUL_COHORT_SIZE,
      metricDefinitions: {},
      cohorts: [],
      caveats: ["Cohort summaries were skipped because includeCohorts=false."],
    };
  }

  const buckets = new Map<string, {
    cohort: string;
    customers: SafeCustomer[];
    revenue: number;
    orders: number;
    secondPurchaseDays: number[];
  }>();

  for (const customer of input.customers) {
    const firstOrderDate = customer.firstOrderDate ?? sortedOrders(customer)[0]?.createdAt ?? null;
    if (!firstOrderDate || firstOrderDate < input.timeframeStart) continue;
    const key = monthKey(firstOrderDate);
    const bucket = buckets.get(key) ?? { cohort: key, customers: [], revenue: 0, orders: 0, secondPurchaseDays: [] };
    const orders = sortedOrders(customer);
    bucket.customers.push(customer);
    bucket.revenue += customer.totalSpent;
    bucket.orders += customer.totalOrders;
    if (orders.length >= 2) {
      bucket.secondPurchaseDays.push(daysBetween(orders[0].createdAt, orders[1].createdAt));
    }
    buckets.set(key, bucket);
  }

  const cohorts = Array.from(buckets.values())
    .sort((a, b) => b.cohort.localeCompare(a.cohort))
    .slice(0, input.limits.cohortLimit)
    .map((bucket) => {
      const repeatBuyers = bucket.customers.filter((customer) => customer.totalOrders >= 2).length;
      const confidence = bucket.customers.length >= MIN_USEFUL_COHORT_SIZE ? "usable" : "directional";
      return {
        cohort: bucket.cohort,
        cohortSize: bucket.customers.length,
        denominatorCustomers: bucket.customers.length,
        lifetimeRevenue: money(bucket.revenue),
        lifetimeOrderCount: bucket.orders,
        lifetimeAov: bucket.orders ? money(bucket.revenue / bucket.orders) : 0,
        repeatBuyerCount: repeatBuyers,
        repeatRate: bucket.customers.length ? rate(repeatBuyers / bucket.customers.length) : 0,
        amountSpentPerCustomer: bucket.customers.length ? money(bucket.revenue / bucket.customers.length) : 0,
        timeToSecondPurchaseMedianDays: median(bucket.secondPurchaseDays),
        confidence,
      };
    });

  const allDirectional = cohorts.length > 0 && cohorts.every((cohort) => cohort.confidence === "directional");
  return {
    status: cohorts.length
      ? allDirectional ? "directional" as SnapshotSectionStatus : "available" as SnapshotSectionStatus
      : "insufficient_data" as SnapshotSectionStatus,
    count: buckets.size,
    minimumUsefulCohortSize: MIN_USEFUL_COHORT_SIZE,
    metricDefinitions: {
      cohortSize: "Customers whose firstOrderDate is in the cohort month.",
      lifetimeRevenue: "Sum of Customer.totalSpent for customers in the cohort.",
      lifetimeAov: "Lifetime cohort revenue divided by lifetime order count for customers in the cohort.",
      repeatRate: "Customers in cohort with totalOrders > 1 divided by cohort size.",
      amountSpentPerCustomer: "Lifetime cohort revenue divided by cohort size.",
      timeToSecondPurchaseMedianDays: "Median days between first and second local order for customers with at least two orders.",
    },
    cohorts,
    caveats: cleanCaveats([
      cohorts.length ? null : "No first-purchase cohorts were found inside the requested local timeframe.",
      allDirectional ? `All returned cohorts are smaller than ${MIN_USEFUL_COHORT_SIZE} customers; treat cohort reads as directional.` : null,
    ]),
  };
}

function productEntryCohorts(input: {
  customers: SafeCustomer[];
  timeframeStart: Date;
  limits: (typeof DEPTH_LIMITS)[ShopifySourceSnapshotDepth];
  includeCohorts: boolean;
}) {
  if (!input.includeCohorts) {
    return {
      status: "not_requested" as SnapshotSectionStatus,
      count: 0,
      minimumUsefulCohortSize: MIN_USEFUL_COHORT_SIZE,
      metricDefinitions: {},
      cohorts: [],
      caveats: ["Product-entry cohorts were skipped because includeCohorts=false."],
    };
  }

  const buckets = new Map<string, {
    productId: string;
    externalId: string | null;
    name: string;
    category: string | null;
    entryType: string;
    customers: number;
    lifetimeRevenue: number;
    initialRevenue: number;
    lifetimeOrders: number;
    repeatBuyers: number;
    entryTypes: Record<string, number>;
    selectionMethods: Record<string, number>;
  }>();

  for (const customer of input.customers) {
    const orders = sortedOrders(customer);
    const firstOrder = orders[0];
    if (!firstOrder || firstOrder.createdAt < input.timeframeStart) continue;
    const entry = primaryEntry(firstOrder);
    const product = entry.item?.product ?? null;
    const bucketId = entry.entryType === "multi_product_entry"
      ? "multi_product_entry"
      : product?.id ?? "unknown_product_entry";
    const current = buckets.get(bucketId) ?? {
      productId: bucketId,
      externalId: entry.entryType === "multi_product_entry" ? null : product?.externalId ?? null,
      name: entry.entryType === "multi_product_entry"
        ? "Multi-product entry"
        : product?.name ?? "Unknown product entry",
      category: entry.entryType === "multi_product_entry" ? null : product?.category ?? null,
      entryType: entry.entryType,
      customers: 0,
      lifetimeRevenue: 0,
      initialRevenue: 0,
      lifetimeOrders: 0,
      repeatBuyers: 0,
      entryTypes: {},
      selectionMethods: {},
    };
    current.customers += 1;
    current.lifetimeRevenue += customer.totalSpent;
    current.initialRevenue += firstOrder.totalAmount;
    current.lifetimeOrders += customer.totalOrders;
    if (customer.totalOrders >= 2) current.repeatBuyers += 1;
    current.entryTypes[entry.entryType] = (current.entryTypes[entry.entryType] ?? 0) + 1;
    current.selectionMethods[entry.selectionMethod] = (current.selectionMethods[entry.selectionMethod] ?? 0) + 1;
    buckets.set(bucketId, current);
  }

  const cohorts = Array.from(buckets.values())
    .sort((a, b) => b.customers - a.customers || b.lifetimeRevenue - a.lifetimeRevenue)
    .slice(0, input.limits.cohortLimit)
    .map((bucket) => {
      const confidence = bucket.customers >= MIN_USEFUL_COHORT_SIZE ? "usable" : "directional";
      const repeatRate = bucket.customers ? bucket.repeatBuyers / bucket.customers : 0;
      return {
        productId: bucket.productId,
        externalId: bucket.externalId,
        firstProduct: compactText(bucket.name, 140),
        category: compactText(bucket.category, 80),
        entryType: bucket.entryType,
        cohortSize: bucket.customers,
        denominatorCustomers: bucket.customers,
        lifetimeRevenue: money(bucket.lifetimeRevenue),
        initialRevenue: money(bucket.initialRevenue),
        lifetimeOrderCount: bucket.lifetimeOrders,
        repeatBuyerCount: bucket.repeatBuyers,
        repeatBuyerRate: rate(repeatRate),
        aov: bucket.lifetimeOrders ? money(bucket.lifetimeRevenue / bucket.lifetimeOrders) : 0,
        confidence,
        selectionMethods: bucket.selectionMethods,
        secondPurchaseOpportunity: confidence === "directional"
          ? "directional_insufficient_data"
          : repeatRate < 0.2
            ? "needs_post_purchase_cross_sell_or_replenishment"
            : "scale_as_entry_path",
      };
    });

  const allDirectional = cohorts.length > 0 && cohorts.every((cohort) => cohort.confidence === "directional");
  const hasMultiProductFallback = cohorts.some((cohort) => cohort.entryType === "multi_product_entry");
  const hasUnknownFallback = cohorts.some((cohort) => cohort.entryType === "unknown_product_entry");
  return {
    status: cohorts.length
      ? allDirectional ? "directional" as SnapshotSectionStatus : "available" as SnapshotSectionStatus
      : "insufficient_data" as SnapshotSectionStatus,
    count: buckets.size,
    minimumUsefulCohortSize: MIN_USEFUL_COHORT_SIZE,
    metricDefinitions: {
      cohortSize: "Customers whose first local order maps to the entry product or fallback entry type.",
      primaryProductSelection: "Highest line revenue on first order, then highest quantity, then first line item fallback.",
      multiProductEntry: "Used when multiple first-order line items tie for the primary-product rule.",
      unknownProductEntry: "Used when the first order has no usable product line-item data.",
      lifetimeRevenue: "Sum of Customer.totalSpent for customers in the first-product cohort.",
      repeatBuyerRate: "Customers in cohort with totalOrders > 1 divided by cohort size.",
      aov: "Lifetime cohort revenue divided by lifetime order count for customers in the cohort.",
    },
    cohorts,
    caveats: cleanCaveats([
      cohorts.length ? null : "No first-product cohorts were found inside the requested local timeframe.",
      allDirectional ? `All returned product-entry cohorts are smaller than ${MIN_USEFUL_COHORT_SIZE} customers; treat product-entry reads as directional.` : null,
      hasMultiProductFallback ? "Some first orders tied across multiple products; those customers are grouped under multi_product_entry." : null,
      hasUnknownFallback ? "Some first orders lacked usable product line-item data; those customers are grouped under unknown_product_entry." : null,
    ]),
  };
}

function productPerformance(input: {
  timeframeOrders: SafeOrder[];
  productCount: number;
  limits: (typeof DEPTH_LIMITS)[ShopifySourceSnapshotDepth];
}) {
  const metrics = new Map<string, ProductMetric>();

  for (const order of input.timeframeOrders) {
    for (const item of order.items) {
      const product = item.product;
      const current = metrics.get(product.id) ?? {
        productId: product.id,
        externalId: product.externalId,
        name: product.name,
        category: product.category,
        price: product.price,
        avgReplenishmentDays: product.avgReplenishmentDays,
        revenue: 0,
        orders: new Set<string>(),
        customers: new Set<string>(),
        unitsSold: 0,
        purchaseDatesByCustomer: new Map<string, Date[]>(),
      };
      current.revenue += item.quantity * item.price;
      current.orders.add(order.id);
      current.customers.add(order.customerId);
      current.unitsSold += item.quantity;
      const dates = current.purchaseDatesByCustomer.get(order.customerId) ?? [];
      dates.push(order.createdAt);
      current.purchaseDatesByCustomer.set(order.customerId, dates);
      metrics.set(product.id, current);
    }
  }

  const products = Array.from(metrics.values());
  const compacted = products.map(compactProduct);
  const p75Aov = percentile(compacted.map((item) => item.aov), 0.75);

  const topRevenueProducts = [...compacted]
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, input.limits.productLimit);
  const topOrderVolumeProducts = [...compacted]
    .sort((a, b) => b.orders - a.orders || b.unitsSold - a.unitsSold)
    .slice(0, input.limits.productLimit);
  const highAovProducts = [...compacted]
    .filter((item) => item.aov >= p75Aov && item.orders > 0)
    .sort((a, b) => b.aov - a.aov || b.revenue - a.revenue)
    .slice(0, input.limits.productLimit);
  const replenishmentCandidates = [...compacted]
    .filter((item) => Boolean(item.avgReplenishmentDays) || Boolean(item.observedMedianReorderDays))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, input.limits.productLimit);
  const educationSupportCandidates = [...compacted]
    .filter((item) => item.orders > 0 && (item.repeatBuyerRate ?? 0) < 0.15)
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, input.limits.productLimit);

  return {
    status: products.length ? "available" as SnapshotSectionStatus : "partial" as SnapshotSectionStatus,
    productsAnalyzed: products.length,
    localProductCount: input.productCount,
    topRevenueProducts,
    topOrderVolumeProducts,
    highAovProducts,
    campaignAnchorCandidates: topRevenueProducts,
    educationSupportCandidates,
    replenishmentCandidates,
    caveats: products.length
      ? []
      : ["No local order-item/product combinations were found inside the requested timeframe."],
  };
}

function lifecycleSignals(input: {
  customers: SafeCustomer[];
  productPerformance: ReturnType<typeof productPerformance>;
  timeframeEnd: Date;
}) {
  const spentValues = input.customers.map((customer) => customer.totalSpent).filter((value) => value > 0);
  const p90Spent = percentile(spentValues, 0.9);
  const vipCandidates = input.customers.filter((customer) =>
    customer.totalSpent >= p90Spent || (customer.monetaryScore ?? 0) >= 4,
  ).length;
  const oneTimeBuyers = input.customers.filter((customer) => customer.totalOrders === 1).length;
  const repeatBuyers = input.customers.filter((customer) => customer.totalOrders >= 2).length;
  const winbackCandidates = input.customers.filter((customer) => {
    if (!customer.lastOrderDate || customer.totalOrders <= 0) return false;
    return daysBetween(customer.lastOrderDate, input.timeframeEnd) >= 90 || (customer.churnRiskScore ?? 0) >= 60;
  }).length;

  return {
    status: input.customers.length ? "available" as SnapshotSectionStatus : "unavailable" as SnapshotSectionStatus,
    vipCandidates,
    oneTimeBuyers,
    repeatBuyers,
    replenishmentCandidateProducts: input.productPerformance.replenishmentCandidates.length,
    winbackCandidates,
    postPurchaseCrossSellOpportunities: input.productPerformance.educationSupportCandidates.length,
    caveats: [
      "Lifecycle signals are aggregate local-data hints and do not create Shopify or Klaviyo segments.",
    ],
  };
}

function klaviyoEnrichmentCandidates() {
  const labels = [
    {
      property: "worklin_ltv_band",
      definition: "Customer value bucket based on local Customer.totalSpent.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.totalSpent"],
      use: "Segment customers into value bands for VIP, nurture, and winback strategy.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_order_count_band",
      definition: "Order-count bucket based on local Customer.totalOrders.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.totalOrders"],
      use: "Separate first-time, repeat, and loyal purchasers.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_first_purchase_cohort",
      definition: "First-purchase month based on local Customer.firstOrderDate.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.firstOrderDate"],
      use: "Compare acquisition-month retention and reporting cohorts.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_first_product_cohort",
      definition: "First-order entry product using highest line revenue, highest quantity, then first line fallback.",
      source: "shopify_local_order_product_data",
      sourceFields: ["Order.totalAmount", "OrderItem.quantity", "OrderItem.price", "Product.name"],
      use: "Target education and cross-sell by entry product.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_repeat_buyer_status",
      definition: "Repeat-buyer classification based on whether local Customer.totalOrders is greater than one.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.totalOrders"],
      use: "Support repeat-buyer and one-time buyer lifecycle branches.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_vip_candidate",
      definition: "VIP candidate flag based on high local Customer.totalSpent or monetary score.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.totalSpent", "Customer.monetaryScore"],
      use: "Flag customers for VIP treatment and premium campaign logic.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_replenishment_candidate",
      definition: "Replenishment candidate flag based on product replenishment settings or observed reorder timing.",
      source: "shopify_local_product_order_data",
      sourceFields: ["Product.avgReplenishmentDays", "Order.createdAt", "OrderItem.productId"],
      use: "Support replenishment reminders after future approval-gated sync.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_high_aov_customer",
      definition: "High-AOV flag based on local Customer.avgOrderValue distribution.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.avgOrderValue"],
      use: "Identify premium product and bundle candidates.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
    {
      property: "worklin_churn_risk",
      definition: "Churn-risk flag based on local churn-risk score and last-order recency.",
      source: "shopify_local_customer_data",
      sourceFields: ["Customer.churnRiskScore", "Customer.lastOrderDate"],
      use: "Support winback and reactivation planning.",
      syncStatus: "not_synced",
      requiresCapability: "klaviyo.profile.write",
      approvalRequired: true,
    },
  ];

  return {
    status: "available" as SnapshotSectionStatus,
    syncStatus: "not_synced",
    labels,
    caveats: [
      "These are proposed future Klaviyo profile-property candidates only.",
      "Segment/Profile Sync must be built and approved before any profile properties are written.",
      "Candidates are definitions and readiness hints only; this snapshot does not sync profiles.",
    ],
  };
}

function snapshotReadStatus(input: {
  timeframeCommerceSummary: { status: SnapshotSectionStatus; caveats: string[] };
  lifetimeCustomerValue: { status: SnapshotSectionStatus; caveats: string[] };
  firstPurchaseCohorts: { status: SnapshotSectionStatus; caveats: string[] };
  productEntryCohorts: { status: SnapshotSectionStatus; caveats: string[] };
  productPerformance: { status: SnapshotSectionStatus; caveats: string[] };
  lifecycleSignals: { status: SnapshotSectionStatus; caveats: string[] };
}) {
  const sections = [
    { key: "timeframeCommerceSummary", section: input.timeframeCommerceSummary },
    { key: "lifetimeCustomerValue", section: input.lifetimeCustomerValue },
    { key: "firstPurchaseCohorts", section: input.firstPurchaseCohorts },
    { key: "productEntryCohorts", section: input.productEntryCohorts },
    { key: "productPerformance", section: input.productPerformance },
    { key: "lifecycleSignals", section: input.lifecycleSignals },
  ];
  const requested = sections.filter(({ section }) => section.status !== "not_requested");
  const computedSections = requested
    .filter(({ section }) =>
      ["available", "partial", "directional", "local_only"].includes(section.status),
    )
    .map(({ key }) => key);
  const caveatedSections = requested
    .filter(({ section }) => section.status !== "available" || section.caveats.length > 0)
    .map(({ key }) => key);
  const status: "available" | "partial" | "unavailable" = requested.length &&
    computedSections.length === requested.length &&
    caveatedSections.length === 0
    ? "available"
    : computedSections.length
      ? "partial"
      : "unavailable";

  return {
    status,
    computedSections,
    verifiedSections: computedSections,
    caveatedSections,
  };
}

function snapshotSourceStatuses(input: {
  connectors: SourceConnector[];
  generatedAt: string;
  snapshotStatus: "available" | "partial" | "unavailable";
  computedSections: string[];
  caveatedSections: string[];
}) {
  const statuses = [
    sourceStatusForArtifactSource("shopify_snapshot", input.connectors, true),
    sourceStatusForArtifactSource("uploaded_csv", input.connectors, false),
    sourceStatusForArtifactSource("google_sheet", input.connectors, false),
  ];

  return statuses.map((status) => {
    if (status.source !== "shopify_snapshot") return status;
    return {
      ...status,
      snapshotRoute: "GET /api/sources/shopify/snapshot",
      snapshotAvailability: input.snapshotStatus === "available"
        ? "snapshot_local_data_available"
        : input.snapshotStatus === "partial"
          ? "snapshot_partial_local_data"
          : "snapshot_local_data_unavailable",
      snapshotReadStatus: input.snapshotStatus,
      snapshotReadMethod: "local_data",
      computedSections: input.computedSections,
      verifiedSections: input.computedSections,
      caveatedSections: input.caveatedSections,
      lastSnapshotReadAt: input.snapshotStatus === "unavailable" ? null : input.generatedAt,
      verificationStatus: status.verificationStatus,
      verificationMethod: status.verificationMethod,
      connectorVerificationStatus: status.verificationStatus,
      connectorVerificationMethod: status.verificationMethod,
      lastVerifiedAt: status.lastVerifiedAt,
      detail: input.snapshotStatus === "available"
        ? "Shopify snapshot computed requested local-data sections."
        : input.snapshotStatus === "partial"
          ? "Shopify snapshot computed partial local-data sections with caveats."
          : "Shopify snapshot could not find usable local commerce data.",
    };
  });
}

export async function buildShopifySourceSnapshot(input: ShopifySourceSnapshotInput = {}) {
  const parsed = parseShopifySourceSnapshotInput(input);
  if (!parsed.ok) return parsed;

  const generatedAt = new Date().toISOString();
  const depth = parsed.data.depth;
  const timeframeDays = parsed.data.timeframeDays;
  const includeCohorts = parsed.data.includeCohorts;
  const limits = DEPTH_LIMITS[depth];
  const timeframeEnd = new Date();
  const timeframeStart = new Date(timeframeEnd);
  timeframeStart.setDate(timeframeStart.getDate() - timeframeDays);

  const connectors = await listSourceConnectors();
  const shopifyConnector = connectors.find((connector) => connector.id === "shopify") ?? null;
  const localData = await loadLocalSnapshotData({ timeframeStart, timeframeEnd });
  const coverage = dataCoverage(localData);

  const commerce = commerceSummary({
    customers: localData.customers,
    timeframeOrders: localData.timeframeOrders,
    timeframeStart,
    timeframeEnd,
    timeframeDays,
    integrationState: localData.integrationState,
  });
  const value = customerValue({ customers: localData.customers });
  const acquisition = acquisitionCohorts({
    customers: localData.customers,
    timeframeStart,
    limits,
    includeCohorts,
  });
  const entry = productEntryCohorts({
    customers: localData.customers,
    timeframeStart,
    limits,
    includeCohorts,
  });
  const performance = productPerformance({
    timeframeOrders: localData.timeframeOrders,
    productCount: localData.productCount,
    limits,
  });
  const lifecycle = lifecycleSignals({
    customers: localData.customers,
    productPerformance: performance,
    timeframeEnd,
  });
  const enrichment = klaviyoEnrichmentCandidates();
  const readStatus = snapshotReadStatus({
    timeframeCommerceSummary: commerce,
    lifetimeCustomerValue: value,
    firstPurchaseCohorts: acquisition,
    productEntryCohorts: entry,
    productPerformance: performance,
    lifecycleSignals: lifecycle,
  });
  const allCaveats = cleanCaveats([
    ...(shopifyConnector?.caveats ?? []),
    ...commerce.caveats,
    ...value.caveats,
    ...acquisition.caveats,
    ...entry.caveats,
    ...performance.caveats,
    ...lifecycle.caveats,
    ...enrichment.caveats,
    "Snapshot uses local normalized Shopify data only; it does not call Shopify live APIs.",
    "computedSections and verifiedSections mean sections computed from local data, not live Shopify API verification.",
    "Snapshot omits customer contact fields, raw order payloads, raw customer payloads, and full workflow data.",
  ]);

  const response = {
    ok: true as const,
    platform: "shopify",
    generatedAt,
    depth,
    timeframeDays,
    includeCohorts,
    snapshotReadStatus: readStatus.status,
    snapshotReadMethod: "local_data",
    computedSections: readStatus.computedSections,
    verifiedSections: readStatus.verifiedSections,
    caveatedSections: readStatus.caveatedSections,
    snapshotAvailability: readStatus.status === "available"
      ? "snapshot_local_data_available"
      : readStatus.status === "partial"
        ? "snapshot_partial_local_data"
        : "snapshot_local_data_unavailable",
    snapshot: {
      connector: shopifyConnector ? summarizeConnectorForContext(shopifyConnector) : null,
      timeframeCommerceSummary: commerce,
      lifetimeCustomerValue: value,
      firstPurchaseCohorts: acquisition,
      productEntryCohorts: entry,
      productPerformance: performance,
      lifecycleSignals: lifecycle,
      klaviyoEnrichmentCandidates: enrichment,
      safetyPosture: {
        readOnly: true,
        localDataOnly: true,
        externalActionTaken: false,
        canGoLiveNow: false,
        shopifyWritesAllowed: false,
        klaviyoWritesAllowed: false,
        draftCreationAttempted: false,
        sendOrScheduleAllowed: false,
        flowOrSegmentCreationAllowed: false,
        profileSyncAllowed: false,
        liveExternalActionsBlocked: true,
      },
    },
    sourceStatuses: snapshotSourceStatuses({
      connectors,
      generatedAt,
      snapshotStatus: readStatus.status,
      computedSections: readStatus.computedSections,
      caveatedSections: readStatus.caveatedSections,
    }),
    caveats: allCaveats,
    metadata: {
      route: "GET /api/sources/shopify/snapshot",
      depth,
      timeframeDays,
      includeCohorts,
      effectiveLimits: limits,
      dataCoverage: coverage,
      localRowsAnalyzed: {
        customers: coverage.customersAnalyzed,
        orders: coverage.ordersAnalyzed,
        timeframeOrders: coverage.timeframeOrdersAnalyzed,
        orderItems: coverage.orderItemsAnalyzed,
        timeframeOrderItems: coverage.timeframeOrderItemsAnalyzed,
        products: coverage.productsAnalyzed,
      },
      sizeBytes: 0,
      helpersUsed: [
        "listSourceConnectors",
        "prisma.customer",
        "prisma.order",
        "prisma.orderItem",
        "prisma.product",
        "prisma.integrationState",
      ],
      liveReadAttempted: false,
      snapshotReadMethod: "local_data",
      snapshotReadStatus: readStatus.status,
      computedSections: readStatus.computedSections,
      verifiedSections: readStatus.verifiedSections,
      caveatedSections: readStatus.caveatedSections,
      verifiedSectionsMeaning: "computed_from_local_data_not_live_connector_verification",
      connectorVerificationStatus: shopifyConnector?.verificationStatus ?? "unavailable",
      connectorVerificationMethod: shopifyConnector?.verificationMethod ?? "not_applicable",
      connectorLastVerifiedAt: shopifyConnector?.lastVerifiedAt ?? null,
      liveWriteAttempted: false,
      schemaChanged: false,
      omittedDataClasses: [
        "customer contact fields",
        "raw order payloads",
        "raw customer payloads",
        "shipping and billing addresses",
        "full workflow request bodies",
        "full workflow result bodies",
      ],
    },
  };

  response.metadata.sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");

  return { ok: true as const, data: response };
}

export function shopifySnapshotContextStatus(input: {
  connectorStatus: ReturnType<typeof sourceStatusForArtifactSource>;
}) {
  return {
    ...input.connectorStatus,
    snapshotRoute: "GET /api/sources/shopify/snapshot",
    snapshotDepths: SHOPIFY_SOURCE_SNAPSHOT_DEPTHS,
    snapshotTimeframeDays: SHOPIFY_SOURCE_SNAPSHOT_TIMEFRAMES,
    snapshotAvailability: input.connectorStatus.status === "partial_source_available" ||
      input.connectorStatus.status === "connected_snapshot_available"
      ? "snapshot_route_available_local_data_check_on_request"
      : "snapshot_route_available_source_not_connected",
    detail: `${input.connectorStatus.detail} Use the Shopify snapshot route for compact read-only commerce and cohort summaries when needed.`,
  };
}
