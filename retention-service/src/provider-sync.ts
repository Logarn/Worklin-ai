import type {
  KlaviyoPropertyAccessMode,
  NormalizedSourcePayload,
  RetentionProvider,
  SourceEventInput,
} from "./types.js";

export const SHOPIFY_ADMIN_API_VERSION = "2026-07";
export const KLAVIYO_API_REVISION = "2026-07-15";

const KLAVIYO_ORIGIN = "https://a.klaviyo.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_CHARACTERS = 2_048;
const MAX_CREDENTIAL_CHARACTERS = 4_096;
const MAX_ALLOWLIST_PROPERTIES = 500;
const MAX_KLAVIYO_PROPERTIES_PER_RESOURCE = 2_000;
const MAX_KLAVIYO_PROPERTY_CHARACTERS = 504;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/u;
const SHOPIFY_HOST_PATTERN =
  /^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u;
const BLOCKED_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderSyncLifecycle =
  "historical_backfill" | "incremental_poll" | "reconciliation";

export interface ProviderSyncCheckpoint {
  cursor: string | null;
  watermark: string | null;
  pendingWatermark: string | null;
}

export interface ProviderRateLimitMetadata {
  retryAfterMs?: number;
  limit?: number;
  remaining?: number;
  resetAfterMs?: number;
  shopifyCost?: {
    requested: number | null;
    actual: number | null;
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

export interface ProviderSyncPageInput<Resource extends string> {
  integrationId: string;
  resource: Resource;
  checkpoint?: Partial<ProviderSyncCheckpoint>;
  pageSize?: number;
}

export interface ProviderSyncPage<Resource extends string> {
  provider: RetentionProvider;
  lifecycle: ProviderSyncLifecycle;
  resource: Resource;
  events: SourceEventInput[];
  rejectedCount?: number;
  checkpoint: ProviderSyncCheckpoint;
  hasMore: boolean;
  rateLimit: ProviderRateLimitMetadata;
}

export interface ProviderSyncLifecycleClient<Resource extends string> {
  historicalBackfillPage(
    input: ProviderSyncPageInput<Resource>,
  ): Promise<ProviderSyncPage<Resource>>;
  incrementalPollPage(
    input: ProviderSyncPageInput<Resource>,
  ): Promise<ProviderSyncPage<Resource>>;
  reconciliationPage(
    input: ProviderSyncPageInput<Resource>,
  ): Promise<ProviderSyncPage<Resource>>;
}

export class ProviderSyncError extends Error {
  readonly name = "ProviderSyncError";

  constructor(
    readonly provider: RetentionProvider,
    readonly code:
      | "invalid_configuration"
      | "invalid_checkpoint"
      | "invalid_request"
      | "provider_request_failed"
      | "provider_rate_limited"
      | "provider_response_too_large"
      | "malformed_provider_response",
    message: string,
    readonly status: number,
    readonly rateLimit: ProviderRateLimitMetadata = {},
  ) {
    super(message);
  }
}

export type ShopifySyncResource = "customers" | "orders";

export interface ShopifyProviderSyncClientOptions {
  shopDomain: string;
  accessToken: string;
  fetch?: FetchImplementation;
  now?: () => Date;
}

export type KlaviyoSyncResource = "profiles" | "events";

export interface KlaviyoProviderSyncClientOptions {
  privateApiKey: string;
  propertyAccessMode?: KlaviyoPropertyAccessMode;
  propertyAllowlist: readonly string[];
  fetch?: FetchImplementation;
  now?: () => Date;
}

interface BoundedJsonResponse {
  value: unknown;
  headers: Headers;
}

interface ShopifyConnection {
  nodes: unknown[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface KlaviyoDocument {
  data: unknown[];
  included: unknown[];
  nextCursor: string | null;
}

const SHOPIFY_CUSTOMERS_QUERY = `
  query WorklinRetentionCustomers(
    $first: Int!
    $after: String
    $query: String
  ) {
    customers(
      first: $first
      after: $after
      query: $query
      sortKey: UPDATED_AT
    ) {
      nodes {
        id
        firstName
        lastName
        createdAt
        updatedAt
        numberOfOrders
        amountSpent {
          amount
          currencyCode
        }
        defaultEmailAddress {
          emailAddress
        }
        defaultPhoneNumber {
          phoneNumber
        }
        emailMarketingConsent {
          marketingState
          consentUpdatedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const SHOPIFY_ORDERS_QUERY = `
  query WorklinRetentionOrders(
    $first: Int!
    $after: String
    $query: String
  ) {
    orders(
      first: $first
      after: $after
      query: $query
      sortKey: UPDATED_AT
    ) {
      nodes {
        id
        name
        createdAt
        updatedAt
        processedAt
        cancelledAt
        email
        displayFinancialStatus
        displayFulfillmentStatus
        subtotalLineItemsQuantity
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          id
          firstName
          lastName
          defaultEmailAddress {
            emailAddress
          }
          defaultPhoneNumber {
            phoneNumber
          }
        }
        lineItems(first: 50) {
          nodes {
            id
            name
            quantity
            sku
            variant {
              id
              product {
                id
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  provider: RetentionProvider,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw malformedResponse(provider);
  }
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function requiredString(
  value: unknown,
  provider: RetentionProvider,
  maxCharacters = 2_048,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCharacters ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw malformedResponse(provider);
  }
  return value;
}

function optionalString(
  value: unknown,
  provider: RetentionProvider,
  maxCharacters = 2_048,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value, provider, maxCharacters);
}

function requiredIsoTime(value: unknown, provider: RetentionProvider): string {
  const candidate = requiredString(value, provider, 128);
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds)) {
    throw malformedResponse(provider);
  }
  return new Date(milliseconds).toISOString();
}

function optionalIsoTime(
  value: unknown,
  provider: RetentionProvider,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredIsoTime(value, provider);
}

function numericTimestamp(
  value: unknown,
  provider: RetentionProvider,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedResponse(provider);
  }
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(parsed.getTime())) {
    throw malformedResponse(provider);
  }
  return parsed.toISOString();
}

function malformedResponse(provider: RetentionProvider): ProviderSyncError {
  return new ProviderSyncError(
    provider,
    "malformed_provider_response",
    `${providerDisplayName(provider)} returned an invalid read response.`,
    502,
  );
}

function providerDisplayName(provider: RetentionProvider): string {
  return provider === "shopify" ? "Shopify" : "Klaviyo";
}

function configurationError(
  provider: RetentionProvider,
  message: string,
): ProviderSyncError {
  return new ProviderSyncError(provider, "invalid_configuration", message, 400);
}

function validateCredential(
  provider: RetentionProvider,
  credential: string,
): string {
  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    credential.length > MAX_CREDENTIAL_CHARACTERS ||
    credential.trim() !== credential ||
    /[\u0000-\u001f\u007f]/u.test(credential)
  ) {
    throw configurationError(
      provider,
      `${providerDisplayName(provider)} credentials are invalid.`,
    );
  }
  return credential;
}

function validateShopifyOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw configurationError("shopify", "The Shopify store domain is invalid.");
  }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    !SHOPIFY_HOST_PATTERN.test(hostname)
  ) {
    throw configurationError("shopify", "The Shopify store domain is invalid.");
  }
  return `https://${hostname}`;
}

function isSafeKlaviyoPropertyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_KLAVIYO_PROPERTY_CHARACTERS &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !BLOCKED_PROPERTY_NAMES.has(value)
  );
}

function validatePropertySelection(
  mode: KlaviyoPropertyAccessMode,
  values: readonly string[],
): { mode: KlaviyoPropertyAccessMode; allowlist: ReadonlySet<string> } {
  if (mode !== "allowlist" && mode !== "all") {
    throw configurationError(
      "klaviyo",
      "The Klaviyo property access mode is invalid.",
    );
  }
  if (!Array.isArray(values) || values.length > MAX_ALLOWLIST_PROPERTIES) {
    throw configurationError(
      "klaviyo",
      "The Klaviyo property allowlist is invalid.",
    );
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !isSafeKlaviyoPropertyName(value)) {
      throw configurationError(
        "klaviyo",
        "The Klaviyo property allowlist is invalid.",
      );
    }
    unique.add(value);
  }
  if (mode === "all" && unique.size > 0) {
    throw configurationError(
      "klaviyo",
      "An allowlist cannot be combined with all-property access.",
    );
  }
  return { mode, allowlist: unique };
}

function validateIntegrationId(
  provider: RetentionProvider,
  value: string,
): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ProviderSyncError(
      provider,
      "invalid_request",
      "The provider synchronization request is invalid.",
      400,
    );
  }
  return value;
}

function validateCursor(
  provider: RetentionProvider,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_CHARACTERS ||
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    !OPAQUE_CURSOR_PATTERN.test(value)
  ) {
    throw new ProviderSyncError(
      provider,
      "invalid_checkpoint",
      "The provider synchronization cursor is invalid.",
      400,
    );
  }
  return value;
}

function validateWatermark(
  provider: RetentionProvider,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new ProviderSyncError(
      provider,
      "invalid_checkpoint",
      "The provider synchronization watermark is invalid.",
      400,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ProviderSyncError(
      provider,
      "invalid_checkpoint",
      "The provider synchronization watermark is invalid.",
      400,
    );
  }
  return new Date(milliseconds).toISOString();
}

function validatePageSize(
  provider: RetentionProvider,
  value: number | undefined,
  maximum: number,
): number {
  const pageSize = value ?? maximum;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maximum) {
    throw new ProviderSyncError(
      provider,
      "invalid_request",
      `The ${providerDisplayName(provider)} page size is invalid.`,
      400,
    );
  }
  return pageSize;
}

function advanceWatermark(
  previous: string | null,
  occurredAtValues: readonly string[],
): string | null {
  let latestMilliseconds =
    previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous);
  for (const occurredAt of occurredAtValues) {
    latestMilliseconds = Math.max(latestMilliseconds, Date.parse(occurredAt));
  }
  return Number.isFinite(latestMilliseconds)
    ? new Date(latestMilliseconds).toISOString()
    : null;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    return Math.min(
      Math.max(0, Math.ceil(Number(value) * 1_000)),
      MAX_RETRY_AFTER_MS,
    );
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(Math.max(0, retryAt - now.getTime()), MAX_RETRY_AFTER_MS);
}

