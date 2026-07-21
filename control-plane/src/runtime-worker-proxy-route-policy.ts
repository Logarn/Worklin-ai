const MAX_PATH_LENGTH = 8_192;
const MAX_ASSISTANT_ID_LENGTH = 256;
const MAX_ROUTE_SEGMENT_LENGTH = 2_048;

const SUPPORTED_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);

export const ASSISTANT_RUNTIME_ROUTE_INVENTORY_SHA256 =
  "32219aa6b9cb27f11446a6ba53c0c9e9d10c4bdc4a4bbc353396aa4b8e8c1be5";

/**
 * First-segment inventory for the assistant's declarative runtime routes.
 *
 * The companion test derives this inventory from
 * assistant/src/runtime/routes. New route families therefore fail closed until
 * their pooled-runtime lifetime is reviewed and this policy is updated.
 */
export const ASSISTANT_RUNTIME_ROUTE_FAMILIES = Object.freeze([
  "acp",
  "admin",
  "apps",
  "artifacts",
  "attachments",
  "audio",
  "audit",
  "auth",
  "avatar",
  "background-tools",
  "background-wake",
  "backup",
  "backups",
  "bookmarks",
  "brain-graph",
  "brain-graph-ui",
  "brands",
  "browser",
  "btw",
  "cache",
  "calls",
  "channel-verification-sessions",
  "channels",
  "clients",
  "config",
  "confirm",
  "consolidation",
  "contact-channels",
  "contacts",
  "content-source",
  "conversation-starters",
  "conversations",
  "copybook-campaigns",
  "copybook-months",
  "copybooks",
  "credentials",
  "debug",
  "defer",
  "diagnostics",
  "dictation",
  "disk-pressure",
  "documents",
  "domain",
  "email",
  "events",
  "export",
  "filing",
  "gateway",
  "groups",
  "guardian-actions",
  "health",
  "healthz",
  "heartbeat",
  "home",
  "host-app-control-result",
  "host-bash-result",
  "host-browser-event",
  "host-browser-result",
  "host-browser-session-invalidated",
  "host-cu-result",
  "host-file-result",
  "host-transfer-result",
  "identity",
  "image-generation",
  "inference",
  "integrations",
  "internal",
  "live-voice",
  "llm-request-logs",
  "logs",
  "memory",
  "memory-items",
  "messages",
  "migrations",
  "model",
  "notification-intent-result",
  "notifications",
  "oauth",
  "pages",
  "pending-interactions",
  "platform",
  "playground",
  "plugins",
  "profiler",
  "ps",
  "question-response",
  "recordings",
  "resolve_contact_prompt",
  "retrospective",
  "sanity",
  "schedules",
  "search",
  "secret",
  "secrets",
  "sequences",
  "settings",
  "shared-artifacts",
  "skills",
  "slack",
  "sounds",
  "stt",
  "subagents",
  "suggestion",
  "surface-actions",
  "surfaces",
  "tasks",
  "telemetry",
  "tools",
  "trace-events",
  "transfers",
  "trust-rules",
  "tts",
  "ui",
  "usage",
  "user-routes",
  "watchers",
  "webhooks",
  "work-items",
  "workflows",
  "workspace",
  "workspace-files",
  "x",
] as const);

const KNOWN_ROUTE_FAMILIES = new Set<string>(ASSISTANT_RUNTIME_ROUTE_FAMILIES);

/**
 * Routes reviewed for the interactive pooled beta.
 *
 * Every entry is a complete method + endpoint template from the assistant's
 * declarative route inventory. Parameters match exactly one canonical path
 * segment. Globs, optional segments, prefixes, and family-wide fallbacks are
 * deliberately unsupported.
 */
