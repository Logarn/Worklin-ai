import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../../memory/db-init.js";
import { rawRun } from "../../memory/raw-query.js";
import type { ToolContext } from "../types.js";
import {
  executeFarmRecordsList,
  executeFarmRecordUpsert,
} from "./farm-record-tools.js";

initializeDb();

const context = { conversationId: "conversation-1" } as ToolContext;

beforeEach(() => {
  rawRun("DELETE FROM artifacts");
  rawRun("DELETE FROM retention_brands");
});

describe("farm record skill tools", () => {
  test("creates and reads a farm record", async () => {
    const created = await executeFarmRecordUpsert(
      {
        farm_name: "Example Farm",
        record_id: "daily-check",
        title: "Morning production check",
        reference: "PROD-001",
        category: "Production",
        record_type: "Production record",
        status: "Recorded",
        summary: "Morning checks were submitted by the farm team.",
        attention_level: "normal",
        activity_note: "Morning check recorded",
        activity_state: "done",
      },
      context,
    );

    expect(created.isError).toBe(false);
    expect(created.content).toContain('"visibleIn": "Work"');

    const listed = await executeFarmRecordsList({}, context);
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("Morning production check");
    expect(listed.content).toContain("Requested is not confirmed");
  });

  test("rejects an update that lacks reliable status fields", async () => {
    const result = await executeFarmRecordUpsert(
      { farm_name: "Example Farm", title: "Incomplete record" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid input");
  });
});
