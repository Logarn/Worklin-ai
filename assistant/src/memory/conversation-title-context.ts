export type TitleOrigin =
  | "runtime_api"
  | "channel_inbound"
  | "voice_outbound"
  | "voice_inbound"
  | "guardian_request"
  | "schedule"
  | "task"
  | "watcher"
  | "subagent"
  | "sequence"
  | "heartbeat"
  | "filing"
  | "local"
  | "task_submit"
  | "memory_consolidation"
  | "memory_retrospective"
  | "misc";

export interface TitleContext {
  origin: TitleOrigin;
  conversationKey?: string;
  sourceChannel?: string;
  assistantId?: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
  triggerTextSnippet?: string;
  systemHint?: string;
  metadataHints?: string[];
  uxBrief?: string;
}

export interface PersistedTitleContextFields {
  conversationType?: string | null;
  source?: string | null;
  originChannel?: string | null;
}

const SYSTEM_SOURCE_ORIGINS: Readonly<Record<string, TitleOrigin>> = {
  guardian_request: "guardian_request",
  schedule: "schedule",
  reminder: "schedule",
  task: "task",
  watcher: "watcher",
  subagent: "subagent",
  sequence: "sequence",
  heartbeat: "heartbeat",
  filing: "filing",
  task_submit: "task_submit",
  "task-submit": "task_submit",
  memory_consolidation: "memory_consolidation",
  "memory-consolidation": "memory_consolidation",
  memory: "memory_consolidation",
  compaction: "memory_consolidation",
  "auto-analysis": "memory_consolidation",
  memory_retrospective: "memory_retrospective",
  "memory-retrospective": "memory_retrospective",
  "memory-retrospective-fork": "memory_retrospective",
  background: "misc",
  direct: "misc",
  notification: "misc",
  a2a: "misc",
};

const EXPLICIT_INTERACTIVE_SOURCE_ORIGINS: Readonly<
  Record<string, TitleOrigin>
> = {
  runtime_api: "runtime_api",
  channel_inbound: "channel_inbound",
  voice_outbound: "voice_outbound",
  voice_inbound: "voice_inbound",
  local: "local",
};

const HUMAN_CHANNEL_SOURCES = new Set([
  "user",
  "slack",
  "telegram",
  "whatsapp",
  "email",
]);

const HUMAN_ORIGIN_CHANNELS = new Set([
  "slack",
  "telegram",
  "whatsapp",
  "email",
]);

function normalizePersistedValue(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Recover title-routing semantics from persisted conversation provenance.
 * `isNonInteractive` is deliberately not an input: remote human channels run
 * without an attached UI client, while schedules and background jobs can be
 * stored in compatibility rows whose `conversationType` is still `standard`.
 */
export function resolvePersistedTitleContext(
  conversation: PersistedTitleContextFields | null | undefined,
): TitleContext | undefined {
  const source = normalizePersistedValue(conversation?.source);
  const originChannel = normalizePersistedValue(conversation?.originChannel);

  if (source) {
    const systemOrigin = SYSTEM_SOURCE_ORIGINS[source];
    if (systemOrigin) return { origin: systemOrigin };
  }

  // The stored channel identifies the actual ingress. A generic `user` source
  // is the database default and only acts as a fallback when no channel was
  // persisted.
  if (originChannel) {
    if (originChannel === "a2a") {
      return { origin: "misc", sourceChannel: originChannel };
    }
    if (originChannel === "phone") {
      return { origin: "voice_inbound", sourceChannel: originChannel };
    }
    if (HUMAN_ORIGIN_CHANNELS.has(originChannel)) {
      return { origin: "channel_inbound", sourceChannel: originChannel };
    }
    if (originChannel === "vellum" || originChannel === "platform") {
      return { origin: "runtime_api", sourceChannel: originChannel };
    }
    return { origin: "misc", sourceChannel: originChannel };
  }

  if (source) {
    const explicitInteractiveOrigin =
      EXPLICIT_INTERACTIVE_SOURCE_ORIGINS[source];
    if (explicitInteractiveOrigin) {
      return {
        origin: explicitInteractiveOrigin,
      };
    }
  }

  if (source === "phone") {
    return { origin: "voice_inbound", sourceChannel: "phone" };
  }

  if (source && HUMAN_CHANNEL_SOURCES.has(source)) {
    const sourceChannel = source !== "user" ? source : undefined;
    return {
      origin: "channel_inbound",
      ...(sourceChannel ? { sourceChannel } : {}),
    };
  }

  return undefined;
}
