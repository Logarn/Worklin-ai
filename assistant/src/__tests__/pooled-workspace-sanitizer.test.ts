import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createManagedVoiceSession,
  releaseManagedVoiceSession,
  resetManagedVoiceSessionsForTesting,
} from "../live-voice/provider-session.js";
import {
  installInternalPooledVoiceLeaseAuthority,
  resetPooledVoiceLeaseFenceForTesting,
} from "../services/pooled-voice-lease-fence.js";
import {
  createNodePooledWorkspaceFileSystem,
  createPooledWorkspaceSanitizer,
  type PooledWorkspaceBinding,
  type PooledWorkspaceFileSystem,
  type PooledWorkspaceProofGuard,
  type PooledWorkspaceSanitizationProofs,
  type PooledWorkspaceTenant,
} from "../services/pooled-workspace-sanitizer.js";

const TENANT: PooledWorkspaceTenant = {
  orgId: "org-1",
  assistantId: "assistant-1",
};
const WORKER = "worker-1";
const GENERATION = 4;
const LEASE_ENV_KEYS = [
  "WORKLIN_RUNTIME_MODE",
  "WORKLIN_RUNTIME_WORKER_STACK_ID",
  "WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED",
  "WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED",
] as const;
const originalLeaseEnv = new Map(
  LEASE_ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("pooled workspace sanitizer", () => {
  let root: string;
  let workspaceRoot: string;
  let tenantWorkspace: string;
  let cesSecurity: string;
  let gatewaySecurity: string;
  let binding: PooledWorkspaceBinding;
  let proofs: PooledWorkspaceSanitizationProofs;
  let proofCallbackCalls: number;
  let readCalls: number;
  let removedPaths: string[];
  let fsyncedPaths: string[];
  let fileSystem: PooledWorkspaceFileSystem;

  beforeEach(() => {
    resetManagedVoiceSessionsForTesting();
    resetPooledVoiceLeaseFenceForTesting();
    for (const key of LEASE_ENV_KEYS) delete process.env[key];
    root = realpathSync(
      mkdtempSync(join(tmpdir(), "pooled-workspace-sanitizer-")),
    );
    workspaceRoot = join(root, "workspaces");
    tenantWorkspace = join(workspaceRoot, "tenant-current");
    cesSecurity = join(root, "ces-security");
    gatewaySecurity = join(root, "gateway-security");
    mkdirSync(tenantWorkspace, { recursive: true });
    mkdirSync(cesSecurity);
    mkdirSync(gatewaySecurity);
    writeFileSync(join(cesSecurity, "credential"), "never-delete");
    writeFileSync(join(gatewaySecurity, "signing-key"), "never-delete");

    binding = {
      tenant: TENANT,
      workerStackId: WORKER,
      workspaceRoot,
      tenantWorkspacePath: tenantWorkspace,
    };
    proofs = {
      tenant: TENANT,
      workerStackId: WORKER,
      generation: GENERATION,
      leaseDraining: true,
      activeTenantRequestCount: 0,
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    };
    proofCallbackCalls = 0;
    readCalls = 0;
    removedPaths = [];
    fsyncedPaths = [];
    fileSystem = tempRestrictedFileSystem(root, {
      onRead: () => {
        readCalls += 1;
      },
      onRemove: (path) => {
        removedPaths.push(path);
      },
      onFsync: (path) => {
        fsyncedPaths.push(path);
      },
    });
  });

  afterEach(() => {
    resetManagedVoiceSessionsForTesting();
    resetPooledVoiceLeaseFenceForTesting();
    for (const [key, value] of originalLeaseEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function proofGuard(): PooledWorkspaceProofGuard {
    return {
      resolveCurrentTenantWorkspace: async () => binding,
      withExclusiveSanitizationProofs: async (_input, operation) => {
        proofCallbackCalls += 1;
        return operation(proofs);
      },
    };
  }

  function sanitizer(
    overrides: Partial<{
      proofGuard: PooledWorkspaceProofGuard;
      fileSystem: PooledWorkspaceFileSystem;
      cesSecurityPaths: readonly string[];
      gatewaySecurityPaths: readonly string[];
    }> = {},
  ) {
    return createPooledWorkspaceSanitizer({
      proofGuard: overrides.proofGuard ?? proofGuard(),
      fileSystem: overrides.fileSystem ?? fileSystem,
      cesSecurityPaths: overrides.cesSecurityPaths ?? [cesSecurity],
      gatewaySecurityPaths: overrides.gatewaySecurityPaths ?? [gatewaySecurity],
    });
  }

  test("deletes only tenant workspace contents, fsyncs, and returns the production receipt shape", async () => {
    mkdirSync(join(tenantWorkspace, "nested", "deeper"), {
      recursive: true,
    });
    writeFileSync(join(tenantWorkspace, "root.txt"), "tenant");
    writeFileSync(
      join(tenantWorkspace, "nested", "deeper", "state.json"),
      "{}",
    );

    const receipt = await sanitizer().sanitize({
      tenant: TENANT,
      workerStackId: WORKER,
      generation: GENERATION,
    });

    expect(receipt).toEqual({
      status: "sanitized",
      workerStackId: WORKER,
      generation: GENERATION,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    });
    expect(readdirSync(tenantWorkspace)).toEqual([]);
    expect(existsSync(tenantWorkspace)).toBe(true);
    expect(readFile(join(cesSecurity, "credential"))).toBe("never-delete");
    expect(readFile(join(gatewaySecurity, "signing-key"))).toBe("never-delete");
    expect(
      removedPaths.every((path) => isStrictlyWithin(tenantWorkspace, path)),
    ).toBe(true);
    expect(
      removedPaths.some(
        (path) =>
          path === cesSecurity ||
          path === gatewaySecurity ||
          path.startsWith(`${cesSecurity}/`) ||
          path.startsWith(`${gatewaySecurity}/`),
      ),
    ).toBe(false);
    expect(fsyncedPaths).toContain(tenantWorkspace);
    expect(proofCallbackCalls).toBe(1);
  });

  test("preserves a live gateway socket outside the tenant workspace", async () => {
    const runtimeIpcDir = realpathSync(mkdtempSync("/tmp/worklin-ipc-"));
    const gatewaySocket = join(runtimeIpcDir, "gateway.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(gatewaySocket, resolve);
    });

    try {
      writeFileSync(join(tenantWorkspace, "state.json"), "{}");
      const receipt = await sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      });

      expect(receipt.status).toBe("sanitized");
      expect(readdirSync(tenantWorkspace)).toEqual([]);
      expect(server.listening).toBe(true);
      expect(lstatSync(gatewaySocket).isSocket()).toBe(true);
      expect(removedPaths).not.toContain(gatewaySocket);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(runtimeIpcDir, { recursive: true, force: true });
    }
  });

  test("is idempotent while still requiring fresh exclusive proofs", async () => {
    writeFileSync(join(tenantWorkspace, "state.json"), "{}");
    const service = sanitizer();
    const first = await service.sanitize({
      tenant: TENANT,
      workerStackId: WORKER,
      generation: GENERATION,
    });
    const second = await service.sanitize({
      tenant: TENANT,
      workerStackId: WORKER,
      generation: GENERATION,
    });

    expect(first.status).toBe("sanitized");
    expect(second).toEqual({
      status: "already_sanitized",
      workerStackId: WORKER,
      generation: GENERATION,
      remainingTenantPaths: 0,
      credentialsTouched: false,
    });
    expect(proofCallbackCalls).toBe(2);
  });

  test("blocks sanitization during active voice and proceeds after the session is released", async () => {
    process.env.WORKLIN_RUNTIME_WORKER_VOICE_LEASE_FENCING_ENABLED = "true";
    installInternalPooledVoiceLeaseAuthority(() => ({
      tenant: TENANT,
      workerStackId: WORKER,
      generation: 4,
    }));
    const voice = createManagedVoiceSession({
      sessionId: "voice-session-1",
      assistantId: TENANT.assistantId,
      conversationId: "conversation-1",
      actorId: "actor-1",
      organizationId: TENANT.orgId,
      engine: "hume",
    });
    const statePath = join(tenantWorkspace, "state.json");
    writeFileSync(statePath, "{}");
    const service = sanitizer();

    await expect(
      service.sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("zero active voice sessions");
    expect(existsSync(statePath)).toBe(true);
    expect(removedPaths).toEqual([]);

    expect(releaseManagedVoiceSession(voice.binding.sessionId, "actor-1")).toBe(
      true,
    );
    await expect(
      service.sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).resolves.toMatchObject({
      status: "sanitized",
      workerStackId: WORKER,
    });
    expect(readdirSync(tenantWorkspace)).toEqual([]);
  });

  test.each([
    {
      label: "lease not draining",
      mutate: (value: Record<string, unknown>) => {
        value.leaseDraining = false;
      },
    },
    {
      label: "stale generation",
      mutate: (value: Record<string, unknown>) => {
        value.generation = GENERATION - 1;
      },
    },
    {
      label: "tenant request",
      mutate: (value: Record<string, unknown>) => {
        value.activeTenantRequestCount = 1;
      },
    },
    {
      label: "tenant process",
      mutate: (value: Record<string, unknown>) => {
        value.activeTenantProcessCount = 1;
      },
    },
    {
      label: "tenant session",
      mutate: (value: Record<string, unknown>) => {
        value.activeTenantSessionCount = 1;
      },
    },
    {
      label: "wrong worker",
      mutate: (value: Record<string, unknown>) => {
        value.workerStackId = "worker-2";
      },
    },
  ])("fails closed on $label proof", async ({ mutate }) => {
    writeFileSync(join(tenantWorkspace, "keep.txt"), "keep");
    const unsafe = { ...proofs } as unknown as Record<string, unknown>;
    mutate(unsafe);
    proofs = unsafe as unknown as PooledWorkspaceSanitizationProofs;

    await expect(
      sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("current draining lease generation");
    expect(readCalls).toBe(0);
    expect(removedPaths).toEqual([]);
    expect(existsSync(join(tenantWorkspace, "keep.txt"))).toBe(true);
  });

  test("resolves and rejects a mismatched workspace binding while holding deletion proofs", async () => {
    writeFileSync(join(tenantWorkspace, "keep.txt"), "keep");
    binding = {
      ...binding,
      tenant: { orgId: "org-2", assistantId: TENANT.assistantId },
    };

    await expect(
      sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("belongs to another tenant or worker");
    expect(proofCallbackCalls).toBe(1);
    expect(removedPaths).toEqual([]);
  });

  test("rejects a tenant workspace outside its assigned root", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    binding = { ...binding, tenantWorkspacePath: outside };

    await expect(
      sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("not a strict child");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(removedPaths).toEqual([]);
  });

  test("rejects a symlinked tenant workspace without touching its target", async () => {
    const outside = join(root, "outside");
    const link = join(workspaceRoot, "tenant-link");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, link);
    binding = { ...binding, tenantWorkspacePath: link };

    await expect(
      sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("must not be a symlink");
    expect(readFile(join(outside, "keep.txt"))).toBe("keep");
    expect(removedPaths).toEqual([]);
  });

  test("preflights the complete tree and rejects nested symlinks before any deletion", async () => {
    const outside = join(root, "outside-secret");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "keep");
    writeFileSync(join(tenantWorkspace, "ordinary.txt"), "keep");
    symlinkSync(outside, join(tenantWorkspace, "escape"));

    await expect(
      sanitizer().sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("rejects symbolic links");
    expect(readFile(join(tenantWorkspace, "ordinary.txt"))).toBe("keep");
    expect(readFile(join(outside, "secret"))).toBe("keep");
    expect(removedPaths).toEqual([]);
  });

  test("rejects any overlap with explicit CES or gateway security storage", async () => {
    writeFileSync(join(tenantWorkspace, "credential"), "keep");
    await expect(
      sanitizer({ cesSecurityPaths: [tenantWorkspace] }).sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("protected CES security");
    await expect(
      sanitizer({ gatewaySecurityPaths: [tenantWorkspace] }).sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("protected gateway security");
    expect(readFile(join(tenantWorkspace, "credential"))).toBe("keep");
    expect(removedPaths).toEqual([]);
  });

  test("stops if an entry identity changes between preflight and deletion", async () => {
    const file = join(tenantWorkspace, "state.json");
    writeFileSync(file, "{}");
    const base = fileSystem;
    let fileStatCalls = 0;
    const changingFileSystem: PooledWorkspaceFileSystem = {
      ...base,
      lstat: async (path) => {
        const stat = await base.lstat(path);
        if (path === file && ++fileStatCalls === 2) {
          return { ...stat, identity: `${stat.identity}-changed` };
        }
        return stat;
      },
    };

    await expect(
      sanitizer({ fileSystem: changingFileSystem }).sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("changed during sanitization");
    expect(existsSync(file)).toBe(true);
    expect(removedPaths).toEqual([]);
  });

  test("withholds a receipt when durable verification finds a new tenant path", async () => {
    const initial = join(tenantWorkspace, "state.json");
    const reappeared = join(tenantWorkspace, "reappeared.json");
    writeFileSync(initial, "{}");
    const base = fileSystem;
    let tenantFsyncs = 0;
    const racingFileSystem: PooledWorkspaceFileSystem = {
      ...base,
      fsyncDirectory: async (path) => {
        await base.fsyncDirectory(path);
        if (path === tenantWorkspace && ++tenantFsyncs === 1) {
          writeFileSync(reappeared, "{}");
        }
      },
    };

    await expect(
      sanitizer({ fileSystem: racingFileSystem }).sanitize({
        tenant: TENANT,
        workerStackId: WORKER,
        generation: GENERATION,
      }),
    ).rejects.toThrow("found remaining tenant paths");
    expect(existsSync(reappeared)).toBe(true);
  });
});

function tempRestrictedFileSystem(
  root: string,
  hooks: {
    onRead(path: string): void;
    onRemove(path: string): void;
    onFsync(path: string): void;
  },
): PooledWorkspaceFileSystem {
  const node = createNodePooledWorkspaceFileSystem();
  const assertTempPath = (path: string) => {
    if (path !== root && !isStrictlyWithin(root, path)) {
      throw new Error(`Test filesystem escaped its temp root: ${path}`);
    }
  };
  return {
    realpath: async (path) => {
      assertTempPath(path);
      return node.realpath(path);
    },
    lstat: async (path) => {
      assertTempPath(path);
      return node.lstat(path);
    },
    readDirectory: async (path) => {
      assertTempPath(path);
      hooks.onRead(path);
      return node.readDirectory(path);
    },
    removeFile: async (path) => {
      assertTempPath(path);
      hooks.onRemove(path);
      return node.removeFile(path);
    },
    removeDirectory: async (path) => {
      assertTempPath(path);
      hooks.onRemove(path);
      return node.removeDirectory(path);
    },
    fsyncDirectory: async (path) => {
      assertTempPath(path);
      hooks.onFsync(path);
      return node.fsyncDirectory(path);
    },
  };
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
