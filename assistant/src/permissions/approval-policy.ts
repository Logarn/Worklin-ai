import type { OwnerKind } from "../tools/types.js";
import type { TrustRule } from "./types.js";
import { RiskLevel } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Execution context for per-context threshold resolution. */
export type ExecutionContext = "conversation" | "background" | "headless";

/** Contextual information that an approval policy uses to reach a decision. */
export interface ApprovalContext {
  riskLevel: RiskLevel;
  toolName: string;
  matchedRule?: TrustRule;
  isContainerized: boolean;
  isWorkspaceScoped: boolean;
  /** Whether this call has an interactive client available for approval. */
  executionContext?: ExecutionContext;
  /**
   * Owner kind of the tool, as recorded by the tool registry — "skill" /
   * "plugin" / "mcp" for extension-owned tools, `undefined` for core tools
   * (and for tools that aren't registered, e.g. unregistered skill tools
   * matched only via `hasManifestOverride`).
   */
  toolOrigin?: OwnerKind;
  /** Whether the tool's owning skill is a first-party bundled skill. */
  isSkillBundled?: boolean;
  /** Whether the tool has a manifest override (unregistered skill tool). */
  hasManifestOverride?: boolean;
  /** Whether the command's registry entry has sandboxAutoApprove: true. */
  hasSandboxAutoApprove?: boolean;
  /** Whether skill loading will execute inline command expansions. */
  isDynamicSkillLoad?: boolean;
  /**
   * Resolved auto-approve threshold for this execution context.
   * - "none": prompt for everything (strictest)
   * - "low": auto-approve Low risk (default, matches existing behavior)
   * - "medium": auto-approve Low and Medium risk
   * - "high": auto-approve everything unconditionally
   */
  autoApproveUpTo?: "none" | "low" | "medium" | "high";
}

// ── Ordinal maps for threshold comparison ─────────────────────────────────────
// Hoisted to module level since these are constant. Unknown enum values
// conservatively map to the strictest interpretation: risk defaults to 2 (high)
// and threshold defaults to 0 (low).
const RISK_ORDINAL: Record<string, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDINAL: Record<string, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
};

const AUTONOMOUS_READ_TOOLS = new Set(["web_search", "recall"]);
const AUTONOMOUS_WORKSPACE_READ_TOOLS = new Set(["file_read", "file_list"]);
const INTERNAL_ORCHESTRATION_TOOLS = new Set([
  "subagent_spawn",
  "subagent_status",
  "subagent_message",
  "subagent_read",
  "subagent_abort",
  "notify_parent",
]);

/**
 * Check whether a risk level falls within the configured auto-approve threshold.
 * Returns `true` when the risk is at or below the threshold (i.e. auto-approve).
 */
function isRiskWithinThreshold(
  riskLevel: string,
  autoApproveUpTo: string | undefined,
): boolean {
  const risk = RISK_ORDINAL[riskLevel] ?? 2;
  const threshold = THRESHOLD_ORDINAL[autoApproveUpTo ?? "low"] ?? 0;
  return risk <= threshold;
}

/** The outcome of an approval policy evaluation. */
export interface ApprovalDecision {
  decision: "allow" | "prompt" | "deny";
  reason: string;
  /** Present only when the decision was driven by a matched rule. */
  matchedRule?: TrustRule;
}

/** An object that evaluates an approval context and returns a decision. */
export interface ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision;
}

// ── Default implementation ───────────────────────────────────────────────────

/**
 * Implements the approval decision policy used by `check()` in checker.ts.
 *
 * The decision flow:
 *
 * 1. Deny rule → deny
 * 2. Internal subagent orchestration → allow
 * 3. Safe skill setup/context read → allow
 *    (plain skill_load and brand_brain_read; dynamic skill loads excluded)
 * 4. Non-interactive read-only research → allow
 *    (web_search/recall, plus workspace-scoped file_read/file_list)
 * 4. Ask rule + risk > autoApproveUpTo → prompt
 *    Ask rule + risk ≤ autoApproveUpTo → allow (threshold overrides ask rule)
 * 4. Sandbox auto-approve: bash + sandboxAutoApprove + autoApproveUpTo !== "none" → allow
 *    (Path resolution is baked into `hasSandboxAutoApprove` upstream: containerized
 *    environments skip path checks; non-containerized environments validate all
 *    path arguments against the workspace root.)
 * 5. Allow rule + non-High → allow
 * 6. Allow rule + High → fall through to risk-based
 * 7. No rule + third-party skill tool + risk > autoApproveUpTo → prompt
 *    No rule + third-party skill tool + risk ≤ autoApproveUpTo → allow (threshold overrides)
 * 8. No rule + Low + workspace-scoped + within threshold → allow
 * 9. No rule + Low + bundled skill + within threshold → allow
 * 10. Risk ≤ autoApproveUpTo threshold → allow
 * 11. Risk > autoApproveUpTo threshold → prompt
 */