export const POOLED_RUNTIME_REQUEST_BOUND_ROUTE_SIGNATURES = Object.freeze([
  // Runtime identity and readiness.
  "GET health",
  "GET healthz",
  "GET identity",

  // Conversation and message persistence. Agent generation is entered only
  // through POST /messages; auxiliary inference, analysis, wake, import, and
  // playground routes remain unavailable.
  "DELETE conversations",
  "DELETE conversations/:id",
  "GET conversations",
  "GET conversations/:id",
  "GET conversations/attention",
  "GET conversations/search",
  "PATCH conversations/:id/name",
  "POST conversations",
  "POST conversations/:id/archive",
  "POST conversations/:id/cancel",
  "POST conversations/:id/surface",
  "POST conversations/:id/undo",
  "POST conversations/:id/unarchive",
  "POST conversations/:id/wipe",
  "POST conversations/archive/bulk",
  "POST conversations/fork",
  "POST conversations/rename",
  "POST conversations/reorder",
  "POST conversations/seen",
  "POST conversations/seen/bulk",
  "POST conversations/unread",
  "DELETE messages/queued/:id",
  "GET messages",
  "GET messages/:id/content",
  "GET search",
  "GET suggestion",
  "POST messages",
  "POST messages/queued/:id/steer",

  // Tenant workspace attachment storage. Hosted file-path uploads and
  // registrations are independently constrained to the active workspace by
  // the assistant handlers.
  "DELETE attachments",
  "GET attachments/:id",
  "GET attachments/:id/content",
  "POST attachments",
  "POST attachments/lookup",
  "POST attachments/register",

  // Tenant workspace CRUD.
  "GET workspace/file",
  "GET workspace/file/content",
  "GET workspace/tree",
  "GET workspace-files",
  "GET workspace-files/read",
  "POST workspace/delete",
  "POST workspace/mkdir",
  "POST workspace/rename",
  "POST workspace/write",

  // Tenant database-backed memory, documents, artifacts, bookmarks, and
  // conversation groups. PDF rendering and memory maintenance/reindex routes
  // are intentionally absent because they launch process-wide work.
  "DELETE bookmarks/by-message/:messageId",
  "DELETE documents/:id/comments/:commentId",
  "DELETE groups/:groupId",
  "DELETE memory-items/:id",
  "GET artifacts",
  "GET artifacts/:id",
  "GET bookmarks",
  "GET brands",
  "GET documents",
  "GET documents/:id",
  "GET documents/:id/comments",
  "GET groups",
  "GET memory-items",
  "GET memory-items/:id",
  "PATCH artifacts/:id",
  "PATCH documents/:id/comments/:commentId",
  "PATCH groups/:groupId",
  "PATCH memory-items/:id",
  "POST bookmarks",
  "POST documents",
  "POST documents/:id/comments",
  "POST documents/:id/conversations",
  "POST groups",
  "POST groups/reorder",
  "POST memory-items",

  // Dashboard home state and bounded surface interactions.
  "GET home/feed",
  "GET home/state",
  "GET surfaces/:surfaceId",
  "PATCH home/feed/:id",
  "POST home/feed/:id/actions/:actionId",
  "POST home/feed/query",
  "POST surface-actions",
  "POST surfaces/:id/undo",

  // Read-only tenant configuration and model catalogs. Pooled provider/model
  // mutations are owned by the control plane's BYOK bootstrap, not by worker
  // configuration endpoints.
  "GET config",
  "GET config/allowlist/validate",
  "GET config/embeddings",
  "GET config/llm/call-sites",
  "GET config/llm/profiles",
  "GET config/schema",
  "GET model",
  "PUT settings/client",

  // Synchronous task-template and work-item CRUD. Every run, wake, cancel,
  // preflight, scheduler, workflow, and background queue entry point is absent.
  "DELETE work-items/:id",
  "GET work-items",
  "GET work-items/:id",
  "GET work-items/:id/output",
  "PATCH work-items/:id",
  "POST tasks/delete",
  "POST tasks/list",
  "POST tasks/queue/add",
  "POST tasks/queue/remove",
  "POST tasks/queue/show",
  "POST tasks/queue/update",
  "POST tasks/save",
  "POST work-items/:id/approve-permissions",
  "POST work-items/:id/complete",

  // Reviewed workspace-backed app data/preview/history and static skill reads.
  // App compilation/import/publish/share and skill mutation/inspection are
  // process-global or executable and therefore absent.
  "GET apps",
  "GET apps/:id/data",
  "GET apps/:id/diff",
  "GET apps/:id/history",
  "GET apps/:id/preview",
  "GET apps/signing-identity",
  "GET skills",
  "GET skills/:id",
  "GET skills/:id/files",
  "GET skills/:id/files/content",
  "GET skills/categories",
  "GET skills/search",
  "POST apps/:id/data",
  "POST apps/sign-bundle",
  "PUT apps/:id/preview",

  // Approval resolution is valid only while the originating request still
  // owns the tenant lease. Secret delivery is excluded because the current
  // body contract also permits persistence in worker-local secure storage.
  "GET pending-interactions",
  "POST confirm",
  "POST question-response",
] as const);

