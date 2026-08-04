import type {
  RetentionScalar,
  SegmentPredicate,
  WorklinSegmentExpression,
} from "@vellumai/retention-domain";
import { validateWorklinSegmentExpression } from "@vellumai/retention-domain";

export type SegmentEligibilityReason =
  | "eligible"
  | "missing_email"
  | "unsubscribed"
  | "suppressed"
  | "consent_unknown";

export interface SegmentCustomerState {
  profile: {
    status: string;
    has_email: boolean;
    has_phone: boolean;
    created_at: string;
    source_updated_at: string | null;
  };
  consent: { email: string };
  metric: {
    source_event_count: number;
    klaviyo_event_count: number;
    days_since_last_event: number | null;
  };
  evidence: {
    provider: string[];
    event_type: string[];
  };
  trait: Record<string, unknown>;
}

const SAFE_FIXED_KEYS = {
  consent: new Set(["email"]),
  evidence: new Set(["provider", "event_type"]),
  metric: new Set([
    "source_event_count",
    "klaviyo_event_count",
    "days_since_last_event",
  ]),
  profile: new Set([
    "status",
    "has_email",
    "has_phone",
    "created_at",
    "source_updated_at",
  ]),
} as const;

const TRAIT_KEY_PATTERN = /^klaviyo\.[\p{L}\p{N}][\p{L}\p{N} _.-]{0,127}$/u;
const SEGMENT_NAMESPACES = new Set([
  "consent",
  "evidence",
  "metric",
  "profile",
  "trait",
]);
const SEGMENT_OPERATORS = new Set([
  "after",
  "before",
  "contains",
  "equals",
  "exists",
  "greater_than",
  "greater_than_or_equal",
  "in",
  "less_than",
  "less_than_or_equal",
  "not_contains",
  "not_equals",
  "not_exists",
  "not_in",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeExpressionValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 512;
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((item) => isSafeExpressionValue(item) && !Array.isArray(item))
  );
}

function hasSafeRuntimeShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "predicate") {
    if (
      typeof value.namespace !== "string" ||
      !SEGMENT_NAMESPACES.has(value.namespace) ||
      typeof value.key !== "string" ||
      typeof value.operator !== "string" ||
      !SEGMENT_OPERATORS.has(value.operator)
    ) {
      return false;
    }
    if (value.value !== undefined && !isSafeExpressionValue(value.value)) {
      return false;
    }
    if (
      (value.operator === "in" || value.operator === "not_in") &&
      !Array.isArray(value.value)
    ) {
      return false;
    }
    if (
      [
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
      ].includes(value.operator) &&
      typeof value.value !== "number"
    ) {
      return false;
    }
    if (
      (value.operator === "after" || value.operator === "before") &&
      (typeof value.value !== "string" ||
        !Number.isFinite(Date.parse(value.value)))
    ) {
      return false;
    }
    return true;
  }
  if (value.type === "not") {
    return hasSafeRuntimeShape(value.expression);
  }
  if (value.type === "all" || value.type === "any") {
    return (
      Array.isArray(value.expressions) &&
      value.expressions.every(hasSafeRuntimeShape)
    );
  }
  return false;
}

export function validateSafeSegmentExpression(
  expression: WorklinSegmentExpression,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!hasSafeRuntimeShape(expression)) {
    return {
      ok: false,
      code: "invalid_segment_expression",
      message: "The segment expression has an invalid runtime shape.",
    };
  }
  const structural = validateWorklinSegmentExpression(expression, {
    maxDepth: 8,
    maxNodes: 100,
  });
  if (!structural.ok) {
    return {
      ok: false,
      code: structural.error.code,
      message: structural.error.message,
    };
  }
  for (const reference of structural.value.references) {
    if (reference.namespace === "trait") {
      if (!TRAIT_KEY_PATTERN.test(reference.key)) {
        return {
          ok: false,
          code: "unsafe_segment_reference",
          message: "Segment traits must be approved Klaviyo property keys.",
        };
      }
      continue;
    }
    if (!SAFE_FIXED_KEYS[reference.namespace].has(reference.key as never)) {
      return {
        ok: false,
        code: "unsafe_segment_reference",
        message: "The segment references unsupported customer state.",
      };
    }
  }
  return { ok: true };
}

function comparable(value: unknown): string | number | boolean | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : null;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contains(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return left.some((value) => equal(value, right));
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLocaleLowerCase().includes(right.toLocaleLowerCase())
  );
}

function compareNumbers(left: unknown, right: unknown): number | null {
  if (
    typeof left !== "number" ||
    typeof right !== "number" ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return null;
  }
  return left - right;
}

function compareDates(left: unknown, right: unknown): number | null {
  if (typeof left !== "string" || typeof right !== "string") return null;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime - rightTime
    : null;
}

function predicateValue(
  state: SegmentCustomerState,
  predicate: SegmentPredicate,
): unknown {
  return state[predicate.namespace][predicate.key as never];
}

function evaluatePredicate(
  state: SegmentCustomerState,
  predicate: SegmentPredicate,
): boolean {
  const actual = predicateValue(state, predicate);
  const expected = predicate.value;
  switch (predicate.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "equals":
      return equal(actual, expected);
    case "not_equals":
      return !equal(actual, expected);
    case "contains":
      return contains(actual, expected);
    case "not_contains":
      return !contains(actual, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((value) => equal(actual, value))
      );
    case "not_in":
      return (
        Array.isArray(expected) &&
        !expected.some((value) => equal(actual, value))
      );
    case "greater_than":
      return (compareNumbers(actual, expected) ?? 0) > 0;
    case "greater_than_or_equal":
      return (compareNumbers(actual, expected) ?? -1) >= 0;
    case "less_than":
      return (compareNumbers(actual, expected) ?? 0) < 0;
    case "less_than_or_equal":
      return (compareNumbers(actual, expected) ?? 1) <= 0;
    case "after":
      return (compareDates(actual, expected) ?? 0) > 0;
    case "before":
      return (compareDates(actual, expected) ?? 0) < 0;
  }
}

export function evaluateSegmentExpression(
  expression: WorklinSegmentExpression,
  state: SegmentCustomerState,
): boolean {
  if (expression.type === "predicate") {
    return evaluatePredicate(state, expression);
  }
  if (expression.type === "not") {
    return !evaluateSegmentExpression(expression.expression, state);
  }
  if (expression.type === "all") {
    return expression.expressions.every((child) =>
      evaluateSegmentExpression(child, state),
    );
  }
  return expression.expressions.some((child) =>
    evaluateSegmentExpression(child, state),
  );
}

export function campaignEligibility(state: SegmentCustomerState): {
  eligible: boolean;
  reason: SegmentEligibilityReason;
} {
  if (!state.profile.has_email) {
    return { eligible: false, reason: "missing_email" };
  }
  if (state.consent.email === "subscribed") {
    return { eligible: true, reason: "eligible" };
  }
  if (state.consent.email === "unsubscribed") {
    return { eligible: false, reason: "unsubscribed" };
  }
  if (state.consent.email === "suppressed") {
    return { eligible: false, reason: "suppressed" };
  }
  return { eligible: false, reason: "consent_unknown" };
}

export function scalarForDossier(value: unknown): RetentionScalar | null {
  return comparable(value);
}
