import {
  ApiKeySession,
  ProfilesApi,
  ListsApi,
  EventsApi,
  ProfileEnum,
  ListEnum,
  MetricEnum,
  EventEnum,
} from "klaviyo-api";
import { prisma } from "@/lib/prisma";
import { SEGMENT_LABELS } from "@/lib/constants";
import { blockLegacyExternalExecution } from "@/lib/legacy-execution-gate";

type KlaviyoClient = {
  profiles: ProfilesApi;
  lists: ListsApi;
  events: EventsApi;
};

export const klaviyoClient: KlaviyoClient | null = process.env.KLAVIYO_API_KEY
  ? {
      profiles: new ProfilesApi(new ApiKeySession(process.env.KLAVIYO_API_KEY)),
      lists: new ListsApi(new ApiKeySession(process.env.KLAVIYO_API_KEY)),
      events: new EventsApi(new ApiKeySession(process.env.KLAVIYO_API_KEY)),
    }
  : null;

function ensureKlaviyoClient() {
  if (!klaviyoClient || !process.env.KLAVIYO_API_KEY) {
    throw new Error("Klaviyo is not configured. Set KLAVIYO_API_KEY.");
  }
  return klaviyoClient;
}

export async function syncProfilesToKlaviyo(limit = 500) {
  blockLegacyExternalExecution("Klaviyo profile sync");
  const client = ensureKlaviyoClient();
  const customers = await prisma.customer.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
  });

  let synced = 0;
  const errors: string[] = [];

  for (const customer of customers) {
    try {
      await client.profiles.createOrUpdateProfile({
        data: {
          type: ProfileEnum.Profile,
          attributes: {
            email: customer.email,
            phoneNumber: customer.phone ?? undefined,
            firstName: customer.firstName ?? undefined,
            lastName: customer.lastName ?? undefined,
            properties: {
              totalOrders: customer.totalOrders,
              totalSpent: customer.totalSpent,
              avgOrderValue: customer.avgOrderValue,
              segment: customer.segment,
              churnRiskScore: customer.churnRiskScore,
            },
          },
        },
      });
      synced += 1;
    } catch (error) {
      errors.push(
        `Failed profile ${customer.email}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { total: customers.length, synced, failed: errors.length, errors };
}

export async function syncSegmentsToKlaviyo() {
  blockLegacyExternalExecution("Klaviyo segment sync");
  const client = ensureKlaviyoClient();
  const grouped = await prisma.customer.groupBy({
    by: ["segment"],
    _count: { _all: true },
  });

  const results: Array<{ segment: string; count: number; status: string; detail?: string }> = [];
  for (const row of grouped) {
    const segmentKey = row.segment || "unclassified";
    const segmentName = SEGMENT_LABELS[segmentKey] ?? segmentKey;

    try {
      const list = await client.lists.createList({
        data: {
          type: ListEnum.List,
          attributes: {
            name: `Retention Segment - ${segmentName}`,
          },
        },
      });

      // Attempt to hydrate list membership with profile IDs (best effort).
      const profiles = await prisma.customer.findMany({
        where: { segment: row.segment },
        select: { email: true },
        take: 250,
      });
      for (const profile of profiles) {
        if (!profile.email) continue;
        const upsert = await client.profiles.createOrUpdateProfile({
          data: {
            type: ProfileEnum.Profile,
            attributes: { email: profile.email },
          },
        });
        const profileId = upsert.body?.data?.id;
        const listId = list.body?.data?.id;
        if (profileId && listId) {
          await client.lists.addProfilesToList(listId, {
            data: [{ type: ProfileEnum.Profile, id: profileId }],
          });
        }
      }

      results.push({ segment: segmentKey, count: row._count._all, status: "created_or_exists" });
    } catch (error) {
      results.push({
        segment: segmentKey,
        count: row._count._all,
        status: "failed",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return {
    totalSegments: grouped.length,
    success: results.filter((r) => r.status !== "failed").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

export async function sendKlaviyoCampaignMessage(input: {
  channel: "email" | "sms";
  recipients: string[];
  subject?: string;
  body: string;
}) {
  blockLegacyExternalExecution("Klaviyo send");
  const client = ensureKlaviyoClient();
  const recipients = Array.from(new Set(input.recipients.filter(Boolean)));
  if (!recipients.length) {
    throw new Error("At least one recipient is required.");
  }

  if (input.channel === "email") {
    await client.events.createEvent({
      data: {
        type: EventEnum.Event,
        attributes: {
          metric: { data: { type: MetricEnum.Metric, attributes: { name: "Retention Email Sent" } } },
          profile: {
            data: {
              type: ProfileEnum.Profile,
              attributes: { email: recipients[0] },
            },
          },
          properties: {
            subject: input.subject ?? "Retention Campaign",
            body: input.body,
            recipients,
          },
          time: new Date(),
          value: 0,
          uniqueId: `retention-email-${Date.now()}`,
        },
      },
    });
  } else {
    await client.events.createEvent({
      data: {
        type: EventEnum.Event,
        attributes: {
          metric: { data: { type: MetricEnum.Metric, attributes: { name: "Retention SMS Sent" } } },
          profile: {
            data: {
              type: ProfileEnum.Profile,
              attributes: { phoneNumber: recipients[0] },
            },
          },
          properties: {
            message: input.body,
            recipients,
          },
          time: new Date(),
          value: 0,
          uniqueId: `retention-sms-${Date.now()}`,
        },
      },
    });
  }

  return {
    sent: recipients.length,
    channel: input.channel,
    status: "queued_via_klaviyo_event",
  };
}

export async function triggerKlaviyoFlow(flowId: string, profileEmail: string) {
  blockLegacyExternalExecution("Klaviyo flow trigger");
  const client = ensureKlaviyoClient();
  await client.events.createEvent({
    data: {
      type: EventEnum.Event,
      attributes: {
        metric: { data: { type: MetricEnum.Metric, attributes: { name: "Retention Flow Triggered" } } },
        profile: { data: { type: ProfileEnum.Profile, attributes: { email: profileEmail } } },
        properties: {
          flowId,
        },
        time: new Date(),
        uniqueId: `retention-flow-${flowId}-${Date.now()}`,
      },
    },
  });

  return { triggered: true, flowId, profileEmail };
}
