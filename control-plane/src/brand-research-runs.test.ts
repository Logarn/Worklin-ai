import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  brandResearchRunPayload,
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
  markBrandResearchRunCancelled,
} from "./brand-research-runs.js";

const now = () => "2026-07-20T00:00:00.000Z";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureBrandResearchRunSchema(db);
  return db;
}

describe("brand research runs", () => {
  test("creates one durable queued run and deduplicates repeated onboarding", () => {
    const db = makeDb();
    const input = {
      orgId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      brandName: "  Acme\nStudio ",
      websiteUrl: "acme.example/",
    };

    const first = createOrGetBrandResearchRun(db, input, now);
    const second = createOrGetBrandResearchRun(db, input, now);

    expect(first.id).toBe(second.id);
    expect(first.status).toBe("queued");
    expect(first.brand_name).toBe("Acme Studio");
    expect(first.website_url).toBe("https://acme.example/");
    expect(JSON.parse(first.tracks_json)).toContain("competitors");
  });

  test("requires a brand name or website", () => {
    const db = makeDb();
    expect(() =>
      createOrGetBrandResearchRun(
        db,
        { orgId: "org", userId: "user", assistantId: "assistant" },
        now,
      ),
    ).toThrow("A brand name or public website is required.");
  });

  test("cancels only an active run and exposes honest status", () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme",
      },
      now,
    );

    expect(markBrandResearchRunCancelled(db, run.id, now)).toBe(true);
    expect(markBrandResearchRunCancelled(db, run.id, now)).toBe(false);
    const payload = brandResearchRunPayload({
      ...run,
      status: "cancelled",
      cancelled_at: now(),
    });
    expect(payload.status).toBe("cancelled");
    expect(payload.evidence_count).toBe(0);
  });
});
