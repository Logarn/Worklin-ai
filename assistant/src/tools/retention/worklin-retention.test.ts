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

async function expectLiveDataRequired(
  resultPromise: Promise<{ content: string; isError?: boolean }>,
): Promise<void> {
  const result = await resultPromise;
  const parsed = JSON.parse(result.content);
  expect(result.isError).toBe(true);
  expect(parsed.error.code).toBe("live_data_required");
  expect(parsed.safety.externalActionTaken).toBe(false);
}

describe("Worklin Retention tools", () => {
  test("customer and campaign tools never substitute fixture data", async () => {
    const operations = [
      executeRetentionSourceStatus({}, context),
      executeRetentionBrandBrain({}, context),
      executeRetentionShopifySnapshot({}, context),
      executeRetentionKlaviyoSnapshot({}, context),
      executeRetentionUnifiedCustomerView({}, context),
      executeRetentionComputeCustomerFeatures({}, context),
      executeRetentionFindMissingPieces({}, context),
      executeRetentionFindCampaignOpportunities({}, context),
      executeRetentionGenerateCampaignPackage({}, context),
      executeRetentionRunQa({}, context),
    ];
    for (const operation of operations) {
      await expectLiveDataRequired(operation);
    }
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
    await expectLiveDataRequired(executeRetentionAuditStatus({}, context));
  });

  test("fixture flags cannot bypass live data requirements", async () => {
    const result = await executeRetentionAudit(
      { allow_fixture_data: true },
      context,
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.status).toBe("blocked");
    expect(parsed.title).toContain("Real Source Data Required");
    expect(parsed.readiness.canRunFullAudit).toBe(false);
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
