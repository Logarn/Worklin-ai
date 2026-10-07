import { describe, expect, test } from "bun:test";

import type { ArtifactSummary } from "./use-work-data";
import { getFarmRecords, parseFarmRecordArtifact } from "./farm-record-model";

function artifact(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: "farm_record:example-farm:record-1",
    brandId: "example-farm",
    resourceType: "farm_record",
    resourceId: "example-farm:record-1",
    artifactType: "farm_production",
    parentArtifactId: null,
    projectId: null,
    metadata: {
      contractVersion: "farm_record_v1",
      recordId: "record-1",
      title: "Morning production check",
      reference: "PROD-001",
      category: "Production",
      recordType: "Production record",
      status: "Recorded",
      summary: "The morning check was submitted.",
      attentionLevel: "normal",
      details: [{ label: "House", value: "House 1" }],
      activity: [
        {
          at: "2026-10-07T06:30:00.000Z",
          label: "Morning check recorded",
          state: "done",
        },
      ],
    },
    favorite: false,
    archived: false,
    createdAt: 1_791_358_200_000,
    updatedAt: 1_791_358_200_000,
    title: "Morning production check",
    sourceExists: true,
    childCount: 0,
    ...overrides,
  };
}

describe("farm record model", () => {
  test("parses a persisted farm record", () => {
    expect(parseFarmRecordArtifact(artifact())).toMatchObject({
      recordId: "record-1",
      category: "Production",
      attentionLevel: "normal",
      details: [{ label: "House", value: "House 1" }],
    });
  });

  test("ignores unrelated or malformed artifacts", () => {
    expect(
      parseFarmRecordArtifact(artifact({ resourceType: "document" })),
    ).toBeNull();
    expect(
      parseFarmRecordArtifact(artifact({ metadata: { title: "Incomplete" } })),
    ).toBeNull();
  });

  test("filters by farm and orders newest records first", () => {
    const records = getFarmRecords(
      [
        artifact({ id: "older", updatedAt: 100 }),
        artifact({
          id: "newer",
          updatedAt: 200,
          metadata: {
            ...artifact().metadata,
            recordId: "record-2",
            reference: "PROD-002",
          },
        }),
        artifact({ id: "other-farm", brandId: "other-farm" }),
      ],
      "example-farm",
    );

    expect(records.map((record) => record.artifactId)).toEqual([
      "newer",
      "older",
    ]);
  });
});
