import { createHash } from "node:crypto";

export const RETENTION_DECISION_PROGRAMS = [
  "non_buyer_conversion",
  "re_engagement",
  "repeat_purchase",
] as const;

export type RetentionDecisionProgram =
  (typeof RETENTION_DECISION_PROGRAMS)[number];

export const RETENTION_CAMPAIGN_MODES = [
  "dynamic_template",
  "individual_message",
] as const;

export type RetentionCampaignMode = (typeof RETENTION_CAMPAIGN_MODES)[number];

export const RETENTION_CAMPAIGN_STATES = [
  "draft",
  "approved",
  "ready_to_send",
  "sending",
  "sent",
  "partially_sent",
  "failed",
  "cancelled",
] as const;

export type RetentionCampaignState =
  (typeof RETENTION_CAMPAIGN_STATES)[number];

export type RetentionContractErrorCode =
  | "approval_invalidated"
  | "approval_required"
  | "campaign_not_ready"
  | "idempotency_conflict"
  | "idempotency_key_required"
  | "invalid_approval_material"
  | "invalid_campaign_transition"
  | "invalid_confidence"
  | "invalid_customer_evidence"
  | "invalid_program_policy"
  | "invalid_recipient_decision"
  | "invalid_segment_expression"
  | "invalid_trait_provenance"
  | "tenant_mismatch";

export interface RetentionContractError {
  code: RetentionContractErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export type RetentionContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RetentionContractError };

export type RetentionScalar = string | number | boolean | null;

export type RetentionJsonValue =
  | RetentionScalar
  | RetentionJsonValue[]
  | { [key: string]: RetentionJsonValue };

export type SegmentPredicateNamespace =
  | "consent"
  | "evidence"
  | "metric"
  | "profile"
  | "trait";

export type SegmentPredicateOperator =
  | "after"
  | "before"
  | "contains"
  | "equals"
  | "exists"
  | "greater_than"
  | "greater_than_or_equal"
  | "in"
  | "less_than"
  | "less_than_or_equal"
  | "not_contains"
  | "not_equals"
  | "not_exists"
  | "not_in";

export interface SegmentPredicate {
  type: "predicate";
  namespace: SegmentPredicateNamespace;
  key: string;
  operator: SegmentPredicateOperator;
  value?: RetentionScalar | readonly RetentionScalar[];
}

export interface SegmentAllExpression {
  type: "all";
  expressions: readonly WorklinSegmentExpression[];
}

export interface SegmentAnyExpression {
  type: "any";
  expressions: readonly WorklinSegmentExpression[];
}

export interface SegmentNotExpression {
  type: "not";
  expression: WorklinSegmentExpression;
}

export type WorklinSegmentExpression =
  | SegmentPredicate
  | SegmentAllExpression
  | SegmentAnyExpression
  | SegmentNotExpression;

export interface SegmentExpressionReference {
  namespace: SegmentPredicateNamespace;
  key: string;
}

export interface SegmentExpressionValidation {
  depth: number;
  nodeCount: number;
  references: readonly SegmentExpressionReference[];
}

export interface SegmentExpressionValidationOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export type CustomerEvidenceOrigin =
  | "declared"
  | "imported"
  | "inferred"
  | "observed";

export type CustomerDataSensitivity =
  | "standard"
  | "personal"
  | "sensitive"
  | "restricted";

export interface CustomerEvidenceSource {
  connector: string;
  externalEventId?: string;
  externalRecordId?: string;
}

export interface CustomerEvidence {
  id: string;
  orgId: string;
  customerId: string;
  evidenceType: string;
  origin: CustomerEvidenceOrigin;
  source: CustomerEvidenceSource;
  occurredAt: string;
  receivedAt: string;
  sensitivity: CustomerDataSensitivity;
  attributes?: Readonly<Record<string, RetentionJsonValue>>;
}

