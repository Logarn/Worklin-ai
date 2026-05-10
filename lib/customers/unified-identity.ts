import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const UNIFIED_CUSTOMER_IDENTITY_DEPTHS = ["compact", "standard", "full"] as const;

export type UnifiedCustomerIdentityDepth = (typeof UNIFIED_CUSTOMER_IDENTITY_DEPTHS)[number];

export type UnifiedCustomerIdentityInput = {
  customerId?: string | null;
  email?: string | null;
  externalId?: string | null;
  depth?: UnifiedCustomerIdentityDepth | string | null;
  limit?: number | string | null;
  includeProfiles?: boolean | string | null;
  includeMergeCandidates?: boolean | string | null;
};

type ParsedUnifiedCustomerIdentityInput =
  | {
      ok: true;
      data: {
        customerId: string | null;
        email: string | null;
        externalId: string | null;
        depth: UnifiedCustomerIdentityDepth;
        limit: number;
        includeProfiles: boolean;
        includeMergeCandidates: boolean;
      };
    }
  | { ok: false; issues: string[] };

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MERGE_SIGNAL_SCAN_LIMIT = 5000;

const DEPTH_LIMITS = {
  compact: {
    orders: 3,
    events: 5,
    receipts: 3,
    products: 3,
    mergeCandidates: 2,
  },
  standard: {
    orders: 6,
    events: 10,
    receipts: 6,
    products: 5,
    mergeCandidates: 4,
  },
  full: {
    orders: 12,
    events: 20,
    receipts: 12,
    products: 8,
    mergeCandidates: 8,
  },
} as const;

const CUSTOMER_IDENTITY_SELECT = {
  id: true,
  externalId: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
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
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      id: true,
      externalId: true,
      orderNumber: true,
      totalAmount: true,
      status: true,
      createdAt: true,
      deliveredAt: true,
      items: {
        take: 8,
        select: {
          quantity: true,
          price: true,
          product: {
            select: {
              id: true,
              externalId: true,
              name: true,
              category: true,
              avgReplenishmentDays: true,
            },
          },
        },
      },
    },
  },
  events: {
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      eventType: true,
      createdAt: true,
    },
  },
  campaignReceipts: {
    orderBy: { sentAt: "desc" },
    take: 50,
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
          name: true,
          type: true,
          channel: true,
          status: true,
        },
      },
    },
  },
} satisfies Prisma.CustomerSelect;

type CustomerIdentityRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_IDENTITY_SELECT }>;

type MinimalCustomerIdentityRow = {
  id: string;
  externalId: string | null;
  email: string;
  phone: string | null;
  totalOrders: number;
  totalSpent: number;
};

const IDENTITY_MATCHING_RULES = [
  {
    signal: "shopify_customer_id",
    internalSource: "Customer.externalId",
    rule: "Exact local Shopify customer id is the strongest v0 identity key when present.",
    outputPolicy: "Returned as shopifyCustomerExternalId because it is a source id, not a contact field.",
    caveat: "This is a local Shopify sync key; v0 does not perform a live Shopify lookup.",
  },
  {
    signal: "klaviyo_profile_id",
    internalSource: "not_durable_in_local_schema_yet",
    rule: "Klaviyo profile id is acknowledged but not matched in v0 because there is no durable local Klaviyo profile id join field.",
    outputPolicy: "Returned as null with klaviyoProfileIdKnown=false.",
    caveat: "Future Klaviyo profile joins must remain read-only until Segment/Profile Sync and approval-gated write capabilities are built.",
  },
  {
    signal: "email",
    internalSource: "Customer.email",
    rule: "Normalized email may be used internally for lookup and identity id generation when no Shopify customer id exists.",
    outputPolicy: "Raw email is never returned; response may include only a hash/presence signal.",
    caveat: "Email-only matches are weaker than Shopify-id matches and can represent imported or placeholder local rows.",
  },
  {
    signal: "phone",
    internalSource: "Customer.phone",
    rule: "Normalized phone is used only as a review-only merge-candidate signal.",
    outputPolicy: "Raw phone is never returned; response may include only a hash/presence signal.",
    caveat: "Shared phone hash candidates are not automatically merged or synced.",
  },
  {
    signal: "local_customer_activity",
    internalSource: "Customer, Order, CustomerEvent, CampaignReceipt",
    rule: "Local orders, events, and campaign receipts strengthen identity confidence and source coverage.",
    outputPolicy: "Returned as aggregate summaries and safe ids only.",
    caveat: "V0 is a derived local snapshot, not a persisted identity graph or feature store.",
  },
] as const;

