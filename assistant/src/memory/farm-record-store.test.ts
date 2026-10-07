import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "./db-init.js";
import {
  listFarmBrands,
  listFarmRecords,
  upsertFarmRecord,
} from "./farm-record-store.js";
import { rawRun } from "./raw-query.js";

initializeDb();

beforeEach(() => {
  rawRun("DELETE FROM artifacts");
  rawRun("DELETE FROM retention_brands");
});

describe("farm record store", () => {
  test("creates a farm brand and persists a traceable record", () => {
    const record = upsertFarmRecord({
      farmId: "example-farm",
      farmName: "Example Farm",
      recordId: "feed-order-1042",
      title: "Grower feed order",
      reference: "PO-1042",
      category: "Purchases",
      recordType: "Purchase order",
      status: "Supplier confirmed",
      summary: "Delivery is confirmed for tomorrow morning.",
      attentionLevel: "normal",
      amount: "KSh 73,100",
      details: [{ label: "Ordered", value: "1,500 kg" }],
      activity: { label: "Supplier confirmed delivery", state: "done" },
    });

    expect(listFarmBrands()).toEqual([
      { id: "example-farm", name: "Example Farm" },
    ]);
    expect(record).toMatchObject({
      recordId: "feed-order-1042",
      reference: "PO-1042",
      status: "Supplier confirmed",
      amount: "KSh 73,100",
    });
    expect(record.activity).toHaveLength(1);
  });

  test("updates the same record and preserves its activity history", () => {
    const base = {
      farmId: "example-farm",
      farmName: "Example Farm",
      recordId: "weight-sample",
      title: "House 2 weight sample",
      reference: "OBS-H2-1007",
      category: "Production" as const,
      recordType: "Production record",
      summary: "Thirty-bird sample requested.",
      attentionLevel: "action" as const,
      details: [{ label: "Sample size", value: "Pending" }],
    };
    const first = upsertFarmRecord({
      ...base,
      status: "Assigned",
      activity: { label: "Weight check assigned", state: "current" },
    });
    const updated = upsertFarmRecord({
      ...base,
      status: "Verified",
      summary: "Thirty-bird sample averaged 1.58 kg.",
      attentionLevel: "watch",
      details: [{ label: "Average", value: "1.58 kg" }],
      activity: { label: "Sample verified", state: "done" },
    });

    expect(updated.artifactId).toBe(first.artifactId);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.status).toBe("Verified");
    expect(updated.activity.map((item) => item.label)).toEqual([
      "Weight check assigned",
      "Sample verified",
    ]);
    expect(listFarmRecords({ farmId: "example-farm" }).records).toHaveLength(1);
  });

  test("requires an unambiguous selector when more than one farm exists", () => {
    for (const [farmId, farmName] of [
      ["farm-one", "Farm One"],
      ["farm-two", "Farm Two"],
    ] as const) {
      upsertFarmRecord({
        farmId,
        farmName,
        title: "Daily note",
        category: "Production",
        recordType: "Observation",
        status: "Recorded",
        summary: "Daily production note.",
        attentionLevel: "normal",
        activity: { label: "Observation recorded", state: "done" },
      });
    }

    expect(() => listFarmRecords({})).toThrow(
      "More than one farm matched the selector",
    );
  });
});