export interface CustomerTraitProvenance {
  origin: CustomerEvidenceOrigin;
  evidenceIds: readonly string[];
  source: CustomerEvidenceSource;
  modelReference?: string;
  reasoningReference?: string;
}

export type CustomerTraitStatus =
  | "active"
  | "disputed"
  | "expired"
  | "revoked";

export interface CustomerTrait {
  id: string;
  orgId: string;
  customerId: string;
  key: string;
  value: RetentionJsonValue;
  confidence: number;
  sensitivity: CustomerDataSensitivity;
  status: CustomerTraitStatus;
  provenance: CustomerTraitProvenance;
  observedAt: string;
  expiresAt?: string;
}

export interface AiModelReference {
  provider: string;
  model: string;
  promptVersion: string;
  responseId?: string;
}

export interface RecipientDecisionHypothesis {
  id: string;
  statement: string;
  confidence: number;
  evidenceIds: readonly string[];
}

export interface RecipientDecisionRecommendation {
  action: string;
  channel: string;
  timing?: string;
  offer?: string;
  personalizationBrief: string;
}

export interface AiUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimatedProviderCost?: number;
  currency?: string;
}

export type AiRecipientDecisionStatus =
  | "proposed"
  | "reviewed"
  | "approved"
  | "rejected"
  | "stale";

export interface AiRecipientDecision {
  id: string;
  orgId: string;
  customerId: string;
  campaignId?: string;
  program: RetentionDecisionProgram;
  status: AiRecipientDecisionStatus;
  dossierChecksum: string;
  model: AiModelReference;
  generatedAt: string;
  objective: string;
  rationale: string;
  recommendation: RecipientDecisionRecommendation;
  hypotheses: readonly RecipientDecisionHypothesis[];
  evidenceIds: readonly string[];
  confidence: number;
  sensitivity: CustomerDataSensitivity;
  requiresHumanReview: boolean;
  usage?: AiUsageRecord;
}

export type AiRecipientDecisionInput = AiRecipientDecision;

export interface ApprovalChecksumReference {
  id: string;
  checksum: string;
}

export interface CampaignApprovalMaterial {
  orgId: string;
  campaignId: string;
  campaignRevision: number;
  program: RetentionDecisionProgram;
  mode: RetentionCampaignMode;
  audienceSnapshotId: string;
  audienceChecksum: string;
  recipientDecisions: readonly ApprovalChecksumReference[];
  content: readonly ApprovalChecksumReference[];
  modelReferences: readonly string[];
  promptReferences: readonly string[];
  offerChecksum?: string | null;
}

export interface ProgramPolicyApprovalMaterial {
  orgId: string;
  programId: string;
  program: RetentionDecisionProgram;
  name: string;
  policyVersion: string;
  policy: RetentionJsonValue;
}

export interface CampaignApprovalSnapshot {
  material: CampaignApprovalMaterial;
  checksum: string;
  approvedBy: string;
  approvedAt: string;
  invalidatedAt?: string;
  invalidationReasons?: readonly string[];
}

export interface CampaignApprovalMetadata {
  approvedBy: string;
  approvedAt: string;
}

export interface RetentionDecisionCampaign {
  id: string;
  orgId: string;
  program: RetentionDecisionProgram;
  mode: RetentionCampaignMode;
  state: RetentionCampaignState;
  revision: number;
  approval: CampaignApprovalSnapshot | null;
  lastTransitionAt: string;
}

export interface CampaignReleaseRequest {
  orgId: string;
  campaignId: string;
  idempotencyKey: string;
  approvalChecksum: string;
  requestedBy: string;
  requestedAt: string;
}

export interface CampaignReleaseReceipt {
  orgId: string;
  campaignId: string;
  idempotencyKey: string;
  approvalChecksum: string;
  releaseId: string;
  acceptedAt: string;
  status: "accepted" | "completed";
}