function cleanString(value: unknown, max = 200) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeDepth(value: unknown): UnifiedCustomerIdentityDepth | null {
  const cleaned = cleanString(value, 40)?.toLowerCase();
  if (!cleaned) return null;
  return UNIFIED_CUSTOMER_IDENTITY_DEPTHS.includes(cleaned as UnifiedCustomerIdentityDepth)
    ? (cleaned as UnifiedCustomerIdentityDepth)
    : null;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const cleaned = cleanString(value, 12)?.toLowerCase();
  if (!cleaned) return null;
  if (["true", "1", "yes"].includes(cleaned)) return true;
  if (["false", "0", "no"].includes(cleaned)) return false;
  return null;
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return { ok: true as const, limit: DEFAULT_LIMIT };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false as const, issue: "limit must be a positive whole number." };
  }
  return { ok: true as const, limit: Math.min(parsed, MAX_LIMIT) };
}

export function parseUnifiedCustomerIdentityInput(
  input: UnifiedCustomerIdentityInput = {},
): ParsedUnifiedCustomerIdentityInput {
  const issues: string[] = [];
  const customerId = cleanString(input.customerId, 200);
  const email = cleanString(input.email, 320)?.toLowerCase() ?? null;
  const externalId = cleanString(input.externalId, 200);
  const depth = input.depth == null ? "compact" : normalizeDepth(input.depth);
  const limit = normalizeLimit(input.limit);
  const includeProfiles = input.includeProfiles == null ? true : normalizeBoolean(input.includeProfiles);
  const includeMergeCandidates = input.includeMergeCandidates == null
    ? true
    : normalizeBoolean(input.includeMergeCandidates);

  if (!depth) issues.push("depth must be one of compact, standard, or full.");
  if (!limit.ok) issues.push(limit.issue);
  if (includeProfiles === null) issues.push("includeProfiles must be true or false.");
  if (includeMergeCandidates === null) issues.push("includeMergeCandidates must be true or false.");

  return issues.length || !depth || !limit.ok || includeProfiles === null || includeMergeCandidates === null
    ? { ok: false, issues }
    : {
        ok: true,
        data: {
          customerId,
          email,
          externalId,
          depth,
          limit: limit.limit,
          includeProfiles,
          includeMergeCandidates,
        },
      };
}

function hashValue(value: string | null | undefined, length = 20) {
  if (!value) return null;
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, length);
}

function normalizeEmail(value: string | null | undefined) {
  return cleanString(value, 320)?.toLowerCase() ?? null;
}

function emailDomain(value: string | null | undefined) {
  const normalized = normalizeEmail(value);
  if (!normalized) return null;
  const [, domain] = normalized.split("@");
  return domain || null;
}

function normalizePhone(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length >= 7 ? digits : null;
}

