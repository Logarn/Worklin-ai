import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  buildPlatformSandboxArgs,
  buildPlatformSandboxEnv,
  preparePlatformSandboxLaunch,
  terminateSandboxProcessTree,
} from "../tools/shared/platform-sandbox.js";

let rootDir: string;
let workspaceDir: string;
let securityDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "platform-sandbox-boundary-"));
  workspaceDir = join(rootDir, "workspace");
  securityDir = join(rootDir, "gateway-security");
  mkdirSync(workspaceDir);
  mkdirSync(securityDir);
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function successfulProbe() {
  return { available: true };
}

describe("platform sandbox filesystem boundary", () => {
  test("rejects a working-directory escape before capability probing", () => {
    let probeCalled = false;
    const result = preparePlatformSandboxLaunch(
      {
        workspaceDir,
        cwd: securityDir,
        command: "bash",
        args: ["-c", "--", "touch escaped"],
        env: {},
        networkMode: "off",
      },
      {
        platform: "linux",
        bubblewrapPath: "/usr/bin/bwrap",
        probe: () => {
          probeCalled = true;
          return successfulProbe();
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Platform sandbox working directory must be inside the tenant workspace.",
    });
    expect(probeCalled).toBe(false);
  });

  test("makes only the tenant workspace durably writable and masks security storage", () => {
    const result = preparePlatformSandboxLaunch(
      {
        workspaceDir,
        cwd: workspaceDir,
        command: "bash",
        args: ["-c", "--", "touch allowed"],
        env: { GATEWAY_SECURITY_DIR: securityDir },
        networkMode: "off",
      },
      {
        platform: "linux",
        bubblewrapPath: "/usr/bin/bwrap",
        probe: successfulProbe,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const args = result.launch.args;
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--unshare-user");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--disable-userns");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--ro-bind");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/tmp");

    const writableBinds: string[][] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--bind") {
        writableBinds.push([args[index + 1]!, args[index + 2]!]);
      }
    }
    const realWorkspace = realpathSync(workspaceDir);
    expect(writableBinds).toEqual([[realWorkspace, realWorkspace]]);

    const securityMaskIndex = args.indexOf(realpathSync(securityDir));
    const workspaceBindIndex = args.indexOf("--bind");
    expect(securityMaskIndex).toBeGreaterThan(workspaceBindIndex);
    expect(args[securityMaskIndex - 1]).toBe("--tmpfs");
  });

  test("masks every runtime-root sibling outside the tenant workspace", () => {
    const runtimeRoot = join(rootDir, "runtime");
    const tenantWorkspace = join(runtimeRoot, "workspace");
    const controlDatabase = join(runtimeRoot, "control-plane.sqlite");
    const cesData = join(runtimeRoot, "ces-data");
    mkdirSync(tenantWorkspace, { recursive: true });
    mkdirSync(cesData);
    writeFileSync(controlDatabase, "tenant registry");

    const previousRuntimeRoot = process.env.WORKLIN_RUNTIME_ROOT;
    process.env.WORKLIN_RUNTIME_ROOT = runtimeRoot;
    try {
      const result = preparePlatformSandboxLaunch(
        {
          workspaceDir: tenantWorkspace,
          cwd: tenantWorkspace,
          command: "bash",
          args: ["-c", "--", "true"],
          env: {},
          networkMode: "off",
        },
        {
          platform: "linux",
          bubblewrapPath: "/usr/bin/bwrap",
          probe: successfulProbe,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const args = result.launch.args;
      expect(args).toContain(realpathSync(controlDatabase));
      expect(args).toContain(realpathSync(cesData));
      const workspaceOccurrences = args.filter(
        (arg) => arg === realpathSync(tenantWorkspace),
      );
      expect(workspaceOccurrences).toHaveLength(3);
    } finally {
      if (previousRuntimeRoot === undefined) {
        delete process.env.WORKLIN_RUNTIME_ROOT;
      } else {
        process.env.WORKLIN_RUNTIME_ROOT = previousRuntimeRoot;
      }
    }
  });
});

describe("platform sandbox environment and network policy", () => {
  test("strips platform service secrets, internal sockets, and credential endpoints", () => {
    const key = (...parts: string[]) => parts.join("_");
    const source = {
      PATH: "/usr/bin",
      HTTP_PROXY: "http://127.0.0.1:1234",
      INTERNAL_GATEWAY_BASE_URL: "http://gateway.internal",
      GATEWAY_SECURITY_DIR: securityDir,
      CES_CREDENTIAL_URL: "http://ces.internal",
      CES_SERVICE_TOKEN: "platform-secret",
      [key("CUSTOM", "API", "KEY")]: "custom-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      SAFE_VALUE: "kept",
    };
    const env = buildPlatformSandboxEnv(source, workspaceDir);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.SAFE_VALUE).toBe("kept");
    expect(env.HOME).toBe(workspaceDir);
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.INTERNAL_GATEWAY_BASE_URL).toBeUndefined();
    expect(env.GATEWAY_SECURITY_DIR).toBeUndefined();
    expect(env.CES_CREDENTIAL_URL).toBeUndefined();
    expect(env.CES_SERVICE_TOKEN).toBeUndefined();
    expect(env[key("CUSTOM", "API", "KEY")]).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  test("keeps offline execution network-isolated and rejects proxied mode before probing", () => {
    let proxiedProbeCalled = false;
    const denied = preparePlatformSandboxLaunch(
      {
        workspaceDir,
        cwd: workspaceDir,
        command: "bash",
        args: ["-c", "--", "true"],
        env: {},
        networkMode: "off",
      },
      {
        platform: "linux",
        bubblewrapPath: "/usr/bin/bwrap",
        probe: successfulProbe,
      },
    );
    const proxied = preparePlatformSandboxLaunch(
      {
        workspaceDir,
        cwd: workspaceDir,
        command: "bash",
        args: ["-c", "--", "true"],
        env: {
          HTTP_PROXY: "http://127.0.0.1:1234",
          HTTPS_PROXY: "http://127.0.0.1:1234",
        },
        networkMode: "proxied",
      },
      {
        platform: "linux",
        bubblewrapPath: "/usr/bin/bwrap",
        probe: () => {
          proxiedProbeCalled = true;
          return successfulProbe();
        },
      },
    );

    expect(denied.ok && denied.launch.args).toContain("--unshare-net");
    expect(proxied).toEqual({
      ok: false,
      error:
        'Platform subprocess network mode "proxied" is unavailable because proxy environment variables do not provide a kernel-enforced egress boundary and would leave the host network reachable. Use Worklin\'s scoped HTTP or provider tools for authenticated external actions; platform subprocesses must run offline.',
    });
    expect(proxiedProbeCalled).toBe(false);
  });

  test("does not let direct argument construction bypass the offline policy", () => {
    expect(() =>
      buildPlatformSandboxArgs({
        workspaceDir,
        cwd: workspaceDir,
        command: "bash",
        args: ["-c", "--", "true"],
        networkMode: "proxied",
        blockedPaths: [],
      }),
    ).toThrow(
      "proxy environment variables do not provide a kernel-enforced egress boundary",
    );
  });
});

describe("platform sandbox fail-closed lifecycle", () => {
  test("returns no launch command when the bubblewrap capability probe fails", () => {
    const result = preparePlatformSandboxLaunch(
      {
        workspaceDir,
        cwd: workspaceDir,
        command: "bash",
        args: ["-c", "--", "echo must-not-run"],
        env: {},
        networkMode: "off",
      },
      {
        platform: "linux",
        bubblewrapPath: "/usr/bin/bwrap",
        probe: () => ({
          available: false,
          error: "Creating new namespace failed",
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("launch");
    expect(!result.ok && result.error).toContain(
      "bubblewrap cannot create the required",
    );
  });

  test("kills the sandbox namespace leader process group and falls back to the child", () => {
    const groupKills: Array<[number, NodeJS.Signals]> = [];
    const directKills: NodeJS.Signals[] = [];
    terminateSandboxProcessTree(
      {
        pid: 4321,
        kill: (signal) => {
          directKills.push(signal as NodeJS.Signals);
          return true;
        },
      },
      (pid, signal) => {
        groupKills.push([pid, signal as NodeJS.Signals]);
        return true;
      },
    );
    expect(groupKills).toEqual([[-4321, "SIGKILL"]]);
    expect(directKills).toEqual([]);

    terminateSandboxProcessTree(
      {
        pid: 4321,
        kill: (signal) => {
          directKills.push(signal as NodeJS.Signals);
          return true;
        },
      },
      () => {
        throw new Error("process group already exited");
      },
    );
    expect(directKills).toEqual(["SIGKILL"]);
  });
});
