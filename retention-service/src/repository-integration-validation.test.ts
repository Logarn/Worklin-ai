import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import type { RetentionDatabase } from "./database.js";
import { RetentionRepository } from "./repository.js";
import type { TenantContext } from "./types.js";

const context: TenantContext = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "integration-owner",
  assistantId: "22222222-2222-4222-8222-222222222222",
  roles: ["retention_owner"],
  permissions: ["retention:integrations"],
  requestId: randomUUID(),
};

function repositoryForStatus(status: number): {
  repository: RetentionRepository;
  persisted: () => boolean;
  requests: Array<{ url: string; method: string | undefined }>;
} {
  let didPersist = false;
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const database = {
    withTenant: async () => {
      didPersist = true;
      throw new Error("Persistence must not run for rejected credentials.");
    },
  } as unknown as RetentionDatabase;
  return {
    repository: new RetentionRepository(
      database,
      new RetentionCrypto(Buffer.alloc(32, 42)),
      {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore: {
          putEncryptedPayload: async () => "unused",
          deleteEncryptedPayload: async () => undefined,
          ready: async () => true,
        },
        providerFetch: async (input, init) => {
          requests.push({
            url: String(input),
            method: init?.method,
          });
          return Response.json(
            { errors: [{ status: String(status) }] },
            { status },
          );
        },
      },
    ),
    persisted: () => didPersist,
    requests,
  };
}

describe("integration credential validation", () => {
  test("validates Klaviyo with a read-only request before persistence", async () => {
    const fixture = repositoryForStatus(401);
    await expect(
      fixture.repository.createIntegration(context, {
        brandId: "33333333-3333-4333-8333-333333333333",
        provider: "klaviyo",
        controlPlaneConnectionId: "connection-example",
        credential: "pk_example_private_key",
        webhookSecret: "example-webhook-secret",
        propertyAllowlist: ["Customer stage"],
      }),
    ).rejects.toMatchObject({
      code: "klaviyo_credentials_rejected",
      status: 401,
    });
    expect(fixture.persisted()).toBe(false);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.method).toBe("GET");
    expect(fixture.requests[0]?.url).toStartWith(
      "https://a.klaviyo.com/api/profiles?",
    );
  });

  test("reports missing Klaviyo read scope distinctly", async () => {
    const fixture = repositoryForStatus(403);
    await expect(
      fixture.repository.createIntegration(context, {
        brandId: "33333333-3333-4333-8333-333333333333",
        provider: "klaviyo",
        controlPlaneConnectionId: "connection-example",
        credential: "pk_example_private_key",
        webhookSecret: "example-webhook-secret",
      }),
    ).rejects.toMatchObject({
      code: "klaviyo_read_scope_required",
      status: 403,
    });
    expect(fixture.persisted()).toBe(false);
  });
});