function headerRateLimit(
  headers: Headers,
  now: Date,
): ProviderRateLimitMetadata {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), now);
  const limit = parseNonNegativeInteger(
    headers.get("ratelimit-limit") ?? headers.get("x-ratelimit-limit"),
  );
  const remaining = parseNonNegativeInteger(
    headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining"),
  );
  const resetSeconds = parseNonNegativeInteger(
    headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset"),
  );
  return {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetSeconds === undefined
      ? {}
      : {
          resetAfterMs: Math.min(resetSeconds * 1_000, MAX_RETRY_AFTER_MS),
        }),
  };
}

async function readBoundedBody(
  response: Response,
  provider: RetentionProvider,
): Promise<string> {
  const contentLength = parseNonNegativeInteger(
    response.headers.get("content-length"),
  );
  if (contentLength !== undefined && contentLength > MAX_RESPONSE_BYTES) {
    throw new ProviderSyncError(
      provider,
      "provider_response_too_large",
      `${providerDisplayName(provider)} returned an oversized read response.`,
      502,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderSyncError(
        provider,
        "provider_response_too_large",
        `${providerDisplayName(provider)} returned an oversized read response.`,
        502,
      );
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw malformedResponse(provider);
  }
}

async function fetchBoundedJson(
  provider: RetentionProvider,
  fetchImplementation: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  now: Date,
): Promise<BoundedJsonResponse> {
  let response: Response;
  try {
    response = await fetchImplementation(input, init);
  } catch {
    throw new ProviderSyncError(
      provider,
      "provider_request_failed",
      `${providerDisplayName(provider)} read request failed.`,
      502,
    );
  }

  const rateLimit = headerRateLimit(response.headers, now);
  if (!response.ok) {
    throw new ProviderSyncError(
      provider,
      response.status === 429
        ? "provider_rate_limited"
        : "provider_request_failed",
      response.status === 429
        ? `${providerDisplayName(provider)} rate limited the read request.`
        : `${providerDisplayName(provider)} rejected the read request.`,
      response.status,
      rateLimit,
    );
  }

  const body = await readBoundedBody(response, provider);
  try {
    return {
      value: JSON.parse(body),
      headers: response.headers,
    };
  } catch {
    throw malformedResponse(provider);
  }
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function shopifyRateLimit(
  value: unknown,
  headers: Headers,
  now: Date,
): ProviderRateLimitMetadata {
  const metadata = headerRateLimit(headers, now);
  const root = optionalRecord(value);
  const extensions = optionalRecord(root?.extensions);
  const cost = optionalRecord(extensions?.cost);
  const throttle = optionalRecord(cost?.throttleStatus);
  const maximumAvailable = finiteNonNegativeNumber(throttle?.maximumAvailable);
  const currentlyAvailable = finiteNonNegativeNumber(
    throttle?.currentlyAvailable,
  );
  const restoreRate = finiteNonNegativeNumber(throttle?.restoreRate);
  if (
    maximumAvailable === undefined ||
    currentlyAvailable === undefined ||
    restoreRate === undefined
  ) {
    return metadata;
  }
  return {
    ...metadata,
    shopifyCost: {
      requested: finiteNonNegativeNumber(cost?.requestedQueryCost) ?? null,
      actual: finiteNonNegativeNumber(cost?.actualQueryCost) ?? null,
      maximumAvailable,
      currentlyAvailable,
      restoreRate,
    },
  };
}

function parseShopifyConnection(
  value: unknown,
  resource: ShopifySyncResource,
  pageSize: number,
): ShopifyConnection {
  const root = requiredRecord(value, "shopify");
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw malformedResponse("shopify");
  }
  const data = requiredRecord(root.data, "shopify");
  const connection = requiredRecord(data[resource], "shopify");
  if (!Array.isArray(connection.nodes) || connection.nodes.length > pageSize) {
    throw malformedResponse("shopify");
  }
  const pageInfo = requiredRecord(connection.pageInfo, "shopify");
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw malformedResponse("shopify");
  }
  if (
    pageInfo.endCursor !== null &&
    pageInfo.endCursor !== undefined &&
    typeof pageInfo.endCursor !== "string"
  ) {
    throw malformedResponse("shopify");
  }
  const endCursor = validateCursor("shopify", pageInfo.endCursor);
  if (pageInfo.hasNextPage && endCursor === null) {
    throw malformedResponse("shopify");
  }
  return {
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      endCursor,
    },
  };
}

function shopifyConsent(
  value: unknown,
): NormalizedSourcePayload["consent"] | undefined {
  const consent = optionalRecord(value);
  const state = consent?.marketingState;
  if (typeof state !== "string") return undefined;
  if (state === "SUBSCRIBED") {
    return { channel: "email", state: "subscribed" };
  }
  if (state === "UNSUBSCRIBED" || state === "NOT_SUBSCRIBED") {
    return { channel: "email", state: "unsubscribed" };
  }
  return { channel: "email", state: "unknown" };
}

function shopifyCustomerName(
  customer: Record<string, unknown>,
): string | undefined {
  const firstName = optionalString(customer.firstName, "shopify", 256);
  const lastName = optionalString(customer.lastName, "shopify", 256);
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  return displayName || undefined;
}

