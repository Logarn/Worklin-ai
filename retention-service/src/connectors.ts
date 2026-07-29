import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  RetentionServiceError,
  type NormalizedSourcePayload,
  type RetentionProvider,
  type SourceEventInput,
} from "./types.js";

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function stringValue(
  value: unknown,
  ...keys: string[]
): string | undefined {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim()
    ? current.trim()
    : undefined;
}

function recordValue(
  value: unknown,
  ...keys: string[]
): Record<string, unknown> | undefined {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

function isoTime(value: unknown, fallback: Date): string {
  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

function parseJsonBody(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new RetentionServiceError(
      "invalid_webhook_payload",
      "The provider webhook payload is invalid.",
      400,
    );
  }
}

export interface ConnectorWebhookInput {
  integrationId: string;
  headers: Headers;
  rawBody: Uint8Array;
  secret: string;
  now?: Date;
}

export interface RetentionConnector {
  readonly provider: RetentionProvider;
  verifyWebhook(input: ConnectorWebhookInput): boolean;
  normalizeWebhook(input: ConnectorWebhookInput): SourceEventInput[];
}

export class ShopifyRetentionConnector implements RetentionConnector {
  readonly provider = "shopify" as const;

  verifyWebhook(input: ConnectorWebhookInput): boolean {
    const provided = input.headers.get("x-shopify-hmac-sha256");
    if (!provided) return false;
    let decoded: Buffer;
    try {
      decoded = Buffer.from(provided, "base64");
    } catch {
      return false;
    }
    const expected = createHmac("sha256", input.secret)
      .update(input.rawBody)
      .digest();
    return safeEqual(decoded, expected);
  }

  normalizeWebhook(input: ConnectorWebhookInput): SourceEventInput[] {
    const payload = parseJsonBody(input.rawBody);
    const record = recordValue(payload) ?? {};
    const topic =
      input.headers.get("x-shopify-topic")?.trim() || "shopify.unknown";
    const externalEventId =
      input.headers.get("x-shopify-webhook-id")?.trim() ||
      createHmac("sha256", input.secret)
        .update(input.rawBody)
        .digest("hex");
    const customer =
      recordValue(record, "customer") ??
      (topic.startsWith("customers/") ? record : undefined);
    const email =
      stringValue(customer, "email") ??
      stringValue(record, "email") ??
      stringValue(record, "contact_email");
    const phone =
      stringValue(customer, "phone") ?? stringValue(record, "phone");
    const externalCustomerId =
      customer?.id === undefined ? undefined : String(customer.id);
    const acceptsMarketing =
      customer?.email_marketing_consent &&
      typeof customer.email_marketing_consent === "object"
        ? stringValue(customer, "email_marketing_consent", "state")
        : undefined;
    const normalized: NormalizedSourcePayload = {
      customer:
        externalCustomerId || email || phone
          ? {
              ...(externalCustomerId
                ? { externalId: externalCustomerId }
                : {}),
              ...(email ? { email } : {}),
              ...(phone ? { phone } : {}),
              ...(stringValue(customer, "first_name") ||
              stringValue(customer, "last_name")
                ? {
                    displayName: [
                      stringValue(customer, "first_name"),
                      stringValue(customer, "last_name"),
                    ]
                      .filter(Boolean)
                      .join(" "),
                  }
                : {}),
            }
          : undefined,
      ...(acceptsMarketing
        ? {
            consent: {
              channel: "email" as const,
              state:
                acceptsMarketing === "subscribed"
                  ? ("subscribed" as const)
                  : ("unsubscribed" as const),
            },
          }
        : {}),
      ...(topic.startsWith("orders/") ||
      topic.startsWith("refunds/") ||
      topic.startsWith("fulfillments/")
        ? { commerce: record }
        : {}),
      source: { topic, payload: record },
    };
    return [
      {
        integrationId: input.integrationId,
        provider: this.provider,
        externalEventId,
        eventType: topic,
        occurredAt: isoTime(
          record.updated_at ?? record.created_at,
          input.now ?? new Date(),
        ),
        ...(externalCustomerId
          ? { customerExternalId: externalCustomerId }
          : {}),
        payload: normalized,
        signatureVerified: true,
      },
    ];
  }
}

export class KlaviyoRetentionConnector implements RetentionConnector {
  readonly provider = "klaviyo" as const;

  verifyWebhook(input: ConnectorWebhookInput): boolean {
    const signature = input.headers.get("klaviyo-signature");
    const timestamp = input.headers.get("klaviyo-timestamp");
    if (!signature || !timestamp) return false;
    const timestampMs = new Date(timestamp).getTime();
    const nowMs = (input.now ?? new Date()).getTime();
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(nowMs - timestampMs) > 5 * 60 * 1000
    ) {
      return false;
    }
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "hex");
    } catch {
      return false;
    }
    const expected = createHmac("sha256", input.secret)
      .update(input.rawBody)
      .update(timestamp)
      .digest();
    return safeEqual(provided, expected);
  }

  normalizeWebhook(input: ConnectorWebhookInput): SourceEventInput[] {
    const parsed = parseJsonBody(input.rawBody);
    const data = recordValue(parsed)?.data;
    if (!Array.isArray(data)) {
      throw new RetentionServiceError(
        "invalid_webhook_payload",
        "The Klaviyo webhook payload does not contain events.",
        400,
      );
    }
    return data.map((item, index) => {
      const record = recordValue(item) ?? {};
      const payload = recordValue(record, "payload") ?? {};
      const eventData = recordValue(payload, "data") ?? {};
      const attributes = recordValue(eventData, "attributes") ?? {};
      const relationships = recordValue(eventData, "relationships") ?? {};
      const profileRelationship =
        recordValue(relationships, "profile", "data") ?? {};
      const profile =
        recordValue(payload, "included") ??
        recordValue(attributes, "profile") ??
        {};
      const eventProperties =
        recordValue(attributes, "event_properties") ?? {};
      const topic =
        stringValue(record, "topic") ?? "event:klaviyo.unknown";
      const externalEventId =
        stringValue(record, "external_id") ??
        stringValue(eventData, "id") ??
        `${input.headers.get("klaviyo-webhook-id") ?? "batch"}:${index}`;
      const profileId =
        stringValue(profileRelationship, "id") ??
        stringValue(profile, "id") ??
        stringValue(eventProperties, "Klaviyo Profile ID");
      const email =
        stringValue(profile, "attributes", "email") ??
        stringValue(eventProperties, "Email");
      const consentState = topic.includes("unsubscribed")
        ? "unsubscribed"
        : topic.includes("suppressed")
          ? "suppressed"
          : topic.includes("subscribed")
            ? "subscribed"
            : undefined;
      const normalized: NormalizedSourcePayload = {
        customer:
          profileId || email
            ? {
                ...(profileId ? { externalId: profileId } : {}),
                ...(email ? { email } : {}),
              }
            : undefined,
        ...(consentState
          ? {
              consent: {
                channel: topic.includes("sms")
                  ? ("sms" as const)
                  : ("email" as const),
                state: consentState,
              },
            }
          : {}),
        delivery: {
          topic,
          eventProperties,
        },
        source: { topic, payload },
      };
      return {
        integrationId: input.integrationId,
        provider: this.provider,
        externalEventId,
        eventType: topic,
        occurredAt: isoTime(
          attributes.datetime ?? attributes.timestamp,
          input.now ?? new Date(),
        ),
        ...(profileId ? { customerExternalId: profileId } : {}),
        payload: normalized,
        signatureVerified: true,
      };
    });
  }
}

const connectors: Record<RetentionProvider, RetentionConnector> = {
  shopify: new ShopifyRetentionConnector(),
  klaviyo: new KlaviyoRetentionConnector(),
};

export function retentionConnector(
  provider: RetentionProvider,
): RetentionConnector {
  return connectors[provider];
}
