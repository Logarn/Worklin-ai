import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";

import {
  ASSISTANT_RUNTIME_ROUTE_INVENTORY_SHA256,
  ASSISTANT_RUNTIME_ROUTE_FAMILIES,
  classifyRuntimeWorkerProxyRoute,
  parseAssistantProxyPath,
  POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES,
  POOLED_RUNTIME_CONTROL_PLANE_ROUTE_SIGNATURES,
  POOLED_RUNTIME_REQUEST_BOUND_ROUTE_SIGNATURES,
  type RuntimeWorkerProxyRouteRejectionReason,
} from "./runtime-worker-proxy-route-policy.js";

const ASSISTANT_ID = "assistant-123";
const BASE = `/v1/assistants/${ASSISTANT_ID}`;
const VOICE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function classify(method: string, suffix: string, upgrade?: string) {
  return classifyRuntimeWorkerProxyRoute({
    method,
    pathname: `${BASE}/${suffix}`,
    upgrade,
  });
}

function rejection(method: string, suffix: string, upgrade?: string) {
  const decision = classify(method, suffix, upgrade);
  expect(decision.status).toBe("rejected");
  if (decision.status !== "rejected") {
    throw new Error("Expected route rejection.");
  }
  return decision.reason;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (entry === "__tests__") continue;
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function routeFamiliesDeclaredByAssistant(): string[] {
  const routesDirectory = assistantRoutesDirectory();
  const families = new Set<string>();
  const endpointPattern = /endpoint:\s*"([^"]+)"/gu;

  for (const path of sourceFiles(routesDirectory)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(endpointPattern)) {
      const endpoint = match[1]!;
      families.add(endpoint.split("/")[0]!);
    }
  }

  return [...families].sort();
}

function assistantRoutesDirectory(): string {
  return resolve(import.meta.dir, "../../assistant/src/runtime/routes");
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!("name" in property) || !property.name) return null;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : null;
}

function routeSignaturesDeclaredByAssistant(): string[] {
  const signatures = new Set<string>();

  for (const path of sourceFiles(assistantRoutesDirectory())) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const dynamicMethods: string[] = [];

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "METHODS" &&
        node.initializer
      ) {
        const initializer = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (ts.isArrayLiteralExpression(initializer)) {
          for (const element of initializer.elements) {
            if (ts.isStringLiteralLike(element)) {
              dynamicMethods.push(element.text);
            }
          }
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        let endpoint: string | null = null;
        let method: string | null = null;
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyName(property);
          if (
            name === "endpoint" &&
            ts.isStringLiteralLike(property.initializer)
          ) {
            endpoint = property.initializer.text;
          } else if (
            name === "method" &&
            ts.isStringLiteralLike(property.initializer)
          ) {
            method = property.initializer.text;
          }
        }
        if (endpoint && method) signatures.add(`${method} ${endpoint}`);
      }

      ts.forEachChild(node, visit);
    };
    visit(source);

    if (path.endsWith("/user-routes.ts")) {
      for (const method of dynamicMethods) {
        signatures.add(`${method} x/:path*`);
      }
    }
  }

  return [...signatures].sort();
}

function splitRouteSignature(signature: string): {
  method: string;
  endpoint: string;
} {
  const separator = signature.indexOf(" ");
  return {
    method: signature.slice(0, separator),
    endpoint: signature.slice(separator + 1),
  };
}

function concreteEndpoint(endpoint: string): string {
  return endpoint
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? `sample-${segment.slice(1)}` : segment,
    )
    .join("/");
}