export const POOLED_RUNTIME_CONTROL_PLANE_ROUTE_SIGNATURES = Object.freeze([
  "DELETE secrets",
  "GET secrets",
  "POST secrets",
  "POST secrets/read",
] as const);

export const POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES = Object.freeze([
  ...POOLED_RUNTIME_REQUEST_BOUND_ROUTE_SIGNATURES,
  ...POOLED_RUNTIME_CONTROL_PLANE_ROUTE_SIGNATURES,
] as const);

interface CompiledRoutePattern {
  method: string;
  endpoint: string;
  segments: readonly string[];
}

const PARAMETER_SEGMENT = /^:[A-Za-z][A-Za-z0-9_]*$/u;

function compileRouteSignature(signature: string): CompiledRoutePattern {
  const separator = signature.indexOf(" ");
  const method = signature.slice(0, separator);
  const endpoint = signature.slice(separator + 1);
  const segments = endpoint.split("/");

  if (
    separator <= 0 ||
    !SUPPORTED_METHODS.has(method) ||
    !endpoint ||
    segments.some(
      (segment) =>
        !segment ||
        segment.includes("*") ||
        (segment.startsWith(":")
          ? !PARAMETER_SEGMENT.test(segment)
          : segment.includes(":")),
    )
  ) {
    throw new Error(`Invalid exact pooled route signature: ${signature}`);
  }

  return Object.freeze({
    method,
    endpoint,
    segments: Object.freeze(segments),
  });
}

const REQUEST_BOUND_ROUTE_PATTERNS = Object.freeze(
  POOLED_RUNTIME_REQUEST_BOUND_ROUTE_SIGNATURES.map(compileRouteSignature),
);

// These declared static endpoints would otherwise be captured by the reviewed
// GET conversations/:id pattern. Static assistant routes take precedence over
// parameter routes, so the proxy must mirror that precedence and deny the
// unreviewed handler rather than treating its literal segment as an id.
const DENIED_STATIC_ROUTE_SHADOWS = new Set([
  "GET conversations/inference-profile-sessions",
  "GET conversations/llm-context",
]);

function findRequestBoundRoutePattern(
  method: string,
  segments: readonly string[],
): CompiledRoutePattern | undefined {
  if (DENIED_STATIC_ROUTE_SHADOWS.has(`${method} ${segments.join("/")}`)) {
    return undefined;
  }
  return REQUEST_BOUND_ROUTE_PATTERNS.find(
    (pattern) =>
      pattern.method === method &&
      pattern.segments.length === segments.length &&
      pattern.segments.every(
        (segment, index) =>
          segment.startsWith(":") || segment === segments[index],
      ),
  );
}

const BACKGROUND_ROUTE_FAMILIES = new Set([
  "background-tools",
  "background-wake",
  "consolidation",
  "defer",
  "filing",
  "heartbeat",
  "schedules",
  "sequences",
  "subagents",
  "watchers",
  "workflows",
]);

/**
 * These route families can read or mutate credentials and integration state
 * that still lives in the worker process/protected gateway directory. Pooled
 * v1 intentionally supports only request-scoped model-provider keys from the
 * control-plane vault, so every other integration credential surface must
 * remain on a dedicated runtime.
 */
const WORKER_LOCAL_CREDENTIAL_ROUTE_FAMILIES = new Set([
  "auth",
  "channels",
  "credentials",
  "email",
  "integrations",
  "notifications",
  "oauth",
  "platform",
  "slack",
  "webhooks",
]);

/**
 * These families expose process-wide diagnostics, host callbacks, executable
 * extensions, or storage outside the tenant checkpoint. Reusing the process
 * for another tenant is unsafe until each surface has a tenant-scoped
 * lifecycle and generation-bound authorization.
 */
