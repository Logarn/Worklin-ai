/**
 * SubagentManager — owns the lifecycle of all subagent conversations.
 *
 * Responsibilities:
 *   - spawn / abort / dispose subagent conversations
 *   - enforce concurrency and depth limits
 *   - route events from child conversations through parent's socket
 *   - inject completion summaries back into parent context
 */

import { v4 as uuid } from "uuid";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { Conversation } from "../daemon/conversation.js";
import {
  findConversation,
  findConversationOrSubagent,
  removeSubagentConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import { resolveDefaultProvider } from "../providers/connection-resolution.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { listProviders } from "../providers/registry.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import {
  SUBAGENT_LIMITS,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentConfig,
  type SubagentRole,
  type SubagentState,
  type SubagentStatus,
  TERMINAL_STATUSES,
} from "./types.js";

const log = getLogger("subagent-manager");

/** How long to keep terminal subagent metadata after the live conversation is released (ms). */
const TERMINAL_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
/** How often to sweep expired terminal entries (ms). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Skill ID merge helper ──────────────────────────────────────────────

/**
 * Merge role-defined skill IDs with caller-provided skill IDs, deduplicating.
 * Exported for direct unit testing.
 */
export function mergeSkillIds(
  roleSkillIds: string[],
  configSkillIds?: string[],
): string[] {
  return [...new Set([...roleSkillIds, ...(configSkillIds ?? [])])];
}

// ── Default subagent system prompt ──────────────────────────────────────

function buildSubagentSystemPrompt(
  config: SubagentConfig,
  role: SubagentRole,
  depth: number,
): string {
  const roleConfig = SUBAGENT_ROLE_REGISTRY[role];
  const sections: string[] = [
    roleConfig.systemPromptPreamble,
    "",
    "## Your Task",
    config.objective,
  ];
  if (config.context) {
    sections.push("", "## Context from Parent", config.context);
  }
  sections.push(
    "",
    "## Constraints",
    `- Role: ${role}`,
    `- Delegation depth: ${depth} of ${SUBAGENT_LIMITS.maxDepth}.`,
    ...(role === "supervisor" && depth < SUBAGENT_LIMITS.maxDepth
      ? [
          `- You may spawn up to ${SUBAGENT_LIMITS.maxActiveChildrenPerParent} focused workers and must synthesize their results before finishing.`,
        ]
      : ["- You cannot spawn nested subagents."]),
    "- Use notify_parent to report important findings or if you are blocked.",
  );
  return sections.join("\n");
}

// ── Manager ─────────────────────────────────────────────────────────────

interface ManagedSubagent {
  /** Live conversation — null after the subagent reaches a terminal state and is released. */
  conversation: Conversation | null;
  state: SubagentState;
  /** Mutable reference to the parent's current sendToClient. Updated on reconnect. */
  parentSendToClient: (msg: ServerMessage) => void;
  /** Epoch ms after which this terminal entry can be removed by the TTL sweep. */
  retainedUntil?: number;
  /**
   * Sticky monotonic flag: set to true when sendMessage enqueues a follow-up
   * message while a run is in progress, and never cleared. Needed because the
   * drain dispatch is racy against the observation window around runAgentLoop's
   * `finally`: drainQueue is async — it awaits buildPassthroughBatch (which
   * awaits resolveSlash) before shifting anything — and runAgentLoop fires it
   * without awaiting. So between the moment `finally` schedules drainQueue and
   * the moment a queued item is actually dispatched by drainBatch /
   * drainSingleMessage, `hasQueuedMessages()` and `isProcessing()` can each
   * flip in either direction (queue empties mid-await, or `processing` flips
   * false while items are still pending). Checking this sticky flag lets the
   * finally block in runSubagent reason about "any queued work existed for
   * this subagent during the run" without racing drain dispatch, and defer
   * the release to the TTL sweep rather than tearing down mid-drain.
   */
  hadEnqueuedMessages?: boolean;
  /** Debounces hierarchy-aware finalization after an agent-loop idle event. */
  finalizeTimer?: ReturnType<typeof setTimeout>;
  /** Worker lifecycle messages waiting for this supervisor's next turn. */
  pendingParentNotifications?: Array<{
    message: string;
    metadata?: Record<string, unknown>;
  }>;
  /** True while the supervisor is processing one queued worker notification. */
  processingParentNotification?: boolean;
  /** Retries notification delivery after the supervisor's current turn settles. */
  notificationDrainTimer?: ReturnType<typeof setTimeout>;
  /** Cancels the entire delegation tree when its shared deadline expires. */
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

export interface SubagentNotificationInfo {
  subagentId: string;
  label: string;
  status: "running" | "completed" | "failed" | "aborted";
  error?: string;
  conversationId?: string;
  objective?: string;
}

export class SubagentManager {
  /** subagentId → ManagedSubagent */
  private subagents = new Map<string, ManagedSubagent>();
  /** parentConversationId → Set<subagentId> */
  private parentToChildren = new Map<string, Set<string>>();
  /** `${parentConversationId}:${normalizedLabel}` → subagentId */
  private labelIndex = new Map<string, string>();

  /**
   * Shared rate-limit timestamps array from the daemon server.
   * Set by DaemonServer at startup so subagents share the global rate limit.
   */
  sharedRequestTimestamps: number[] = [];

  // ── Spawn ───────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent.  Returns the subagent ID immediately.
   * The subagent's agent loop is started asynchronously (fire-and-forget).
   */
  async spawn(
    config: Omit<SubagentConfig, "id">,
    parentSendToClient: (msg: ServerMessage) => void,
  ): Promise<string> {
    // ── Resolve role ─────────────────────────────────────────────────
    const parentManaged = this.findManagedByConversationId(
      config.parentConversationId,
    );
    const isFork = config.fork === true;
    let role: SubagentRole = (config.role as SubagentRole) ?? "general";
    if (isFork && role !== "general") {
      log.warn(
        {
          requestedRole: role,
          parentConversationId: config.parentConversationId,
          label: config.label,
        },
        "Fork requested with non-general role — forcing general to preserve KV cache alignment",
      );
      role = "general";
    }
    if (!SUBAGENT_ROLE_REGISTRY[role]) {
      throw new Error(
        `Invalid subagent role "${config.role}". Must be one of: ${Object.keys(SUBAGENT_ROLE_REGISTRY).join(", ")}`,
      );
    }
    const roleConfig = SUBAGENT_ROLE_REGISTRY[role];

    // ── Hierarchy and fan-out limits ─────────────────────────────────
    const depth = (parentManaged?.state.depth ?? 0) + 1;
    const rootConversationId =
      parentManaged?.state.rootConversationId ?? config.parentConversationId;
    const deadlineAt =
      parentManaged?.state.deadlineAt ??
      Date.now() + SUBAGENT_LIMITS.maxRunDurationMs;
    if (deadlineAt <= Date.now()) {
      throw new Error(
        "Cannot spawn subagent: the delegation run deadline has expired.",
      );
    }
    if (parentManaged) {
      if (
        TERMINAL_STATUSES.has(parentManaged.state.status) ||
        !parentManaged.conversation
      ) {
        throw new Error(
          "Cannot spawn nested subagent: parent supervisor is no longer active.",
        );
      }
      const parentRole = parentManaged.state.config.role ?? "general";
      if (parentRole !== "supervisor") {
        throw new Error(
          `Cannot spawn nested subagent: parent role "${parentRole}" is not allowed to delegate. Use role "supervisor" for coordinated child workers.`,
        );
      }
    }
    if (depth > SUBAGENT_LIMITS.maxDepth) {
      throw new Error(
        `Cannot spawn nested subagent: maximum delegation depth is ${SUBAGENT_LIMITS.maxDepth}.`,
      );
    }
    const activeChildren = this.countActiveChildren(
      config.parentConversationId,
    );
    if (activeChildren >= SUBAGENT_LIMITS.maxActiveChildrenPerParent) {
      throw new Error(
        `Cannot spawn subagent: parent already has ${activeChildren} active children (limit ${SUBAGENT_LIMITS.maxActiveChildrenPerParent}).`,
      );
    }
    const activeInRoot = this.countActiveInRoot(rootConversationId);
    if (activeInRoot >= SUBAGENT_LIMITS.maxActiveDescendantsPerRoot) {
      throw new Error(
        `Cannot spawn subagent: root delegation tree already has ${activeInRoot} active agents (limit ${SUBAGENT_LIMITS.maxActiveDescendantsPerRoot}).`,
      );
    }
    const totalInRoot = this.countTotalInRoot(rootConversationId);
    if (totalInRoot >= SUBAGENT_LIMITS.maxTotalDescendantsPerRoot) {
      throw new Error(
        `Cannot spawn subagent: root delegation tree already created ${totalInRoot} agents (limit ${SUBAGENT_LIMITS.maxTotalDescendantsPerRoot}).`,
      );
    }

    // ── Create conversation ─────────────────────────────────────────
    const subagentId = uuid();
    const conversationRecord = bootstrapConversation({
      conversationType: "background",
      source: "subagent",
      origin: "subagent",
      systemHint: `Subagent: ${config.label}`,
    });

    // ── Build conversation dependencies ─────────────────────────────
    const appConfig = getConfig();
    const effectiveOverrideProfile =
      config.overrideProfile ?? appConfig.llm.activeProfile;
    // Connection-aware default-provider resolution. Throws
    // `ConnectionResolutionError` if `llm.default.provider_connection` is
    // unset or the connection row is missing/mismatched (config bugs).
    // Returns null on soft credential failures (missing credential,
    // platform auth unavailable).
    const baseProvider = await resolveDefaultProvider(appConfig);
    if (!baseProvider) {
      const resolved = resolveCallSiteConfig("mainAgent", appConfig.llm);
      throw new ProviderNotConfiguredError(resolved.provider, listProviders(), {
        connectionName: resolved.provider_connection,
      });
    }
    // Per-call `options.config.callSite` (e.g. `subagentSpawn`) can resolve
    // to a profile that differs from `llm.default`. The shared wrapper
    // threads `appConfig` through so per-call alternate-profile routing is
    // also connection-aware (matches the canonical dispatch path).
    let provider = wrapWithCallSiteRouting(baseProvider, appConfig);
    const { rateLimit } = appConfig;
    if (rateLimit.maxRequestsPerMinute > 0) {
      provider = new RateLimitProvider(
        provider,
        rateLimit,
        this.sharedRequestTimestamps,
      );
    }

    const parentConversation =
      findConversation(config.parentConversationId) ??
      findConversationOrSubagent(config.parentConversationId);

    let systemPrompt: string;
    if (isFork) {
      // Forks use the parent's system prompt directly — no subagent preamble.
      if (config.parentSystemPrompt) {
        systemPrompt = config.parentSystemPrompt;
      } else {
        const resolved = parentConversation?.getCurrentSystemPrompt();
        if (!resolved) {
          throw new Error(
            "Fork spawn requires a parent system prompt but neither config.parentSystemPrompt " +
              "nor findConversation yielded one.",
          );
        }
        systemPrompt = resolved;
      }
    } else {
      systemPrompt =
        config.systemPromptOverride ??
        buildSubagentSystemPrompt({ ...config, id: subagentId }, role, depth);
    }
    const maxTokens = resolveCallSiteConfig("subagentSpawn", appConfig.llm, {
      ...(effectiveOverrideProfile
        ? {
            overrideProfile: effectiveOverrideProfile,
            forceOverrideProfile: true,
          }
        : {}),
    }).maxTokens;
    const workingDir = getSandboxWorkingDir();

    // ── Initialise state ────────────────────────────────────────────
    const now = Date.now();
    // For forks, default sendResultToUser to false (silent) unless explicitly true.
    const resolvedSendResultToUser = isFork
      ? config.sendResultToUser === true
        ? true
        : false
      : config.sendResultToUser;
    const state: SubagentState = {
      config: {
        ...config,
        id: subagentId,
        role,
        sendResultToUser: resolvedSendResultToUser,
        ...(effectiveOverrideProfile
          ? { overrideProfile: effectiveOverrideProfile }
          : {}),
      },
      status: "pending",
      conversationId: conversationRecord.id,
      isFork,
      depth,
      rootConversationId,
      ...(parentManaged
        ? { parentSubagentId: parentManaged.state.config.id }
        : {}),
      deadlineAt,
      createdAt: now,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    };

    // Store the managed subagent early so the wrapper can read the mutable
    // parentSendToClient reference — this ensures reconnects are picked up.
    const managed: ManagedSubagent = {
      // Placeholder — replaced with the real Conversation a few lines below, before
      // any code reads this field. Using null! avoids the `as unknown as` cast.
      conversation: null! as Conversation,
      state,
      // Nested workers publish lifecycle events to the root sender instead of
      // nesting subagent_event envelopes inside their supervisor's stream.
      parentSendToClient:
        parentManaged?.parentSendToClient ?? parentSendToClient,
    };
    managed.deadlineTimer = setTimeout(
      () => {
        const current = this.subagents.get(subagentId);
        if (!current || TERMINAL_STATUSES.has(current.state.status)) return;
        current.state.error = "Delegation run exceeded its 15-minute deadline.";
        this.abort(subagentId, current.parentSendToClient, undefined, {
          suppressNotification: false,
        });
      },
      Math.max(0, deadlineAt - now),
    );

    // Wrap sendToClient to envelope all events with the subagent ID.
    // Reads from managed.parentSendToClient so reconnects are picked up.
    const wrappedSendToClient = (msg: ServerMessage): void => {
      managed.parentSendToClient({
        type: "subagent_event",
        subagentId,
        conversationId: config.parentConversationId,
        event: msg,
      } as ServerMessage);
      if (msg.type === "assistant_activity_state" && msg.phase === "idle") {
        this.scheduleFinalization(subagentId, 50);
      }
    };

    const conversation = new Conversation(
      conversationRecord.id,
      provider,
      systemPrompt,
      wrappedSendToClient,
      workingDir,
      { maxTokens, cacheTtl: "5m" },
    );

    // Mark conversation as having no direct client — it routes through parent.
    // This ensures interactive prompts (host attachment reads) fail fast.
    conversation.updateClient(wrappedSendToClient, true);
    conversation.setIsSubagent(true);
    // Subagents are created as background conversations (see the
    // `bootstrapConversation` call above) and never call `loadFromDb`, so cache
    // the type on the live conversation directly for the runtime-assembly path.
    conversation.conversationType = "background";

    // Subagents execute as background child conversations, but their tool
    // permissions must still be scoped to the actor that spawned them. Without
    // this, tool execution falls back to `unknown` trust and guardian-owned
    // desktop turns get denied as unverified.
    if (parentConversation?.trustContext) {
      conversation.setTrustContext({ ...parentConversation.trustContext });
    }
    const parentAuthContext = parentConversation?.getAuthContext();
    if (parentAuthContext) {
      conversation.setAuthContext({ ...parentAuthContext });
    }
    if (parentConversation?.assistantId) {
      conversation.setAssistantId(parentConversation.assistantId);
    }

    if (isFork) {
      // Force the fork to use the parent's system prompt as-is without dynamic rebuild.
      // This ensures KV cache alignment with the parent conversation.
      conversation.hasSystemPromptOverride = true;
    }

    // Apply role-based tool filter if the role defines one.
    // Skip for forks — general role has allowedTools: undefined, and forks
    // should have the same tool access as the parent.
    if (!isFork && roleConfig.allowedTools) {
      conversation.setSubagentAllowedTools(new Set(roleConfig.allowedTools));
    }

    // Pre-activate skills defined by the role config, merged with any caller-provided skill IDs.
    const mergedSkillIds = mergeSkillIds(
      roleConfig.skillIds,
      config.preactivatedSkillIds,
    );
    if (mergedSkillIds.length > 0) {
      conversation.setPreactivatedSkillIds(mergedSkillIds);
    }

    managed.conversation = conversation;
    this.subagents.set(subagentId, managed);
    // Index the live conversation so the per-conversation injectors (workspace
    // context, disk-pressure warning) can resolve it by id; subagents are not
    // in the eviction-managed conversation store.
    setSubagentConversation(conversationRecord.id, conversation);
    const labelKey = `${config.parentConversationId}:${config.label.toLowerCase().trim()}`;
    if (this.labelIndex.has(labelKey)) {
      log.warn(
        {
          label: config.label,
          parentConversationId: config.parentConversationId,
          existingSubagentId: this.labelIndex.get(labelKey),
          newSubagentId: subagentId,
        },
        "Label collision: new subagent overwrites label index entry (previous subagent still accessible by UUID)",
      );
    }
    this.labelIndex.set(labelKey, subagentId);

    // Track parent → child relationship.
    if (!this.parentToChildren.has(config.parentConversationId)) {
      this.parentToChildren.set(config.parentConversationId, new Set());
    }
    this.parentToChildren.get(config.parentConversationId)!.add(subagentId);

    // Notify client that a subagent was spawned.
    managed.parentSendToClient({
      type: "subagent_spawned",
      subagentId,
      parentConversationId: config.parentConversationId,
      label: config.label,
      objective: config.objective,
      isFork: config.fork ?? false,
      parentToolUseId: config.parentToolUseId,
    } as ServerMessage);

    log.info(
      {
        subagentId,
        parentConversationId: config.parentConversationId,
        label: config.label,
        depth,
        rootConversationId,
      },
      "Subagent spawned",
    );

    // ── Kick off the agent loop (fire-and-forget) ───────────────────
    this.runSubagent(subagentId, config.objective).catch((err) => {
      log.error({ subagentId, err }, "Subagent run failed unexpectedly");
    });

    return subagentId;
  }

  // ── Internal: run the subagent ────────────────────────────────────────

  private async runSubagent(
    subagentId: string,
    objective: string,
  ): Promise<void> {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Capture the live conversation — it is non-null at this point because
    // spawn() sets it before firing runSubagent.
    const conversation = managed.conversation!;

    // Read the current parent sender so reconnects are picked up.
    const getSender = () => managed.parentSendToClient;

    this.setStatus(subagentId, "running", getSender());
    managed.state.startedAt = Date.now();

    try {
      // For forks, inject the parent's message history before the first message.
      // This prepends the inherited context so the fork has full conversational
      // awareness while the objective becomes the latest user turn.
      if (managed.state.isFork && managed.state.config.parentMessages) {
        conversation.injectInheritedContext(
          managed.state.config.parentMessages,
        );
        // Release the parent message arrays now that they've been injected — holding
        // them in SubagentState.config would retain significant memory until the TTL
        // sweep disposes this entry (up to 30 minutes for terminal subagents).
        managed.state.config.parentMessages = undefined;
        managed.state.config.parentSystemPrompt = undefined;
      }

      // Send the objective as the first user message and process it.
      // For forks, wrap the objective in directive framing so it overrides
      // conversational momentum from the inherited context. Without this,
      // the fork tends to continue the parent conversation instead of
      // pivoting to the task — the inherited context is louder than a bare
      // objective buried after 100k+ tokens of chat history.
      const message = managed.state.isFork
        ? [
            "⎯⎯⎯ FORK TASK ⎯⎯⎯",
            "You have been forked from the parent conversation to execute a specific task.",
            "The conversation above is context — do NOT continue it. Do NOT spawn sub-agents.",
            "Complete this task directly and return only your findings:",
            "",
            objective,
            "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
          ].join("\n")
        : objective;
      const { id: messageId } = await conversation.persistUserMessage({
        content: message,
      });
      await conversation.runAgentLoop(message, messageId, {
        callSite: "subagentSpawn",
        ...(managed.state.config.overrideProfile
          ? {
              overrideProfile: managed.state.config.overrideProfile,
              forceOverrideProfile: true,
            }
          : {}),
      });

      // Agent loop completed successfully. A supervisor may still own running
      // children, so hierarchy-aware finalization decides whether to complete
      // now or remain alive in awaiting_children until worker notifications
      // have been processed and synthesized.
      managed.state.usage = { ...conversation.usageStats };
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.finalizeWhenSettled(subagentId);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();
      // Copy usage from the captured conversation reference — managed.conversation
      // may have been nulled by an external dispose() before catch runs.
      managed.state.usage = { ...conversation.usageStats };

      // Only update status if not already terminal (e.g. aborted).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.abortAllForParent(
          managed.state.conversationId,
          managed.parentSendToClient,
          { suppressNotifications: true },
        );
        this.setStatus(subagentId, "failed", getSender(), errorMsg);
        this.notifyParentTerminal(managed, "failed");
      }

      log.error({ subagentId, err }, "Subagent failed");
    } finally {
      // Release the heavyweight Conversation — output is already persisted in DB.
      // drainQueue is async: it awaits buildPassthroughBatch (which awaits
      // resolveSlash) before shifting anything, and runAgentLoop fires it
      // without awaiting. That means by the time this finally runs, a drain
      // may already be scheduled but not yet dispatched — so checking
      // hasQueuedMessages() / isProcessing() here races the dispatch and can
      // observe an empty queue (or `processing === false`) while queued work
      // is still pending. The hadEnqueuedMessages flag (set in sendMessage)
      // is a sticky monotonic marker that any queued work existed during this
      // run, letting us defer the release to the TTL sweep rather than
      // tearing down mid-drain.
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        // Supervisors stay live while children run. Completion notifications
        // will wake this conversation and the idle event will re-run
        // hierarchy-aware finalization.
        return;
      }
      if (!managed.conversation) {
        return;
      }
      if (managed.hadEnqueuedMessages) {
        log.debug(
          { subagentId },
          "Deferring conversation release — messages were enqueued during run",
        );
        managed.retainedUntil = Date.now() + TERMINAL_RETENTION_MS;
        this.ensureSweepRunning();
      } else {
        this.releaseConversation(managed);
      }
    }
  }

  // ── Abort ─────────────────────────────────────────────────────────────

  abort(
    subagentId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
    callerConversationId?: string,
    options?: { suppressNotification?: boolean },
  ): boolean {
    const managed = this.subagents.get(subagentId);
    if (!managed) return false;
    if (TERMINAL_STATUSES.has(managed.state.status)) return false;
    // If a caller conversation is specified, verify ownership.
    if (
      callerConversationId &&
      managed.state.config.parentConversationId !== callerConversationId
    ) {
      log.warn(
        {
          subagentId,
          callerConversationId,
          parentConversationId: managed.state.config.parentConversationId,
        },
        "Abort rejected: caller does not own this subagent",
      );
      return false;
    }

    // Cancellation is hierarchical: a supervisor cannot leave detached
    // workers running after it has been stopped.
    this.abortAllForParent(
      managed.state.conversationId,
      managed.parentSendToClient,
      { suppressNotifications: true },
    );

    managed.conversation?.abort(
      createAbortReason(
        "subagent_aborted",
        "SubagentManager.abort",
        managed.conversation.conversationId,
      ),
    );
    managed.state.completedAt = Date.now();
    // Route the status update through the stored root sender. It may be a
    // no-op in a headless run, but state and parent-context notification still
    // proceed without requiring an attached UI client.
    const statusSender = managed.parentSendToClient ?? parentSendToClient;
    this.setStatus(subagentId, "aborted", statusSender);
    // Notify parent that the subagent was explicitly aborted — tell it NOT to re-spawn.
    // Skip when the parent LLM itself called subagent_abort (it already has the tool result).
    if (!options?.suppressNotification) {
      const label = managed.state.config.label;
      const prefix = managed.state.isFork ? "Fork" : "Subagent";
      const message =
        `[${prefix} "${label}" was explicitly aborted]\n\n` +
        `This ${prefix.toLowerCase()} was cancelled on purpose. Do NOT re-spawn or retry it.`;
      this.injectMessageIntoParent(
        managed.state.config.parentConversationId,
        message,
        {
          subagentNotification: {
            subagentId,
            label,
            status: "aborted" as const,
            conversationId: managed.state.conversationId,
          },
        },
      );
    }

    this.releaseConversation(managed);

    log.info({ subagentId }, "Subagent aborted");
    return true;
  }

  /**
   * Abort all subagents belonging to a parent conversation.
   * Called when the parent conversation is aborted or evicted.
   */
  abortAllForParent(
    parentConversationId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
    options?: { suppressNotifications?: boolean },
  ): number {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) return 0;

    let count = 0;
    for (const childId of children) {
      if (
        this.abort(
          childId,
          parentSendToClient,
          undefined,
          options?.suppressNotifications
            ? { suppressNotification: true }
            : undefined,
        )
      ) {
        count++;
      }
    }

    // Dispose all children — the parent conversation is going away so nobody
    // will call subagent_read.  Use snapshot since dispose mutates the set.
    for (const childId of [...children]) {
      this.dispose(childId);
    }

    return count;
  }

  // ── Send message to subagent ──────────────────────────────────────────

  async sendMessage(
    subagentId: string,
    content: string,
  ): Promise<"sent" | "empty" | "not_found" | "terminal"> {
    const trimmed = content?.trim();
    if (!trimmed) return "empty";

    const managed = this.subagents.get(subagentId);
    if (!managed) return "not_found";
    if (TERMINAL_STATUSES.has(managed.state.status) || !managed.conversation)
      return "terminal";

    // If the conversation is busy, queue the message; otherwise process immediately.
    const result = managed.conversation.enqueueMessage({ content: trimmed });
    if (result.rejected) {
      return "sent"; // error event already delivered via sendToClient
    }
    if (result.queued) {
      managed.hadEnqueuedMessages = true;
    }
    if (!result.queued) {
      // Capture conversation before the await — managed.conversation may be
      // nulled by an external dispose() while persistUserMessage is awaited.
      const conversation = managed.conversation;
      const { id: messageId } = await conversation.persistUserMessage({
        content: trimmed,
      });
      conversation
        .runAgentLoop(trimmed, messageId, {
          callSite: "subagentSpawn",
          ...(managed.state.config.overrideProfile
            ? {
                overrideProfile: managed.state.config.overrideProfile,
                forceOverrideProfile: true,
              }
            : {}),
        })
        .catch((err) => {
          log.error({ subagentId, err }, "Subagent message processing failed");
        });
    }
    return "sent";
  }

  // ── Hierarchy coordination ───────────────────────────────────────────

  private findManagedByConversationId(
    conversationId: string,
  ): ManagedSubagent | undefined {
    for (const managed of this.subagents.values()) {
      if (managed.state.conversationId === conversationId) return managed;
    }
    return undefined;
  }

  private countActiveChildren(parentConversationId: string): number {
    return this.getChildrenOf(parentConversationId).filter(
      (child) => !TERMINAL_STATUSES.has(child.status),
    ).length;
  }

  private countActiveInRoot(rootConversationId: string): number {
    let count = 0;
    for (const managed of this.subagents.values()) {
      const stateRoot =
        managed.state.rootConversationId ??
        managed.state.config.parentConversationId;
      if (
        stateRoot === rootConversationId &&
        !TERMINAL_STATUSES.has(managed.state.status)
      ) {
        count++;
      }
    }
    return count;
  }

  private countTotalInRoot(rootConversationId: string): number {
    let count = 0;
    for (const managed of this.subagents.values()) {
      const stateRoot =
        managed.state.rootConversationId ??
        managed.state.config.parentConversationId;
      if (stateRoot === rootConversationId) count++;
    }
    return count;
  }

  private scheduleFinalization(subagentId: string, delayMs = 0): void {
    const managed = this.subagents.get(subagentId);
    if (!managed || TERMINAL_STATUSES.has(managed.state.status)) return;
    if (managed.finalizeTimer) return;
    managed.finalizeTimer = setTimeout(() => {
      managed.finalizeTimer = undefined;
      this.finalizeWhenSettled(subagentId);
    }, delayMs);
    if (
      managed.finalizeTimer &&
      typeof managed.finalizeTimer === "object" &&
      "unref" in managed.finalizeTimer
    ) {
      (managed.finalizeTimer as { unref: () => void }).unref();
    }
  }

  private scheduleParentNotificationDrain(
    subagentId: string,
    delayMs = 0,
  ): void {
    const managed = this.subagents.get(subagentId);
    if (!managed || TERMINAL_STATUSES.has(managed.state.status)) return;
    if (managed.notificationDrainTimer) return;
    managed.notificationDrainTimer = setTimeout(() => {
      managed.notificationDrainTimer = undefined;
      void this.drainParentNotifications(subagentId);
    }, delayMs);
    if (
      managed.notificationDrainTimer &&
      typeof managed.notificationDrainTimer === "object" &&
      "unref" in managed.notificationDrainTimer
    ) {
      (managed.notificationDrainTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Run worker notifications as explicit supervisor turns. Keeping these out
   * of Conversation's general message queue gives the manager a deterministic
   * completion barrier and preserves the subagent call-site/profile routing.
   */
  private async drainParentNotifications(subagentId: string): Promise<void> {
    const managed = this.subagents.get(subagentId);
    if (
      !managed ||
      TERMINAL_STATUSES.has(managed.state.status) ||
      !managed.conversation ||
      managed.processingParentNotification
    ) {
      return;
    }

    const conversation = managed.conversation;
    if (conversation.isProcessing() || conversation.hasQueuedMessages()) {
      this.scheduleParentNotificationDrain(subagentId, 25);
      return;
    }

    const next = managed.pendingParentNotifications?.shift();
    if (!next) {
      this.finalizeWhenSettled(subagentId);
      return;
    }

    managed.processingParentNotification = true;
    if (managed.state.status !== "running") {
      this.setStatus(subagentId, "running", managed.parentSendToClient);
    }

    try {
      const { id: messageId } = await conversation.persistUserMessage({
        content: next.message,
        metadata: next.metadata,
      });
      await conversation.runAgentLoop(next.message, messageId, {
        callSite: "subagentSpawn",
        ...(managed.state.config.overrideProfile
          ? {
              overrideProfile: managed.state.config.overrideProfile,
              forceOverrideProfile: true,
            }
          : {}),
      });
      managed.state.usage = { ...conversation.usageStats };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();
      managed.state.usage = { ...conversation.usageStats };
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.abortAllForParent(
          managed.state.conversationId,
          managed.parentSendToClient,
          { suppressNotifications: true },
        );
        this.setStatus(
          subagentId,
          "failed",
          managed.parentSendToClient,
          errorMsg,
        );
        this.notifyParentTerminal(managed, "failed");
        this.releaseConversation(managed);
      }
      log.error(
        { subagentId, err },
        "Supervisor failed to process worker notification",
      );
      return;
    } finally {
      managed.processingParentNotification = false;
    }

    if ((managed.pendingParentNotifications?.length ?? 0) > 0) {
      this.scheduleParentNotificationDrain(subagentId);
    } else {
      this.finalizeWhenSettled(subagentId);
    }
  }

  /**
   * Complete a subagent only after its own turn is idle, its message queue is
   * drained, and all direct workers are terminal. This keeps supervisors alive
   * long enough to receive worker results and produce their final synthesis.
   */
  private finalizeWhenSettled(subagentId: string): void {
    const managed = this.subagents.get(subagentId);
    if (!managed || TERMINAL_STATUSES.has(managed.state.status)) return;
    const conversation = managed.conversation;
    if (!conversation) return;

    const activeChildren = this.countActiveChildren(
      managed.state.conversationId,
    );
    if (
      managed.processingParentNotification ||
      (managed.pendingParentNotifications?.length ?? 0) > 0
    ) {
      this.scheduleParentNotificationDrain(subagentId, 25);
      return;
    }
    if (activeChildren > 0) {
      if (managed.state.status !== "awaiting_children") {
        this.setStatus(
          subagentId,
          "awaiting_children",
          managed.parentSendToClient,
        );
      }
      return;
    }

    if (conversation.isProcessing() || conversation.hasQueuedMessages()) {
      this.scheduleFinalization(subagentId, 25);
      return;
    }

    managed.state.usage = { ...conversation.usageStats };
    managed.state.completedAt = Date.now();
    this.setStatus(subagentId, "completed", managed.parentSendToClient);
    log.info(
      {
        subagentId,
        depth: managed.state.depth ?? 1,
        parentSubagentId: managed.state.parentSubagentId,
      },
      "Subagent completed",
    );
    this.notifyParentTerminal(managed, "completed");
    if (managed.hadEnqueuedMessages) {
      managed.retainedUntil = Date.now() + TERMINAL_RETENTION_MS;
      this.ensureSweepRunning();
    } else {
      this.releaseConversation(managed);
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getState(subagentId: string): SubagentState | undefined {
    return this.subagents.get(subagentId)?.state;
  }

  getByLabel(
    label: string,
    parentConversationId: string,
  ): SubagentState | undefined {
    const key = `${parentConversationId}:${label.toLowerCase().trim()}`;
    const id = this.labelIndex.get(key);
    return id ? this.getState(id) : undefined;
  }

  getChildrenOf(parentConversationId: string): SubagentState[] {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) return [];
    return [...children]
      .map((id) => this.subagents.get(id)?.state)
      .filter((s): s is SubagentState => s !== undefined);
  }

  /** Total number of active (non-terminal) subagents. */
  get activeCount(): number {
    return [...this.subagents.values()].filter(
      (s) => !TERMINAL_STATUSES.has(s.state.status),
    ).length;
  }

  /**
   * Update the parent sender for all active children of a conversation.
   * Called when the parent client reconnects to a new socket.
   */
  updateParentSender(
    parentConversationId: string,
    newSendToClient: (msg: ServerMessage) => void,
  ): void {
    for (const managed of this.subagents.values()) {
      const rootConversationId =
        managed.state.rootConversationId ??
        managed.state.config.parentConversationId;
      if (
        rootConversationId === parentConversationId &&
        !TERMINAL_STATUSES.has(managed.state.status)
      ) {
        managed.parentSendToClient = newSendToClient;
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Release the live Conversation from a terminal subagent, keeping only
   * lightweight metadata (state, config, usage) for later queries.
   * The conversation's output is already persisted in the database.
   */
  private releaseConversation(managed: ManagedSubagent): void {
    if (!managed.conversation) return;
    if (managed.finalizeTimer) {
      clearTimeout(managed.finalizeTimer);
      managed.finalizeTimer = undefined;
    }
    if (managed.notificationDrainTimer) {
      clearTimeout(managed.notificationDrainTimer);
      managed.notificationDrainTimer = undefined;
    }
    if (managed.deadlineTimer) {
      clearTimeout(managed.deadlineTimer);
      managed.deadlineTimer = undefined;
    }
    const conversation = managed.conversation;
    removeSubagentConversation(conversation.conversationId, conversation);
    conversation.dispose();
    managed.conversation = null;
    managed.retainedUntil = Date.now() + TERMINAL_RETENTION_MS;
    this.ensureSweepRunning();

    log.debug(
      { subagentId: managed.state.config.id },
      "Released live conversation for terminal subagent",
    );
  }

  /**
   * Dispose a subagent and remove it from tracking.
   * Should be called after the subagent reaches a terminal state
   * and its data is no longer needed.
   */
  dispose(subagentId: string): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Dispose the full descendant tree before removing the parent indexes.
    this.abortAllForParent(
      managed.state.conversationId,
      managed.parentSendToClient,
      { suppressNotifications: true },
    );

    if (managed.finalizeTimer) {
      clearTimeout(managed.finalizeTimer);
      managed.finalizeTimer = undefined;
    }
    if (managed.notificationDrainTimer) {
      clearTimeout(managed.notificationDrainTimer);
      managed.notificationDrainTimer = undefined;
    }
    if (managed.deadlineTimer) {
      clearTimeout(managed.deadlineTimer);
      managed.deadlineTimer = undefined;
    }

    if (managed.conversation) {
      const conversation = managed.conversation;
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        conversation.abort(
          createAbortReason(
            "subagent_aborted",
            "SubagentManager.dispose",
            conversation.conversationId,
          ),
        );
      }
      removeSubagentConversation(conversation.conversationId, conversation);
      conversation.dispose();
      managed.conversation = null;
    }
    this.subagents.delete(subagentId);

    // Remove from label index only if it still maps to this subagent
    // (guards against stale delete when a newer subagent reused the label).
    const label = managed.state.config.label;
    const parentConvId = managed.state.config.parentConversationId;
    const labelKey = `${parentConvId}:${label.toLowerCase().trim()}`;
    if (this.labelIndex.get(labelKey) === subagentId) {
      this.labelIndex.delete(labelKey);
    }

    // Remove from parent tracking.
    const parentId = managed.state.config.parentConversationId;
    const siblings = this.parentToChildren.get(parentId);
    if (siblings) {
      siblings.delete(subagentId);
      if (siblings.size === 0) {
        this.parentToChildren.delete(parentId);
      }
    }
  }

  /** Dispose all subagents. Called on daemon shutdown. */
  disposeAll(): void {
    this.stopSweep();
    for (const id of [...this.subagents.keys()]) {
      this.dispose(id);
    }
  }

  // ── TTL sweep for terminal metadata ──────────────────────────────────

  private sweepTimer?: ReturnType<typeof setInterval>;

  private ensureSweepRunning(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => this.sweepTerminal(),
      SWEEP_INTERVAL_MS,
    );
    // Don't let the sweep timer keep the process alive.
    if (
      this.sweepTimer &&
      typeof this.sweepTimer === "object" &&
      "unref" in this.sweepTimer
    ) {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Remove terminal entries whose retention period has expired. */
  private sweepTerminal(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, managed] of this.subagents) {
      if (!managed.retainedUntil || now < managed.retainedUntil) continue;
      // If the retention window has expired and the conversation is still live,
      // release it now — the drain has had ample time to complete.
      if (managed.conversation) {
        this.releaseConversation(managed);
        // releaseConversation resets retainedUntil to keep metadata around for
        // another window; the entry will be swept on the next pass.
        continue;
      }
      expired.push(id);
    }
    for (const id of expired) {
      log.debug(
        { subagentId: id },
        "Sweeping expired terminal subagent metadata",
      );
      this.dispose(id);
    }
    // Stop the timer if there are no more entries to sweep.
    const hasTerminal = [...this.subagents.values()].some(
      (s) => s.retainedUntil !== undefined,
    );
    if (!hasTerminal) {
      this.stopSweep();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setStatus(
    subagentId: string,
    status: SubagentStatus,
    parentSendToClient: (msg: ServerMessage) => void,
    error?: string,
  ): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Idempotent terminal state guard.
    if (
      TERMINAL_STATUSES.has(managed.state.status) &&
      managed.state.status !== status
    ) {
      return;
    }

    managed.state.status = status;
    if (error !== undefined) managed.state.error = error;

    parentSendToClient({
      type: "subagent_status_changed",
      subagentId,
      status,
      error,
      usage: managed.state.usage,
    } as ServerMessage);
  }

  // ── Child → Parent notification ────────────────────────────────────

  /**
   * Look up the parent info for a child conversation.
   * Returns undefined if the conversationId doesn't belong to a subagent.
   */
  getParentInfo(childConversationId: string):
    | {
        parentConversationId: string;
        subagentId: string;
        label: string;
        parentSendToClient: (msg: ServerMessage) => void;
      }
    | undefined {
    for (const [subagentId, managed] of this.subagents) {
      if (managed.state.conversationId === childConversationId) {
        return {
          parentConversationId: managed.state.config.parentConversationId,
          subagentId,
          label: managed.state.config.label,
          parentSendToClient: managed.parentSendToClient,
        };
      }
    }
    return undefined;
  }

  /**
   * Send a notification from a running subagent to its parent conversation.
   * Returns true if the notification was sent, false if the child is not a
   * subagent, is in a terminal state, or the parent callback is not wired.
   */
  notifyParent(
    childConversationId: string,
    message: string,
    urgency: string,
  ): boolean {
    const info = this.getParentInfo(childConversationId);
    if (!info) return false;

    const managed = this.subagents.get(info.subagentId);
    if (!managed || TERMINAL_STATUSES.has(managed.state.status)) return false;

    const prefix = managed.state.isFork ? "Fork" : "Subagent";
    let notificationString = `[${prefix} "${info.label}" — ${urgency}] ${message}`;
    if (urgency === "blocked") {
      notificationString += `\nUse subagent_message to send guidance to this ${prefix.toLowerCase()}.`;
    }

    this.injectMessageIntoParent(
      info.parentConversationId,
      notificationString,
      {
        subagentNotification: {
          subagentId: info.subagentId,
          label: info.label,
          status: "running" as const,
          conversationId: managed.state.conversationId,
          objective: managed.state.config.objective,
        },
      },
    );
    return true;
  }

  /**
   * Inject a completion/failure notification into the parent conversation
   * so the LLM automatically informs the user.
   */
  private notifyParentTerminal(
    managed: ManagedSubagent,
    outcome: "completed" | "failed",
  ): void {
    const { config } = managed.state;
    const isFork = managed.state.isFork;
    let message: string;

    if (outcome === "completed") {
      if (isFork) {
        const silent = config.sendResultToUser !== true;
        message =
          `[Fork "${config.label}" completed]\n\n` +
          `Use subagent_read with subagent_id "${config.id}" and last_n: 1 to retrieve the final synthesis.\n` +
          (silent
            ? `This fork was spawned for internal processing. Process the findings internally — do NOT share raw fork output with the user.`
            : `Do NOT re-spawn this fork — just read and share the results.`);
      } else {
        const silent = config.sendResultToUser === false;
        message =
          `[Subagent "${config.label}" completed]\n\n` +
          `Use subagent_read with subagent_id "${config.id}" to retrieve the full output.\n` +
          (silent
            ? `This subagent was spawned for internal processing. Read the result for your own use but do NOT share it with the user.\nDo NOT re-spawn this subagent.`
            : `Do NOT re-spawn this subagent — just read and share the results.`);
      }
    } else {
      const error = managed.state.error ?? "Unknown error";
      const prefix = isFork ? "Fork" : "Subagent";
      message =
        `[${prefix} "${config.label}" failed]\n\n` +
        `Error: ${error}\n` +
        `Do NOT re-spawn or retry this ${prefix.toLowerCase()} unless the user explicitly asks.`;
    }

    const notification: SubagentNotificationInfo = {
      subagentId: config.id,
      label: config.label,
      status: outcome,
      conversationId: managed.state.conversationId,
      objective: config.objective,
      ...(outcome === "failed"
        ? { error: managed.state.error ?? "Unknown error" }
        : {}),
    };

    this.injectMessageIntoParent(config.parentConversationId, message, {
      subagentNotification: notification,
    });
  }

  /**
   * Inject a notification message into the parent conversation so the LLM
   * sees subagent lifecycle events. Relies on the parent conversation's
   * sendToClient (backed by broadcastMessage) for event delivery.
   */
  private injectMessageIntoParent(
    parentConversationId: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const parentConversation =
      findConversation(parentConversationId) ??
      findConversationOrSubagent(parentConversationId);
    if (!parentConversation) {
      log.warn(
        { parentConversationId },
        "Subagent finished but parent conversation not found",
      );
      return;
    }
    const managedParent =
      this.findManagedByConversationId(parentConversationId);
    if (managedParent && !TERMINAL_STATUSES.has(managedParent.state.status)) {
      if (!managedParent.pendingParentNotifications) {
        managedParent.pendingParentNotifications = [];
      }
      managedParent.pendingParentNotifications.push({ message, metadata });
      this.scheduleParentNotificationDrain(
        managedParent.state.config.id,
        parentConversation.isProcessing() ? 25 : 0,
      );
      return;
    }

    const enqueueResult = parentConversation.enqueueMessage({
      content: message,
      metadata,
    });
    if (!enqueueResult.queued && !enqueueResult.rejected) {
      parentConversation
        .persistUserMessage({ content: message, metadata })
        .then(({ id: messageId }) =>
          parentConversation.runAgentLoop(message, messageId),
        )
        .catch((err) => {
          log.error(
            { parentConversationId, err },
            "Failed to process subagent notification in parent",
          );
        });
    }
  }
}
