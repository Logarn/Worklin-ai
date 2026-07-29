import { describe, expect, test } from "bun:test";

import {
  createAiRecipientDecision,
  createCampaignApprovalSnapshot,
  getAllowedCampaignTransitions,
  getCampaignApprovalChecksum,
  getProgramPolicyApprovalChecksum,
  invalidateCampaignApprovalSnapshot,
  isRetentionCampaignMode,
  isRetentionDecisionProgram,
  RETENTION_CAMPAIGN_MODES,
  RETENTION_DECISION_PROGRAMS,
  transitionRetentionDecisionCampaign,
  validateCampaignApprovalSnapshot,
  validateCampaignRelease,
  validateCustomerEvidence,
  validateCustomerTrait,
  validateWorklinSegmentExpression,
  type AiRecipientDecisionInput,
  type CampaignApprovalMaterial,
  type CampaignApprovalSnapshot,
  type RetentionDecisionCampaign,
  type WorklinSegmentExpression,
} from "./decisioning-contracts.js";

const approvalMaterial = (
  overrides: Partial<CampaignApprovalMaterial> = {},
): CampaignApprovalMaterial => ({
  orgId: "org-abc",
  campaignId: "campaign-123",
  campaignRevision: 1,
  program: "non_buyer_conversion",
  mode: "individual_message",
  audienceSnapshotId: "audience-123",
  audienceChecksum: "audience-checksum",
  recipientDecisions: [
    { id: "customer-2", checksum: "decision-2" },
    { id: "customer-1", checksum: "decision-1" },
  ],
  content: [
    { id: "customer-2", checksum: "content-2" },
    { id: "customer-1", checksum: "content-1" },
  ],
  modelReferences: ["model-b", "model-a"],
  promptReferences: ["prompt-b", "prompt-a"],
  offerChecksum: "offer-checksum",
  ...overrides,
});

