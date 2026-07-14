import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _setMetadataPath } from "../credentials/metadata-store.js";
import type { ToolContext } from "../types.js";
import { buildLiveReadonlyKlaviyoDatasetFromApiKey } from "./klaviyo-connection.js";
import {
  buildKlaviyoL365AuditForTest,
  executeRetentionAudit,
  executeRetentionAuditStatus,
  executeRetentionBrandBrain,
  executeRetentionComputeCustomerFeatures,
  executeRetentionCreateKlaviyoDraft,
  executeRetentionFindCampaignOpportunities,
  executeRetentionFindMissingPieces,
  executeRetentionGenerateCampaignPackage,
  executeRetentionKlaviyoSnapshot,
  executeRetentionRunQa,
  executeRetentionShopifySnapshot,
  executeRetentionSourceStatus,
  executeRetentionUnifiedCustomerView,
} from "./worklin-retention.js";

const context = {} as ToolContext;
let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "worklin-retention-test-"));
  _setMetadataPath(join(tempDir, "credential-metadata.json"));
});

afterEach(() => {
  _setMetadataPath(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Worklin Retention tools", () => {
  test("source status is read-only and not live", async () => {
    const result = await executeRetentionSourceStatus({}, context);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.safety.externalActionTaken).toBe(false);
    expect(parsed.safety.canGoLiveNow).toBe(false);
  });

  test("source status tolerates conversational onboarding context", async () => {
    const result = await executeRetentionSourceStatus(
      {
        brand_name: "Dr. Rachael Institute",
        website_url: "https://drrachaelinstitute.com",
      },
      context,
    );
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.safety.externalActionTaken).toBe(false);
    expect(parsed.safety.canGoLiveNow).toBe(false);
  });

  test("Brand Brain returns Worklin context and no external action", async () => {
    const result = await executeRetentionBrandBrain({}, context);
    const parsed = JSON.parse(result.content);

    expect(parsed.brandName).toContain("Worklin");
    expect(parsed.rules.length).toBeGreaterThan(0);
    expect(parsed.readiness.status).toBe("partial");
    expect(parsed.compliance.forbiddenClaims.length).toBeGreaterThan(0);
    expect(parsed.sourceProvenance.length).toBeGreaterThan(0);
    expect(parsed.safety.externalActionTaken).toBe(false);
  });

  test("Brand Brain accepts onboarding brand name and website URL", async () => {
    const result = await executeRetentionBrandBrain(
      {
        brand_name: "Dr. Rachael Institute",
        website_url: "https://drrachaelinstitute.com",
      },
      context,
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.brandName).toBe("Dr. Rachael Institute");
    expect(parsed.websiteUrl).toBe("https://drrachaelinstitute.com");
    expect(parsed.readiness.completed).toContain(
      "Brand website/domain provided in onboarding conversation",
    );
    expect(
      parsed.sourceProvenance.some((source: { label?: string }) =>
        source.label?.includes("drrachaelinstitute.com"),
      ),
    ).toBe(true);
  });

  test("Shopify and Klaviyo snapshot tools return safe read-only snapshots", async () => {
    const shopify = JSON.parse(
      (await executeRetentionShopifySnapshot({}, context)).content,
    );
    const klaviyo = JSON.parse(
      (await executeRetentionKlaviyoSnapshot({}, context)).content,
    );

    expect(shopify.platform).toBe("shopify");
    expect(shopify.safety.blockedCapabilities).toContain("shopify_write");
    expect(klaviyo.platform).toBe("klaviyo");
    expect(klaviyo.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
  });

  test("unified customer view exposes matched and caveated identities", async () => {
    const result = await executeRetentionUnifiedCustomerView({}, context);
    const parsed = JSON.parse(result.content);

    expect(parsed.summary.totalIdentities).toBeGreaterThan(0);
    expect(parsed.summary.matchedAcrossSources).toBeGreaterThan(0);
    expect(parsed.summary.shopifyOnly).toBeGreaterThan(0);
  });

  test("feature computation returns retention labels", async () => {
    const result = await executeRetentionComputeCustomerFeatures({}, context);
    const parsed = JSON.parse(result.content);

    expect(parsed.summary.evaluatedCustomers).toBeGreaterThan(0);
    expect(parsed.summary.highPriorityCustomers).toBeGreaterThan(0);
  });

  test("missing pieces and opportunities are blocked from live action", async () => {
    const missingPieces = JSON.parse(
      (await executeRetentionFindMissingPieces({}, context)).content,
    );
    const opportunities = JSON.parse(
      (await executeRetentionFindCampaignOpportunities({}, context)).content,
    );

    expect(missingPieces.summary.total).toBeGreaterThan(0);
    expect(opportunities.summary.draftOnly).toBe(true);
    expect(opportunities.safety.blockedCapabilities).toContain(
      "klaviyo_send_campaign",
    );
  });

  test("campaign package and QA require approval", async () => {
    const campaignPackage = JSON.parse(
      (await executeRetentionGenerateCampaignPackage({}, context)).content,
    );
    const qa = JSON.parse((await executeRetentionRunQa({}, context)).content);

    expect(campaignPackage.status).toBe("package_only");
    expect(campaignPackage.approvalStatus).toBe("required");
    expect(qa.approvalStatus).toBe("required");
    expect(qa.safety.canGoLiveNow).toBe(false);
  });

  test("real-client audit blocks when live source coverage is incomplete", async () => {
    const result = await executeRetentionAudit({}, context);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.status).toBe("blocked");
    expect(parsed.title).toContain("Real Source Data Required");
    expect(parsed.readiness.canRunFullAudit).toBe(false);
    expect(parsed.safety.externalActionTaken).toBe(false);
    expect(parsed.reason).toContain("will not produce");
  });

  test("audit status reports full-audit readiness blockers", async () => {
    const result = await executeRetentionAuditStatus({}, context);
    const parsed = JSON.parse(result.content);

    expect(parsed.status).toBe("blocked");
    expect(parsed.canRunFullAudit).toBe(false);
    expect(parsed.readiness.blockers.length).toBeGreaterThan(0);
    expect(parsed.safety.externalActionTaken).toBe(false);
  });

  test("explicit fixture audit produces the first milestone demo result", async () => {
    const result = await executeRetentionAudit(
      { allow_fixture_data: true },
      context,
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.title).toBe("Deep Retention Audit");
    expect(parsed.brandName).toContain("Worklin");
    expect(parsed.modulePreview.length).toBeGreaterThan(0);
    expect(parsed.responseGuidance).toContain("Do not paste the full audit");
    expect(parsed.document.primaryAction).toContain("Worklin audit card");
    expect(parsed.safety.externalActionTaken).toBe(false);
    expect(parsed.safety.canGoLiveNow).toBe(false);
  });

  test("Klaviyo draft creation is unavailable until approval adapter exists", async () => {
    const result = await executeRetentionCreateKlaviyoDraft({}, context);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(true);
    expect(parsed.safety.externalActionTaken).toBe(false);
    expect(parsed.safety.canGoLiveNow).toBe(false);
    expect(parsed.safety.approvalStatus).toBe("blocked");
  });

  test("live read-only Klaviyo dataset uses GET-only requests and redacts the key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      const path = String(url).replace("https://a.klaviyo.com/api", "");
      const dataByPath: Record<string, unknown> = {
        "/accounts/": {
          data: [
            {
              id: "acct_test",
              attributes: {
                contact_information: {
                  organization_name: "Cushionaire",
                },
              },
            },
          ],
        },
        "/campaigns/?filter=equals(messages.channel%2C'email')&page[size]=50": {
          data: [
            {
              id: "camp_1",
              attributes: {
                name: "VIP Refill Push",
                status: "sent",
                channel: "email",
                subject_line: "Ready for a refill?",
                sent_at: "2026-05-01T12:00:00.000Z",
              },
            },
          ],
        },
        "/flows/?page[size]=50": {
          data: [
            {
              id: "flow_1",
              attributes: {
                name: "Welcome Series",
                status: "live",
                trigger_type: "new_subscriber",
              },
            },
          ],
        },
        "/forms/?page[size]=100": {
          data: [
            {
              id: "form_1",
              attributes: {
                name: "Welcome Popup",
                status: "live",
                form_type: "popup",
              },
            },
          ],
        },
        "/lists/?page[size]=10": {
          data: [{ id: "list_1", attributes: { name: "Newsletter" } }],
        },
        "/segments/?page[size]=10": {
          data: [{ id: "seg_1", attributes: { name: "Engaged 60" } }],
        },
        "/metrics/": {
          data: [
            { id: "metric_1", attributes: { name: "Placed Order" } },
            { id: "metric_2", attributes: { name: "Opened Email" } },
            { id: "metric_3", attributes: { name: "Clicked Email" } },
          ],
        },
      };
      return new Response(JSON.stringify(dataByPath[path] ?? { data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const dataset = await buildLiveReadonlyKlaviyoDatasetFromApiKey({
      apiKey: "pk_test_secret",
      fetchImpl,
    });

    expect(calls.length).toBe(7);
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(
      calls.every(
        (call) =>
          (call.init?.headers as Record<string, string>).Authorization ===
          "Klaviyo-API-Key pk_test_secret",
      ),
    ).toBe(true);
    expect(dataset.brandName).toBe("Cushionaire");
    expect(dataset.sourceMode).toBe("klaviyo_l365");
    expect(dataset.customers).toHaveLength(0);
    expect(
      dataset.connectors.find((connector) => connector.id === "shopify")
        ?.status,
    ).toBe("not_connected");
    expect(dataset.brandBrain.products).toHaveLength(0);
    expect(dataset.klaviyoSnapshot?.depth).toBe("l365");
    expect(dataset.klaviyoSnapshot?.campaigns.count).toBe(1);
    expect(dataset.klaviyoSnapshot?.campaignPerformance?.count).toBe(1);
    expect(dataset.klaviyoSnapshot?.forms?.count).toBe(1);
    expect(dataset.klaviyoSnapshot?.freshness.status).toBe("fresh");
    expect(dataset.klaviyoSnapshot?.safety.externalActionTaken).toBe(false);
    expect(JSON.stringify(dataset)).not.toContain("pk_test_secret");

    const audit = buildKlaviyoL365AuditForTest(
      { brand_name: "Cushionaire" },
      dataset,
    );

    expect(audit.swarm.mode).toBe("section_agent_swarm");
    expect(audit.swarm.agentCount).toBeGreaterThanOrEqual(10);
    expect(audit.swarm.agents.map((agent) => agent.agentId)).toContain(
      "campaign_cadence_agent",
    );
    expect(audit.swarm.agents.map((agent) => agent.agentId)).toContain(
      "qa_safety_agent",
    );
    expect(audit.auditTrace.map((card) => card.title)).toContain(
      "Campaign Cadence Agent",
    );
    expect(audit.artifact.contentMarkdown).toContain("## Audit Swarm Method");
    expect(audit.artifact.contentMarkdown).toContain("Data Trust Agent");
    expect(audit.safety.externalActionTaken).toBe(false);
    expect(audit.safety.canGoLiveNow).toBe(false);
  });

  test("Klaviyo L365 dataset records optional forms read failures without sample data", async () => {
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(init?.method).toBe("GET");
      const path = String(url).replace("https://a.klaviyo.com/api", "");
      if (path === "/forms/?page[size]=100") {
        return new Response(
          JSON.stringify({ errors: [{ detail: "forbidden" }] }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const dataByPath: Record<string, unknown> = {
        "/accounts/": {
          data: [
            {
              id: "acct_test",
              attributes: {
                contact_information: {
                  organization_name: "Dr. Rachael Institute",
                },
              },
            },
          ],
        },
        "/campaigns/?filter=equals(messages.channel%2C'email')&page[size]=50": {
          data: [],
        },
        "/flows/?page[size]=50": { data: [] },
        "/lists/?page[size]=10": { data: [] },
        "/segments/?page[size]=10": { data: [] },
        "/metrics/": { data: [] },
      };
      return new Response(JSON.stringify(dataByPath[path] ?? { data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const dataset = await buildLiveReadonlyKlaviyoDatasetFromApiKey({
      apiKey: "pk_test_secret",
      fetchImpl,
    });

    expect(dataset.sourceMode).toBe("klaviyo_l365");
    expect(dataset.klaviyoSnapshot?.forms?.count).toBe(0);
    expect(dataset.klaviyoSnapshot?.queryErrors?.[0]?.path).toBe(
      "/forms/?page[size]=100",
    );
    expect(dataset.klaviyoSnapshot?.safety.externalActionTaken).toBe(false);
    expect(JSON.stringify(dataset)).not.toContain("pk_test_secret");
  });
});