function money(value: number | null | undefined) {
  return Number((value ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function countBy(values: Array<string | null | undefined>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value?.trim() || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function canonicalIdentityId(customer: Pick<CustomerIdentityRow, "id" | "externalId" | "email">) {
  const basis = customer.externalId
    ? `shopify:${customer.externalId}`
    : customer.email
      ? `email:${normalizeEmail(customer.email)}`
      : `local:${customer.id}`;
  return `worklin_identity_${hashValue(basis, 18)}`;
}

function identityConfidenceAssessment(customer: CustomerIdentityRow) {
  const signals = [
    Boolean(customer.email),
    Boolean(customer.externalId),
    Boolean(customer.phone),
    customer.totalOrders > 0,
    customer.events.length > 0,
    customer.campaignReceipts.length > 0,
  ].filter(Boolean).length;
  const reasons = [
    "Local Customer row exists.",
    customer.externalId ? "Shopify customer external id is present." : null,
    customer.email ? "Email is available internally and returned only as a hash/presence signal." : null,
    customer.phone ? "Phone is available internally and returned only as a hash/presence signal." : null,
    customer.totalOrders > 0 ? "Local Shopify order history is linked." : null,
    customer.events.length > 0 ? "Local customer events are linked." : null,
    customer.campaignReceipts.length > 0 ? "Local campaign receipts are linked." : null,
  ].filter((reason): reason is string => Boolean(reason));

  if (customer.externalId && customer.email && customer.totalOrders > 0 && signals >= 4) {
    return {
      level: "high_local_match",
      score: 0.86,
      reasons,
      caveats: [
        "High confidence is still local-only; no live Shopify or Klaviyo verification was performed.",
        "Klaviyo profile id is not joined in v0.",
      ],
    };
  }
  if (customer.email && (customer.totalOrders > 0 || customer.events.length > 0)) {
    return {
      level: "medium_local_match",
      score: 0.62,
      reasons,
      caveats: [
        "Email is available internally but is not returned raw.",
        "No durable Klaviyo profile id or live source verification is available in v0.",
      ],
    };
  }
  return {
    level: "low_local_match",
    score: 0.34,
    reasons,
    caveats: [
      "Identity is based on a sparse local customer row.",
      "Add Shopify/Klaviyo profile joins and feature-store signals later before using this for autonomy.",
    ],
  };
}

function identityStatus(customer: CustomerIdentityRow) {
  if (customer.externalId && customer.email) return "shopify_local_customer_linked";
  if (customer.email) return "local_customer_email_only";
  return "local_customer_only";
}

function matchedSourceSystems(customer: CustomerIdentityRow) {
  return [
    "worklin_local_customer",
    customer.externalId ? "shopify_local_customer" : null,
    customer.orders.length > 0 ? "shopify_local_orders" : null,
    customer.events.length > 0 ? "worklin_customer_events" : null,
    customer.campaignReceipts.length > 0 ? "worklin_campaign_receipts" : null,
  ].filter((source): source is string => Boolean(source));
}

function eventSummary(customer: CustomerIdentityRow, limit: number) {
  const events = customer.events.slice(0, limit);
  return {
    totalKnownEvents: customer.events.length,
    countsByType: countBy(customer.events.map((event) => event.eventType)),
    recent: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

function orderSummary(customer: CustomerIdentityRow, limit: number, productLimit: number) {
  const orders = customer.orders.slice(0, limit);
  const products = new Map<string, {
    productId: string;
    externalId: string | null;
    name: string;
    category: string | null;
    quantity: number;
    revenue: number;
    avgReplenishmentDays: number | null;
  }>();

  for (const order of customer.orders) {
    for (const item of order.items) {
      const key = item.product.id;
      const current = products.get(key) ?? {
        productId: item.product.id,
        externalId: item.product.externalId,
        name: item.product.name,
        category: item.product.category,
        quantity: 0,
        revenue: 0,
        avgReplenishmentDays: item.product.avgReplenishmentDays,
      };
      current.quantity += item.quantity;
      current.revenue += item.quantity * item.price;
      products.set(key, current);
    }
  }

  return {
    totalKnownOrders: customer.orders.length,
    recent: orders.map((order) => ({
      id: order.id,
      externalIdKnown: Boolean(order.externalId),
      externalIdHash: hashValue(order.externalId, 18),
      orderNumberKnown: Boolean(order.orderNumber),
      status: order.status,
      totalAmount: money(order.totalAmount),
      createdAt: order.createdAt.toISOString(),
      deliveredAt: iso(order.deliveredAt),
      itemCount: order.items.length,
    })),
    productSignals: Array.from(products.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, productLimit)
      .map((product) => ({
        productId: product.productId,
        externalIdKnown: Boolean(product.externalId),
        externalIdHash: hashValue(product.externalId, 18),
        name: product.name,
        category: product.category,
        quantity: product.quantity,
        revenue: money(product.revenue),
        avgReplenishmentDays: product.avgReplenishmentDays,
      })),
  };
}

function campaignReceiptSummary(customer: CustomerIdentityRow, limit: number) {
  const receipts = customer.campaignReceipts.slice(0, limit);
  const conversions = customer.campaignReceipts.filter((receipt) => Boolean(receipt.convertedAt)).length;
  const clicks = customer.campaignReceipts.filter((receipt) => Boolean(receipt.clickedAt)).length;
  const opens = customer.campaignReceipts.filter((receipt) => Boolean(receipt.openedAt)).length;

  return {
    totalKnownReceipts: customer.campaignReceipts.length,
    countsByStatus: countBy(customer.campaignReceipts.map((receipt) => receipt.status)),
    engagementRates: {
      openRate: rate(opens, customer.campaignReceipts.length),
      clickRate: rate(clicks, customer.campaignReceipts.length),
      conversionRate: rate(conversions, customer.campaignReceipts.length),
    },
    recent: receipts.map((receipt) => ({
      id: receipt.id,
      channel: receipt.channel,
      status: receipt.status,
      sentAt: iso(receipt.sentAt),
      openedAt: iso(receipt.openedAt),
      clickedAt: iso(receipt.clickedAt),
      convertedAt: iso(receipt.convertedAt),
      revenue: money(receipt.revenue),
      campaign: {
        id: receipt.campaign.id,
        name: receipt.campaign.name,
        type: receipt.campaign.type,
        channel: receipt.campaign.channel,
        status: receipt.campaign.status,
      },
    })),
  };
}

function evidenceFor(customer: CustomerIdentityRow) {
  return [
    {
      source: "worklin.local_customer",
      signal: "Customer row exists",
      confidence: "high",
      observedAt: customer.createdAt.toISOString(),
    },
    customer.externalId
      ? {
          source: "shopify.local_sync",
          signal: "Customer.externalId is present",
          confidence: "high",
          observedAt: iso(customer.createdAt),
        }
      : null,
    customer.totalOrders > 0
      ? {
          source: "shopify.local_orders",
          signal: `${customer.totalOrders} local order(s) linked to customer`,
          confidence: "medium",
          observedAt: iso(customer.lastOrderDate),
        }
      : null,
    customer.events.length
      ? {
          source: "worklin.customer_events",
          signal: `${customer.events.length} local event(s) linked to customer`,
          confidence: "medium",
          observedAt: customer.events[0]?.createdAt.toISOString() ?? null,
        }
      : null,
    customer.campaignReceipts.length
      ? {
          source: "worklin.campaign_receipts",
          signal: `${customer.campaignReceipts.length} campaign receipt(s) linked to customer`,
          confidence: "medium",
          observedAt: iso(customer.campaignReceipts[0]?.sentAt),
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function buildPhoneGroups(customers: MinimalCustomerIdentityRow[]) {
  const groups = new Map<string, MinimalCustomerIdentityRow[]>();
  for (const customer of customers) {
    const phone = normalizePhone(customer.phone);
    if (!phone) continue;
    const phoneHash = hashValue(phone, 18);
    if (!phoneHash) continue;
    const group = groups.get(phoneHash) ?? [];
    group.push(customer);
    groups.set(phoneHash, group);
  }
  return groups;
}

function mergeCandidatesFor(input: {
  customer: CustomerIdentityRow;
  phoneGroups: Map<string, MinimalCustomerIdentityRow[]>;
  limit: number;
}) {
  const phoneHash = hashValue(normalizePhone(input.customer.phone), 18);
  if (!phoneHash) return [];
  const group = input.phoneGroups.get(phoneHash) ?? [];
  return group
    .filter((candidate) => candidate.id !== input.customer.id)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, input.limit)
    .map((candidate) => ({
      identityId: canonicalIdentityId(candidate),
      localCustomerId: candidate.id,
      sharedSignal: "phone_hash",
      confidence: "candidate_only_review_required",
      externalIdPresent: Boolean(candidate.externalId),
      totalOrders: candidate.totalOrders,
      totalSpent: money(candidate.totalSpent),
    }));
}

function compactIdentityProfile(input: {
  customer: CustomerIdentityRow;
  depth: UnifiedCustomerIdentityDepth;
  phoneGroups: Map<string, MinimalCustomerIdentityRow[]>;
  includeMergeCandidates: boolean;
}) {
  const limits = DEPTH_LIMITS[input.depth];
  const customer = input.customer;
  const normalizedPhone = normalizePhone(customer.phone);
  const confidence = identityConfidenceAssessment(customer);
  const profile = {
    identityId: canonicalIdentityId(customer),
    resolutionStatus: identityStatus(customer),
    confidence: confidence.level,
    confidenceScore: confidence.score,
    confidenceReasons: confidence.reasons,
    confidenceCaveats: confidence.caveats,
    canonicalLocalCustomerId: customer.id,
    sourceIds: {
      worklinCustomerId: customer.id,
      shopifyCustomerExternalId: customer.externalId,
      klaviyoProfileId: null,
      klaviyoProfileIdKnown: false,
    },
    identifiers: {
      localCustomerId: customer.id,
      shopifyCustomerExternalId: customer.externalId,
      emailHash: hashValue(customer.email, 24),
      emailDomainKnown: Boolean(emailDomain(customer.email)),
      phoneHash: hashValue(normalizedPhone, 18),
      phonePresent: Boolean(normalizedPhone),
    },
    contactState: {
      emailPresent: Boolean(customer.email),
      phonePresent: Boolean(normalizedPhone),
      namePresent: Boolean(customer.firstName || customer.lastName),
      rawContactFieldsReturned: false,
    },
    commerce: {
      totalOrders: customer.totalOrders,
      totalSpent: money(customer.totalSpent),
      avgOrderValue: money(customer.avgOrderValue),
      firstOrderDate: iso(customer.firstOrderDate),
      lastOrderDate: iso(customer.lastOrderDate),
      recencyScore: customer.recencyScore,
      frequencyScore: customer.frequencyScore,
      monetaryScore: customer.monetaryScore,
      segment: customer.segment,
      churnRiskScore: customer.churnRiskScore,
    },
    matchedSourceSystems: matchedSourceSystems(customer),
    dataCoverage: {
      localCustomer: true,
      shopifyCustomerExternalId: Boolean(customer.externalId),
      klaviyoProfileId: false,
      orders: customer.orders.length,
      events: customer.events.length,
      campaignReceipts: customer.campaignReceipts.length,
      rawContactFieldsReturned: false,
    },
    linkedSources: {
      localCustomer: true,
      shopifyLocalCustomer: Boolean(customer.externalId),
      shopifyLocalOrders: customer.orders.length > 0,
      worklinCustomerEvents: customer.events.length > 0,
      worklinCampaignReceipts: customer.campaignReceipts.length > 0,
      klaviyoProfileIdKnown: false,
    },
    evidence: evidenceFor(customer),
    caveats: [
      "Unified identity v0 is derived from local Worklin rows only.",
      "No profile merge, profile sync, Klaviyo profile write, or external lookup was performed.",
      "Email and phone are represented as hashes/presence signals, not raw contact fields.",
      "Klaviyo profile id is not available in the current local schema, so Klaviyo profile matching is caveated.",
    ],
  };

  if (input.depth === "compact") {
    return {
      ...profile,
      activitySummary: {
        totalKnownOrders: customer.orders.length,
        totalKnownEvents: customer.events.length,
        totalKnownCampaignReceipts: customer.campaignReceipts.length,
      },
      mergeCandidates: input.includeMergeCandidates
        ? mergeCandidatesFor({ customer, phoneGroups: input.phoneGroups, limit: limits.mergeCandidates })
        : [],
    };
  }

  return {
    ...profile,
    orders: orderSummary(customer, limits.orders, limits.products),
    events: eventSummary(customer, limits.events),
    campaignReceipts: campaignReceiptSummary(customer, limits.receipts),
    mergeCandidates: input.includeMergeCandidates
      ? mergeCandidatesFor({ customer, phoneGroups: input.phoneGroups, limit: limits.mergeCandidates })
      : [],
  };
}

function buildWhere(input: {
  customerId: string | null;
  email: string | null;
  externalId: string | null;
}): Prisma.CustomerWhereInput {
  return {
    ...(input.customerId ? { id: input.customerId } : {}),
    ...(input.email ? { email: { equals: input.email, mode: "insensitive" as const } } : {}),
    ...(input.externalId ? { externalId: input.externalId } : {}),
  };
}

function summarizeDuplicateSignals(phoneGroups: Map<string, MinimalCustomerIdentityRow[]>) {
  const duplicatePhoneGroups = Array.from(phoneGroups.entries()).filter(([, customers]) => customers.length > 1);
  return {
    scannedCustomers: Array.from(phoneGroups.values()).reduce((sum, group) => sum + group.length, 0),
    sharedPhoneHashGroups: duplicatePhoneGroups.length,
    customersInSharedPhoneHashGroups: duplicatePhoneGroups.reduce((sum, [, group]) => sum + group.length, 0),
    examples: duplicatePhoneGroups.slice(0, 5).map(([phoneHash, group]) => ({
      phoneHash,
      count: group.length,
      localCustomerIds: group.map((customer) => customer.id).slice(0, 5),
    })),
  };
}

function safeInputSummary(input: ParsedUnifiedCustomerIdentityInput & { ok: true }) {
  return {
    customerIdProvided: Boolean(input.data.customerId),
    customerId: input.data.customerId,
    emailProvided: Boolean(input.data.email),
    emailHash: hashValue(input.data.email, 24),
    externalIdProvided: Boolean(input.data.externalId),
    externalId: input.data.externalId,
    depth: input.data.depth,
    limit: input.data.limit,
    includeProfiles: input.data.includeProfiles,
    includeMergeCandidates: input.data.includeMergeCandidates,
    rawContactFieldsReturned: false,
  };
}

export async function buildUnifiedCustomerIdentity(input: UnifiedCustomerIdentityInput = {}) {
  const parsed = parseUnifiedCustomerIdentityInput(input);
  if (!parsed.ok) return parsed;

  const where = buildWhere(parsed.data);
  const generatedAt = new Date().toISOString();
  const exactLookup = Boolean(parsed.data.customerId || parsed.data.email || parsed.data.externalId);

  const [
    totalLocalCustomers,
    matchingCustomerCount,
    customersWithEmail,
    customersWithPhone,
    customersWithExternalId,
    customersWithOrders,
    customersWithEvents,
    customersWithCampaignReceipts,
    identityRows,
    mergeSignalRows,
  ] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where }),
    prisma.customer.count({ where: { email: { not: "" } } }),
    prisma.customer.count({ where: { phone: { not: null } } }),
    prisma.customer.count({ where: { externalId: { not: null } } }),
    prisma.customer.count({ where: { totalOrders: { gt: 0 } } }),
    prisma.customer.count({ where: { events: { some: {} } } }),
    prisma.customer.count({ where: { campaignReceipts: { some: {} } } }),
    prisma.customer.findMany({
      where,
      orderBy: [{ totalSpent: "desc" }, { createdAt: "desc" }],
      take: exactLookup ? Math.max(parsed.data.limit, 1) : parsed.data.limit,
      select: CUSTOMER_IDENTITY_SELECT,
    }),
    parsed.data.includeMergeCandidates
      ? prisma.customer.findMany({
          where: { phone: { not: null } },
          orderBy: { createdAt: "desc" },
          take: MERGE_SIGNAL_SCAN_LIMIT,
          select: {
            id: true,
            externalId: true,
            email: true,
            phone: true,
            totalOrders: true,
            totalSpent: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const phoneGroups = buildPhoneGroups(mergeSignalRows);
  const profiles = parsed.data.includeProfiles
    ? identityRows.map((customer) =>
        compactIdentityProfile({
          customer,
          depth: parsed.data.depth,
          phoneGroups,
          includeMergeCandidates: parsed.data.includeMergeCandidates,
        }),
      )
    : [];

  return {
    ok: true as const,
    readOnly: true,
    externalActionTaken: false,
    canGoLiveNow: false,
    generatedAt,
    identityGraph: {
      name: "Unified Customer Identity v0",
      mode: "derived_local_identity_snapshot",
      persistedIdentityTable: false,
      profileMergesPerformed: false,
      profileSyncPerformed: false,
      klaviyoProfileJoinStatus: "not_available_in_local_schema",
      matchingRules: IDENTITY_MATCHING_RULES,
      canonicalRules: [
        "Customer.id remains the local canonical row key.",
        "Customer.externalId is treated as the Shopify/local sync identifier when present.",
        "Normalized email hash is used as a pseudonymous identity signal.",
        "Normalized phone hash is used only as a merge-candidate signal requiring review.",
      ],
    },
    summary: {
      totalLocalCustomers,
      matchingCustomerCount,
      identitiesReturned: profiles.length,
      depth: parsed.data.depth,
      limit: parsed.data.limit,
      coverage: {
        customersWithEmail,
        customersWithPhone,
        customersWithExternalId,
        customersWithOrders,
        customersWithEvents,
        customersWithCampaignReceipts,
      },
      duplicateSignals: parsed.data.includeMergeCandidates
        ? summarizeDuplicateSignals(phoneGroups)
        : {
            skipped: true,
            reason: "includeMergeCandidates=false",
      },
    },
    dataCoverage: {
      sourceSystems: {
        worklinLocalCustomer: totalLocalCustomers > 0,
        shopifyLocalCustomerIds: customersWithExternalId > 0,
        shopifyLocalOrders: customersWithOrders > 0,
        klaviyoProfileIds: false,
        worklinCustomerEvents: customersWithEvents > 0,
        worklinCampaignReceipts: customersWithCampaignReceipts > 0,
      },
      counts: {
        totalLocalCustomers,
        matchingCustomerCount,
        identitiesReturned: profiles.length,
        customersWithEmail,
        customersWithPhone,
        customersWithExternalId,
        customersWithOrders,
        customersWithEvents,
        customersWithCampaignReceipts,
      },
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
    profiles,
    missingCapabilities: [
      "Customer Feature Store v0",
      "Rule-Based Customer Scoring v0",
      "Segment Definition Builder v0",
      "Segment/Profile Sync v0",
      "Klaviyo profile id join",
      "Durable identity merge review workflow",
    ],
    caveats: [
      "Identity v0 is read-only and derived from existing local Customer, Order, CustomerEvent, and CampaignReceipt rows.",
      "No schema migration, identity merge write, external source lookup, profile sync, segment creation, send, or schedule was performed.",
      "Klaviyo profile ids are not joined yet; future sync requires explicit capability and approval gates.",
    ],
    safety: {
      readOnly: true,
      externalActionTaken: false,
      canGoLiveNow: false,
      profileMergePerformed: false,
      profileSyncPerformed: false,
      segmentSyncPerformed: false,
      klaviyoWritesAllowed: false,
      shopifyWritesAllowed: false,
      liveExternalActionsBlocked: true,
    },
    metadata: {
      route: "GET/POST /api/customers/identity",
      generatedAt,
      input: safeInputSummary(parsed),
      sourceTables: ["Customer", "Order", "OrderItem", "Product", "CustomerEvent", "CampaignReceipt"],
      mergeSignalScanLimit: parsed.data.includeMergeCandidates ? MERGE_SIGNAL_SCAN_LIMIT : 0,
      rawContactFieldsReturned: false,
      rawPayloadsReturned: false,
    },
  };
}