describe("runtime worker proxy route inventory", () => {
  test("matches every declarative assistant route family", () => {
    expect(routeFamiliesDeclaredByAssistant()).toEqual([
      ...ASSISTANT_RUNTIME_ROUTE_FAMILIES,
    ]);
  });

  test("pins the exact method and endpoint inventory used for the safety review", () => {
    const inventory = routeSignaturesDeclaredByAssistant();
    expect(inventory).toHaveLength(552);
    expect(
      createHash("sha256").update(inventory.join("\n")).digest("hex"),
    ).toBe(ASSISTANT_RUNTIME_ROUTE_INVENTORY_SHA256);
  });

  test("pins a unique, wildcard-free allowlist to declared assistant routes", () => {
    const declared = new Set<string>(routeSignaturesDeclaredByAssistant());
    expect(new Set(POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES).size).toBe(
      POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES.length,
    );

    for (const signature of POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES) {
      expect(signature).not.toContain("*");
      expect(declared.has(signature)).toBeTrue();
    }

    for (const signature of POOLED_RUNTIME_REQUEST_BOUND_ROUTE_SIGNATURES) {
      const { method, endpoint } = splitRouteSignature(signature);
      expect(classify(method, concreteEndpoint(endpoint))).toMatchObject({
        status: "allowed",
        handling: "request_bound",
        reason: "request_lifetime_fenced",
      });
    }
    for (const signature of POOLED_RUNTIME_CONTROL_PLANE_ROUTE_SIGNATURES) {
      const { method, endpoint } = splitRouteSignature(signature);
      expect(classify(method, concreteEndpoint(endpoint))).toMatchObject({
        status: "allowed",
        handling: "control_plane_model_key_vault",
        reason: "pooled_model_key_vault_intercept",
      });
    }
  });

  test("every allowed declared route maps to one exact reviewed signature", () => {
    const allowed = new Set<string>(POOLED_RUNTIME_ALLOWED_ROUTE_SIGNATURES);

    for (const signature of routeSignaturesDeclaredByAssistant()) {
      const { method, endpoint } = splitRouteSignature(signature);
      const decision = classify(method, concreteEndpoint(endpoint));

      if (allowed.has(signature)) {
        expect(decision.status).toBe("allowed");
      } else {
        expect(decision.status).toBe("rejected");
      }

      if (decision.status === "allowed") {
        expect(allowed.has(signature)).toBeTrue();
      }
    }
  });

  test("allows reviewed request-bounded dashboard and chat routes", () => {
    for (const [method, suffix] of [
      ["GET", "conversations"],
      ["POST", "messages"],
      ["POST", "conversations/conversation-1/cancel"],
      ["POST", "attachments"],
      ["GET", "workspace/tree"],
      ["POST", "memory-items"],
      ["GET", "documents"],
      ["GET", "home/state"],
      ["GET", "skills"],
      ["POST", "tasks/queue/add"],
      ["GET", "work-items"],
    ]) {
      expect(classify(method!, suffix!)).toMatchObject({
        status: "allowed",
        handling: "request_bound",
        reason: "request_lifetime_fenced",
        method,
        assistantId: ASSISTANT_ID,
        upstreamPathname: `/v1/${suffix}`,
      });
    }
  });

  test("does not let reviewed parameter routes shadow unreviewed static handlers", () => {
    expect(rejection("GET", "conversations/inference-profile-sessions")).toBe(
      "dynamic_runtime_route_unsupported",
    );
    expect(rejection("GET", "conversations/llm-context")).toBe(
      "dynamic_runtime_route_unsupported",
    );
  });

  test("rejects the indefinite assistant event stream", () => {
    expect(rejection("GET", "events")).toBe(
      "assistant_event_stream_requires_dedicated_runtime",
    );
  });

  test("rejects unknown route families instead of guessing their lifetime", () => {
    expect(rejection("GET", "future-long-lived-session")).toBe(
      "unknown_route_family",
    );
  });
});

