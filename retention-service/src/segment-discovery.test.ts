import { describe, expect, test } from "bun:test";

import { SegmentDiscoveryProfiler } from "./segment-discovery.js";
import type { SegmentCustomerState } from "./segment-runs.js";

function customer(index: number): SegmentCustomerState {
  const inPattern = index < 5;
  return {
    profile: {
      status: "active",
      has_email: true,
      has_phone: false,
      created_at: "2026-01-01T00:00:00.000Z",
      source_updated_at: null,
    },
    consent: { email: index === 7 ? "suppressed" : "subscribed" },
    metric: {
      source_event_count: inPattern ? 8 : 1,
      klaviyo_event_count: inPattern ? 8 : 1,
      days_since_last_event: inPattern ? 4 : 60,
    },
    evidence: {
      provider: ["klaviyo"],
      event_type: inPattern
        ? [
            "product_view",
            ...Array.from(
              { length: 14 },
              (_, eventIndex) => `event_${eventIndex}`,
            ),
          ]
        : ["email_open"],
    },
    trait: {
      "klaviyo.Source quiz?": inPattern ? "starter" : "other",
      "klaviyo.email": `profile-${index}@example.com`,
      "klaviyo.health_status": "must never appear",
    },
  };
}

describe("segment discovery profiler", () => {
  test("uses every profile to surface private cross-signal patterns", () => {
    const profiles = Array.from({ length: 8 }, (_, index) => customer(index));
    const profiler = new SegmentDiscoveryProfiler();
    for (const profile of profiles) profiler.observeSignals(profile);
    profiler.prepareCombinations();
    for (const profile of profiles) profiler.observeCombinations(profile);

    const result = profiler.summary();

    expect(result.profileCoverage).toEqual({
      profilesAnalyzed: 8,
      eligibleProfiles: 7,
      allActiveProfilesIncluded: true,
    });
    expect(result.behaviorCombinations.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(result.behaviorCombinations);
    expect(serialized).toContain('"key":"event_type"');
    expect(serialized).toContain("klaviyo.Source quiz?");
    expect(serialized).not.toContain("profile-0@example.com");
    expect(serialized).not.toContain("health_status");
  });
});
