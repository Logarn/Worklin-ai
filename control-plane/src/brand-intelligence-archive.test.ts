import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  brandIntelligenceArchiveConfigFromEnv,
  createBrandIntelligenceArchiveService,
  parseBrandIntelligenceArchiveRequest,
  type BrandIntelligenceArchiveConfig,
} from "./brand-intelligence-archive.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = `brand_research_${"a".repeat(64)}`;

function config(
  overrides: Partial<BrandIntelligenceArchiveConfig> = {},
): BrandIntelligenceArchiveConfig {
  return {
    enabled: true,
    bucket: "worklin-brand-intelligence",
    endpoint: "https://storage.example.com/",
    region: "auto",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    urlStyle: "path",
    globalMaxBytes: 8 * 1024 * 1024 * 1024,
    perBrandMaxBytes: 1536 * 1024 * 1024,
    warningPercent: 70,
    maxJobBytes: 8 * 1024 * 1024,
    maxAssetBytes: 10 * 1024 * 1024,
    maxVisualAssets: 24,
    fetchTimeoutMs: 1_000,
    ...overrides,
  };
}

function request() {
  return {
    organizationId: ORGANIZATION_ID,
    userId: "user-1",
    assistantId: "assistant-1",
    brandId: "brand-1",
    snapshotId: SNAPSHOT_ID,
    brandBrain: { brandId: "brand-1", profile: { name: "Acme" } },
    report: {
      query: { brandName: "Acme" },
      visualEvidence: [
        {
          id: "visual-1",
          title: "Campaign image",
          kind: "paid_ad",
          module: "paid_media",
          sourceUrl: "https://public.example.com/ad/1",
          mediaUrl: "https://public.example.com/ad/1.jpg",
          mediaType: "image",
          observedAt: "2026-08-04T00:00:00.000Z",
        },
      ],
    },
    quality: null,
  };
}

describe("brand intelligence archive", () => {
  test("stays disabled until storage is explicitly configured", () => {
    expect(brandIntelligenceArchiveConfigFromEnv({}).enabled).toBe(false);
    expect(() =>
      brandIntelligenceArchiveConfigFromEnv({
        WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_ENABLED: "true",
      }),
    ).toThrow();
  });

  test("rejects invalid and oversized requests", () => {
    expect(parseBrandIntelligenceArchiveRequest(request(), 1)).toBeNull();
    expect(
      parseBrandIntelligenceArchiveRequest(
        { ...request(), organizationId: "not-an-organization" },
        1024 * 1024,
      ),
    ).toBeNull();
  });

  test("archives one immutable report and deduplicated visual on retry", async () => {
    const db = new Database(":memory:");
    const stored = new Map<string, Uint8Array>();
    const service = createBrandIntelligenceArchiveService(db, config(), {
      objectStore: {
        put: async (key, body) => {
          stored.set(key, body);
        },
      },
      fetch: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      resolveHostname: async () => ["93.184.216.34"],
    });

    expect(service.enqueue(request())).toMatchObject({
      status: "queued",
      idempotent: false,
    });
    expect(service.enqueue(request())).toMatchObject({
      status: "queued",
      idempotent: true,
    });
    expect(await service.processNext()).toBe(true);
    expect(stored.size).toBe(2);
    expect(service.enqueue(request())).toMatchObject({
      status: "complete",
      idempotent: true,
    });
    expect(await service.processNext()).toBe(false);
    expect(service.usage(request()).brandBytes).toBeGreaterThan(0);
    db.close();
  });

  test("fails closed when the configured storage cap is reached", async () => {
    const db = new Database(":memory:");
    const service = createBrandIntelligenceArchiveService(
      db,
      config({ globalMaxBytes: 32, perBrandMaxBytes: 32, maxVisualAssets: 0 }),
      { objectStore: { put: async () => undefined } },
    );
    service.enqueue({ ...request(), report: { query: { brandName: "Acme" } } });
    expect(await service.processNext()).toBe(true);
    const failed = db
      .query<
        { status: string; error_code: string },
        []
      >("SELECT status, error_code FROM brand_intelligence_archive_jobs")
      .get();
    expect(failed).toEqual({ status: "failed", error_code: "global_quota" });
    db.close();
  });

  test("does not fetch visual assets from private network addresses", async () => {
    const db = new Database(":memory:");
    let fetched = false;
    const stored = new Map<string, Uint8Array>();
    const service = createBrandIntelligenceArchiveService(db, config(), {
      objectStore: {
        put: async (key, body) => {
          stored.set(key, body);
        },
      },
      fetch: async () => {
        fetched = true;
        return new Response(new Uint8Array([1]));
      },
      resolveHostname: async () => ["127.0.0.1"],
    });
    service.enqueue(request());
    expect(await service.processNext()).toBe(true);
    expect(fetched).toBe(false);
    expect(stored.size).toBe(1);
    const row = db
      .query<
        { status: string },
        []
      >("SELECT status FROM brand_intelligence_archive_jobs")
      .get();
    expect(row?.status).toBe("partial");
    db.close();
  });
});
