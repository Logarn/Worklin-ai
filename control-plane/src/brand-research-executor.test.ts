import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
  getBrandResearchRunForUser,
} from "./brand-research-runs.js";
import {
  createBrandResearchExecutor,
  readBrandResearchRuntimeResult,
  type BrandResearchRuntimeClient,
} from "./brand-research-executor.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureBrandResearchRunSchema(db);
  return db;
}

function savedReport() {
  return {
    version: "brand_research_v1",
    generatedAt: "2026-07-29T00:00:00.000Z",
    query: { brandName: "Acme Studio", websiteUrl: "https://acme.example" },
    executiveSummary: ["Acme has a clear public positioning signal."],
    identity: {
      category: "Marketing services",
      positioning: "Research-led creative work",
      offers: ["Brand audits"],
      audienceSignals: ["Growth teams"],
    },
    competitorLandscape: [
      {
        name: "Example Rival",
        positioning: "A competing service",
        notableMoves: ["Publishes case studies"],
        evidenceIds: ["competitor-1"],
        confidence: "medium",
      },
    ],
    channelFindings: {
      seoAndContent: ["Public content is discoverable."],
      social: ["A public profile is visible."],
      emailAndLifecycle: ["A newsletter sign-up is visible."],
      sms: ["No SMS offer was observed."],
      productAndLaunches: ["The services page describes the offer."],
    },
    marketSignals: ["The category has active public coverage."],
    customerSignals: ["Public reviews mention strategy work."],
    trendSignals: ["Research-led positioning is visible in the category."],
    evidence: [
      {
        id: "official-1",
        url: "https://acme.example/",
        title: "Acme Studio",
        sourceType: "official_site",
        observedAt: "2026-07-29T00:00:00.000Z",
        finding: "Public positioning",
        confidence: "high",
      },
      {
        id: "competitor-1",
        url: "https://rival.example/",
        title: "Example Rival",
        sourceType: "competitor_site",
        observedAt: "2026-07-29T00:00:00.000Z",
        finding: "Public competitor positioning",
        confidence: "medium",
      },
      {
        id: "social-1",
        url: "https://www.linkedin.com/company/acme-studio/",
        title: "Acme on LinkedIn",
        sourceType: "social_profile",
        observedAt: "2026-07-29T00:00:00.000Z",
        finding: "Public social activity",
        confidence: "medium",
      },
      {
        id: "market-1",
        url: "https://example.org/market-report",
        title: "Category report",
        sourceType: "market_report",
        observedAt: "2026-07-29T00:00:00.000Z",
        finding: "Market context",
        confidence: "low",
      },
    ],
    gaps: [],
    recommendations: [],
    safety: {
      readOnly: true,
      publicSourcesOnly: true,
      unsupportedClaimsExcluded: true,
      caveats: [],
    },
  };
}

