import { z } from "zod";

import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/utils/api-errors";

import { throwRetentionResponseError } from "./api-error";

const uuidSchema = z.string().uuid();
const brandSchema = z.object({
  id: uuidSchema,
  name: z.string(),
});
const klaviyoConnectionSchema = z.object({
  id: uuidSchema,
  provider: z.literal("klaviyo"),
  migrationRunId: uuidSchema,
});

export interface ConnectKlaviyoInput {
  brandName: string;
  websiteUrl?: string;
  credential: string;
  propertyAllowlist: string[];
}

export interface RetentionKlaviyoConnection {
  brandId: string;
  brandName: string;
  integrationId: string;
  migrationRunId: string;
}

export async function createRetentionBrand(
  assistantId: string,
  input: { name: string; websiteUrl?: string },
): Promise<z.infer<typeof brandSchema>> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/brands",
    body: input,
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create the brand workspace.");
  if (!response.ok) {
    throwRetentionResponseError(
      response,
      error,
      "Failed to create the brand workspace.",
    );
  }
  const parsed = brandSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention brand response was invalid.");
  }
  return parsed.data;
}

export async function createRetentionKlaviyoIntegration(
  assistantId: string,
  input: {
    brandId: string;
    credential: string;
    propertyAllowlist: string[];
  },
): Promise<z.infer<typeof klaviyoConnectionSchema>> {
  const { data, error, response } = await client.post<unknown, unknown>({
    url: "/v1/retention/integrations",
    body: {
      brandId: input.brandId,
      provider: "klaviyo",
      credential: input.credential,
      propertyAllowlist: input.propertyAllowlist,
    },
    headers: {
      "Content-Type": "application/json",
      "X-Worklin-Assistant-Id": assistantId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to connect Klaviyo.");
  if (!response.ok) {
    throwRetentionResponseError(response, error, "Failed to connect Klaviyo.");
  }
  const parsed = klaviyoConnectionSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Klaviyo connection response was invalid.");
  }
  return parsed.data;
}

export async function connectRetentionKlaviyo(
  assistantId: string,
  input: ConnectKlaviyoInput,
): Promise<RetentionKlaviyoConnection> {
  const brand = await createRetentionBrand(assistantId, {
    name: input.brandName,
    ...(input.websiteUrl ? { websiteUrl: input.websiteUrl } : {}),
  });
  const integration = await createRetentionKlaviyoIntegration(assistantId, {
    brandId: brand.id,
    credential: input.credential,
    propertyAllowlist: input.propertyAllowlist,
  });
  return {
    brandId: brand.id,
    brandName: brand.name,
    integrationId: integration.id,
    migrationRunId: integration.migrationRunId,
  };
}
