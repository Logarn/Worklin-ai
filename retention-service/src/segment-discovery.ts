import type { WorklinSegmentExpression } from "@vellumai/retention-domain";

import {
  campaignEligibility,
  type SegmentCustomerState,
} from "./segment-runs.js";

const MIN_PRIVATE_COHORT_SIZE = 5;
const MAX_CANDIDATE_SIGNALS = 48;
const MAX_MATCHED_SIGNALS_PER_PROFILE = 12;
const MAX_COMBINATIONS = 100;

const UNSAFE_KEY =
  /(?:email|phone|mobile|address|full.?name|first.?name|last.?name|health|medical|diagnosis|religion|race|ethnicity|sexual|pregnan|disab|politic|marital|married|single.?status|financial.?hardship)/iu;
const DIRECT_IDENTIFIER =
  /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\+?\d[\d\s().-]{7,}\d)/iu;

interface DiscoverySignal {
  id: string;
  family: string;
  label: string;
  expression: WorklinSegmentExpression;
}

interface CountedSignal extends DiscoverySignal {
  memberCount: number;
  eligibleCount: number;
}

interface CountedCombination {
  left: CountedSignal;
  right: CountedSignal;
  memberCount: number;
  eligibleCount: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function signal(input: Omit<DiscoverySignal, "id">): DiscoverySignal {
  return { ...input, id: stableJson(input.expression) };
}

function safeScalar(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    DIRECT_IDENTIFIER.test(value)
  ) {
    return null;
  }
  return value;
}