const approvalSnapshot = (): CampaignApprovalSnapshot => {
  const result = createCampaignApprovalSnapshot(approvalMaterial(), {
    approvedBy: "user-123",
    approvedAt: "2026-07-28T12:00:00.000Z",
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const campaign = (
  overrides: Partial<RetentionDecisionCampaign> = {},
): RetentionDecisionCampaign => ({
  id: "campaign-123",
  orgId: "org-abc",
  program: "non_buyer_conversion",
  mode: "individual_message",
  state: "draft",
  revision: 1,
  approval: null,
  lastTransitionAt: "2026-07-28T11:00:00.000Z",
  ...overrides,
});

describe("shared retention decision contracts", () => {
  test("exports the three programs and two campaign modes", () => {
    expect(RETENTION_DECISION_PROGRAMS).toEqual([
      "non_buyer_conversion",
      "re_engagement",
      "repeat_purchase",
    ]);
    expect(RETENTION_CAMPAIGN_MODES).toEqual([
      "dynamic_template",
      "individual_message",
    ]);
    expect(isRetentionDecisionProgram("re_engagement")).toBe(true);
    expect(isRetentionDecisionProgram("invented_program")).toBe(false);
    expect(isRetentionCampaignMode("individual_message")).toBe(true);
  });

  test("validates segment structure without making marketing decisions", () => {
    const expression: WorklinSegmentExpression = {
      type: "all",
      expressions: [
        {
          type: "predicate",
          namespace: "metric",
          key: "order_count",
          operator: "equals",
          value: 0,
        },
        {
          type: "not",
          expression: {
            type: "predicate",
            namespace: "consent",
            key: "email_suppressed",
            operator: "equals",
            value: true,
          },
        },
      ],
    };

    const result = validateWorklinSegmentExpression(expression);

    expect(result).toEqual({
      ok: true,
      value: {
        depth: 3,
        nodeCount: 4,
        references: [
          { namespace: "consent", key: "email_suppressed" },
          { namespace: "metric", key: "order_count" },
        ],
      },
    });
  });

  test("rejects malformed and overly complex segment expressions", () => {
    const missingValue = validateWorklinSegmentExpression({
      type: "predicate",
      namespace: "trait",
      key: "interest",
      operator: "equals",
    });
    const tooDeep = validateWorklinSegmentExpression(
      {
        type: "not",
        expression: {
          type: "not",
          expression: {
            type: "predicate",
            namespace: "profile",
            key: "country",
            operator: "exists",
          },
        },
      },
      { maxDepth: 2 },
    );

    expect(missingValue.ok).toBe(false);
    if (!missingValue.ok) {
      expect(missingValue.error.code).toBe("invalid_segment_expression");
    }
    expect(tooDeep.ok).toBe(false);
  });

  test("requires inferred traits to retain model and evidence provenance", () => {
    const invalid = validateCustomerTrait({
      id: "trait-123",
      orgId: "org-abc",
      customerId: "customer-123",
      key: "preferred_product",
      value: "example-product",
      confidence: 0.72,
      sensitivity: "personal",
      status: "active",
      provenance: {
        origin: "inferred",
        evidenceIds: ["evidence-123"],
        source: { connector: "worklin" },
      },
      observedAt: "2026-07-28T12:00:00.000Z",
    });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid_trait_provenance");
    }

    const valid = validateCustomerTrait({
      id: "trait-123",
      orgId: "org-abc",
      customerId: "customer-123",
      key: "preferred_product",
      value: "example-product",
      confidence: 0.72,
      sensitivity: "personal",
      status: "active",
      provenance: {
        origin: "inferred",
        evidenceIds: ["evidence-123"],
        source: { connector: "worklin" },
        modelReference: "provider/model",
      },
      observedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(valid.ok).toBe(true);
  });

  test("preserves evidence provenance and sensitivity", () => {
    const evidence = {
      id: "evidence-123",
      orgId: "org-abc",
      customerId: "customer-123",
      evidenceType: "quiz_response",
      origin: "declared" as const,
      source: {
        connector: "quiz",
        externalEventId: "event-123",
      },
      occurredAt: "2026-07-28T11:55:00.000Z",
      receivedAt: "2026-07-28T12:00:00.000Z",
      sensitivity: "sensitive" as const,
      attributes: {
        answerReference: "answer-123",
      },
    };

    expect(validateCustomerEvidence(evidence)).toEqual({
      ok: true,
      value: evidence,
    });
    expect(
      validateCustomerEvidence({
        ...evidence,
        source: { connector: "" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_customer_evidence" },
    });
  });

  test("stores AI judgement without replacing it with domain heuristics", () => {
    const input: AiRecipientDecisionInput = {
      id: "decision-123",
      orgId: "org-abc",
      customerId: "customer-123",
      campaignId: "campaign-123",
      program: "repeat_purchase",
      status: "proposed",
      dossierChecksum: "dossier-checksum",
      model: {
        provider: "provider",
        model: "model",
        promptVersion: "prompt-v1",
      },
      generatedAt: "2026-07-28T12:00:00.000Z",
      objective: "Invite the customer to explore a complementary product.",
      rationale: "The AI selected this objective from the supplied evidence.",
      recommendation: {
        action: "prepare_personalized_email",
        channel: "email",
        timing: "next suitable customer moment",
        personalizationBrief: "Use the verified purchase context.",
      },
      hypotheses: [
        {
          id: "hypothesis-123",
          statement: "A complementary product may be useful.",
          confidence: 0.61,
          evidenceIds: ["evidence-123"],
        },
      ],
      evidenceIds: ["evidence-123"],
      confidence: 0.68,
      sensitivity: "standard",
      requiresHumanReview: true,
    };

    const result = createAiRecipientDecision(input);

    expect(result).toEqual({ ok: true, value: input });
  });
});

describe("campaign approval and state contracts", () => {
  test("creates an order-independent checksum for frozen approval material", () => {
    const first = getCampaignApprovalChecksum(approvalMaterial());
    const reordered = getCampaignApprovalChecksum(
      approvalMaterial({
        recipientDecisions: [
          { id: "customer-1", checksum: "decision-1" },
          { id: "customer-2", checksum: "decision-2" },
        ],
        content: [
          { id: "customer-1", checksum: "content-1" },
          { id: "customer-2", checksum: "content-2" },
        ],
        modelReferences: ["model-a", "model-b"],
        promptReferences: ["prompt-a", "prompt-b"],
      }),
    );

    expect(first.ok).toBe(true);
    expect(reordered).toEqual(first);
  });

  test("rejects ambiguous duplicate approval references", () => {
    const result = getCampaignApprovalChecksum(
      approvalMaterial({
        recipientDecisions: [
          { id: "customer-1", checksum: "decision-1" },
          { id: "customer-1", checksum: "decision-2" },
        ],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_approval_material" },
    });
  });

  test("invalidates approval when frozen content changes", () => {
    const snapshot = approvalSnapshot();
    const changedMaterial = approvalMaterial({
      content: [{ id: "customer-1", checksum: "changed-content" }],
    });

    const validation = validateCampaignApprovalSnapshot(
      snapshot,
      changedMaterial,
    );
    const invalidated = invalidateCampaignApprovalSnapshot(
      snapshot,
      changedMaterial,
      "2026-07-28T13:00:00.000Z",
    );

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe("approval_invalidated");
      expect(validation.error.details?.changedFields).toContain("content");
    }
    expect(invalidated.invalidatedAt).toBe("2026-07-28T13:00:00.000Z");
    expect(invalidated.invalidationReasons).toContain("content");
  });

  test("reports a newly added optional offer checksum as an approval change", () => {
    const withoutOffer = approvalMaterial({ offerChecksum: undefined });
    const snapshotResult = createCampaignApprovalSnapshot(withoutOffer, {
      approvedBy: "user-123",
      approvedAt: "2026-07-28T12:00:00.000Z",
    });
    if (!snapshotResult.ok) {
      throw new Error(snapshotResult.error.message);
    }

    const invalidated = invalidateCampaignApprovalSnapshot(
      snapshotResult.value,
      approvalMaterial({ offerChecksum: "new-offer" }),
      "2026-07-28T13:00:00.000Z",
    );

    expect(invalidated.invalidationReasons).toContain("offerChecksum");
  });

  test("enforces approval and campaign state transitions", () => {
    const snapshot = approvalSnapshot();
    const approved = transitionRetentionDecisionCampaign(
      campaign(),
      "approved",
      "2026-07-28T12:00:00.000Z",
      snapshot,
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      return;
    }

    const ready = transitionRetentionDecisionCampaign(
      approved.value,
      "ready_to_send",
      "2026-07-28T12:05:00.000Z",
    );
    const illegal = transitionRetentionDecisionCampaign(
      approved.value,
      "sent",
      "2026-07-28T12:05:00.000Z",
    );

    expect(ready.ok).toBe(true);
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.error.code).toBe("invalid_campaign_transition");
    }
    expect(getAllowedCampaignTransitions("sending")).toEqual([
      "sent",
      "partially_sent",
      "failed",
    ]);
  });

  test("rejects a tampered approval snapshot during state transition", () => {
    const snapshot = {
      ...approvalSnapshot(),
      checksum: "tampered-checksum",
    };
    const result = transitionRetentionDecisionCampaign(
      campaign(),
      "approved",
      "2026-07-28T12:00:00.000Z",
      snapshot,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "approval_invalidated" },
    });
  });

  test("returns to a new unapproved revision when a campaign is redrafted", () => {
    const redrafted = transitionRetentionDecisionCampaign(
      campaign({
        state: "approved",
        approval: approvalSnapshot(),
      }),
      "draft",
      "2026-07-28T13:00:00.000Z",
    );

    expect(redrafted.ok).toBe(true);
    if (redrafted.ok) {
      expect(redrafted.value.revision).toBe(2);
      expect(redrafted.value.approval).toBeNull();
    }
  });
});

describe("idempotent release validation", () => {
  test("accepts a new release only with current approval", () => {
    const snapshot = approvalSnapshot();
    const result = validateCampaignRelease({
      campaign: campaign({
        state: "ready_to_send",
        approval: snapshot,
      }),
      currentApprovalMaterial: approvalMaterial(),
      request: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        requestedBy: "user-123",
        requestedAt: "2026-07-28T13:00:00.000Z",
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        disposition: "new",
        idempotencyKey: "release-123",
      },
    });
  });

  test("replays an exact release after sending has begun", () => {
    const snapshot = approvalSnapshot();
    const result = validateCampaignRelease({
      campaign: campaign({
        state: "sending",
        approval: snapshot,
      }),
      currentApprovalMaterial: approvalMaterial(),
      request: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        requestedBy: "user-123",
        requestedAt: "2026-07-28T13:05:00.000Z",
      },
      existingRelease: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        releaseId: "provider-release-123",
        acceptedAt: "2026-07-28T13:00:01.000Z",
        status: "accepted",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.disposition).toBe("replay");
    }
  });

  test("rejects reused keys with different release material", () => {
    const snapshot = approvalSnapshot();
    const result = validateCampaignRelease({
      campaign: campaign({
        state: "ready_to_send",
        approval: snapshot,
      }),
      currentApprovalMaterial: approvalMaterial(),
      request: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: "different-approval",
        requestedBy: "user-123",
        requestedAt: "2026-07-28T13:05:00.000Z",
      },
      existingRelease: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        releaseId: "provider-release-123",
        acceptedAt: "2026-07-28T13:00:01.000Z",
        status: "accepted",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("idempotency_conflict");
    }
  });

  test("rejects stale approval material and tenant mismatches", () => {
    const snapshot = approvalSnapshot();
    const stale = validateCampaignRelease({
      campaign: campaign({
        state: "ready_to_send",
        approval: snapshot,
      }),
      currentApprovalMaterial: approvalMaterial({
        audienceChecksum: "changed-audience",
      }),
      request: {
        orgId: "org-abc",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        requestedBy: "user-123",
        requestedAt: "2026-07-28T13:05:00.000Z",
      },
    });
    const wrongTenant = validateCampaignRelease({
      campaign: campaign({
        state: "ready_to_send",
        approval: snapshot,
      }),
      currentApprovalMaterial: approvalMaterial(),
      request: {
        orgId: "org-other",
        campaignId: "campaign-123",
        idempotencyKey: "release-123",
        approvalChecksum: snapshot.checksum,
        requestedBy: "user-123",
        requestedAt: "2026-07-28T13:05:00.000Z",
      },
    });

    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("approval_invalidated");
    }
    expect(wrongTenant.ok).toBe(false);
    if (!wrongTenant.ok) {
      expect(wrongTenant.error.code).toBe("tenant_mismatch");
    }
  });

  test("checksums complete program policies and changes with material edits", () => {
    const first = getProgramPolicyApprovalChecksum({
      orgId: "org-abc",
      programId: "program-123",
      program: "re_engagement",
      name: "Useful return visit",
      policyVersion: "v1",
      policy: { objective: "Help, do not pressure", maxDiscount: 10 },
    });
    const reordered = getProgramPolicyApprovalChecksum({
      orgId: "org-abc",
      programId: "program-123",
      program: "re_engagement",
      name: "Useful return visit",
      policyVersion: "v1",
      policy: { maxDiscount: 10, objective: "Help, do not pressure" },
    });
    const changed = getProgramPolicyApprovalChecksum({
      orgId: "org-abc",
      programId: "program-123",
      program: "re_engagement",
      name: "Useful return visit",
      policyVersion: "v2",
      policy: { objective: "Help, do not pressure", maxDiscount: 10 },
    });

    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    expect(changed.ok).toBe(true);
    if (first.ok && reordered.ok && changed.ok) {
      expect(first.value).toBe(reordered.value);
      expect(first.value).not.toBe(changed.value);
    }
  });

  test("rejects incomplete program approval material", () => {
    const result = getProgramPolicyApprovalChecksum({
      orgId: "org-abc",
      programId: "",
      program: "repeat_purchase",
      name: "Repeat purchase",
      policyVersion: "v1",
      policy: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_program_policy");
    }
  });
});