describe("brand research executor", () => {
  test("marks a run complete only after a validated saved Brand Brain report", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
        websiteUrl: "https://acme.example",
      },
      () => new Date().toISOString(),
    );
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => ({
        status: "started",
        parentTaskId: "conversation-1",
      }),
      poll: async () => ({
        status: "saved",
        brandBrainId: "brand-acme",
        report: savedReport(),
      }),
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
      pollIntervalMs: 1,
    }).runOnce();

    const completed = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(completed?.status).toBe("complete");
    expect(completed?.brand_brain_id).toBe("brand-acme");
    expect(completed?.evidence_count).toBeGreaterThan(0);
    expect(completed?.parent_task_id).toBe("conversation-1");
  });

  test("records an honest complete-with-gaps result when onboarding was skipped", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      { orgId: "org-1", userId: "user-1", assistantId: "assistant-1" },
      () => new Date().toISOString(),
    );
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => {
        throw new Error(
          "Seed-missing runs must not dispatch an assistant task.",
        );
      },
      poll: async () => ({ status: "running" }),
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
    }).runOnce();

    const completed = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(completed?.status).toBe("complete");
    expect(completed?.evidence_count).toBe(0);
    expect(completed?.track_progress_json).toContain("not_observable");
  });

  test("keeps an unsaved assistant result partial instead of inventing completion", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
      },
      () => new Date().toISOString(),
    );
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => ({
        status: "started",
        parentTaskId: "conversation-1",
      }),
      poll: async () => ({
        status: "partial",
        detail: "The provider did not return a report save.",
      }),
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
      pollIntervalMs: 1,
    }).runOnce();

    const partial = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(partial?.status).toBe("partial");
    expect(partial?.brand_brain_id).toBeNull();
    expect(partial?.error).toContain("provider did not return");
  });

  test("keeps a saved report partial when a track lacks matching evidence", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
      },
      () => new Date().toISOString(),
    );
    const report = savedReport();
    report.evidence = report.evidence.filter(
      (evidence) => evidence.sourceType !== "social_profile",
    );
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => ({
        status: "started",
        parentTaskId: "conversation-1",
      }),
      poll: async () => ({
        status: "saved",
        brandBrainId: "brand-acme",
        report,
      }),
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
      pollIntervalMs: 1,
    }).runOnce();

    const partial = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(partial?.status).toBe("partial");
    expect(partial?.brand_brain_id).toBe("brand-acme");
    expect(partial?.provider_gaps_json).toContain(
      "social findings do not reference track-specific evidence",
    );
  });

  test("does not call a deep report complete when its quality check fails", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
      },
      () => new Date().toISOString(),
    );
    const report = {
      ...savedReport(),
      intelligence: { contractVersion: "brand_intelligence_v1" },
    };
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => ({
        status: "started",
        parentTaskId: "conversation-1",
      }),
      poll: async () => ({
        status: "saved",
        brandBrainId: "brand-acme",
        report,
        qualityAccepted: false,
        qualityFailures: ["Competitor comparisons need more sources."],
      }),
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
      pollIntervalMs: 1,
    }).runOnce();

    const partial = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(partial?.status).toBe("partial");
    expect(partial?.brand_brain_id).toBe("brand-acme");
    expect(partial?.error).toContain(
      "Competitor comparisons need more sources.",
    );
  });

  test("recognizes completion from the saved tool result, not assistant prose", () => {
    const result = readBrandResearchRuntimeResult([
      {
        role: "assistant",
        toolCalls: [
          {
            name: "subagent_spawn",
            input: {
              label: "brand-research:competitors",
              objective: "Research competitors.",
            },
            result: JSON.stringify({
              subagentId: "researcher-competitors",
              status: "pending",
            }),
          },
          {
            name: "subagent_spawn",
            input: {
              label: "brand-research:competitors:1",
              objective: "Build one public competitor dossier.",
            },
            result: JSON.stringify({
              subagentId: "researcher-competitor-1",
              status: "pending",
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: "WORKLIN_RESEARCH_RUN_STATUS: saved",
        toolCalls: [
          {
            name: "skill_execute",
            input: {
              tool: "brand_research_save",
              input: { report: savedReport() },
            },
            result: JSON.stringify({
              saved: true,
              brandId: "brand-acme",
              artifactSaved: true,
            }),
          },
        ],
      },
    ]);

    expect(result).toMatchObject({
      status: "saved",
      brandBrainId: "brand-acme",
      childTasks: [
        {
          id: "researcher-competitors",
          track: "competitors",
        },
        {
          id: "researcher-competitor-1",
          track: "competitors",
        },
      ],
    });
  });

  test("does not trust a Brand Brain save when its Work artifact failed", () => {
    expect(
      readBrandResearchRuntimeResult([
        {
          role: "assistant",
          content: "WORKLIN_RESEARCH_RUN_STATUS: saved",
          toolCalls: [
            {
              name: "brand_research_save",
              input: { report: savedReport() },
              result: JSON.stringify({
                saved: true,
                brandId: "brand-acme",
                artifactSaved: false,
              }),
            },
          ],
        },
      ]),
    ).toMatchObject({ status: "partial" });
  });

  test("persists observed specialist tasks while research is running", async () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
        websiteUrl: "https://acme.example",
      },
      () => new Date().toISOString(),
    );
    let polls = 0;
    const runtimeClient: BrandResearchRuntimeClient = {
      dispatch: async () => ({
        status: "started",
        parentTaskId: "conversation-1",
      }),
      poll: async () => {
        polls += 1;
        if (polls === 1) {
          return {
            status: "running",
            childTasks: [
              {
                id: "researcher-identity",
                label: "brand-research:identity_and_offers",
                track: "identity_and_offers",
              },
              {
                id: "researcher-social",
                label: "brand-research:social",
                track: "social",
              },
            ],
          };
        }
        return {
          status: "saved",
          brandBrainId: "brand-acme",
          report: savedReport(),
          childTasks: [
            {
              id: "researcher-identity",
              label: "brand-research:identity_and_offers",
              track: "identity_and_offers",
            },
            {
              id: "researcher-social",
              label: "brand-research:social",
              track: "social",
            },
          ],
        };
      },
    };

    await createBrandResearchExecutor(db, undefined, {
      runtimeClient,
      pollIntervalMs: 1,
    }).runOnce();

    const completed = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(JSON.parse(completed!.child_task_ids_json)).toEqual([
      "researcher-identity",
      "researcher-social",
    ]);
    expect(completed?.track_progress_json).toContain("identity_and_offers");
    expect(completed?.status).toBe("complete");
  });
});