function shopifyCustomerSignal(
  customer: Record<string, unknown>,
): NonNullable<NormalizedSourcePayload["customer"]> {
  const emailAddress = optionalRecord(customer.defaultEmailAddress);
  const phoneNumber = optionalRecord(customer.defaultPhoneNumber);
  const displayName = shopifyCustomerName(customer);
  return {
    externalId: requiredString(customer.id, "shopify", 512),
    ...(optionalString(emailAddress?.emailAddress, "shopify", 512)
      ? {
          email: optionalString(emailAddress?.emailAddress, "shopify", 512),
        }
      : {}),
    ...(optionalString(phoneNumber?.phoneNumber, "shopify", 64)
      ? {
          phone: optionalString(phoneNumber?.phoneNumber, "shopify", 64),
        }
      : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function shopifyCustomerEvent(
  integrationId: string,
  value: unknown,
): SourceEventInput {
  const customer = requiredRecord(value, "shopify");
  const customerSignal = shopifyCustomerSignal(customer);
  const updatedAt = requiredIsoTime(customer.updatedAt, "shopify");
  const createdAt = requiredIsoTime(customer.createdAt, "shopify");
  const amountSpent = optionalRecord(customer.amountSpent);
  const amount = optionalString(amountSpent?.amount, "shopify", 64);
  const currencyCode = optionalString(amountSpent?.currencyCode, "shopify", 8);
  const numberOfOrders =
    typeof customer.numberOfOrders === "number" &&
    Number.isSafeInteger(customer.numberOfOrders) &&
    customer.numberOfOrders >= 0
      ? customer.numberOfOrders
      : undefined;
  const payload: NormalizedSourcePayload = {
    customer: customerSignal,
    ...(shopifyConsent(customer.emailMarketingConsent)
      ? { consent: shopifyConsent(customer.emailMarketingConsent) }
      : {}),
    commerce: {
      createdAt,
      updatedAt,
      ...(numberOfOrders === undefined ? {} : { numberOfOrders }),
      ...(amount && currencyCode
        ? { amountSpent: { amount, currencyCode } }
        : {}),
    },
    source: {
      provider: "shopify",
      resource: "customers",
      id: customerSignal.externalId,
    },
  };
  return {
    integrationId,
    provider: "shopify",
    externalEventId: `shopify.customer:${customerSignal.externalId}:${updatedAt}`,
    eventType: "shopify.customer.snapshot",
    occurredAt: updatedAt,
    customerExternalId: customerSignal.externalId,
    payload,
    signatureVerified: false,
  };
}

function shopifyMoney(value: unknown): Record<string, string> | undefined {
  const moneyBag = optionalRecord(value);
  const shopMoney = optionalRecord(moneyBag?.shopMoney);
  const amount = optionalString(shopMoney?.amount, "shopify", 64);
  const currencyCode = optionalString(shopMoney?.currencyCode, "shopify", 8);
  return amount && currencyCode ? { amount, currencyCode } : undefined;
}

function shopifyLineItems(value: unknown): Record<string, unknown>[] {
  const connection = optionalRecord(value);
  if (!connection) return [];
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 50) {
    throw malformedResponse("shopify");
  }
  return connection.nodes.map((item) => {
    const lineItem = requiredRecord(item, "shopify");
    const quantity = lineItem.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      throw malformedResponse("shopify");
    }
    const variant = optionalRecord(lineItem.variant);
    const product = optionalRecord(variant?.product);
    return {
      id: requiredString(lineItem.id, "shopify", 512),
      name: requiredString(lineItem.name, "shopify", 1_024),
      quantity,
      ...(optionalString(lineItem.sku, "shopify", 512)
        ? { sku: optionalString(lineItem.sku, "shopify", 512) }
        : {}),
      ...(optionalString(variant?.id, "shopify", 512)
        ? { variantId: optionalString(variant?.id, "shopify", 512) }
        : {}),
      ...(optionalString(product?.id, "shopify", 512)
        ? { productId: optionalString(product?.id, "shopify", 512) }
        : {}),
    };
  });
}

function shopifyOrderEvent(
  integrationId: string,
  value: unknown,
): SourceEventInput {
  const order = requiredRecord(value, "shopify");
  const orderId = requiredString(order.id, "shopify", 512);
  const updatedAt = requiredIsoTime(order.updatedAt, "shopify");
  const createdAt = requiredIsoTime(order.createdAt, "shopify");
  const customer = optionalRecord(order.customer);
  const customerSignal = customer ? shopifyCustomerSignal(customer) : undefined;
  const fallbackEmail = optionalString(order.email, "shopify", 512);
  const normalizedCustomer =
    customerSignal ??
    (fallbackEmail
      ? {
          email: fallbackEmail,
        }
      : undefined);
  const lineItemQuantity = order.subtotalLineItemsQuantity;
  if (
    lineItemQuantity !== null &&
    lineItemQuantity !== undefined &&
    (typeof lineItemQuantity !== "number" ||
      !Number.isSafeInteger(lineItemQuantity) ||
      lineItemQuantity < 0)
  ) {
    throw malformedResponse("shopify");
  }
  const total = shopifyMoney(order.currentTotalPriceSet);
  const payload: NormalizedSourcePayload = {
    ...(normalizedCustomer ? { customer: normalizedCustomer } : {}),
    commerce: {
      orderId,
      name: requiredString(order.name, "shopify", 512),
      createdAt,
      updatedAt,
      ...(optionalIsoTime(order.processedAt, "shopify")
        ? { processedAt: optionalIsoTime(order.processedAt, "shopify") }
        : {}),
      ...(optionalIsoTime(order.cancelledAt, "shopify")
        ? { cancelledAt: optionalIsoTime(order.cancelledAt, "shopify") }
        : {}),
      ...(optionalString(order.displayFinancialStatus, "shopify", 128)
        ? {
            financialStatus: optionalString(
              order.displayFinancialStatus,
              "shopify",
              128,
            ),
          }
        : {}),
      ...(optionalString(order.displayFulfillmentStatus, "shopify", 128)
        ? {
            fulfillmentStatus: optionalString(
              order.displayFulfillmentStatus,
              "shopify",
              128,
            ),
          }
        : {}),
      ...(lineItemQuantity === null || lineItemQuantity === undefined
        ? {}
        : { lineItemQuantity }),
      ...(total ? { total } : {}),
      lineItems: shopifyLineItems(order.lineItems),
    },
    source: {
      provider: "shopify",
      resource: "orders",
      id: orderId,
    },
  };
  return {
    integrationId,
    provider: "shopify",
    externalEventId: `shopify.order:${orderId}:${updatedAt}`,
    eventType: "shopify.order.snapshot",
    occurredAt: updatedAt,
    ...(customerSignal?.externalId
      ? { customerExternalId: customerSignal.externalId }
      : {}),
    payload,
    signatureVerified: false,
  };
}

function shopifySearchQuery(
  lifecycle: ProviderSyncLifecycle,
  watermark: string | null,
): string | null {
  if (lifecycle === "historical_backfill" || watermark === null) {
    return null;
  }
  return `updated_at:>='${watermark}'`;
}

export class ShopifyProviderSyncClient implements ProviderSyncLifecycleClient<ShopifySyncResource> {
  readonly provider = "shopify" as const;
  readonly #origin: string;
  readonly #accessToken: string;
  readonly #fetch: FetchImplementation;
  readonly #now: () => Date;

  constructor(options: ShopifyProviderSyncClientOptions) {
    this.#origin = validateShopifyOrigin(options.shopDomain);
    this.#accessToken = validateCredential("shopify", options.accessToken);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  historicalBackfillPage(
    input: ProviderSyncPageInput<ShopifySyncResource>,
  ): Promise<ProviderSyncPage<ShopifySyncResource>> {
    return this.#readPage("historical_backfill", input);
  }

  incrementalPollPage(
    input: ProviderSyncPageInput<ShopifySyncResource>,
  ): Promise<ProviderSyncPage<ShopifySyncResource>> {
    return this.#readPage("incremental_poll", input);
  }

  reconciliationPage(
    input: ProviderSyncPageInput<ShopifySyncResource>,
  ): Promise<ProviderSyncPage<ShopifySyncResource>> {
    return this.#readPage("reconciliation", input);
  }

  async #readPage(
    lifecycle: ProviderSyncLifecycle,
    input: ProviderSyncPageInput<ShopifySyncResource>,
  ): Promise<ProviderSyncPage<ShopifySyncResource>> {
    const integrationId = validateIntegrationId("shopify", input.integrationId);
    if (input.resource !== "customers" && input.resource !== "orders") {
      throw new ProviderSyncError(
        "shopify",
        "invalid_request",
        "The Shopify synchronization resource is invalid.",
        400,
      );
    }
    const cursor = validateCursor("shopify", input.checkpoint?.cursor);
    const watermark = validateWatermark("shopify", input.checkpoint?.watermark);
    const pendingWatermark = validateWatermark(
      "shopify",
      input.checkpoint?.pendingWatermark,
    );
    const pageSize = validatePageSize("shopify", input.pageSize, 100);
    const query =
      input.resource === "customers"
        ? SHOPIFY_CUSTOMERS_QUERY
        : SHOPIFY_ORDERS_QUERY;
    const endpoint = new URL(
      `/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      this.#origin,
    );
    const now = this.#now();
    const response = await fetchBoundedJson(
      "shopify",
      this.#fetch,
      endpoint,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-shopify-access-token": this.#accessToken,
        },
        body: JSON.stringify({
          query,
          variables: {
            first: pageSize,
            after: cursor,
            query: shopifySearchQuery(lifecycle, watermark),
          },
        }),
      },
      now,
    );
    const connection = parseShopifyConnection(
      response.value,
      input.resource,
      pageSize,
    );
    const events = connection.nodes.map((node) =>
      input.resource === "customers"
        ? shopifyCustomerEvent(integrationId, node)
        : shopifyOrderEvent(integrationId, node),
    );
    const hasMore = connection.pageInfo.hasNextPage;
    const observedWatermark = advanceWatermark(
      pendingWatermark ?? watermark,
      events.map(({ occurredAt }) => occurredAt),
    );
    return {
      provider: "shopify",
      lifecycle,
      resource: input.resource,
      events,
      checkpoint: {
        cursor: hasMore ? connection.pageInfo.endCursor : null,
        watermark: hasMore ? watermark : observedWatermark,
        pendingWatermark: hasMore ? observedWatermark : null,
      },
      hasMore,
      rateLimit: shopifyRateLimit(response.value, response.headers, now),
    };
  }
}

function klaviyoEndpoint(resource: KlaviyoSyncResource): URL {
  return new URL(`/api/${resource}`, KLAVIYO_ORIGIN);
}

function klaviyoFilter(
  resource: KlaviyoSyncResource,
  lifecycle: ProviderSyncLifecycle,
  watermark: string | null,
): string | null {
  if (lifecycle === "historical_backfill" || watermark === null) {
    return null;
  }
  const field = resource === "profiles" ? "updated" : "datetime";
  return `greater-or-equal(${field},${watermark})`;
}

function addKlaviyoReadParameters(
  url: URL,
  resource: KlaviyoSyncResource,
  lifecycle: ProviderSyncLifecycle,
  pageSize: number,
  cursor: string | null,
  watermark: string | null,
): void {
  url.searchParams.set("page[size]", String(pageSize));
  const sortField = resource === "profiles" ? "updated" : "datetime";
  url.searchParams.set(
    "sort",
    lifecycle === "historical_backfill" ? `-${sortField}` : sortField,
  );
  if (cursor) {
    url.searchParams.set("page[cursor]", cursor);
  }
  const filter = klaviyoFilter(resource, lifecycle, watermark);
  if (filter) {
    url.searchParams.set("filter", filter);
  }
  if (resource === "profiles") {
    url.searchParams.set(
      "fields[profile]",
      "email,phone_number,first_name,last_name,created,updated,properties,subscriptions",
    );
    url.searchParams.set("additional-fields[profile]", "subscriptions");
    return;
  }
  url.searchParams.set(
    "fields[event]",
    "datetime,timestamp,event_properties,uuid",
  );
  url.searchParams.set(
    "fields[profile]",
    "email,phone_number,first_name,last_name,properties",
  );
  url.searchParams.set("fields[metric]", "name");
  url.searchParams.set("include", "profile,metric");
}

function parseKlaviyoNextCursor(
  value: unknown,
  resource: KlaviyoSyncResource,
): string | null {
  if (value === null || value === undefined) return null;
  const next = requiredString(value, "klaviyo", 8_192);
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw malformedResponse("klaviyo");
  }
  if (
    url.origin !== KLAVIYO_ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.replace(/\/+$/u, "") !== `/api/${resource}` ||
    url.hash
  ) {
    throw malformedResponse("klaviyo");
  }
  const cursors = url.searchParams.getAll("page[cursor]");
  if (cursors.length !== 1) {
    throw malformedResponse("klaviyo");
  }
  return validateCursor("klaviyo", cursors[0]);
}

function parseKlaviyoDocument(
  value: unknown,
  resource: KlaviyoSyncResource,
  pageSize: number,
): KlaviyoDocument {
  const root = requiredRecord(value, "klaviyo");
  if (!Array.isArray(root.data) || root.data.length > pageSize) {
    throw malformedResponse("klaviyo");
  }
  const links = requiredRecord(root.links, "klaviyo");
  const included = root.included;
  if (included !== undefined && !Array.isArray(included)) {
    throw malformedResponse("klaviyo");
  }
  return {
    data: root.data,
    included: included ?? [],
    nextCursor: parseKlaviyoNextCursor(links.next, resource),
  };
}

function filteredProperties(
  value: unknown,
  selection: {
    mode: KlaviyoPropertyAccessMode;
    allowlist: ReadonlySet<string>;
  },
): Record<string, unknown> {
  const properties = optionalRecord(value);
  if (!properties) return {};
  const keys =
    selection.mode === "all"
      ? Object.keys(properties).filter(isSafeKlaviyoPropertyName)
      : [...selection.allowlist].filter((key) =>
          Object.hasOwn(properties, key),
        );
  if (keys.length > MAX_KLAVIYO_PROPERTIES_PER_RESOURCE) {
    throw malformedResponse("klaviyo");
  }
  return Object.fromEntries(keys.map((key) => [key, properties[key]]));
}

function klaviyoTraits(
  value: unknown,
  selection: {
    mode: KlaviyoPropertyAccessMode;
    allowlist: ReadonlySet<string>;
  },
): NonNullable<NormalizedSourcePayload["traits"]> {
  return Object.entries(filteredProperties(value, selection)).map(
    ([key, propertyValue]) => ({
      key: `klaviyo.${key}`,
      value: propertyValue,
      evidenceKind: "imported",
      sensitivity: "personal",
      confidence: 1,
    }),
  );
}

export function isApprovedKlaviyoTraitKey(
  traitKey: string,
  propertyAccessMode: KlaviyoPropertyAccessMode,
  allowlist: readonly string[],
): boolean {
  const prefix = "klaviyo.";
  if (!traitKey.startsWith(prefix)) return false;
  const propertyName = traitKey.slice(prefix.length);
  return (
    isSafeKlaviyoPropertyName(propertyName) &&
    (propertyAccessMode === "all" || allowlist.includes(propertyName))
  );
}

function klaviyoConsent(
  value: unknown,
): NormalizedSourcePayload["consent"] | undefined {
  const subscriptions = optionalRecord(value);
  const email = optionalRecord(subscriptions?.email);
  const marketing = optionalRecord(email?.marketing);
  const suppressions = marketing?.suppression;
  if (Array.isArray(suppressions) && suppressions.length > 0) {
    return { channel: "email", state: "suppressed" };
  }
  const consent =
    typeof marketing?.consent === "string"
      ? marketing.consent.toLocaleUpperCase("en-US")
      : undefined;
  if (consent === "SUBSCRIBED") {
    return { channel: "email", state: "subscribed" };
  }
  if (consent === "UNSUBSCRIBED" || consent === "NEVER_SUBSCRIBED") {
    return { channel: "email", state: "unsubscribed" };
  }
  return consent ? { channel: "email", state: "unknown" } : undefined;
}

function klaviyoCustomerSignal(
  id: string,
  attributes: Record<string, unknown>,
): NonNullable<NormalizedSourcePayload["customer"]> {
  const firstName = optionalString(attributes.first_name, "klaviyo", 256);
  const lastName = optionalString(attributes.last_name, "klaviyo", 256);
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const email = optionalString(attributes.email, "klaviyo", 512);
  const phone = optionalString(attributes.phone_number, "klaviyo", 64);
  return {
    externalId: id,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function klaviyoResource(
  value: unknown,
  expectedType: string,
): {
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
} {
  const resource = requiredRecord(value, "klaviyo");
  if (resource.type !== expectedType) {
    throw malformedResponse("klaviyo");
  }
  return {
    id: requiredString(resource.id, "klaviyo", 512),
    attributes: requiredRecord(resource.attributes, "klaviyo"),
    relationships: optionalRecord(resource.relationships) ?? {},
  };
}

function klaviyoProfileEvent(
  integrationId: string,
  value: unknown,
  selection: {
    mode: KlaviyoPropertyAccessMode;
    allowlist: ReadonlySet<string>;
  },
): SourceEventInput {
  const profile = klaviyoResource(value, "profile");
  const updatedAt = requiredIsoTime(profile.attributes.updated, "klaviyo");
  const createdAt = optionalIsoTime(profile.attributes.created, "klaviyo");
  const customer = klaviyoCustomerSignal(profile.id, profile.attributes);
  const traits = klaviyoTraits(profile.attributes.properties, selection);
  const consent = klaviyoConsent(profile.attributes.subscriptions);
  const payload: NormalizedSourcePayload = {
    customer,
    ...(consent ? { consent } : {}),
    ...(traits.length > 0 ? { traits } : {}),
    source: {
      provider: "klaviyo",
      resource: "profiles",
      id: profile.id,
      ...(createdAt ? { createdAt } : {}),
      updatedAt,
      approvedProperties: filteredProperties(
        profile.attributes.properties,
        selection,
      ),
    },
  };
  return {
    integrationId,
    provider: "klaviyo",
    externalEventId: `klaviyo.profile:${profile.id}:${updatedAt}`,
    eventType: "klaviyo.profile.snapshot",
    occurredAt: updatedAt,
    customerExternalId: profile.id,
    payload,
    signatureVerified: false,
  };
}

function relationshipId(
  relationships: Record<string, unknown>,
  name: string,
): string | undefined {
  const relationship = optionalRecord(relationships[name]);
  const data = optionalRecord(relationship?.data);
  if (!data) return undefined;
  return optionalString(data.id, "klaviyo", 512);
}

function includedResourceMap(
  included: readonly unknown[],
): {
  resources: Map<string, Record<string, unknown>>;
  rejectedCount: number;
} {
  const resources = new Map<string, Record<string, unknown>>();
  let rejectedCount = 0;
  for (const value of included) {
    try {
      const resource = requiredRecord(value, "klaviyo");
      const type = requiredString(resource.type, "klaviyo", 64);
      const id = requiredString(resource.id, "klaviyo", 512);
      if (type !== "profile" && type !== "metric") {
        continue;
      }
      resources.set(`${type}:${id}`, resource);
    } catch (error) {
      if (
        error instanceof ProviderSyncError &&
        error.code === "malformed_provider_response"
      ) {
        rejectedCount += 1;
        continue;
      }
      throw error;
    }
  }
  return { resources, rejectedCount };
}

function klaviyoEventOccurredAt(attributes: Record<string, unknown>): string {
  return (
    optionalIsoTime(attributes.datetime, "klaviyo") ??
    numericTimestamp(attributes.timestamp, "klaviyo") ??
    (() => {
      throw malformedResponse("klaviyo");
    })()
  );
}

function klaviyoDeliveryEvent(
  integrationId: string,
  value: unknown,
  included: ReadonlyMap<string, Record<string, unknown>>,
  selection: {
    mode: KlaviyoPropertyAccessMode;
    allowlist: ReadonlySet<string>;
  },
): SourceEventInput {
  const event = klaviyoResource(value, "event");
  const occurredAt = klaviyoEventOccurredAt(event.attributes);
  const profileId = relationshipId(event.relationships, "profile");
  const metricId = relationshipId(event.relationships, "metric");
  const includedProfile = profileId
    ? included.get(`profile:${profileId}`)
    : undefined;
  const includedMetric = metricId
    ? included.get(`metric:${metricId}`)
    : undefined;
  const profileAttributes = includedProfile
    ? requiredRecord(includedProfile.attributes, "klaviyo")
    : undefined;
  const metricAttributes = includedMetric
    ? requiredRecord(includedMetric.attributes, "klaviyo")
    : undefined;
  const metricName = optionalString(metricAttributes?.name, "klaviyo", 512);
  const approvedEventProperties = filteredProperties(
    event.attributes.event_properties,
    selection,
  );
  const payload: NormalizedSourcePayload = {
    ...(profileId && profileAttributes
      ? {
          customer: klaviyoCustomerSignal(profileId, profileAttributes),
        }
      : {}),
    delivery: {
      eventId: event.id,
      ...(metricId ? { metricId } : {}),
      ...(metricName ? { metricName } : {}),
      approvedProperties: approvedEventProperties,
    },
    source: {
      provider: "klaviyo",
      resource: "events",
      id: event.id,
    },
  };
  const uuid = optionalString(event.attributes.uuid, "klaviyo", 512);
  return {
    integrationId,
    provider: "klaviyo",
    externalEventId: `klaviyo.event:${uuid ?? event.id}`,
    eventType: "klaviyo.event",
    occurredAt,
    ...(profileId ? { customerExternalId: profileId } : {}),
    payload,
    signatureVerified: false,
  };
}

export class KlaviyoProviderSyncClient implements ProviderSyncLifecycleClient<KlaviyoSyncResource> {
  readonly provider = "klaviyo" as const;
  readonly #privateApiKey: string;
  readonly #propertySelection: {
    mode: KlaviyoPropertyAccessMode;
    allowlist: ReadonlySet<string>;
  };
  readonly #fetch: FetchImplementation;
  readonly #now: () => Date;

  constructor(options: KlaviyoProviderSyncClientOptions) {
    this.#privateApiKey = validateCredential("klaviyo", options.privateApiKey);
    this.#propertySelection = validatePropertySelection(
      options.propertyAccessMode ?? "allowlist",
      options.propertyAllowlist,
    );
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  historicalBackfillPage(
    input: ProviderSyncPageInput<KlaviyoSyncResource>,
  ): Promise<ProviderSyncPage<KlaviyoSyncResource>> {
    return this.#readPage("historical_backfill", input);
  }

  incrementalPollPage(
    input: ProviderSyncPageInput<KlaviyoSyncResource>,
  ): Promise<ProviderSyncPage<KlaviyoSyncResource>> {
    return this.#readPage("incremental_poll", input);
  }

  reconciliationPage(
    input: ProviderSyncPageInput<KlaviyoSyncResource>,
  ): Promise<ProviderSyncPage<KlaviyoSyncResource>> {
    return this.#readPage("reconciliation", input);
  }

  async #readPage(
    lifecycle: ProviderSyncLifecycle,
    input: ProviderSyncPageInput<KlaviyoSyncResource>,
  ): Promise<ProviderSyncPage<KlaviyoSyncResource>> {
    const integrationId = validateIntegrationId("klaviyo", input.integrationId);
    if (input.resource !== "profiles" && input.resource !== "events") {
      throw new ProviderSyncError(
        "klaviyo",
        "invalid_request",
        "The Klaviyo synchronization resource is invalid.",
        400,
      );
    }
    const cursor = validateCursor("klaviyo", input.checkpoint?.cursor);
    const watermark = validateWatermark("klaviyo", input.checkpoint?.watermark);
    const pendingWatermark = validateWatermark(
      "klaviyo",
      input.checkpoint?.pendingWatermark,
    );
    const pageSize = validatePageSize(
      "klaviyo",
      input.pageSize,
      input.resource === "profiles" ? 100 : 200,
    );
    const endpoint = klaviyoEndpoint(input.resource);
    addKlaviyoReadParameters(
      endpoint,
      input.resource,
      lifecycle,
      pageSize,
      cursor,
      watermark,
    );
    const now = this.#now();
    const response = await fetchBoundedJson(
      "klaviyo",
      this.#fetch,
      endpoint,
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/vnd.api+json",
          authorization: `Klaviyo-API-Key ${this.#privateApiKey}`,
          revision: KLAVIYO_API_REVISION,
        },
      },
      now,
    );
    const document = parseKlaviyoDocument(
      response.value,
      input.resource,
      pageSize,
    );
    const included = includedResourceMap(document.included);
    const events: SourceEventInput[] = [];
    let rejectedCount = included.rejectedCount;
    for (const item of document.data) {
      try {
        events.push(
          input.resource === "profiles"
            ? klaviyoProfileEvent(integrationId, item, this.#propertySelection)
            : klaviyoDeliveryEvent(
                integrationId,
                item,
                included.resources,
                this.#propertySelection,
              ),
        );
      } catch (error) {
        if (
          error instanceof ProviderSyncError &&
          error.code === "malformed_provider_response"
        ) {
          rejectedCount += 1;
          continue;
        }
        throw error;
      }
    }
    const hasMore = document.nextCursor !== null;
    const observedWatermark = advanceWatermark(
      pendingWatermark ?? watermark,
      events.map(({ occurredAt }) => occurredAt),
    );
    return {
      provider: "klaviyo",
      lifecycle,
      resource: input.resource,
      events,
      rejectedCount,
      checkpoint: {
        cursor: document.nextCursor,
        watermark: hasMore ? watermark : observedWatermark,
        pendingWatermark: hasMore ? observedWatermark : null,
      },
      hasMore,
      rateLimit: headerRateLimit(response.headers, now),
    };
  }
}