export class DefaultApprovalPolicy implements ApprovalPolicy {
  evaluate(context: ApprovalContext): ApprovalDecision {
    const {
      riskLevel,
      toolName,
      matchedRule,
      isWorkspaceScoped,
      toolOrigin,
      isSkillBundled,
      hasManifestOverride,
      hasSandboxAutoApprove,
    } = context;

    // ── 1. Deny rules apply at ALL risk levels ────────────────────────
    if (matchedRule && matchedRule.decision === "deny") {
      return {
        decision: "deny",
        reason: `Blocked by deny rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // Spawning and coordinating bounded in-process subagents is internal
    // control flow, not access to the user's device. Child tool calls are
    // evaluated independently, so this exemption cannot authorize the work a
    // child performs. Explicit deny rules above remain authoritative.
    if (INTERNAL_ORCHESTRATION_TOOLS.has(toolName)) {
      return {
        decision: "allow",
        reason: "Internal subagent orchestration does not require approval",
      };
    }

    // ── 3. Safe skill setup and read-only context do not need approval ──
    // Loading a plain skill only discovers/installs its instructions. The
    // actions exposed by that skill are evaluated separately when invoked.
    // Dynamic loads are excluded because inline expansions execute commands
    // while the skill is loading.
    const isDynamicSkillLoad =
      context.isDynamicSkillLoad === true ||
      matchedRule?.pattern.startsWith("skill_load_dynamic:");
    if (toolName === "skill_load" && !isDynamicSkillLoad) {
      return {
        decision: "allow",
        reason: "Skill discovery and installation do not require approval",
      };
    }

    // Brand Brain retrieval only reads persisted onboarding context. Any
    // action taken with that context still passes through its own tool policy.
    if (toolName === "brand_brain_read") {
      return {
        decision: "allow",
        reason: "Read-only Brand Brain context does not require approval",
      };
    }

    // A background child has no approval UI to answer a prompt. Permit the
    // small read-only set needed for research and orchestration while keeping
    // explicit deny rules authoritative. Filesystem reads must remain within
    // the workspace; outbound fetches and all side effects are excluded.
    if (
      context.executionContext === "headless" ||
      context.executionContext === "background"
    ) {
      const isAutonomousRead =
        AUTONOMOUS_READ_TOOLS.has(toolName) ||
        (isWorkspaceScoped && AUTONOMOUS_WORKSPACE_READ_TOOLS.has(toolName));
      if (isAutonomousRead) {
        return {
          decision: "allow",
          reason: "Read-only operation allowed for non-interactive research",
        };
      }
    }

    // ── 4. Ask rules prompt — unless the threshold covers the risk.
    // The user's threshold setting takes precedence over ask rules: if the
    // risk falls within autoApproveUpTo, the ask rule is overridden and
    // the tool auto-approves.
    // Dynamic skill loads are executable behavior, so unlike plain loads they
    // are not unconditionally allowed. They still honor the user's selected
    // system-access threshold like every other executable operation.
    if (matchedRule && matchedRule.decision === "ask") {
      if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
        return {
          decision: "allow",
          reason: `${riskLevel} risk: within auto-approve threshold (ask rule overridden)`,
        };
      }
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // ── 4. Sandbox auto-approve: bash + allowlisted → allow ──
    // Respects the autoApproveUpTo threshold: when set to "none", sandbox
    // auto-approve is suppressed — the user wants to approve everything.
    // Path resolution is baked into `hasSandboxAutoApprove` upstream:
    // containerized environments skip path checks (entire fs is workspace),
    // non-containerized environments validate all path args against workspace root.
    if (
      toolName === "bash" &&
      hasSandboxAutoApprove === true &&
      context.autoApproveUpTo !== "none"
    ) {
      return {
        decision: "allow",
        reason: "Workspace filesystem operation (sandbox auto-approve)",
      };
    }

    // ── 4–5. Allow rule handling ──────────────────────────────────────
    if (matchedRule) {
      if (riskLevel !== RiskLevel.High) {
        return {
          decision: "allow",
          reason: `Matched trust rule: ${matchedRule.pattern}`,
          matchedRule,
        };
      }
      // High risk: fall through to risk-based regardless of rule
    }

    // ── 6. No rule + third-party skill tool → prompt (unless threshold covers it)
    if (!matchedRule) {
      // Plugin- and skill-owned tools are both treated as extension-class
      // for approval purposes: external by default, prompt unless bundled.
      // MCP-owned tools fall through to the core risk-based path.
      const isExtensionOwned =
        toolOrigin === "skill" || toolOrigin === "plugin";
      const isThirdPartySkill =
        (isExtensionOwned && !isSkillBundled) ||
        (hasManifestOverride && !toolOrigin);
      if (isThirdPartySkill) {
        if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
          return {
            decision: "allow",
            reason: `${riskLevel} risk: within auto-approve threshold (skill tool)`,
          };
        }
        return {
          decision: "prompt",
          reason: "Skill tool: requires approval by default",
        };
      }
    }

    // ── 7. No rule + Low + workspace-scoped + within threshold → allow ──
    if (
      !matchedRule &&
      riskLevel === RiskLevel.Low &&
      isWorkspaceScoped &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Workspace-scoped low-risk operation auto-allowed",
      };
    }

    // ── 8. No rule + Low + bundled skill + within threshold → allow ──
    if (
      !matchedRule &&
      riskLevel === RiskLevel.Low &&
      toolOrigin === "skill" &&
      isSkillBundled &&
      isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)
    ) {
      return {
        decision: "allow",
        reason: "Bundled skill tool: low risk, auto-allowed",
      };
    }

    // ── 9–10. Risk-based fallback: compare risk against configured threshold ─
    if (isRiskWithinThreshold(riskLevel, context.autoApproveUpTo)) {
      return {
        decision: "allow",
        reason: `${riskLevel} risk: within auto-approve threshold`,
      };
    }
    return {
      decision: "prompt",
      reason: `${riskLevel} risk: above auto-approve threshold`,
    };
  }
}
