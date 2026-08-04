import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  addBrandResearchRunChildTasks,
  brandResearchRunPayload,
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
  getBrandResearchRunForUser,
  markBrandResearchRunCompleted,
  markBrandResearchRunFailed,
  releaseBrandResearchRunForRetry,
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
    expect(first.seed_missing_reason).toBeNull();
    expect(first.brand_name).toBe("Acme Studio");
    expect(first.website_url).toBe("https://acme.example/");
    expect(first.brand_id).toMatch(/^brand-/);
    expect(brandResearchRunPayload(first).brand_id).toBe(first.brand_id);
    expect(JSON.parse(first.tracks_json)).toContain("competitors");
  });

  test("keeps one stable brand identity across later research runs", () => {
    const db = makeDb();
    const first = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme Studio",
        websiteUrl: "https://acme.example",
      },
      now,
    );
    markBrandResearchRunCompleted(db, first.id, now);

    const later = createOrGetBrandResearchRun(
      db,
      {
        orgId: "org-1",
        userId: "user-1",
        assistantId: "assistant-1",
        brandName: "Acme",
        websiteUrl: "acme.example/",
        runKind: "weekly_update",
      },
      now,
    );

    expect(later.id).not.toBe(first.id);
    expect(later.brand_id).toBe(first.brand_id);
    expect(later.run_kind).toBe("weekly_update");
  });

  test("accepts seed-missing onboarding by creating an explicit placeholder run", () => {
    const db = makeDb();
    const run = createOrGetBrandResearchRun(
      db,
      { orgId: "org", userId: "user", assistantId: "assistant" },
      now,
    );
    expect(run.brand_name).toBe("Brand research");
    expect(run.seed_missing_reason).toBe("seedMissing");
    expect(run.website_url).toBeNull();
    expect(run.status).toBe("queued");
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

  test("moves failed runs back to queued for retry", () => {
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
    markBrandResearchRunFailed(db, run.id, now, "Temporary API issue.");
    expect(releaseBrandResearchRunForRetry(db, run.id, now)).toBe(true);
    const retried = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(retried?.status).toBe("queued");
    expect(retried?.track_progress_json).toBeDefined();
    expect(retried?.retry_count).toBe(1);
  });

  test("records specialist task IDs once while a run is active", () => {
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
    db.query(
      "UPDATE brand_research_runs SET status = 'running' WHERE id = ?",
    ).run(run.id);

    expect(
      addBrandResearchRunChildTasks(
        db,
        run.id,
        ["researcher-1", "researcher-1", "researcher-2"],
        now,
      ),
    ).toEqual(["researcher-1", "researcher-2"]);
    expect(
      addBrandResearchRunChildTasks(db, run.id, ["researcher-2"], now),
    ).toEqual([]);

    const stored = getBrandResearchRunForUser(db, run.id, "user-1");
    expect(JSON.parse(stored!.child_task_ids_json)).toEqual([
      "researcher-1",
      "researcher-2",
    ]);
  });
});