describe("runtime worker proxy path canonicalization", () => {
  test("decodes canonical segments exactly once and strips one trailing slash", () => {
    expect(
      parseAssistantProxyPath(
        "/v1/assistants/assistant%20one/conversations/conversation%20one/",
      ),
    ).toEqual({
      assistantId: "assistant one",
      routeSegments: ["conversations", "conversation one"],
      canonicalPathname:
        "/v1/assistants/assistant%20one/conversations/conversation%20one",
      upstreamPathname: "/v1/conversations/conversation%20one",
    });
  });

  test("rejects malformed, ambiguous, or non-canonical paths", () => {
    const malformed = [
      "",
      "v1/assistants/a/conversations",
      "/v1/assistants//conversations",
      "/v1/assistants/a",
      "/v1/assistants/a/",
      "/v1/assistants/a//conversations",
      "/v1/assistants/a/conversations//",
      "/v1/assistants/a/./conversations",
      "/v1/assistants/a/%2e%2e/conversations",
      "/v1/assistants/a/conversations?cursor=1",
      "/v1/assistants/a/conversations#fragment",
      "/v1/assistants/a%2Fb/conversations",
      "/v1/assistants/a%5Cb/conversations",
      "/v1/assistants/a%252Fb/conversations",
      "/v1/assistants/a/%63onversations",
      "/v1/assistants/a/%E0%A4%A",
      "/v1/assistants/a/\u0000",
    ];

    for (const pathname of malformed) {
      expect(parseAssistantProxyPath(pathname)).toBeNull();
      expect(
        classifyRuntimeWorkerProxyRoute({ method: "GET", pathname }),
      ).toEqual({ status: "rejected", reason: "malformed_path" });
    }
  });

  test("rejects unsupported methods and upgrade transports", () => {
    expect(rejection("CONNECT", "conversations")).toBe(
      "unsupported_http_method",
    );
    expect(rejection(" GET", "conversations")).toBe("unsupported_http_method");
    expect(rejection("GET", "conversations", "websocket")).toBe(
      "upgrade_transport_unsupported",
    );
  });
});

describe("managed and native live voice policy", () => {
  test("fails closed for every managed bootstrap and session route", () => {
    for (const [method, suffix, upgrade] of [
      ["POST", "live-voice/sessions", undefined],
      ["POST", "live-voice/sessions", "websocket"],
      ["DELETE", `live-voice/sessions/${VOICE_SESSION_ID}`, undefined],
      [
        "POST",
        `live-voice/sessions/${VOICE_SESSION_ID}/provider-conversation`,
        undefined,
      ],
    ] as const) {
      expect(rejection(method, suffix, upgrade)).toBe(
        "managed_live_voice_route_unsupported",
      );
    }
  });

  test("rejects native websocket/fallback and provider-only routes", () => {
    expect(rejection("GET", "live-voice", "websocket")).toBe(
      "native_live_voice_requires_dedicated_runtime",
    );
    expect(rejection("GET", "live-voice")).toBe(
      "native_live_voice_requires_dedicated_runtime",
    );
    expect(
      rejection("GET", "live-voice/providers/elevenlabs/upstream", "websocket"),
    ).toBe("live_voice_provider_route_forbidden");
    expect(rejection("POST", "live-voice/providers/chat/completions")).toBe(
      "live_voice_provider_route_forbidden",
    );
    expect(rejection("GET", "live-voice/sessions")).toBe(
      "managed_live_voice_route_unsupported",
    );
  });
});

