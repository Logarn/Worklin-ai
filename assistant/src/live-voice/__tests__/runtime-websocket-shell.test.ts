import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => {
  const config = {
    model: "test",
    provider: "test",
    platform: { baseUrl: "https://example.com" },
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200_000 },
    services: {
      stt: { provider: "deepgram" },
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": {
        mode: "your-own",
        provider: "inference-provider-native",
      },
    },
  };
  return {
    loadConfig: () => config,
    getConfig: () => config,
    invalidateConfigCache: () => {},
  };
});

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  readonly audioChunks: number[][] = [];
  readonly mimeTypes: string[] = [];
  started = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.started = true;
    this.onEvent = onEvent;
  }

  sendAudio(audio: Buffer, mimeType: string): void {
    this.audioChunks.push([...audio]);
    this.mimeTypes.push(mimeType);
    this.onEvent?.({
      type: "partial",
      text: `partial-${this.audioChunks.length}`,
    });
  }

  stop(): void {
    this.onEvent?.({ type: "closed" });
  }
}

const resolvedTranscribers: MockStreamingTranscriber[] = [];
function createResolvedTranscriber(): MockStreamingTranscriber {
  const transcriber = new MockStreamingTranscriber();
  resolvedTranscribers.push(transcriber);
  return transcriber;
}

let resolveStreamingTranscriberImpl = async () => createResolvedTranscriber();
const resolveStreamingTranscriberMock = mock(() =>
  resolveStreamingTranscriberImpl(),
);

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: resolveStreamingTranscriberMock,
}));

import { CURRENT_POLICY_EPOCH } from "../../runtime/auth/policy.js";
import { mintToken } from "../../runtime/auth/token-service.js";
import type {
  RuntimeTenantContextClaim,
  RuntimeWorkerLeaseClaim,
} from "../../runtime/auth/types.js";
import { RuntimeHttpServer } from "../../runtime/http-server.js";
import {
  getProductionPooledRuntimeDrainFence,
  installPooledRuntimeQuiescenceProbe,
  resetPooledRuntimeDrainFenceForTesting,
} from "../../runtime/pooled-runtime-drain-fence.js";
import { resetPooledVoiceLeaseFenceForTesting } from "../../services/pooled-voice-lease-fence.js";

type JsonFrame = Record<string, unknown>;

const savedAuthEnv = {
  DISABLE_HTTP_AUTH: process.env.DISABLE_HTTP_AUTH,
  WORKLIN_RUNTIME_MODE: process.env.WORKLIN_RUNTIME_MODE,
  WORKLIN_RUNTIME_WORKER_STACK_ID: process.env.WORKLIN_RUNTIME_WORKER_STACK_ID,
  WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE:
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE,
  WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED:
    process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED,
  WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED:
    process.env.WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED,
  WORKLIN_PLATFORM_ASSISTANT_ID: process.env.WORKLIN_PLATFORM_ASSISTANT_ID,
  PLATFORM_ORGANIZATION_ID: process.env.PLATFORM_ORGANIZATION_ID,
};

function mintGatewayToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function mintActorToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:user-123",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

function mintTenantActorToken(
  context: RuntimeTenantContextClaim,
  pooledWorkerLease?: RuntimeWorkerLeaseClaim,
): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${context.actor_id}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: pooledWorkerLease ? 30 : 3600,
    tenant_context: context,
    ...(pooledWorkerLease ? { pooled_worker_lease: pooledWorkerLease } : {}),
    jti: context.request_id,
  });
}