const PROCESS_GLOBAL_ROUTE_FAMILIES = new Set([
  "backup",
  "backups",
  "browser",
  "cache",
  "debug",
  "diagnostics",
  "disk-pressure",
  "export",
  "gateway",
  "host-app-control-result",
  "host-bash-result",
  "host-browser-event",
  "host-browser-result",
  "host-browser-session-invalidated",
  "host-cu-result",
  "host-file-result",
  "host-transfer-result",
  "image-generation",
  "logs",
  "migrations",
  "notification-intent-result",
  "plugins",
  "profiler",
  "ps",
  "resolve_contact_prompt",
  "telemetry",
  "transfers",
  "trust-rules",
  "user-routes",
]);

export type RuntimeWorkerProxyRouteRejectionReason =
  | "malformed_path"
  | "unsupported_http_method"
  | "unknown_route_family"
  | "upgrade_transport_unsupported"
  | "assistant_event_stream_requires_dedicated_runtime"
  | "terminal_session_requires_dedicated_runtime"
  | "native_live_voice_requires_dedicated_runtime"
  | "managed_live_voice_route_unsupported"
  | "live_voice_provider_route_forbidden"
  | "speech_stream_requires_dedicated_runtime"
  | "direct_dictation_requires_dedicated_runtime"
  | "telephony_requires_dedicated_runtime"
  | "recording_session_requires_dedicated_runtime"
  | "credential_operations_require_dedicated_runtime"
  | "process_global_state_requires_dedicated_runtime"
  | "acp_requires_dedicated_runtime"
  | "background_execution_requires_dedicated_runtime"
  | "internal_runtime_route_forbidden"
  | "dynamic_runtime_route_unsupported";

export interface ParsedAssistantProxyPath {
  assistantId: string;
  routeSegments: readonly string[];
  canonicalPathname: string;
  upstreamPathname: string;
}

interface AllowedRouteBase extends ParsedAssistantProxyPath {
  status: "allowed";
  method: string;
}

export type RuntimeWorkerProxyRouteDecision =
  | (AllowedRouteBase & {
      handling: "request_bound";
      reason: "request_lifetime_fenced";
    })
  | (AllowedRouteBase & {
      handling: "hold_live_voice_session";
      reason: "managed_live_voice_session_hold";
    })
  | (AllowedRouteBase & {
      handling: "release_live_voice_session";
      reason: "managed_live_voice_session_release";
      sessionId: string;
    })
  | (AllowedRouteBase & {
      handling: "use_held_live_voice_session";
      reason: "managed_live_voice_session_held_request";
      sessionId: string;
    })
  | (AllowedRouteBase & {
      handling: "control_plane_model_key_vault";
      reason: "pooled_model_key_vault_intercept";
    })
  | {
      status: "rejected";
      reason: RuntimeWorkerProxyRouteRejectionReason;
    };

export interface RuntimeWorkerProxyRouteInput {
  method: string;
  pathname: string;
  upgrade?: string | null;
}

function decodeCanonicalSegment(raw: string, maxLength: number): string | null {
  if (!raw || raw.length > maxLength * 3) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (
    !decoded ||
    decoded.length > maxLength ||
    decoded !== decoded.trim() ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("%") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(decoded) ||
    decoded.normalize("NFC") !== decoded ||
    encodeURIComponent(decoded) !== raw
  ) {
    return null;
  }

  return decoded;
}

/**
 * Decodes an assistant-scoped proxy pathname exactly once.
 *
 * A single trailing slash is accepted and removed. Empty/repeated segments,
 * dot segments, encoded separators, double-encoding, non-NFC Unicode, query
 * or fragment text, and non-canonical percent encodings are rejected.
 */
