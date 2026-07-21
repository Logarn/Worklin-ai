/**
 * Tests for identity/health route handlers, focusing on profiler metadata
 * in /v1/health and /v1/healthz responses.
 *
 * Proves:
 * - Backward compatibility: health endpoints return expected shape when
 *   profiler mode is off (no env vars).
 * - Profiler payload: when profiler env vars are set, the response includes
 *   a `profiler` object with the expected structure and budget state.
 * - Artifact detection: when run manifests and Bun summary files exist,
 *   the response correctly reports artifact counts and lastCompletedRun.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Silence logger before any imports that use it
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const checkpointStore = new Map<string, string>();

mock.module("../memory/checkpoints.js", () => ({
  deleteMemoryCheckpoint: (key: string) => {
    checkpointStore.delete(key);
  },
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
  },
}));

const getConfiguredProviderCalls: string[] = [];
const mockProvider = { name: "mock-provider" };

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mock(async (callSite: string) => {
    getConfiguredProviderCalls.push(callSite);
    return mockProvider;
  }),
}));

type SidechainCall = {
  callSite?: string;
  content: string;
  maxTokens?: number;
  systemPrompt?: string;
  tools: unknown[];
};

type SidechainResult = {
  text: string;
  hadTextDeltas: false;
  response: { content: [] };
};

const sidechainCalls: SidechainCall[] = [];
let sidechainText = "";
let sidechainResultPromise: Promise<SidechainResult> | null = null;

const identityChangedEvents: Array<{
  fields: {
    name: string;
    role: string;
    personality: string;
    emoji: string;
    home: string;
  };
  originClientId?: string;
}> = [];
let identityPublishError: Error | null = null;
const platformIdentityNames: string[] = [];

mock.module("../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: mock(async (params: SidechainCall) => {
    sidechainCalls.push(params);
    if (sidechainResultPromise) {
      return sidechainResultPromise;
    }
    return {
      text: sidechainText,
      hadTextDeltas: false,
      response: { content: [] },
    };
  }),
}));

mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishIdentityChanged: (
    fields: (typeof identityChangedEvents)[number]["fields"],
    originClientId?: string,
  ) => {
    if (identityPublishError) throw identityPublishError;
    identityChangedEvents.push({ fields, originClientId });
  },
}));

mock.module("../platform/sync-identity.js", () => ({
  syncIdentityNameToPlatform: (name: string) => {
    platformIdentityNames.push(name);
  },
}));

import {
  markDaemonNotReady,
  markDaemonReady,
} from "../runtime/daemon-readiness.js";
import { ConflictError } from "../runtime/routes/errors.js";
import {
  handleDetailedHealth,
  handleReadyz,
  ROUTES,
  writeIdentityAtomicallyIfUnchanged,
} from "../runtime/routes/identity-routes.js";
import { ROUTES as WORKSPACE_ROUTES } from "../runtime/routes/workspace-routes.js";
import { setCesClient } from "../security/secure-keys.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  getHatchedSidecarPath,
  resolveHatchedAtReadOnly,
  selectHatchedAtFromStats,
} from "../workspace/hatched-date.js";
import { _setIdentityFileBeforeCommitHookForTests } from "../workspace/identity-file-write.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

// ── Env helpers ─────────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;

const PROFILER_ENV_KEYS = [
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "WORKLIN_RUNTIME_MODE",
] as const;

function clearProfilerEnv(): void {
  for (const key of PROFILER_ENV_KEYS) {
    delete process.env[key];
  }
}

function setProfilerEnv(
  mode: string,
  runId: string,
  opts?: { maxBytes?: number; maxRuns?: number; minFreeMb?: number },
): void {
  process.env.VELLUM_PROFILER_RUN_ID = runId;
  process.env.VELLUM_PROFILER_MODE = mode;
  if (opts?.maxBytes !== undefined) {
    process.env.VELLUM_PROFILER_MAX_BYTES = String(opts.maxBytes);
  }
  if (opts?.maxRuns !== undefined) {
    process.env.VELLUM_PROFILER_MAX_RUNS = String(opts.maxRuns);
  }
  if (opts?.minFreeMb !== undefined) {
    process.env.VELLUM_PROFILER_MIN_FREE_MB = String(opts.minFreeMb);
  }
}

// ── Filesystem helpers ──────────────────────────────────────────────────

function ensureProfilerRunDir(runId: string): string {
  const wsDir = getWorkspaceDir();
  const runDir = join(wsDir, "data", "profiler", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeRunManifest(
  runId: string,
  manifest: {
    status: "active" | "completed";
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    totalBytes?: number;
  },
): void {
  const runDir = ensureProfilerRunDir(runId);
  const m: Record<string, unknown> = {
    runId,
    status: manifest.status,
    createdAt: manifest.createdAt ?? new Date().toISOString(),
    updatedAt: manifest.updatedAt ?? new Date().toISOString(),
    totalBytes: manifest.totalBytes ?? 0,
  };
  if (manifest.completedAt) {
    m.completedAt = manifest.completedAt;
  }
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(m, null, 2));
}

function writeArtifactFile(
  runId: string,
  filename: string,
  sizeBytes: number,
): void {
  const runDir = ensureProfilerRunDir(runId);
  writeFileSync(join(runDir, filename), Buffer.alloc(sizeBytes));
}

// ── Setup / teardown ────────────────────────────────────────────────────

beforeEach(() => {
  savedEnv = {};
  for (const key of PROFILER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearProfilerEnv();

  // Clean up any profiler run directories from previous tests so
  // rescanRuns() doesn't pick up stale state in the shared workspace.
  const profilerRunsDir = join(getWorkspaceDir(), "data", "profiler", "runs");
  if (existsSync(profilerRunsDir)) {
    rmSync(profilerRunsDir, { recursive: true, force: true });
  }

  rmSync(getHatchedSidecarPath(), { force: true });
  rmSync(join(getWorkspaceDir(), "IDENTITY.md"), { force: true });
  rmSync(join(getWorkspaceDir(), "SOUL.md"), { force: true });
  checkpointStore.clear();
  getConfiguredProviderCalls.length = 0;
  sidechainCalls.length = 0;
  sidechainText = "";
  sidechainResultPromise = null;
  identityChangedEvents.length = 0;
  identityPublishError = null;
  platformIdentityNames.length = 0;
  _setIdentityFileBeforeCommitHookForTests(null);
});

afterEach(() => {
  _setIdentityFileBeforeCommitHookForTests(null);
  markDaemonNotReady("daemon_starting");
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("identity routes — health endpoint", () => {
  describe("backward compatibility (profiler disabled)", () => {
    test("/v1/health returns expected shape without profiler key when env vars are absent", async () => {
      const res = handleDetailedHealth();
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBeDefined();
      expect(body.version).toBeDefined();
      expect(body.disk).toBeDefined();
      expect(body.memory).toBeDefined();
      expect(body.cpu).toBeDefined();
      expect(body.migrations).toBeDefined();
      expect(body.capabilities).toEqual({ memoryOptOut: true });

      // Profiler should either be absent or show enabled: false
      if ("profiler" in body) {
        const profiler = body.profiler as Record<string, unknown>;
        expect(profiler.enabled).toBe(false);
        expect(profiler.mode).toBeNull();
        expect(profiler.runId).toBeNull();
        expect(profiler.budget).toBeNull();
      }
    });

    test("/v1/healthz returns the same shape as /v1/health", async () => {
      // Both endpoints call handleDetailedHealth, so the shape must match
      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.status).toBe("healthy");
      expect(body.timestamp).toBeDefined();
      expect(body.migrations).toBeDefined();
    });

    test("includes ces.connected=false when no CES client is registered", async () => {
      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.ces).toBeDefined();
      expect((body.ces as Record<string, unknown>).connected).toBe(false);
    });
  });

  describe("CES readiness", () => {
    beforeEach(() => {
      setCesClient(undefined);
      markDaemonReady();
    });

    test("readyz returns 200 and logs warning when CES is unavailable", () => {
      const res = handleReadyz();
      expect(res.status).toBe(200);
    });

    test("readyz returns 200 when CES is connected and ready", () => {
      const mockClient = {
        isReady: () => true,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      const res = handleReadyz();
      expect(res.status).toBe(200);
    });

    test("readyz returns 200 when CES client exists but is not ready", () => {
      const mockClient = {
        isReady: () => false,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      const res = handleReadyz();
      expect(res.status).toBe(200);
    });

    test("isolated runtime readyz returns 503 while CES is unavailable", async () => {
      process.env.WORKLIN_RUNTIME_MODE = "isolated";

      const res = handleReadyz();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "starting",
        reason: "ces_unavailable",
      });
    });

    test("isolated runtime readyz remains unavailable until daemon startup completes", async () => {
      process.env.WORKLIN_RUNTIME_MODE = "isolated";
      const mockClient = {
        isReady: () => true,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      markDaemonNotReady("daemon_starting");

      const res = handleReadyz();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "starting",
        reason: "daemon_starting",
      });
    });

    test("isolated runtime readyz returns 503 until CES is connected", async () => {
      process.env.WORKLIN_RUNTIME_MODE = "isolated";
      const mockClient = {
        isReady: () => false,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);

      const res = handleReadyz();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "starting",
        reason: "ces_not_ready",
      });
    });

    test("isolated runtime readyz returns 200 after CES connects", () => {
      process.env.WORKLIN_RUNTIME_MODE = "isolated";
      const mockClient = {
        isReady: () => true,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);

      const res = handleReadyz();
      expect(res.status).toBe(200);
    });

    test("pooled worker readyz remains unavailable until daemon startup completes", async () => {
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      const mockClient = {
        isReady: () => true,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      markDaemonNotReady("daemon_starting");

      const res = handleReadyz();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "starting",
        reason: "daemon_starting",
      });
    });

    test("pooled worker readyz does not require intentionally disabled CES", async () => {
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      setCesClient(undefined);

      const res = handleReadyz();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok" });
    });

    test("pooled worker readyz ignores a dormant CES client after daemon startup", () => {
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      const mockClient = {
        isReady: () => false,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);

      const res = handleReadyz();
      expect(res.status).toBe(200);
    });
    test("/v1/health reports ces.connected=true when CES is ready", async () => {
      const mockClient = {
        isReady: () => true,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.ces).toBeDefined();
      expect((body.ces as Record<string, unknown>).connected).toBe(true);
    });

    test("/v1/health reports ces.connected=false when CES is not ready", async () => {
      const mockClient = {
        isReady: () => false,
        close: () => {},
      } as unknown as import("../credential-execution/client.js").CesClient;
      setCesClient(mockClient);
      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.ces).toBeDefined();
      expect((body.ces as Record<string, unknown>).connected).toBe(false);
    });
  });

  describe("profiler payload (profiler enabled)", () => {
    test("returns profiler object with enabled=true when env vars are set", async () => {
      setProfilerEnv("cpu", "run-health-test-1", {
        maxBytes: 10_000_000,
        minFreeMb: 10,
      });
      ensureProfilerRunDir("run-health-test-1");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.profiler).toBeDefined();
      const profiler = body.profiler as Record<string, unknown>;
      expect(profiler.enabled).toBe(true);
      expect(profiler.mode).toBe("cpu");
      expect(profiler.runId).toBe("run-health-test-1");
      expect(profiler.runDir).toContain("run-health-test-1");
      expect(typeof profiler.totalBytes).toBe("number");
      expect(typeof profiler.artifactCount).toBe("number");
    });

    test("includes budget block with expected fields", async () => {
      setProfilerEnv("heap", "run-budget-test", {
        maxBytes: 50_000_000,
        minFreeMb: 100,
      });
      ensureProfilerRunDir("run-budget-test");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const budget = profiler.budget as Record<string, unknown>;

      expect(budget).toBeDefined();
      expect(budget.maxBytes).toBe(50_000_000);
      expect(typeof budget.remainingBytes).toBe("number");
      expect(budget.minFreeMb).toBe(100);
      expect(typeof budget.freeMb).toBe("number");
      expect(typeof budget.overBudget).toBe("boolean");
    });

    test("reports artifact count from .cpuprofile files", async () => {
      setProfilerEnv("cpu", "run-artifact-count", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      writeArtifactFile("run-artifact-count", "profile-1.cpuprofile", 1024);
      writeArtifactFile("run-artifact-count", "profile-2.cpuprofile", 2048);
      // Non-artifact file should not count
      writeArtifactFile("run-artifact-count", "log.txt", 512);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;

      expect(profiler.artifactCount).toBe(2);
    });

    test("detects over-budget state when total bytes exceed maxBytes", async () => {
      setProfilerEnv("cpu+heap", "run-over-budget", {
        maxBytes: 100, // Very small budget
        minFreeMb: 0,
      });
      // Write a file larger than the budget
      writeArtifactFile("run-over-budget", "big.cpuprofile", 5000);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const budget = profiler.budget as Record<string, unknown>;

      expect(budget.overBudget).toBe(true);
      expect(budget.remainingBytes).toBe(0);
    });
  });

  describe("lastCompletedRun", () => {
    test("returns null when no completed runs exist", async () => {
      setProfilerEnv("cpu", "run-no-completed", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("run-no-completed");

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;

      expect(profiler.lastCompletedRun).toBeNull();
    });

    test("returns completed run summary with artifact count and hasSummaries", async () => {
      setProfilerEnv("cpu", "active-run-xyz", {
        maxBytes: 100_000_000,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("active-run-xyz");

      // Create a completed run with artifacts and a summary file
      const completedId = "completed-run-abc";
      const expectedCompletedAt = "2025-06-01T00:30:00Z";
      writeRunManifest(completedId, {
        status: "completed",
        createdAt: "2025-06-01T00:00:00Z",
        updatedAt: "2025-06-01T01:00:00Z",
        completedAt: expectedCompletedAt,
        totalBytes: 4096,
      });
      writeArtifactFile(completedId, "profile.cpuprofile", 3072);
      writeArtifactFile(completedId, "summary.md", 256);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const last = profiler.lastCompletedRun as Record<string, unknown>;

      expect(last).toBeDefined();
      expect(last.runId).toBe(completedId);
      expect(last.artifactCount).toBe(1); // Only .cpuprofile counts
      expect(last.hasSummaries).toBe(true);
      expect(typeof last.totalBytes).toBe("number");
      // completedAt should reflect the manifest's completedAt value,
      // not the current time or updatedAt.
      expect(last.completedAt).toBe(expectedCompletedAt);
    });

    test("selects the most recent completed run when multiple exist", async () => {
      setProfilerEnv("heap", "active-multi", {
        maxBytes: 100_000_000,
        maxRuns: 100,
        minFreeMb: 0,
      });
      ensureProfilerRunDir("active-multi");

      writeRunManifest("older-completed", {
        status: "completed",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T01:00:00Z",
      });
      writeArtifactFile("older-completed", "old.heapsnapshot", 512);

      writeRunManifest("newer-completed", {
        status: "completed",
        createdAt: "2025-06-15T00:00:00Z",
        updatedAt: "2025-06-15T01:00:00Z",
      });
      writeArtifactFile("newer-completed", "new.heapsnapshot", 1024);

      const res = handleDetailedHealth();
      const body = (await res.json()) as Record<string, unknown>;
      const profiler = body.profiler as Record<string, unknown>;
      const last = profiler.lastCompletedRun as Record<string, unknown>;

      expect(last).toBeDefined();
      expect(last.runId).toBe("newer-completed");
    });
  });
});

describe("identity routes — createdAt selection", () => {
  test("falls back to mtime when birthtime is the Unix epoch", () => {
    const mtime = new Date("2026-05-01T14:49:47.519Z");

    expect(
      selectHatchedAtFromStats({
        birthtime: new Date(0),
        mtime,
      })?.toISOString(),
    ).toBe(mtime.toISOString());
  });

  test("prefers birthtime when it is valid", () => {
    const birthtime = new Date("2026-04-30T12:00:00.000Z");
    const mtime = new Date("2026-05-01T14:49:47.519Z");

    expect(
      selectHatchedAtFromStats({
        birthtime,
        mtime,
      })?.toISOString(),
    ).toBe(birthtime.toISOString());
  });

  test("returns undefined when both birthtime and mtime are the Unix epoch", () => {
    expect(
      selectHatchedAtFromStats({
        birthtime: new Date(0),
        mtime: new Date(0),
      }),
    ).toBeUndefined();
  });

  test("read-only resolver falls back to current time without writing sidecar", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");

    expect(
      resolveHatchedAtReadOnly(
        join(getWorkspaceDir(), "missing-identity.md"),
        now,
      ),
    ).toBe(now.toISOString());
    expect(existsSync(getHatchedSidecarPath())).toBe(false);
  });

  test("/identity uses persisted hatched sidecar instead of live file metadata", () => {
    const workspaceDir = getWorkspaceDir();
    const dataDir = join(workspaceDir, "data");
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const persistedHatchedAt = "2026-05-01T14:49:47.519Z";

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      identityPath,
      "# Identity\n\n- **Name:** Example Assistant\n",
      "utf-8",
    );
    writeFileSync(
      getHatchedSidecarPath(),
      JSON.stringify({ hatchedAt: persistedHatchedAt }),
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(route).toBeDefined();

    const body = route!.handler({}) as { createdAt?: string };
    expect(body.createdAt).toBe(persistedHatchedAt);
  });

  test("/identity does not write hatched sidecar on read", () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    writeFileSync(
      identityPath,
      "# Identity\n\n- **Name:** Example Assistant\n",
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(route).toBeDefined();

    const body = route!.handler({}) as { createdAt?: string };
    expect(Date.parse(body.createdAt ?? "")).toBeGreaterThan(0);
    expect(existsSync(getHatchedSidecarPath())).toBe(false);
  });
});

describe("identity routes — persisted metadata", () => {
  test("/identity reads role and personality from IDENTITY.md, not SOUL.md", () => {
    const workspaceDir = getWorkspaceDir();
    writeFileSync(
      join(workspaceDir, "IDENTITY.md"),
      [
        "# Identity",
        "",
        "- **Name:** Example Assistant",
        "- **Role:** _(not yet established)_",
        "- **Personality:** _(not yet established)_",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(workspaceDir, "SOUL.md"),
      [
        "# Soul",
        "",
        "- **Role:** This line is behavioral context, not identity metadata.",
        "- **Personality:** This line is also not identity metadata.",
      ].join("\n"),
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(route).toBeDefined();

    const body = route!.handler({}) as {
      role: string;
      personality: string;
    };
    expect(body.role).toBe("");
    expect(body.personality).toBe("");
  });

  test("PATCH /identity persists canonical name, role, and personality", async () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    const soulPath = join(getWorkspaceDir(), "SOUL.md");
    const soul = "# Soul\n\nKeep the assistant warm and direct.\n";
    writeFileSync(
      identityPath,
      [
        "# Identity",
        "",
        "- **Name:** Example Assistant",
        "- **Emoji:** :sparkles:",
        "- **Personality:** _(not yet established)_",
        "- **Role:** _(not yet established)_",
        "",
        "## Avatar",
        "Keep this section.",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(soulPath, soul, "utf-8");
    checkpointStore.set("identity:intro:greetings", '["Old greeting"]');
    checkpointStore.set("identity:intro:cached_at", String(Date.now()));

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(route).toBeDefined();

    const response = await route!.handler({
      body: {
        name: "North Star",
        role: "Lifecycle marketing partner",
        personality: "Clear, curious, and candid",
      },
      headers: { "x-vellum-client-id": "client-123" },
    });

    expect(response).toMatchObject({
      name: "North Star",
      role: "Lifecycle marketing partner",
      personality: "Clear, curious, and candid",
      emoji: ":sparkles:",
    });
    expect(readFileSync(soulPath, "utf-8")).toBe(soul);
    expect(readFileSync(identityPath, "utf-8")).toContain(
      "## Avatar\nKeep this section.",
    );

    const readRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity",
    );
    expect(readRoute!.handler({})).toMatchObject({
      name: "North Star",
      role: "Lifecycle marketing partner",
      personality: "Clear, curious, and candid",
    });
    expect(identityChangedEvents).toEqual([
      {
        fields: {
          name: "North Star",
          role: "Lifecycle marketing partner",
          personality: "Clear, curious, and candid",
          emoji: ":sparkles:",
          home: "",
        },
        originClientId: "client-123",
      },
    ]);
    expect(platformIdentityNames).toEqual(["North Star"]);
    expect(checkpointStore.get("identity:intro:greetings")).toBeUndefined();
    expect(checkpointStore.get("identity:intro:cached_at")).toBeUndefined();
  });

  test("PATCH /identity preserves fields omitted from a partial update", async () => {
    writeFileSync(
      join(getWorkspaceDir(), "IDENTITY.md"),
      [
        "# Identity",
        "",
        "- **Name:** Example Assistant",
        "- **Personality:** Thoughtful and concise",
        "- **Role:** Research partner",
      ].join("\n"),
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(route).toBeDefined();

    const response = await route!.handler({
      body: { role: "Product strategy partner" },
    });

    expect(response).toMatchObject({
      name: "Example Assistant",
      role: "Product strategy partner",
      personality: "Thoughtful and concise",
    });
    expect(platformIdentityNames).toEqual([]);
  });

  test("PATCH /identity rejects empty and whitespace-only updates", async () => {
    writeFileSync(
      join(getWorkspaceDir(), "IDENTITY.md"),
      "# Identity\n\n- **Name:** Example Assistant\n",
      "utf-8",
    );

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(route).toBeDefined();

    await expect(route!.handler({ body: {} })).rejects.toThrow();
    await expect(route!.handler({ body: { role: "   " } })).rejects.toThrow();
    expect(identityChangedEvents).toEqual([]);
    expect(platformIdentityNames).toEqual([]);
  });

  test("atomic identity write rejects a competing file update", async () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    const original = "# Identity\n\n- **Name:** Original\n";
    const competing = "# Identity\n\n- **Name:** External edit\n";
    const requested = "# Identity\n\n- **Name:** Requested edit\n";
    writeFileSync(identityPath, competing, "utf-8");

    await expect(
      writeIdentityAtomicallyIfUnchanged(identityPath, original, requested),
    ).rejects.toThrow(ConflictError);
    expect(readFileSync(identityPath, "utf-8")).toBe(competing);
  });

  test("serializes a competing workspace writer across compare and commit", async () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    const original = [
      "# Identity",
      "",
      "- **Name:** Example Assistant",
      "- **Role:** Original role",
    ].join("\n");
    const competing = [
      "# Identity",
      "",
      "- **Name:** Competing writer",
      "- **Role:** Competing role",
    ].join("\n");
    writeFileSync(identityPath, original, "utf-8");

    const compared = createDeferred<void>();
    const resumeCommit = createDeferred<void>();
    let paused = false;
    _setIdentityFileBeforeCommitHookForTests(async () => {
      if (paused) return;
      paused = true;
      compared.resolve();
      await resumeCommit.promise;
    });

    const updateRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    const workspaceWriteRoute = WORKSPACE_ROUTES.find(
      (candidate) => candidate.operationId === "workspace_write",
    );
    expect(updateRoute).toBeDefined();
    expect(workspaceWriteRoute).toBeDefined();

    const updatePromise = Promise.resolve(
      updateRoute!.handler({ body: { role: "Saved role" } }),
    );
    await compared.promise;

    const competingWritePromise = Promise.resolve(
      workspaceWriteRoute!.handler({
        body: { path: "IDENTITY.md", content: competing },
      }),
    );
    const competingWriteResult = competingWritePromise.catch(
      (error: unknown) => error,
    );
    await Promise.resolve();
    resumeCommit.resolve();

    await expect(updatePromise).resolves.toMatchObject({ role: "Saved role" });
    expect(await competingWriteResult).toBeInstanceOf(ConflictError);
    expect(readFileSync(identityPath, "utf-8")).toContain(
      "- **Role:** Saved role",
    );
    expect(readFileSync(identityPath, "utf-8")).not.toContain(
      "Competing writer",
    );
  });

  test("PATCH /identity reports success after commit when notification fails", async () => {
    const identityPath = join(getWorkspaceDir(), "IDENTITY.md");
    writeFileSync(
      identityPath,
      [
        "# Identity",
        "",
        "- **Name:** Example Assistant",
        "- **Role:** Research partner",
      ].join("\n"),
      "utf-8",
    );
    identityPublishError = new Error("subscriber unavailable");

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(route).toBeDefined();

    await expect(
      route!.handler({ body: { role: "Product strategy partner" } }),
    ).resolves.toMatchObject({
      name: "Example Assistant",
      role: "Product strategy partner",
    });
    expect(readFileSync(identityPath, "utf-8")).toContain(
      "- **Role:** Product strategy partner",
    );
  });
});

describe("identity routes — intro greetings", () => {
  test("discards an old generation result after identity is updated", async () => {
    const workspaceDir = getWorkspaceDir();
    writeFileSync(
      join(workspaceDir, "IDENTITY.md"),
      [
        "# Identity",
        "",
        "- **Name:** Original Assistant",
        "- **Personality:** Crisp and practical",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(workspaceDir, "SOUL.md"),
      "# Soul\n\nKeep greetings useful.\n",
      "utf-8",
    );
    const deferredSidechain = createDeferred<SidechainResult>();
    sidechainResultPromise = deferredSidechain.promise;

    const introRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_intro",
    );
    const updateRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(introRoute).toBeDefined();
    expect(updateRoute).toBeDefined();

    expect(introRoute!.handler({})).toMatchObject({
      source: "fallback",
      refreshing: true,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(sidechainCalls).toHaveLength(1);

    await expect(
      updateRoute!.handler({ body: { name: "Updated Assistant" } }),
    ).resolves.toMatchObject({ name: "Updated Assistant" });

    deferredSidechain.resolve({
      text: JSON.stringify([
        "Old identity greeting one.",
        "Old identity greeting two.",
        "Old identity greeting three.",
        "Old identity greeting four.",
        "Old identity greeting five.",
      ]),
      hadTextDeltas: false,
      response: { content: [] },
    });
    await deferredSidechain.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checkpointStore.get("identity:intro:greetings")).toBeUndefined();
    expect(checkpointStore.get("identity:intro:cached_at")).toBeUndefined();
  });

  test("discards an old generation result after a non-PATCH workspace write", async () => {
    const workspaceDir = getWorkspaceDir();
    const identityPath = join(workspaceDir, "IDENTITY.md");
    writeFileSync(
      identityPath,
      "# Identity\n\n- **Name:** Original Assistant\n",
      "utf-8",
    );
    const deferredSidechain = createDeferred<SidechainResult>();
    sidechainResultPromise = deferredSidechain.promise;

    const introRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_intro",
    );
    const workspaceWriteRoute = WORKSPACE_ROUTES.find(
      (candidate) => candidate.operationId === "workspace_write",
    );
    expect(introRoute).toBeDefined();
    expect(workspaceWriteRoute).toBeDefined();

    expect(introRoute!.handler({})).toMatchObject({
      source: "fallback",
      refreshing: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sidechainCalls).toHaveLength(1);

    await workspaceWriteRoute!.handler({
      body: {
        path: "IDENTITY.md",
        content: "# Identity\n\n- **Name:** Workspace Writer\n",
      },
    });

    deferredSidechain.resolve({
      text: JSON.stringify([
        "Old greeting one.",
        "Old greeting two.",
        "Old greeting three.",
        "Old greeting four.",
        "Old greeting five.",
      ]),
      hadTextDeltas: false,
      response: { content: [] },
    });
    await deferredSidechain.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readFileSync(identityPath, "utf-8")).toContain("Workspace Writer");
    expect(checkpointStore.get("identity:intro:greetings")).toBeUndefined();
    expect(checkpointStore.get("identity:intro:cached_at")).toBeUndefined();
    expect(
      checkpointStore.get("identity:intro:identity_epoch"),
    ).toBeUndefined();
  });

  test("does not let an old generation failure delay greetings after identity is updated", async () => {
    const workspaceDir = getWorkspaceDir();
    writeFileSync(
      join(workspaceDir, "IDENTITY.md"),
      [
        "# Identity",
        "",
        "- **Name:** Original Assistant",
        "- **Personality:** Crisp and practical",
      ].join("\n"),
      "utf-8",
    );
    const deferredSidechain = createDeferred<SidechainResult>();
    sidechainResultPromise = deferredSidechain.promise;

    const introRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_intro",
    );
    const updateRoute = ROUTES.find(
      (candidate) => candidate.operationId === "identity_update",
    );
    expect(introRoute).toBeDefined();
    expect(updateRoute).toBeDefined();

    expect(introRoute!.handler({})).toMatchObject({ refreshing: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(sidechainCalls).toHaveLength(1);

    await updateRoute!.handler({ body: { name: "Updated Assistant" } });
    deferredSidechain.reject(new Error("obsolete provider failure"));
    await deferredSidechain.promise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    sidechainResultPromise = null;
    sidechainText = JSON.stringify([
      "Fresh greeting one.",
      "Fresh greeting two.",
      "Fresh greeting three.",
      "Fresh greeting four.",
      "Fresh greeting five.",
    ]);

    expect(introRoute!.handler({})).toMatchObject({ refreshing: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(sidechainCalls).toHaveLength(2);
  });

  test("returns fallback immediately, generates personalized greetings in the background, then reuses the cache", async () => {
    const workspaceDir = getWorkspaceDir();
    writeFileSync(
      join(workspaceDir, "IDENTITY.md"),
      [
        "# Identity",
        "",
        "- **Name:** Example Assistant",
        "- **Personality:** enjoys crisp, useful hellos",
        "",
        "Identity sentinel: chartreuse compass.",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(workspaceDir, "SOUL.md"),
      [
        "# Soul",
        "",
        "Soul sentinel: copper lighthouse.",
        "",
        "Keep greetings warm and specific.",
      ].join("\n"),
      "utf-8",
    );
    const deferredSidechain = createDeferred<SidechainResult>();
    sidechainResultPromise = deferredSidechain.promise;

    const route = ROUTES.find(
      (candidate) => candidate.operationId === "identity_intro",
    );
    expect(route).toBeDefined();

    const body = route!.handler({
      queryParams: { localHour: "8", localMinute: "15" },
    }) as {
      greetings: string[];
      text: string;
      source: string;
      refreshing: boolean;
    };

    expect(body).toEqual({
      greetings: [
        "What are we working on?",
        "I'm here whenever you need me.",
        "What's on your mind?",
        "Ready when you are.",
      ],
      text: "What are we working on?",
      source: "fallback",
      refreshing: true,
    });
    expect(getConfiguredProviderCalls).toEqual([]);
    expect(sidechainCalls).toEqual([]);

    await Promise.resolve();
    await Promise.resolve();

    expect(getConfiguredProviderCalls).toEqual(["emptyStateGreeting"]);
    expect(sidechainCalls).toHaveLength(1);
    expect(sidechainCalls[0]?.callSite).toBe("emptyStateGreeting");
    expect(sidechainCalls[0]?.tools).toEqual([]);
    expect(sidechainCalls[0]?.content).toContain("Generate 5 short");
    expect(sidechainCalls[0]?.content).not.toContain("Current time of day:");
    expect(sidechainCalls[0]?.content).toContain(
      "do not mention the current time",
    );
    expect(sidechainCalls[0]?.content).toMatch(
      /Current user-local time for subtle tone only: morning \(08:15\)\.$/,
    );
    expect(sidechainCalls[0]?.content).toContain("JSON array");
    expect(sidechainCalls[0]?.systemPrompt).toContain(
      "Identity sentinel: chartreuse compass.",
    );
    expect(sidechainCalls[0]?.systemPrompt).toContain(
      "Soul sentinel: copper lighthouse.",
    );
    deferredSidechain.resolve({
      text: JSON.stringify([
        "Charting the next useful thing?",
        "I brought the compass. Where to?",
        "Ready to make this lighter.",
        "Morning momentum?",
        "Five options, one good start.",
        "A useful next step?",
      ]),
      hadTextDeltas: false,
      response: { content: [] },
    });

    await sidechainResultPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    sidechainCalls.length = 0;
    getConfiguredProviderCalls.length = 0;

    const cachedBody = (await route!.handler({})) as {
      greetings: string[];
      text: string;
      source: string;
      refreshing: boolean;
    };

    expect(cachedBody).toEqual({
      greetings: [
        "Charting the next useful thing?",
        "I brought the compass. Where to?",
        "Ready to make this lighter.",
        "Five options, one good start.",
        "A useful next step?",
      ],
      text: "Charting the next useful thing?",
      source: "cache",
      refreshing: false,
    });
    expect(getConfiguredProviderCalls).toEqual([]);
    expect(sidechainCalls).toEqual([]);
  });
});