function writePooledLeaseAuthority(input: {
  authorityFile: string;
  context: RuntimeTenantContextClaim;
  generation: number;
  expiresAtSeconds: number;
}): RuntimeWorkerLeaseClaim {
  const claim: RuntimeWorkerLeaseClaim = {
    version: 1,
    issuer_service_id: "runtime_dispatcher",
    organization_id: input.context.organization_id,
    user_id: input.context.user_id,
    assistant_id: input.context.assistant_id,
    worker_stack_id: "worker-1",
    lease_generation: input.generation,
    lease_expires_at: input.expiresAtSeconds,
  };
  writeFileSync(
    input.authorityFile,
    JSON.stringify({
      version: 1,
      worker_stack_id: claim.worker_stack_id,
      authority_generation: claim.lease_generation,
      active_lease: {
        organization_id: claim.organization_id,
        user_id: claim.user_id,
        assistant_id: claim.assistant_id,
        worker_stack_id: claim.worker_stack_id,
        lease_generation: claim.lease_generation,
        lease_expires_at_ms: claim.lease_expires_at * 1000,
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(input.authorityFile, 0o600);
  return claim;
}

function tenantHeaders(
  context: RuntimeTenantContextClaim,
): Record<string, string> {
  return {
    "X-Worklin-Tenant-Context-Version": String(context.version),
    "X-Worklin-Org-Id": context.organization_id,
    "X-Worklin-User-Id": context.user_id,
    "X-Worklin-Assistant-Id": context.assistant_id,
    "X-Worklin-Actor-Id": context.actor_id,
    "X-Worklin-Request-Id": context.request_id,
  };
}

async function activatePooledRuntimeAssignment(
  context: RuntimeTenantContextClaim,
  generation: number,
): Promise<void> {
  installPooledRuntimeQuiescenceProbe({
    proveQuiescent: async () => ({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    }),
  });
  const fence = getProductionPooledRuntimeDrainFence();
  const identity = {
    tenant: {
      orgId: context.organization_id,
      assistantId: context.assistant_id,
    },
    workerStackId: "worker-1",
    generation,
  };
  fence.beginAssignmentMutation(identity);
  await fence.proveAssignmentMutationQuiescent(identity);
  fence.activateAssignment(identity);
}

function startFrame(conversationId = "conversation-123"): string {
  return JSON.stringify({
    type: "start",
    conversationId,
    audio: {
      mimeType: "audio/pcm",
      sampleRate: 24_000,
      channels: 1,
    },
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket open"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket failed to open"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket close failed"));
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

async function waitForJsonFrame(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<JsonFrame> {
  await waitForOpen(ws, timeoutMs);
  return await new Promise<JsonFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      const data = event.data;
      if (typeof data !== "string") {
        reject(new Error("Expected text WebSocket message"));
        return;
      }
      resolve(JSON.parse(data) as JsonFrame);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before message"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket errored before message"));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

function closeClient(ws: WebSocket): void {
  if (
    ws.readyState === WebSocket.CONNECTING ||
    ws.readyState === WebSocket.OPEN
  ) {
    ws.close(1000, "test shutdown");
  }
}

describe("RuntimeHttpServer live voice WebSocket shell", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  let clients: WebSocket[];
  let authorityDirectories: string[];

  beforeEach(async () => {
    delete process.env.DISABLE_HTTP_AUTH;
    delete process.env.WORKLIN_RUNTIME_MODE;
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
    delete process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE;
    delete process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED;
    delete process.env.WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED;
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
    delete process.env.PLATFORM_ORGANIZATION_ID;
    resolveStreamingTranscriberImpl = async () => createResolvedTranscriber();
    resolveStreamingTranscriberMock.mockClear();
    resolvedTranscribers.length = 0;
    resetPooledVoiceLeaseFenceForTesting();
    resetPooledRuntimeDrainFenceForTesting();
    authorityDirectories = [];
    clients = [];
    const port = 21100 + Math.floor(Math.random() * 300);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.actualPort}`;
    wsBaseUrl = `ws://127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    for (const client of clients) {
      closeClient(client);
    }
    await server.stop();
    resetPooledVoiceLeaseFenceForTesting();
    resetPooledRuntimeDrainFenceForTesting();
    for (const directory of authorityDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    if (savedAuthEnv.DISABLE_HTTP_AUTH === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = savedAuthEnv.DISABLE_HTTP_AUTH;
    }
    for (const [name, value] of Object.entries(savedAuthEnv)) {
      if (name === "DISABLE_HTTP_AUTH") continue;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function openLiveVoiceClient(token = mintGatewayToken()): WebSocket {
    const ws = new WebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(token)}`,
    );
    clients.push(ws);
    return ws;
  }

  test("rejects unauthorized upgrades before creating a WebSocket", async () => {
    const baseHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    };

    const missingToken = await fetch(`${baseUrl}/v1/live-voice`, {
      headers: baseHeaders,
    });
    expect(missingToken.status).toBe(401);

    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "assistant-isolated";
    process.env.PLATFORM_ORGANIZATION_ID = "org-isolated";
    try {
      const actorToken = await fetch(
        `${baseUrl}/v1/live-voice?token=${mintActorToken()}`,
        { headers: baseHeaders },
      );
      expect(actorToken.status).toBe(401);
    } finally {
      delete process.env.WORKLIN_RUNTIME_MODE;
      delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
      delete process.env.PLATFORM_ORGANIZATION_ID;
    }

    const externalOrigin = await fetch(
      `${baseUrl}/v1/live-voice?token=${mintGatewayToken()}`,
      {
        headers: {
          ...baseHeaders,
          Origin: "https://external.example.com",
        },
      },
    );
    expect(externalOrigin.status).toBe(403);
  });

  test("accepts an isolated actor only with matching canonical tenant headers", async () => {
    const context: RuntimeTenantContextClaim = {
      version: 1,
      organization_id: "org-isolated",
      user_id: "user-isolated",
      assistant_id: "assistant-isolated",
      actor_id: "vellum-principal-user-isolated",
      request_id: "request-isolated",
    };
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = context.assistant_id;
    process.env.PLATFORM_ORGANIZATION_ID = context.organization_id;
    const HeaderWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new HeaderWebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(
        mintTenantActorToken(context),
      )}`,
      { headers: tenantHeaders(context) },
    );
    clients.push(ws);
    await waitForOpen(ws);

    ws.send(startFrame("conversation-tenant-bound"));
    const ready = await waitForJsonFrame(ws);

    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-tenant-bound",
    });
  });

  test("fails closed before upgrade when a pooled runtime assignment is not initialized", async () => {
    const context: RuntimeTenantContextClaim = {
      version: 1,
      organization_id: "org-pooled",
      user_id: "user-pooled",
      assistant_id: "assistant-pooled",
      actor_id: "vellum-principal-user-pooled",
      request_id: "request-pooled",
    };
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "voice-authority-")),
    );
    authorityDirectories.push(directory);
    const authorityFile = join(directory, "active-lease.json");
    const pooledWorkerLease = writePooledLeaseAuthority({
      authorityFile,
      context,
      generation: 3,
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 120,
    });
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE = authorityFile;
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = context.assistant_id;
    process.env.PLATFORM_ORGANIZATION_ID = context.organization_id;
    const HeaderWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new HeaderWebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(
        mintTenantActorToken(context, pooledWorkerLease),
      )}`,
      { headers: tenantHeaders(context) },
    );
    clients.push(ws);
    await expect(waitForOpen(ws)).rejects.toThrow("WebSocket failed to open");
    expect(resolveStreamingTranscriberMock).not.toHaveBeenCalled();
  });

  test("aborts pooled native voice after a lease generation change and requires fresh authentication", async () => {
    const context: RuntimeTenantContextClaim = {
      version: 1,
      organization_id: "org-pooled",
      user_id: "user-pooled",
      assistant_id: "assistant-pooled",
      actor_id: "vellum-principal-user-pooled",
      request_id: "request-pooled",
    };
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "voice-authority-")),
    );
    authorityDirectories.push(directory);
    const authorityFile = join(directory, "active-lease.json");
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 120;
    const generationThreeClaim = writePooledLeaseAuthority({
      authorityFile,
      context,
      generation: 3,
      expiresAtSeconds,
    });
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE = authorityFile;
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = context.assistant_id;
    process.env.PLATFORM_ORGANIZATION_ID = context.organization_id;
    await activatePooledRuntimeAssignment(context, 3);
    await server.stop();
    resetPooledVoiceLeaseFenceForTesting();
    server = new RuntimeHttpServer({ port: 0, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.actualPort}`;
    wsBaseUrl = `ws://127.0.0.1:${server.actualPort}`;
    const HeaderWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new HeaderWebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(
        mintTenantActorToken(context, generationThreeClaim),
      )}`,
      { headers: tenantHeaders(context) },
    );
    clients.push(ws);
    await waitForOpen(ws);
    ws.send(startFrame("conversation-generation-3"));
    expect(await waitForJsonFrame(ws)).toMatchObject({
      type: "ready",
      conversationId: "conversation-generation-3",
    });

    writePooledLeaseAuthority({
      authorityFile,
      context,
      generation: 4,
      expiresAtSeconds,
    });
    ws.send(new Uint8Array([1, 2, 3]));
    expect(await waitForJsonFrame(ws)).toMatchObject({
      type: "error",
      message: "Live voice session is not active",
    });
    ws.close(1000, "stale generation");
    await waitForClose(ws);

    const refreshedContext = {
      ...context,
      request_id: "request-pooled-generation-4",
    };
    const generationFourClaim = writePooledLeaseAuthority({
      authorityFile,
      context: refreshedContext,
      generation: 4,
      expiresAtSeconds,
    });
    resetPooledRuntimeDrainFenceForTesting();
    await activatePooledRuntimeAssignment(refreshedContext, 4);
    const refreshed = new HeaderWebSocket(
      `${wsBaseUrl}/v1/live-voice?token=${encodeURIComponent(
        mintTenantActorToken(refreshedContext, generationFourClaim),
      )}`,
      { headers: tenantHeaders(refreshedContext) },
    );
    clients.push(refreshed);
    await waitForOpen(refreshed);
    refreshed.send(startFrame("conversation-generation-4"));
    expect(await waitForJsonFrame(refreshed)).toMatchObject({
      type: "ready",
      conversationId: "conversation-generation-4",
    });
    expect(resolveStreamingTranscriberMock).toHaveBeenCalledTimes(2);
  });

  test("routes start and audio frames through the real live voice session", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send(startFrame("conversation-ready"));
    const ready = await waitForJsonFrame(ws);

    expect(ready).toMatchObject({
      type: "ready",
      seq: 1,
      conversationId: "conversation-ready",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(resolveStreamingTranscriberMock).toHaveBeenCalledWith({
      sampleRate: 24_000,
    });
    expect(resolvedTranscribers).toHaveLength(1);
    expect(resolvedTranscribers[0]?.started).toBe(true);

    ws.send(new Uint8Array([1, 2, 3]));
    const partial = await waitForJsonFrame(ws);
    expect(partial).toMatchObject({
      type: "stt_partial",
      seq: 2,
      text: "partial-1",
    });
    expect(resolvedTranscribers[0]?.audioChunks).toEqual([[1, 2, 3]]);
    expect(resolvedTranscribers[0]?.mimeTypes).toEqual(["audio/pcm"]);
  });

  test("sends an error for malformed frames and can still start", async () => {
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send("{");
    const error = await waitForJsonFrame(ws);
    expect(error).toMatchObject({
      type: "error",
      seq: 1,
      code: "invalid_json",
    });

    ws.send(startFrame("conversation-after-error"));
    const ready = await waitForJsonFrame(ws);
    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-after-error",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(ready.seq as number).toBeGreaterThan(error.seq as number);
  });

  test("releases the session lock when the WebSocket closes", async () => {
    const first = openLiveVoiceClient();
    const second = openLiveVoiceClient();
    await Promise.all([waitForOpen(first), waitForOpen(second)]);

    first.send(startFrame("conversation-first"));
    const firstReady = await waitForJsonFrame(first);
    expect(firstReady.type).toBe("ready");

    second.send(startFrame("conversation-second"));
    const busy = await waitForJsonFrame(second);
    expect(busy).toMatchObject({
      type: "busy",
      activeSessionId: firstReady.sessionId,
    });

    first.close(1000, "client finished");
    await waitForClose(first);

    second.send(startFrame("conversation-second"));
    const secondReady = await waitForJsonFrame(second);
    expect(secondReady).toMatchObject({
      type: "ready",
      conversationId: "conversation-second",
    });
    expect(secondReady.sessionId).not.toBe(firstReady.sessionId);
  });

  test("releases the session lock after startup STT failure without WebSocket close", async () => {
    let attempts = 0;
    resolveStreamingTranscriberImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Deepgram credentials missing");
      }
      return createResolvedTranscriber();
    };
    const ws = openLiveVoiceClient();
    await waitForOpen(ws);

    ws.send(startFrame("conversation-failed"));
    const error = await waitForJsonFrame(ws);
    expect(error).toMatchObject({
      type: "error",
      code: "invalid_field",
      message: expect.stringContaining("Deepgram credentials missing"),
    });

    ws.send(startFrame("conversation-retry"));
    const ready = await waitForJsonFrame(ws);

    expect(ready).toMatchObject({
      type: "ready",
      conversationId: "conversation-retry",
    });
    expect(typeof ready.sessionId).toBe("string");
    expect(resolveStreamingTranscriberMock).toHaveBeenCalledTimes(2);
    expect(resolvedTranscribers).toHaveLength(1);
    expect(resolvedTranscribers[0]?.started).toBe(true);
  });
});