export function parseAssistantProxyPath(
  pathname: string,
): ParsedAssistantProxyPath | null {
  if (
    typeof pathname !== "string" ||
    pathname.length === 0 ||
    pathname.length > MAX_PATH_LENGTH ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    !pathname.startsWith("/")
  ) {
    return null;
  }

  let withoutTrailingSlash = pathname;
  if (withoutTrailingSlash.endsWith("/")) {
    withoutTrailingSlash = withoutTrailingSlash.slice(0, -1);
  }
  if (withoutTrailingSlash.length === 0 || withoutTrailingSlash.endsWith("/")) {
    return null;
  }

  const rawSegments = withoutTrailingSlash.split("/");
  if (
    rawSegments.length < 5 ||
    rawSegments[0] !== "" ||
    rawSegments[1] !== "v1" ||
    rawSegments[2] !== "assistants" ||
    rawSegments.some((segment, index) => index > 0 && segment.length === 0)
  ) {
    return null;
  }

  const assistantId = decodeCanonicalSegment(
    rawSegments[3]!,
    MAX_ASSISTANT_ID_LENGTH,
  );
  if (!assistantId) return null;

  const decodedRouteSegments: string[] = [];
  for (const rawSegment of rawSegments.slice(4)) {
    const decoded = decodeCanonicalSegment(
      rawSegment,
      MAX_ROUTE_SEGMENT_LENGTH,
    );
    if (!decoded) return null;
    decodedRouteSegments.push(decoded);
  }
  if (decodedRouteSegments.length === 0) return null;

  const canonicalRuntimePath = rawSegments.slice(4).join("/");
  return {
    assistantId,
    routeSegments: Object.freeze(decodedRouteSegments),
    canonicalPathname: withoutTrailingSlash,
    upstreamPathname: `/v1/${canonicalRuntimePath}`,
  };
}

function rejected(
  reason: RuntimeWorkerProxyRouteRejectionReason,
): RuntimeWorkerProxyRouteDecision {
  return { status: "rejected", reason };
}

function isContactsInviteCall(segments: readonly string[]): boolean {
  return (
    segments.length === 4 &&
    segments[0] === "contacts" &&
    segments[1] === "invites" &&
    segments[3] === "call"
  );
}

function isBackgroundStartRoute(
  method: string,
  segments: readonly string[],
): boolean {
  return (
    (method === "POST" &&
      segments.length === 2 &&
      segments[0] === "tasks" &&
      segments[1] === "run") ||
    (method === "POST" &&
      segments.length === 3 &&
      segments[0] === "work-items" &&
      segments[2] === "run") ||
    (method === "POST" &&
      segments.length === 3 &&
      segments[0] === "tasks" &&
      segments[1] === "queue" &&
      segments[2] === "run")
  );
}

function allowedBase(
  parsed: ParsedAssistantProxyPath,
  method: string,
): AllowedRouteBase {
  return { status: "allowed", method, ...parsed };
}

/**
 * Classifies whether an authenticated assistant proxy request can use a
 * pooled worker. Rejected routes must remain on a dedicated runtime (or return
 * unavailable); the policy never silently falls back to an unfenced worker.
 */