describe("long-lived route rejection", () => {
  test("rejects app host paths, executable mutations, publishing, and unknown subroutes", () => {
    for (const [method, suffix] of [
      ["POST", "apps/open-bundle"],
      ["POST", "apps/app-1/bundle"],
      ["GET", "apps/shared"],
      ["POST", "apps/fork"],
      ["POST", "apps/import-bundle"],
      ["POST", "apps/app-1/open"],
      ["POST", "apps/app-1/delete"],
      ["POST", "apps/app-1/restore"],
      ["POST", "apps/app-1/share-cloud"],
      ["POST", "apps/future-dangerous-route"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(
        "process_global_state_requires_dedicated_runtime",
      );
    }

    for (const [method, suffix] of [
      ["GET", "apps"],
      ["GET", "apps/app-1/data"],
      ["POST", "apps/app-1/data"],
      ["GET", "apps/app-1/preview"],
      ["GET", "apps/app-1/history"],
    ] as const) {
      expect(classify(method, suffix)).toMatchObject({
        status: "allowed",
        handling: "request_bound",
      });
    }
  });

  test("rejects process-global diagnostics, host callbacks, and dynamic code surfaces", () => {
    for (const [method, suffix] of [
      ["POST", "browser/execute"],
      ["POST", "cache/get"],
      ["GET", "debug"],
      ["POST", "debug/bash"],
      ["GET", "diagnostics/env-vars"],
      ["GET", "disk-pressure"],
      ["POST", "disk-pressure/acknowledge"],
      ["POST", "disk-pressure/override"],
      ["GET", "gateway/logs/tail"],
      ["POST", "image-generation/generate"],
      ["GET", "logs/export"],
      ["GET", "profiler/runs"],
      ["GET", "ps"],
      ["POST", "host-bash-result"],
      ["POST", "host-browser-result"],
      ["POST", "host-file-result"],
      ["POST", "notification-intent-result"],
      ["GET", "trust-rules"],
      ["GET", "user-routes/list"],
      ["GET", "transfers/transfer-1/content"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(
        "process_global_state_requires_dedicated_runtime",
      );
    }
  });

  test("keeps static skill reads but rejects code-importing and mutating skill routes", () => {
    for (const [method, suffix] of [
      ["GET", "skills"],
      ["GET", "skills/categories"],
      ["GET", "skills/search"],
      ["GET", "skills/skill-1"],
      ["GET", "skills/skill-1/files"],
      ["GET", "skills/skill-1/files/content"],
    ] as const) {
      expect(classify(method, suffix)).toMatchObject({
        status: "allowed",
        handling: "request_bound",
      });
    }
    for (const [method, suffix] of [
      ["POST", "skills"],
      ["POST", "skills/install"],
      ["POST", "skills/draft"],
      ["POST", "skills/check-updates"],
      ["POST", "skills/skill-1/enable"],
      ["PATCH", "skills/skill-1/config"],
      ["POST", "skills/skill-1/update"],
      ["DELETE", "skills/skill-1"],
      ["GET", "skills/skill-1/inspect"],
      ["GET", "skills/skill-1/local-inspect"],
      ["GET", "skills/skill-1/future-executable-route"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(
        "process_global_state_requires_dedicated_runtime",
      );
    }
  });

  test("rejects the complete terminal session route family", () => {
    for (const [method, suffix] of [
      ["POST", "terminal/sessions"],
      ["DELETE", `terminal/sessions/${VOICE_SESSION_ID}`],
      ["POST", `terminal/sessions/${VOICE_SESSION_ID}/input`],
      ["POST", `terminal/sessions/${VOICE_SESSION_ID}/resize`],
      ["GET", `terminal/sessions/${VOICE_SESSION_ID}/events`],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "terminal_session_requires_dedicated_runtime",
      );
    }
  });

  test("rejects speech catalogs, streaming, synthesis, and direct dictation", () => {
    for (const [method, suffix, upgrade] of [
      ["GET", "stt/providers", undefined],
      ["GET", "stt/stream", "websocket"],
      ["POST", "stt/transcribe", undefined],
      ["POST", "stt/transcribe-file", undefined],
      ["POST", "dictation", undefined],
      ["GET", "tts/providers", undefined],
      ["POST", "tts/synthesize", undefined],
    ]) {
      const reason = rejection(method!, suffix!, upgrade);
      expect([
        "speech_stream_requires_dedicated_runtime",
        "direct_dictation_requires_dedicated_runtime",
      ]).toContain(reason);
    }
  });

  test("rejects calls, telephony configuration, callbacks, and recordings", () => {
    const telephonyRoutes = [
      ["POST", "calls/start"],
      ["POST", "calls/call-1/cancel"],
      ["POST", "calls/call-1/answer"],
      ["POST", "calls/call-1/instruction"],
      ["GET", "calls/call-1"],
      ["GET", "calls/relay"],
      ["GET", "calls/media-stream"],
      ["GET", "integrations/twilio/config"],
      ["POST", "integrations/twilio/numbers/provision"],
      ["POST", "contacts/invites/invite-1/call"],
      ["POST", "channel-verification-sessions"],
    ];
    for (const [method, suffix] of telephonyRoutes) {
      expect(rejection(method!, suffix!)).toBe(
        "telephony_requires_dedicated_runtime",
      );
    }

    for (const [method, suffix] of [
      ["POST", "recordings/start"],
      ["POST", "recordings/stop"],
      ["POST", "recordings/pause"],
      ["POST", "recordings/resume"],
      ["GET", "recordings/status"],
      ["POST", "recordings/status"],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "recording_session_requires_dedicated_runtime",
      );
    }
  });

  test("intercepts exact model-key vault routes without forwarding them to pooled workers", () => {
    for (const [method, suffix] of [
      ["POST", "secrets"],
      ["GET", "secrets"],
      ["DELETE", "secrets"],
      ["POST", "secrets/read"],
    ]) {
      expect(classify(method!, suffix!)).toMatchObject({
        status: "allowed",
        handling: "control_plane_model_key_vault",
        reason: "pooled_model_key_vault_intercept",
      });
    }
  });

  test("rejects worker-local secret prompts until delivery is transient-only", () => {
    for (const [method, suffix] of [
      ["POST", "secret"],
      ["GET", "secret"],
      ["PUT", "secret"],
      ["DELETE", "secret"],
      ["POST", "secret/read"],
      ["POST", "secret/reveal"],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "credential_operations_require_dedicated_runtime",
      );
    }
  });

  test("rejects every worker-local credential operation on pooled workers", () => {
    for (const [method, suffix] of [
      ["POST", "credentials/prompt"],
      ["POST", "credentials/list"],
      ["POST", "credentials/inspect"],
      ["POST", "credentials/reveal"],
      ["POST", "credentials/set"],
      ["POST", "credentials/delete"],
      ["GET", "credentials/status"],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "credential_operations_require_dedicated_runtime",
      );
    }
    expect(rejection("PUT", "secrets")).toBe(
      "credential_operations_require_dedicated_runtime",
    );
  });

  test("rejects integration credentials and process-global plugin state", () => {
    for (const [method, suffix] of [
      ["GET", "oauth/apps"],
      ["POST", "oauth/request"],
      ["POST", "email/send"],
      ["PUT", "integrations/vercel/config"],
      ["POST", "notifications/emit"],
      ["GET", "slack/channels"],
      ["POST", "webhooks/register"],
      ["POST", "inference/chatgpt-subscription/auth"],
      ["GET", "inference/chatgpt-subscription/auth/status"],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "credential_operations_require_dedicated_runtime",
      );
    }

    for (const [method, suffix] of [
      ["GET", "plugins/search"],
      ["POST", "plugins/install"],
      ["DELETE", "plugins/example"],
      ["GET", "backups"],
      ["POST", "backups/create"],
      ["POST", "migrations/export"],
      ["POST", "admin/rollback-migrations"],
      ["POST", "resolve_contact_prompt"],
    ]) {
      expect(rejection(method!, suffix!)).toBe(
        "process_global_state_requires_dedicated_runtime",
      );
    }
  });

  test("rejects device, token, pairing, and guardian bootstrap aliases with or without a trailing slash", () => {
    for (const [method, suffix, reason] of [
      ["POST", "auth/token", "credential_operations_require_dedicated_runtime"],
      [
        "POST",
        "auth/token/",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "auth/token/refresh",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "auth/token/revoke",
        "credential_operations_require_dedicated_runtime",
      ],
      ["POST", "auth/pair", "credential_operations_require_dedicated_runtime"],
      [
        "GET",
        "auth/devices",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "auth/devices/revoke",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "auth/guardian/init",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "auth/guardian/refresh",
        "credential_operations_require_dedicated_runtime",
      ],
      [
        "POST",
        "channels/guardian/init",
        "credential_operations_require_dedicated_runtime",
      ],
      ["POST", "guardian-actions/init", "dynamic_runtime_route_unsupported"],
      ["POST", "guardian-actions/init/", "dynamic_runtime_route_unsupported"],
      ["POST", "guardian-actions/refresh", "dynamic_runtime_route_unsupported"],
      ["POST", "clients/devices", "dynamic_runtime_route_unsupported"],
      [
        "POST",
        "contacts/guardian/channel",
        "dynamic_runtime_route_unsupported",
      ],
      [
        "POST",
        "contacts/guardian/channel/",
        "dynamic_runtime_route_unsupported",
      ],
      ["POST", "contacts/prompt", "dynamic_runtime_route_unsupported"],
      ["POST", "pair", "unknown_route_family"],
      ["GET", "devices", "unknown_route_family"],
      ["POST", "guardian/init", "unknown_route_family"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(reason);
    }
  });

  test("keeps contact, client, and guardian-account surfaces outside the beta", () => {
    for (const [method, suffix] of [
      ["GET", "contacts"],
      ["GET", "contacts/"],
      ["GET", "contacts/contact-1"],
      ["POST", "contacts/search"],
      ["POST", "contacts/search/"],
      ["POST", "contacts/merge"],
      ["GET", "contacts/invites"],
      ["POST", "contacts/invites"],
      ["POST", "contacts/invites/redeem"],
      ["DELETE", "contacts/invites/invite-1"],
      ["GET", "clients"],
      ["GET", "clients/"],
      ["POST", "clients/disconnect"],
      ["GET", "guardian-actions/pending"],
      ["POST", "guardian-actions/decision"],
      ["POST", "guardian-actions/decision/"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(
        "dynamic_runtime_route_unsupported",
      );
    }
  });

  test("rejects ACP, background execution, and custom dynamic routes", () => {
    const backgroundRoutes = [
      ["POST", "acp/spawn", "acp_requires_dedicated_runtime"],
      ["POST", "acp/session-1/steer", "acp_requires_dedicated_runtime"],
      [
        "GET",
        "subagents/reconcile",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "subagents/subagent-1/abort",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "workflows/runs/run-1/resume",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "background-tools/cancel",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "schedules/schedule-1/run",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "tasks/run",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "tasks/queue/run",
        "background_execution_requires_dedicated_runtime",
      ],
      [
        "POST",
        "work-items/work-1/run",
        "background_execution_requires_dedicated_runtime",
      ],
    ];
    for (const [method, suffix, reason] of backgroundRoutes) {
      expect(rejection(method!, suffix!)).toBe(
        reason as RuntimeWorkerProxyRouteRejectionReason,
      );
    }
    expect(rejection("POST", "x/custom-route")).toBe(
      "dynamic_runtime_route_unsupported",
    );
  });

  test("rejects unreviewed inference, maintenance, rendering, and interactive routes", () => {
    for (const [method, suffix] of [
      ["POST", "btw"],
      ["POST", "conversations/conversation-1/analyze"],
      ["POST", "conversations/conversation-1/regenerate"],
      ["POST", "conversations/conversation-1/playground/compact"],
      ["GET", "documents/document-1/pdf"],
      ["POST", "memory/v2/backfill"],
      ["POST", "memory/v3/rebuild-index"],
      ["GET", "search/global"],
      ["POST", "settings/avatar/generate"],
      ["POST", "ui/request"],
    ] as const) {
      expect(rejection(method, suffix)).toBe(
        "dynamic_runtime_route_unsupported",
      );
    }
  });

  test("never exposes pooled worker state or lease routes to a user proxy", () => {
    for (const suffix of [
      "internal/pooled-worker/state/export",
      "internal/pooled-worker/state/restore",
      "internal/pooled-worker/state/prepare-empty",
      "internal/pooled-worker/state/sanitize",
      "internal/pooled-worker/lease/revoke",
    ]) {
      expect(rejection("POST", suffix)).toBe(
        "internal_runtime_route_forbidden",
      );
    }
  });
});
