import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  getConfig,
  installPooledRuntimeNeutralConfig,
  releasePooledRuntimeNeutralConfigForAssignment,
} from "./loader.js";
import { loadRuntimeDotEnv } from "./runtime-dotenv.js";

const trackedEnvNames = [
  "IS_PLATFORM",
  "STALE_TENANT_DOTENV_VALUE",
  "VELLUM_WORKSPACE_DIR",
  "WORKLIN_RUNTIME_MODE",
  "WORKLIN_RUNTIME_WORKER_STACK_ID",
] as const;
const originalEnv = new Map(
  trackedEnvNames.map((name) => [name, process.env[name]]),
);
const roots: string[] = [];

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relative = absolute.slice(root.length + 1);
      if (entry.isDirectory()) {
        snapshot.set(relative, "directory");
        visit(absolute);
      } else if (entry.isFile()) {
        snapshot.set(
          relative,
          `file:${readFileSync(absolute).toString("hex")}`,
        );
      } else {
        snapshot.set(relative, "other");
      }
    }
  };
  visit(root);
  return snapshot;
}

afterEach(() => {
  releasePooledRuntimeNeutralConfigForAssignment();
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeCrashStaleWorkspace(): {
  root: string;
  workspace: string;
  configPath: string;
  dbPath: string;
  dotenvPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "worklin-stale-startup-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const dataDir = join(workspace, "data");
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(workspace, "config.json");
  const dbPath = join(dataDir, "assistant.db");
  const dotenvPath = join(root, ".env");
  writeFileSync(
    configPath,
    JSON.stringify({
      ingress: {
        enabled: true,
        publicBaseUrl: "https://tenant-a.invalid",
      },
      logFile: { dir: join(workspace, "tenant-a-logs") },
    }),
  );
  writeFileSync(dbPath, Buffer.from("tenant-a-database-bytes"));
  writeFileSync(
    dotenvPath,
    [
      "STALE_TENANT_DOTENV_VALUE=must-not-load",
      "WORKLIN_RUNTIME_MODE=isolated",
      "WORKLIN_RUNTIME_WORKER_STACK_ID=tenant-a-stack",
    ].join("\n"),
  );
  return { root, workspace, configPath, dbPath, dotenvPath };
}

describe("pooled pre-assignment dotenv and config boundary", () => {
  test("leaves crash-stale dotenv, config, and database bytes untouched", async () => {
    const stale = makeCrashStaleWorkspace();
    process.env.IS_PLATFORM = "true";
    process.env.VELLUM_WORKSPACE_DIR = stale.workspace;
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "deployment-worker";

    const before = {
      dotenv: readFileSync(stale.dotenvPath),
      config: readFileSync(stale.configPath),
      db: readFileSync(stale.dbPath),
      tree: snapshotTree(stale.root),
    };

    loadRuntimeDotEnv();
    const config = installPooledRuntimeNeutralConfig();
    expect(getConfig()).toBe(config);
    expect(config.ingress.publicBaseUrl).not.toBe("https://tenant-a.invalid");
    expect(process.env.STALE_TENANT_DOTENV_VALUE).toBeUndefined();
    expect(process.env.WORKLIN_RUNTIME_MODE).toBe("pooled_worker");
    expect(process.env.WORKLIN_RUNTIME_WORKER_STACK_ID).toBe(
      "deployment-worker",
    );

    const { DaemonServer } = await import("../daemon/server.js");
    const server = new DaemonServer();
    await server.start();

    expect(readFileSync(stale.dotenvPath)).toEqual(before.dotenv);
    expect(readFileSync(stale.configPath)).toEqual(before.config);
    expect(readFileSync(stale.dbPath)).toEqual(before.db);
    expect(snapshotTree(stale.root)).toEqual(before.tree);
  });

  test("dedicated dotenv cannot mint deployment runtime identity", () => {
    const stale = makeCrashStaleWorkspace();
    process.env.VELLUM_WORKSPACE_DIR = stale.workspace;
    delete process.env.WORKLIN_RUNTIME_MODE;
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
    delete process.env.STALE_TENANT_DOTENV_VALUE;

    loadRuntimeDotEnv();

    expect(
      (process.env as Record<string, string | undefined>)
        .STALE_TENANT_DOTENV_VALUE,
    ).toBe("must-not-load");
    expect(process.env.WORKLIN_RUNTIME_MODE).toBeUndefined();
    expect(process.env.WORKLIN_RUNTIME_WORKER_STACK_ID).toBeUndefined();
  });
});