export function classifyRuntimeWorkerProxyRoute(
  input: RuntimeWorkerProxyRouteInput,
): RuntimeWorkerProxyRouteDecision {
  const parsed = parseAssistantProxyPath(input.pathname);
  if (!parsed) return rejected("malformed_path");

  const method =
    typeof input.method === "string" ? input.method.toUpperCase() : "";
  if (
    typeof input.method !== "string" ||
    input.method !== input.method.trim() ||
    !SUPPORTED_METHODS.has(method)
  ) {
    return rejected("unsupported_http_method");
  }

  const segments = parsed.routeSegments;
  const family = segments[0]!;
  const requestBoundRoutePattern = findRequestBoundRoutePattern(
    method,
    segments,
  );

  if (family === "events") {
    // The assistant-scoped SSE stream is intentionally indefinite. Pinning it
    // to a pooled worker would let every idle dashboard monopolize one worker.
    // Pooled web clients use bounded /messages polling during active turns;
    // older clients fail closed here instead of silently creating a permanent
    // worker lease.
    return rejected("assistant_event_stream_requires_dedicated_runtime");
  }
  if (family === "terminal") {
    return rejected("terminal_session_requires_dedicated_runtime");
  }
  if (family === "live-voice") {
    if (segments.length === 1) {
      return rejected("native_live_voice_requires_dedicated_runtime");
    }
    if (segments[1] === "providers") {
      return rejected("live_voice_provider_route_forbidden");
    }
    // Pooled v1 has no tenant-bound voice-provider credential path. Hume and
    // ElevenLabs bootstraps currently read worker-local secure storage, while
    // native voice and provider callbacks require long-lived connections. Keep
    // every managed bootstrap/session shape on a dedicated runtime until both
    // credentials and callbacks are generation-bound in the control plane.
    return rejected("managed_live_voice_route_unsupported");
  }
  if (family === "stt") {
    if (segments[1] === "stream") {
      return rejected("speech_stream_requires_dedicated_runtime");
    }
    return rejected("direct_dictation_requires_dedicated_runtime");
  }
  if (
    family === "dictation" ||
    family === "audio" ||
    family === "sounds" ||
    family === "tts"
  ) {
    return rejected("direct_dictation_requires_dedicated_runtime");
  }
  if (
    family === "calls" ||
    family === "channel-verification-sessions" ||
    (family === "integrations" && segments[1] === "twilio") ||
    isContactsInviteCall(segments)
  ) {
    return rejected("telephony_requires_dedicated_runtime");
  }
  if (family === "recordings") {
    return rejected("recording_session_requires_dedicated_runtime");
  }
  if (input.upgrade?.trim()) {
    return rejected("upgrade_transport_unsupported");
  }
  if (family === "apps" && !requestBoundRoutePattern) {
    // App import/open/compile/publish/delete paths either accept absolute host
    // paths, execute tenant code, produce untracked temporary bundles, or use
    // process-global shared-app storage. Keep a small exact allowlist of
    // workspace-backed catalog, signing, preview, history, and data routes;
    // unknown future app routes fail closed.
    return rejected("process_global_state_requires_dedicated_runtime");
  }
  if (family === "skills" && !requestBoundRoutePattern) {
    // Skill installation, enablement, configuration, update, deletion, and
    // executable inspection mutate or import process-visible code. Pooled v1
    // exposes only static workspace-backed catalog/file reads.
    return rejected("process_global_state_requires_dedicated_runtime");
  }
  if (
    family === "admin" &&
    segments.length === 2 &&
    segments[1] === "rollback-migrations"
  ) {
    return rejected("process_global_state_requires_dedicated_runtime");
  }
  if (family === "secrets") {
    const supported =
      (segments.length === 1 &&
        (method === "GET" || method === "POST" || method === "DELETE")) ||
      (segments.length === 2 && segments[1] === "read" && method === "POST");
    if (!supported) {
      return rejected("credential_operations_require_dedicated_runtime");
    }
    return {
      ...allowedBase(parsed, method),
      handling: "control_plane_model_key_vault",
      reason: "pooled_model_key_vault_intercept",
    };
  }
  if (family === "secret") {
    // The current body contract accepts delivery="store" as well as
    // transient_send. Route policy cannot prove that a request is transient,
    // so every worker-local secret prompt remains dedicated-only until a
    // separate transient-only contract exists.
    return rejected("credential_operations_require_dedicated_runtime");
  }
  if (WORKER_LOCAL_CREDENTIAL_ROUTE_FAMILIES.has(family)) {
    // The current assistant credential stores and broker are process-local.
    // Until pooled workers resolve secrets from a tenant-bound central vault,
    // every storage, reveal, and prompt-creation route must fail closed rather
    // than share a process-wide credential namespace. BYOK model keys use the
    // control-plane interception above.
    return rejected("credential_operations_require_dedicated_runtime");
  }
  if (family === "inference" && segments[1] === "chatgpt-subscription") {
    // Subscription OAuth credentials are intentionally excluded from the
    // pooled model-key vault. BYOK provider keys remain available through the
    // exact /v1/secrets control-plane interception above.
    return rejected("credential_operations_require_dedicated_runtime");
  }
  if (PROCESS_GLOBAL_ROUTE_FAMILIES.has(family)) {
    return rejected("process_global_state_requires_dedicated_runtime");
  }
  if (family === "acp") {
    return rejected("acp_requires_dedicated_runtime");
  }
  if (
    BACKGROUND_ROUTE_FAMILIES.has(family) ||
    isBackgroundStartRoute(method, segments)
  ) {
    return rejected("background_execution_requires_dedicated_runtime");
  }
  if (family === "internal") {
    return rejected("internal_runtime_route_forbidden");
  }
  if (family === "x") {
    return rejected("dynamic_runtime_route_unsupported");
  }
  if (!KNOWN_ROUTE_FAMILIES.has(family)) {
    return rejected("unknown_route_family");
  }
  if (!requestBoundRoutePattern) {
    return rejected("dynamic_runtime_route_unsupported");
  }

  return {
    ...allowedBase(parsed, method),
    handling: "request_bound",
    reason: "request_lifetime_fenced",
  };
}
