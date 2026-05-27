import test from "node:test";
import assert from "node:assert/strict";
import { POST as computeArbitrationsRoute } from "../../app/api/campaigns/arbitrations/compute/route";
import { GET as getArbitrationsRoute } from "../../app/api/campaigns/arbitrations/route";
import { GET as getArbitrationRoute } from "../../app/api/campaigns/arbitrations/[id]/route";
import {
  parseMicroCampaignArbitrationComputeInput,
  previewMicroCampaignArbitrationsFromCandidates,
  type ArbitrationTestCandidate,
} from "./arbitration-frequency-guardrails";

function candidate(overrides: Partial<ArbitrationTestCandidate> = {}): ArbitrationTestCandidate {
  return {
    packageKey: "generic_package",
    opportunityKey: "targeted_promo_dormant_winback",
    status: "prepared",
    packageType: "campaign",
    approvalStatus: "not_requested",
    name: "Generic promo package",
    description: "Broad discount offer for dormant buyers.",
    priority: 55,
    confidence: "medium",
    sourceOpportunity: {
      recommendedCampaignType: "targeted_winback_offer",
      opportunityType: "campaign",
    },
    linkedMicroSegment: {
      definitionKey: "promo_responsive_dormant_buyers",
      name: "Promo responsive dormant buyers",
    },
    messageAngle: {
      readyForBriefGenerator: true,
    },
    futureArtifact: {
      readiness: "ready_for_brief",
    },
    caveats: [],
    ...overrides,
  };
}

function byKey<T extends { packageKey: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.packageKey, row]));
}

test("specific lifecycle intent beats generic promo", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "second_purchase_high_aov",
      opportunityKey: "second_purchase_high_aov_nurture",
      packageType: "lifecycle",
      name: "Second-purchase nurture",
      description: "One-time buyers ready for second purchase.",
      priority: 68,
      sourceOpportunity: {
        recommendedCampaignType: "second_purchase_nurture",
        opportunityType: "lifecycle",
      },
      linkedMicroSegment: {
        definitionKey: "high_aov_one_time_buyers_ready_for_second_purchase",
        name: "High AOV one-time buyers ready for second purchase",
      },
    }),
    candidate({
      packageKey: "generic_discount_offer",
    }),
  ]);

  const resultMap = byKey(results);
  assert.equal(resultMap.get("second_purchase_high_aov")?.decision, "advance");
  assert.equal(resultMap.get("generic_discount_offer")?.decision, "suppress");
});

test("replenishment due now beats generic churn or winback", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "replenishment_due_now",
      opportunityKey: "replenishment_due_now_reminder",
      packageType: "lifecycle",
      name: "Replenishment reminder",
      description: "Repeat buyers are due now for replenishment.",
      priority: 72,
      sourceOpportunity: {
        recommendedCampaignType: "replenishment_reminder",
        opportunityType: "lifecycle",
      },
      linkedMicroSegment: {
        definitionKey: "replenishment_ready_repeat_buyers",
        name: "Replenishment ready repeat buyers",
      },
    }),
    candidate({
      packageKey: "generic_churn_winback",
      name: "Generic churn winback",
      description: "Broad winback offer for lapsed customers.",
    }),
  ]);

  const resultMap = byKey(results);
  assert.equal(resultMap.get("replenishment_due_now")?.decision, "advance");
  assert.equal(resultMap.get("generic_churn_winback")?.decision, "suppress");
  assert.match(
    resultMap.get("generic_churn_winback")?.winningReason ?? "",
    /Recent-buyer specific lifecycle paths beat broad promo pressure|High fatigue or suppression guardrails veto marketing sends for now|Due-now replenishment should move first/i,
  );
});

test("recent buyers suppress broad promos", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "cross_sell_recent_buyer",
      opportunityKey: "product_entry_cross_sell_bridge",
      packageType: "lifecycle",
      name: "Cross-sell bridge",
      description: "Recent entry-product buyers ready for the next product.",
      priority: 63,
      sourceOpportunity: {
        recommendedCampaignType: "cross_sell_bridge",
        opportunityType: "lifecycle",
      },
      linkedMicroSegment: {
        definitionKey: "product_entry_cohort_cross_sell_candidates",
        name: "Product entry cohort cross-sell candidates",
      },
    }),
    candidate({
      packageKey: "broad_promo",
      name: "Broad promo",
      description: "Broad storewide discount campaign.",
    }),
  ]);

  const resultMap = byKey(results);
  assert.equal(resultMap.get("cross_sell_recent_buyer")?.decision, "advance");
  assert.equal(resultMap.get("broad_promo")?.decision, "suppress");
  assert.deepEqual(resultMap.get("broad_promo")?.suppressedByPackageKeys, ["cross_sell_recent_buyer"]);
});

