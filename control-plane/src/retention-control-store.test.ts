import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  createRetentionIntegrationBinding,
  ensureRetentionControlSchema,
  getActiveRetentionIntegrationBinding,
  listActiveRetentionWakeTargets,
  replaceRetentionAccessGrants,
  retentionRolesForUser,
  retentionIntegrationCreatePayload,
  retentionIntegrationConnectionPayload,
  setRetentionIntegrationBindingStatus,
} from "./retention-control-store.js";

describe("retention control store", () => {
  test("requires explicit approver and sender grants for non-owners", () => {
    const db = new Database(":memory:");
    ensureRetentionControlSchema(db);
    expect(
      retentionRolesForUser(db, {
        organizationId: "org-1",
        userId: "marketer-1",
        organizationOwnerId: "owner-1",
        workspaceRole: "manager",
      }),
    ).toEqual(["retention_marketer"]);

    replaceRetentionAccessGrants(db, {
      organizationId: "org-1",
      userId: "marketer-1",
      grantedByUserId: "owner-1",
      roles: ["retention_marketer", "retention_campaign_approver"],
      nowIso: "2026-07-28T12:00:00.000Z",
    });
    expect(
      retentionRolesForUser(db, {
        organizationId: "org-1",
        userId: "marketer-1",
        organizationOwnerId: "owner-1",
        workspaceRole: "manager",
      }),
    ).toEqual(["retention_campaign_approver", "retention_marketer"]);
  });

  test("resolves only activated provider bindings", () => {
    const db = new Database(":memory:");
    ensureRetentionControlSchema(db);
    const binding = createRetentionIntegrationBinding(db, {
      organizationId: "org-1",
      assistantId: "assistant-1",
      userId: "owner-1",
      provider: "shopify",
      nowIso: "2026-07-28T12:00:00.000Z",
    });
    expect(
      getActiveRetentionIntegrationBinding(db, {
        id: binding.id,
        provider: "shopify",
      }),
    ).toBeNull();
    setRetentionIntegrationBindingStatus(
      db,
      binding.id,
      "active",
      "2026-07-28T12:01:00.000Z",
    );
    expect(
      getActiveRetentionIntegrationBinding(db, {
        id: binding.id,
        provider: "shopify",
      })?.org_id,
    ).toBe("org-1");
  });

  test("publishes only the opaque control-plane webhook binding", () => {
    const payload = retentionIntegrationConnectionPayload(
      {
        id: "retention-integration-id",
        webhookRouteToken: "service-internal-route-token",
        credential: "must-not-leak",
        webhookSecret: "must-not-leak",
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "klaviyo",
      },
    );
    expect(payload).toEqual({
      id: "retention-integration-id",
      controlPlaneConnectionId: "11111111-1111-4111-8111-111111111111",
      webhookPath:
        "/webhooks/retention/klaviyo/11111111-1111-4111-8111-111111111111",
    });
  });

  test("overwrites client-controlled integration routing secrets", () => {
    expect(
      retentionIntegrationCreatePayload(
        {
          provider: "klaviyo",
          brandId: "11111111-1111-4111-8111-111111111111",
          credential: "private-key-value",
          controlPlaneConnectionId: "client-binding",
          webhookSecret: "client-webhook-secret",
          webhookRouteToken: "client-route-token",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          webhookSecret: "server-webhook-secret",
        },
      ),
    ).toEqual({
      provider: "klaviyo",
      brandId: "11111111-1111-4111-8111-111111111111",
      credential: "private-key-value",
      controlPlaneConnectionId: "22222222-2222-4222-8222-222222222222",
      webhookSecret: "server-webhook-secret",
    });
  });

  test("returns one tenant-scoped wake target per active organization", () => {
    const db = new Database(":memory:");
    ensureRetentionControlSchema(db);
    const first = createRetentionIntegrationBinding(db, {
      organizationId: "org-1",
      assistantId: "assistant-b",
      userId: "owner-1",
      provider: "shopify",
      nowIso: "2026-07-28T12:00:00.000Z",
    });
    const second = createRetentionIntegrationBinding(db, {
      organizationId: "org-1",
      assistantId: "assistant-a",
      userId: "owner-1",
      provider: "klaviyo",
      nowIso: "2026-07-28T12:00:00.000Z",
    });
    createRetentionIntegrationBinding(db, {
      organizationId: "org-2",
      assistantId: "assistant-pending",
      userId: "owner-2",
      provider: "shopify",
      nowIso: "2026-07-28T12:00:00.000Z",
    });
    setRetentionIntegrationBindingStatus(
      db,
      first.id,
      "active",
      "2026-07-28T12:01:00.000Z",
    );
    setRetentionIntegrationBindingStatus(
      db,
      second.id,
      "active",
      "2026-07-28T12:01:00.000Z",
    );

    expect(listActiveRetentionWakeTargets(db)).toEqual([
      { organizationId: "org-1", assistantId: "assistant-a" },
    ]);
  });
});