function signalsForProfile(state: SegmentCustomerState): DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];
  for (const eventType of state.evidence.event_type) {
    if (
      eventType.length === 0 ||
      eventType.length > 128 ||
      DIRECT_IDENTIFIER.test(eventType)
    ) {
      continue;
    }
    signals.push(
      signal({
        family: "event",
        label: `Has ${eventType} activity`,
        expression: {
          type: "predicate",
          namespace: "evidence",
          key: "event_type",
          operator: "contains",
          value: eventType,
        },
      }),
    );
  }

  const days = state.metric.days_since_last_event;
  if (days !== null) {
    const upperBound = days <= 7 ? 7 : days <= 30 ? 30 : days <= 90 ? 90 : null;
    signals.push(
      signal({
        family: "recency",
        label:
          upperBound === null
            ? "Last activity was more than 90 days ago"
            : `Active within ${upperBound} days`,
        expression:
          upperBound === null
            ? {
                type: "predicate",
                namespace: "metric",
                key: "days_since_last_event",
                operator: "greater_than",
                value: 90,
              }
            : {
                type: "predicate",
                namespace: "metric",
                key: "days_since_last_event",
                operator: "less_than_or_equal",
                value: upperBound,
              },
      }),
    );
  }

  const eventCount = state.metric.source_event_count;
  const activityFloor = eventCount >= 20 ? 20 : eventCount >= 5 ? 5 : null;
  if (activityFloor !== null) {
    signals.push(
      signal({
        family: "activity",
        label: `Has at least ${activityFloor} recorded interactions`,
        expression: {
          type: "predicate",
          namespace: "metric",
          key: "source_event_count",
          operator: "greater_than_or_equal",
          value: activityFloor,
        },
      }),
    );
  }

  for (const [key, rawValue] of Object.entries(state.trait)) {
    if (UNSAFE_KEY.test(key)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const rawItem of values.slice(0, 20)) {
      const value = safeScalar(rawItem);
      if (value === null) continue;
      signals.push(
        signal({
          family: `trait:${key}`,
          label: `${key} is ${String(value)}`,
          expression: {
            type: "predicate",
            namespace: "trait",
            key,
            operator: Array.isArray(rawValue) ? "contains" : "equals",
            value,
          },
        }),
      );
    }
  }
  return [...new Map(signals.map((item) => [item.id, item])).values()];
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\n${right}` : `${right}\n${left}`;
}

export class SegmentDiscoveryProfiler {
  private readonly signalCounts = new Map<string, CountedSignal>();
  private readonly combinationCounts = new Map<string, CountedCombination>();
  private candidates: CountedSignal[] = [];
  private candidateIds = new Set<string>();
  private candidateRank = new Map<string, number>();
  private profileCount = 0;
  private eligibleProfileCount = 0;
  private combinationProfileCount = 0;

  observeSignals(state: SegmentCustomerState): void {
    this.profileCount += 1;
    const eligible = campaignEligibility(state).eligible;
    if (eligible) this.eligibleProfileCount += 1;
    for (const item of signalsForProfile(state)) {
      const counted = this.signalCounts.get(item.id) ?? {
        ...item,
        memberCount: 0,
        eligibleCount: 0,
      };
      counted.memberCount += 1;
      if (eligible) counted.eligibleCount += 1;
      this.signalCounts.set(item.id, counted);
    }
  }

  prepareCombinations(): void {
    const maxUsefulSize = Math.max(
      MIN_PRIVATE_COHORT_SIZE,
      Math.floor(this.profileCount * 0.8),
    );
    this.candidates = [...this.signalCounts.values()]
      .filter(
        (item) =>
          item.memberCount >= MIN_PRIVATE_COHORT_SIZE &&
          item.memberCount <= maxUsefulSize,
      )
      .sort((left, right) => {
        const leftShare = left.memberCount / Math.max(1, this.profileCount);
        const rightShare = right.memberCount / Math.max(1, this.profileCount);
        return (
          Math.abs(leftShare - 0.2) - Math.abs(rightShare - 0.2) ||
          right.eligibleCount - left.eligibleCount ||
          left.id.localeCompare(right.id)
        );
      })
      .slice(0, MAX_CANDIDATE_SIGNALS);
    this.candidateIds = new Set(this.candidates.map((item) => item.id));
    this.candidateRank = new Map(
      this.candidates.map((item, index) => [item.id, index]),
    );
  }

  observeCombinations(state: SegmentCustomerState): void {
    this.combinationProfileCount += 1;
    if (this.candidateIds.size === 0) return;
    const eligible = campaignEligibility(state).eligible;
    const familyCounts = new Map<string, number>();
    const matching = signalsForProfile(state)
      .filter((item) => this.candidateIds.has(item.id))
      .map((item) => this.signalCounts.get(item.id)!)
      .sort(
        (left, right) =>
          (this.candidateRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (this.candidateRank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .filter((item) => {
        const broadFamily = item.family.startsWith("trait:")
          ? "trait"
          : item.family;
        const limit =
          broadFamily === "trait" ? 6 : broadFamily === "event" ? 4 : 2;
        const count = familyCounts.get(broadFamily) ?? 0;
        if (count >= limit) return false;
        familyCounts.set(broadFamily, count + 1);
        return true;
      })
      .slice(0, MAX_MATCHED_SIGNALS_PER_PROFILE);
    for (let leftIndex = 0; leftIndex < matching.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < matching.length;
        rightIndex += 1
      ) {
        const left = matching[leftIndex]!;
        const right = matching[rightIndex]!;
        if (left.family === right.family && left.family !== "event") continue;
        const key = pairKey(left.id, right.id);
        const counted = this.combinationCounts.get(key) ?? {
          left,
          right,
          memberCount: 0,
          eligibleCount: 0,
        };
        counted.memberCount += 1;
        if (eligible) counted.eligibleCount += 1;
        this.combinationCounts.set(key, counted);
      }
    }
  }

  summary(): {
    profileCoverage: {
      profilesAnalyzed: number;
      eligibleProfiles: number;
      allActiveProfilesIncluded: boolean;
    };
    behaviorCombinations: Array<{
      memberCount: number;
      eligibleCount: number;
      supportPercent: number;
      lift: number;
      signals: Array<{
        label: string;
        expression: WorklinSegmentExpression;
      }>;
    }>;
  } {
    const combinations = [...this.combinationCounts.values()]
      .filter(
        (item) =>
          item.memberCount >= MIN_PRIVATE_COHORT_SIZE &&
          item.memberCount <= Math.max(1, Math.floor(this.profileCount * 0.7)),
      )
      .map((item) => {
        const expected =
          (item.left.memberCount * item.right.memberCount) /
          Math.max(1, this.profileCount);
        return {
          ...item,
          lift: expected > 0 ? item.memberCount / expected : 0,
        };
      })
      .sort(
        (left, right) =>
          right.lift - left.lift ||
          right.eligibleCount - left.eligibleCount ||
          right.memberCount - left.memberCount,
      )
      .slice(0, MAX_COMBINATIONS)
      .map((item) => ({
        memberCount: item.memberCount,
        eligibleCount: item.eligibleCount,
        supportPercent: Number(
          ((item.memberCount / Math.max(1, this.profileCount)) * 100).toFixed(
            2,
          ),
        ),
        lift: Number(item.lift.toFixed(2)),
        signals: [item.left, item.right].map((signal) => ({
          label: signal.label,
          expression: signal.expression,
        })),
      }));
    return {
      profileCoverage: {
        profilesAnalyzed: this.profileCount,
        eligibleProfiles: this.eligibleProfileCount,
        allActiveProfilesIncluded:
          this.profileCount === this.combinationProfileCount,
      },
      behaviorCombinations: combinations,
    };
  }
}