test("high fatigue vetoes marketing sends", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "fatigue_guardrail",
      opportunityKey: "broad_campaign_fatigue_suppression",
      packageType: "suppression",
      name: "Fatigue suppression holdout",
      description: "High fatigue customers should be held out from broad sends.",
      priority: 90,
      sourceOpportunity: {
        recommendedCampaignType: "suppression_holdout",
        opportunityType: "suppression",
      },
      linkedMicroSegment: {
        definitionKey: "high_email_fatigue_customers_broad_campaign_suppression",
        name: "High email fatigue customers broad campaign suppression",
      },
    }),
    candidate({
      packageKey: "promo_attempt",
      name: "Promo attempt",
      description: "Broad discount campaign while fatigue is elevated.",
    }),
  ]);

  const resultMap = byKey(results);
  assert.equal(resultMap.get("fatigue_guardrail")?.decision, "block");
  assert.equal(resultMap.get("promo_attempt")?.decision, "suppress");
  assert.equal(resultMap.get("promo_attempt")?.frequencyStatus?.state, "suppressed_fatigue_veto");
});

test("VIP and full-price buyers are protected from heavy discounts", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "full_price_policy",
      opportunityKey: "full_price_discount_protection_policy",
      packageType: "policy",
      name: "Full-price discount protection",
      description: "Likely full-price buyers should not receive unnecessary discounts.",
      priority: 88,
      sourceOpportunity: {
        recommendedCampaignType: "discount_protection_policy",
        opportunityType: "policy",
      },
      linkedMicroSegment: {
        definitionKey: "full_price_likely_customers_discount_protection",
        name: "Full-price likely customers discount protection",
      },
    }),
    candidate({
      packageKey: "heavy_discount_offer",
      name: "Heavy discount offer",
      description: "Aggressive markdown winback campaign.",
    }),
  ]);

  const resultMap = byKey(results);
  assert.equal(resultMap.get("full_price_policy")?.decision, "block");
  assert.equal(resultMap.get("heavy_discount_offer")?.decision, "suppress");
  assert.deepEqual(resultMap.get("heavy_discount_offer")?.suppressedByPackageKeys, ["full_price_policy"]);
});

test("policy and suppression packages remain advisory guardrails only", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({
      packageKey: "policy_guardrail",
      opportunityKey: "full_price_discount_protection_policy",
      packageType: "policy",
      name: "Policy guardrail",
      description: "Policy should stay advisory.",
      sourceOpportunity: {
        recommendedCampaignType: "discount_protection_policy",
        opportunityType: "policy",
      },
      linkedMicroSegment: {
        definitionKey: "full_price_likely_customers_discount_protection",
      },
    }),
    candidate({
      packageKey: "suppression_guardrail",
      opportunityKey: "broad_campaign_fatigue_suppression",
      packageType: "suppression",
      name: "Suppression guardrail",
      description: "Suppression should stay advisory.",
      sourceOpportunity: {
        recommendedCampaignType: "suppression_holdout",
        opportunityType: "suppression",
      },
      linkedMicroSegment: {
        definitionKey: "high_email_fatigue_customers_broad_campaign_suppression",
      },
    }),
  ]);

  for (const result of results) {
    assert.equal(result.decision, "block");
    assert.equal(result.frequencyStatus?.state, "guardrail_only");
    assert.equal(result.externalActionTaken, false);
    assert.equal(result.canGoLiveNow, false);
  }
});

test("preview bundles never claim live external action", () => {
  const results = previewMicroCampaignArbitrationsFromCandidates([
    candidate({ packageKey: "preview_only_package" }),
  ]);

  assert.equal(results[0]?.externalActionTaken, false);
  assert.equal(results[0]?.canGoLiveNow, false);
  assert.equal(results[0]?.sourcePackage?.externalActionTaken, false);
  assert.equal(results[0]?.sourcePackage?.canGoLiveNow, false);
  assert.equal(results[0]?.sourceOpportunity?.externalActionTaken, false);
  assert.equal(results[0]?.sourceOpportunity?.canGoLiveNow, false);
});

test("invalid compute route request stays read-only and safe", async () => {
  const response = await computeArbitrationsRoute(
    new Request("http://worklin.local/api/campaigns/arbitrations/compute", {
      method: "POST",
      body: JSON.stringify({ packageType: "not-a-real-package-type" }),
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.externalActionTaken, false);
  assert.equal(payload.canGoLiveNow, false);
});

test("invalid list route request stays read-only and safe", async () => {
  const response = await getArbitrationsRoute(
    new Request("http://worklin.local/api/campaigns/arbitrations?decision=not-real"),
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.externalActionTaken, false);
  assert.equal(payload.canGoLiveNow, false);
});

test("blank get route identifier is rejected without live action", async () => {
  const response = await getArbitrationRoute(
    new Request("http://worklin.local/api/campaigns/arbitrations/"),
    { params: Promise.resolve({ id: "" }) },
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.externalActionTaken, false);
  assert.equal(payload.canGoLiveNow, false);
});

test("invalid compute parser input is rejected", () => {
  const parsed = parseMicroCampaignArbitrationComputeInput({
    limit: "nope",
    persist: "sometimes",
  });

  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.issues.some((issue) => issue.includes("limit must be a positive whole number.")));
    assert.ok(parsed.issues.some((issue) => issue.includes("persist must be true or false.")));
  }
});