export interface CampaignReleaseValidationInput {
  campaign: RetentionDecisionCampaign;
  currentApprovalMaterial: CampaignApprovalMaterial;
  request: CampaignReleaseRequest;
  existingRelease?: CampaignReleaseReceipt;
}

export type CampaignReleaseValidation =
  | {
      disposition: "new";
      idempotencyKey: string;
    }
  | {
      disposition: "replay";
      idempotencyKey: string;
      receipt: CampaignReleaseReceipt;
    };

const CAMPAIGN_TRANSITIONS: Readonly<
  Record<RetentionCampaignState, readonly RetentionCampaignState[]>
> = {
  draft: ["approved", "cancelled"],
  approved: ["draft", "ready_to_send", "cancelled"],
  ready_to_send: ["draft", "sending", "cancelled"],
  sending: ["sent", "partially_sent", "failed"],
  sent: [],
  partially_sent: ["sending", "failed", "cancelled"],
  failed: ["draft", "ready_to_send", "cancelled"],
  cancelled: [],
};

function failure<T>(
  code: RetentionContractErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RetentionContractResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 0);
}

function canonicalize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entryValue]) => {
      return `${JSON.stringify(key)}:${canonicalize(entryValue)}`;
    })
    .join(",")}}`;
}

function normalizeApprovalMaterial(
  material: CampaignApprovalMaterial,
): CampaignApprovalMaterial {
  const sortReferences = (
    references: readonly ApprovalChecksumReference[],
  ): ApprovalChecksumReference[] => {
    return [...references].sort((left, right) => {
      const idOrder = left.id.localeCompare(right.id);
      return idOrder === 0
        ? left.checksum.localeCompare(right.checksum)
        : idOrder;
    });
  };

  return {
    ...material,
    recipientDecisions: sortReferences(material.recipientDecisions),
    content: sortReferences(material.content),
    modelReferences: [...material.modelReferences].sort(),
    promptReferences: [...material.promptReferences].sort(),
  };
}

function hasValidChecksumReferences(
  references: readonly ApprovalChecksumReference[],
): boolean {
  const ids = new Set<string>();

  return references.every((reference) => {
    if (
      !isNonEmpty(reference.id) ||
      !isNonEmpty(reference.checksum) ||
      ids.has(reference.id)
    ) {
      return false;
    }

    ids.add(reference.id);
    return true;
  });
}

function validateApprovalMaterial(
  material: CampaignApprovalMaterial,
): RetentionContractResult<CampaignApprovalMaterial> {
  if (
    !isNonEmpty(material.orgId) ||
    !isNonEmpty(material.campaignId) ||
    !Number.isInteger(material.campaignRevision) ||
    material.campaignRevision < 1 ||
    !isNonEmpty(material.audienceSnapshotId) ||
    !isNonEmpty(material.audienceChecksum) ||
    material.recipientDecisions.length === 0 ||
    material.content.length === 0 ||
    !hasValidChecksumReferences(material.recipientDecisions) ||
    !hasValidChecksumReferences(material.content) ||
    material.modelReferences.length === 0 ||
    material.promptReferences.length === 0 ||
    material.modelReferences.some((reference) => !isNonEmpty(reference)) ||
    material.promptReferences.some((reference) => !isNonEmpty(reference)) ||
    (material.offerChecksum !== undefined &&
      material.offerChecksum !== null &&
      !isNonEmpty(material.offerChecksum)) ||
    !isRetentionDecisionProgram(material.program) ||
    !isRetentionCampaignMode(material.mode)
  ) {
    return failure(
      "invalid_approval_material",
      "Approval material must contain stable campaign, audience, decision, content, model, and prompt references.",
    );
  }

  return { ok: true, value: normalizeApprovalMaterial(material) };
}

export function validateWorklinSegmentExpression(
  expression: WorklinSegmentExpression,
  options: SegmentExpressionValidationOptions = {},
): RetentionContractResult<SegmentExpressionValidation> {
  const maxDepth = options.maxDepth ?? 12;
  const maxNodes = options.maxNodes ?? 250;
  const references = new Map<string, SegmentExpressionReference>();
  let nodeCount = 0;
  let deepestNode = 0;

  const visit = (
    node: WorklinSegmentExpression,
    depth: number,
  ): RetentionContractError | null => {
    nodeCount += 1;
    deepestNode = Math.max(deepestNode, depth);

    if (nodeCount > maxNodes || depth > maxDepth) {
      return {
        code: "invalid_segment_expression",
        message: "Segment expression exceeds its configured complexity limit.",
        details: { maxDepth, maxNodes },
      };
    }

    if (node.type === "predicate") {
      if (!isNonEmpty(node.key)) {
        return {
          code: "invalid_segment_expression",
          message: "Segment predicate keys must not be empty.",
        };
      }

      const expectsNoValue =
        node.operator === "exists" || node.operator === "not_exists";
      if (
        (expectsNoValue && node.value !== undefined) ||
        (!expectsNoValue && node.value === undefined)
      ) {
        return {
          code: "invalid_segment_expression",
          message: `Segment operator ${node.operator} has an invalid value.`,
          details: { operator: node.operator },
        };
      }

      references.set(`${node.namespace}:${node.key}`, {
        namespace: node.namespace,
        key: node.key,
      });
      return null;
    }

    if (node.type === "not") {
      return visit(node.expression, depth + 1);
    }

    if (node.expressions.length === 0) {
      return {
        code: "invalid_segment_expression",
        message: `Segment ${node.type} expressions must contain at least one child.`,
      };
    }

    for (const child of node.expressions) {
      const error = visit(child, depth + 1);
      if (error) {
        return error;
      }
    }

    return null;
  };

  const error = visit(expression, 1);
  if (error) {
    return { ok: false, error };
  }

  return {
    ok: true,
    value: {
      depth: deepestNode,
      nodeCount,
      references: [...references.values()].sort((left, right) => {
        return `${left.namespace}:${left.key}`.localeCompare(
          `${right.namespace}:${right.key}`,
        );
      }),
    },
  };
}

export function validateCustomerEvidence(
  evidence: CustomerEvidence,
): RetentionContractResult<CustomerEvidence> {
  if (
    !isNonEmpty(evidence.id) ||
    !isNonEmpty(evidence.orgId) ||
    !isNonEmpty(evidence.customerId) ||
    !isNonEmpty(evidence.evidenceType) ||
    !isNonEmpty(evidence.source.connector) ||
    !isNonEmpty(evidence.occurredAt) ||
    !isNonEmpty(evidence.receivedAt)
  ) {
    return failure(
      "invalid_customer_evidence",
      "Customer evidence requires stable ownership, identity, source, type, and timestamps.",
    );
  }

  return { ok: true, value: evidence };
}

export function validateCustomerTrait(
  trait: CustomerTrait,
): RetentionContractResult<CustomerTrait> {
  if (!isConfidence(trait.confidence)) {
    return failure(
      "invalid_confidence",
      "Customer trait confidence must be between 0 and 1.",
      { confidence: trait.confidence },
    );
  }

  if (
    !isNonEmpty(trait.id) ||
    !isNonEmpty(trait.orgId) ||
    !isNonEmpty(trait.customerId) ||
    !isNonEmpty(trait.key) ||
    !isNonEmpty(trait.provenance.source.connector) ||
    trait.provenance.evidenceIds.some((id) => !isNonEmpty(id))
  ) {
    return failure(
      "invalid_trait_provenance",
      "Customer traits require stable ownership, identity, key, source, and evidence references.",
    );
  }

  if (
    trait.provenance.origin === "inferred" &&
    !isNonEmpty(trait.provenance.modelReference ?? "")
  ) {
    return failure(
      "invalid_trait_provenance",
      "Inferred customer traits require a model reference.",
    );
  }

  return { ok: true, value: trait };
}

export function createAiRecipientDecision(
  input: AiRecipientDecisionInput,
): RetentionContractResult<AiRecipientDecision> {
  if (!isConfidence(input.confidence)) {
    return failure(
      "invalid_confidence",
      "Recipient decision confidence must be between 0 and 1.",
      { confidence: input.confidence },
    );
  }

  const invalidHypothesis = input.hypotheses.find(
    (hypothesis) =>
      !isNonEmpty(hypothesis.id) ||
      !isNonEmpty(hypothesis.statement) ||
      !isConfidence(hypothesis.confidence) ||
      hypothesis.evidenceIds.some((id) => !isNonEmpty(id)),
  );
  const invalidUsage =
    input.usage !== undefined &&
    (!isNonNegativeInteger(input.usage.inputTokens) ||
      !isNonNegativeInteger(input.usage.outputTokens) ||
      !isNonNegativeInteger(input.usage.cachedInputTokens) ||
      (input.usage.estimatedProviderCost !== undefined &&
        (!Number.isFinite(input.usage.estimatedProviderCost) ||
          input.usage.estimatedProviderCost < 0)) ||
      (input.usage.estimatedProviderCost !== undefined &&
        !isNonEmpty(input.usage.currency ?? "")));

  if (
    !isNonEmpty(input.id) ||
    !isNonEmpty(input.orgId) ||
    !isNonEmpty(input.customerId) ||
    !isNonEmpty(input.dossierChecksum) ||
    !isNonEmpty(input.model.provider) ||
    !isNonEmpty(input.model.model) ||
    !isNonEmpty(input.model.promptVersion) ||
    !isNonEmpty(input.objective) ||
    !isNonEmpty(input.rationale) ||
    !isNonEmpty(input.recommendation.action) ||
    !isNonEmpty(input.recommendation.channel) ||
    !isNonEmpty(input.recommendation.personalizationBrief) ||
    input.evidenceIds.some((id) => !isNonEmpty(id)) ||
    invalidHypothesis !== undefined ||
    invalidUsage
  ) {
    return failure(
      "invalid_recipient_decision",
      "Recipient decisions require complete AI output and valid evidence references.",
    );
  }

  return { ok: true, value: input };
}

export function getCampaignApprovalChecksum(
  material: CampaignApprovalMaterial,
): RetentionContractResult<string> {
  const validation = validateApprovalMaterial(material);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: createHash("sha256")
      .update(canonicalize(validation.value))
      .digest("hex"),
  };
}

export function getProgramPolicyApprovalChecksum(
  material: ProgramPolicyApprovalMaterial,
): RetentionContractResult<string> {
  if (
    !isNonEmpty(material.orgId) ||
    !isNonEmpty(material.programId) ||
    !RETENTION_DECISION_PROGRAMS.includes(material.program) ||
    !isNonEmpty(material.name) ||
    !isNonEmpty(material.policyVersion) ||
    material.policy === undefined
  ) {
    return failure(
      "invalid_program_policy",
      "Program approval requires a complete versioned Worklin policy.",
    );
  }
  return {
    ok: true,
    value: createHash("sha256")
      .update(canonicalize(material))
      .digest("hex"),
  };
}

export function createCampaignApprovalSnapshot(
  material: CampaignApprovalMaterial,
  metadata: CampaignApprovalMetadata,
): RetentionContractResult<CampaignApprovalSnapshot> {
  if (!isNonEmpty(metadata.approvedBy) || !isNonEmpty(metadata.approvedAt)) {
    return failure(
      "invalid_approval_material",
      "Approval metadata requires an approver and approval timestamp.",
    );
  }

  const materialValidation = validateApprovalMaterial(material);
  if (!materialValidation.ok) {
    return materialValidation;
  }

  const checksum = getCampaignApprovalChecksum(materialValidation.value);
  if (!checksum.ok) {
    return checksum;
  }

  return {
    ok: true,
    value: {
      material: materialValidation.value,
      checksum: checksum.value,
      approvedBy: metadata.approvedBy,
      approvedAt: metadata.approvedAt,
    },
  };
}

export function getCampaignApprovalChangedFields(
  approved: CampaignApprovalMaterial,
  current: CampaignApprovalMaterial,
): readonly string[] {
  const approvedRecord = normalizeApprovalMaterial(approved);
  const currentRecord = normalizeApprovalMaterial(current);
  const keys: ReadonlyArray<keyof CampaignApprovalMaterial> = [
    "orgId",
    "campaignId",
    "campaignRevision",
    "program",
    "mode",
    "audienceSnapshotId",
    "audienceChecksum",
    "recipientDecisions",
    "content",
    "modelReferences",
    "promptReferences",
    "offerChecksum",
  ];

  return keys.filter((key) => {
    return canonicalize(approvedRecord[key]) !== canonicalize(currentRecord[key]);
  });
}

export function validateCampaignApprovalSnapshot(
  snapshot: CampaignApprovalSnapshot,
  currentMaterial: CampaignApprovalMaterial,
): RetentionContractResult<CampaignApprovalSnapshot> {
  if (snapshot.invalidatedAt) {
    return failure(
      "approval_invalidated",
      "Campaign approval has already been invalidated.",
      { invalidatedAt: snapshot.invalidatedAt },
    );
  }

  const approvedChecksum = getCampaignApprovalChecksum(snapshot.material);
  const currentChecksum = getCampaignApprovalChecksum(currentMaterial);
  if (!approvedChecksum.ok) {
    return approvedChecksum;
  }
  if (!currentChecksum.ok) {
    return currentChecksum;
  }

  if (
    approvedChecksum.value !== snapshot.checksum ||
    currentChecksum.value !== snapshot.checksum
  ) {
    return failure(
      "approval_invalidated",
      "Campaign approval does not match the current frozen material.",
      {
        approvedChecksum: snapshot.checksum,
        currentChecksum: currentChecksum.value,
        changedFields: getCampaignApprovalChangedFields(
          snapshot.material,
          currentMaterial,
        ),
      },
    );
  }

  return { ok: true, value: snapshot };
}

export function invalidateCampaignApprovalSnapshot(
  snapshot: CampaignApprovalSnapshot,
  currentMaterial: CampaignApprovalMaterial,
  invalidatedAt: string,
): CampaignApprovalSnapshot {
  const validation = validateCampaignApprovalSnapshot(snapshot, currentMaterial);
  if (validation.ok) {
    return snapshot;
  }

  const changedFields = getCampaignApprovalChangedFields(
    snapshot.material,
    currentMaterial,
  );

  return {
    ...snapshot,
    invalidatedAt,
    invalidationReasons:
      changedFields.length > 0 ? changedFields : [validation.error.code],
  };
}

export function isRetentionDecisionProgram(
  value: string,
): value is RetentionDecisionProgram {
  return RETENTION_DECISION_PROGRAMS.some((program) => program === value);
}

export function isRetentionCampaignMode(
  value: string,
): value is RetentionCampaignMode {
  return RETENTION_CAMPAIGN_MODES.some((mode) => mode === value);
}

export function getAllowedCampaignTransitions(
  state: RetentionCampaignState,
): readonly RetentionCampaignState[] {
  return CAMPAIGN_TRANSITIONS[state];
}

export function transitionRetentionDecisionCampaign(
  campaign: RetentionDecisionCampaign,
  nextState: RetentionCampaignState,
  transitionedAt: string,
  approval?: CampaignApprovalSnapshot,
): RetentionContractResult<RetentionDecisionCampaign> {
  if (!CAMPAIGN_TRANSITIONS[campaign.state].includes(nextState)) {
    return failure(
      "invalid_campaign_transition",
      `Campaign cannot transition from ${campaign.state} to ${nextState}.`,
      { from: campaign.state, to: nextState },
    );
  }

  if (nextState === "approved") {
    if (!approval) {
      return failure(
        "approval_required",
        "A campaign approval snapshot is required for approval.",
      );
    }
    if (
      approval.material.orgId !== campaign.orgId ||
      approval.material.campaignId !== campaign.id ||
      approval.material.campaignRevision !== campaign.revision
    ) {
      return failure(
        "invalid_approval_material",
        "Approval material does not match the campaign identity and revision.",
      );
    }

    const approvalValidation = validateCampaignApprovalSnapshot(
      approval,
      approval.material,
    );
    if (!approvalValidation.ok) {
      return approvalValidation;
    }
  }

  if (nextState === "ready_to_send") {
    if (!campaign.approval) {
      return failure(
        "approval_required",
        "A current campaign approval is required before release readiness.",
      );
    }

    const approvalValidation = validateCampaignApprovalSnapshot(
      campaign.approval,
      campaign.approval.material,
    );
    if (!approvalValidation.ok) {
      return approvalValidation;
    }
  }

  return {
    ok: true,
    value: {
      ...campaign,
      state: nextState,
      revision: nextState === "draft" ? campaign.revision + 1 : campaign.revision,
      approval:
        nextState === "draft"
          ? null
          : nextState === "approved"
            ? (approval ?? null)
            : campaign.approval,
      lastTransitionAt: transitionedAt,
    },
  };
}

export function validateCampaignRelease(
  input: CampaignReleaseValidationInput,
): RetentionContractResult<CampaignReleaseValidation> {
  const idempotencyKey = input.request.idempotencyKey.trim();

  if (!isNonEmpty(idempotencyKey)) {
    return failure(
      "idempotency_key_required",
      "Campaign release requires an idempotency key.",
    );
  }

  if (
    input.request.orgId !== input.campaign.orgId ||
    input.currentApprovalMaterial.orgId !== input.campaign.orgId
  ) {
    return failure(
      "tenant_mismatch",
      "Campaign release organization does not match the campaign.",
    );
  }

  if (
    input.request.campaignId !== input.campaign.id ||
    input.currentApprovalMaterial.campaignId !== input.campaign.id
  ) {
    return failure(
      "campaign_not_ready",
      "Campaign release identity does not match the campaign.",
    );
  }

  if (input.existingRelease) {
    const existing = input.existingRelease;
    const isExactReplay =
      existing.orgId === input.request.orgId &&
      existing.campaignId === input.request.campaignId &&
      existing.idempotencyKey === idempotencyKey &&
      existing.approvalChecksum === input.request.approvalChecksum;

    if (isExactReplay) {
      return {
        ok: true,
        value: {
          disposition: "replay",
          idempotencyKey,
          receipt: existing,
        },
      };
    }

    return failure(
      "idempotency_conflict",
      "The idempotency key is already associated with a different campaign release.",
      { idempotencyKey },
    );
  }

  if (input.campaign.state !== "ready_to_send") {
    return failure(
      "campaign_not_ready",
      "Campaign must be ready_to_send before a new release.",
      { state: input.campaign.state },
    );
  }

  if (!input.campaign.approval) {
    return failure(
      "approval_required",
      "Campaign release requires a current approval snapshot.",
    );
  }

  if (input.request.approvalChecksum !== input.campaign.approval.checksum) {
    return failure(
      "approval_invalidated",
      "Release request approval checksum does not match the campaign approval.",
    );
  }

  const approvalValidation = validateCampaignApprovalSnapshot(
    input.campaign.approval,
    input.currentApprovalMaterial,
  );
  if (!approvalValidation.ok) {
    return approvalValidation;
  }

  return {
    ok: true,
    value: {
      disposition: "new",
      idempotencyKey,
    },
  };
}
