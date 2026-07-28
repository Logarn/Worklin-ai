import { describe, expect, test } from "bun:test";

import type { EnabledRetentionServiceConfig } from "./retention-service-config.js";
import { wakeRetentionTenantJobs } from "./retention-job-waker.js";

const config: EnabledRetentionServiceConfig = {
  enabled: true,
  internalBaseUrl: "http://retention-service.railway.internal:8080/",
  serviceJwtSecret: "j".repeat(32),
  providerWebhookSecret: "w".repeat(32),
  tokenTtlSeconds: 30,
  requestTimeoutMs: 1_000,
  maxRequestBodyBytes: 1_024,
};

describe("wakeRetentionTenantJobs", () => {
  test("uses separately signed tenant requests and reports partial failure", async () => {
    const authorizations: string[] = [];
    const result = await wakeRetentionTenantJobs(
      config,
      [
        { organizationId: "org-1", assistantId: "assistant-1" },
        { organizationId: "org-2", assistantId: "assistant-2" },
      ],
      {
        fetch: async (_input, init) => {
          const authorization = new Headers(init?.headers).get(
            "authorization",
          );
          authorizations.push(authorization ?? "");
          const claims = JSON.parse(
            Buffer.from(
              authorization!.slice("Bearer ".length).split(".")[1]!,
              "base64url",
            ).toString("utf8"),
          ) as { organization_id: string; assistant_id: string };
          return Response.json(
            { accepted: claims.organization_id === "org-1" },
            { status: claims.organization_id === "org-1" ? 202 : 503 },
          );
        },
      },
    );

    expect(result).toEqual({ attempted: 2, accepted: 1, failed: 1 });
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).not.toBe(authorizations[1]);
  });

  test("does no work while the service is disabled", async () => {
    expect(
      await wakeRetentionTenantJobs({ enabled: false }, [
        { organizationId: "org-1", assistantId: "assistant-1" },
      ]),
    ).toEqual({ attempted: 0, accepted: 0, failed: 0 });
  });
});
