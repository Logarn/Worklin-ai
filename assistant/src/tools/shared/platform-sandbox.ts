import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type PlatformSandboxNetworkMode = "off" | "proxied";

export const PLATFORM_SANDBOX_PROXIED_NETWORK_ERROR =
  'Platform subprocess network mode "proxied" is unavailable because proxy environment variables do not provide a kernel-enforced egress boundary and would leave the host network reachable. Use Worklin\'s scoped HTTP or provider tools for authenticated external actions; platform subprocesses must run offline.';

export interface PlatformSandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type PlatformSandboxPreparation =
  | { ok: true; launch: PlatformSandboxLaunch }
  | { ok: false; error: string };

interface PlatformSandboxProbeResult {
  available: boolean;
  error?: string;
}

interface PlatformSandboxDependencies {
  platform?: NodeJS.Platform;
  bubblewrapPath?: string;
  probe?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string>;
    },
  ) => PlatformSandboxProbeResult;
}

const PLATFORM_CHILD_ENV_DENYLIST = new Set([
  "ASSISTANT_IPC_SOCKET_DIR",
  "ASSISTANT_SKILL_IPC_SOCKET_DIR",
  "ALL_PROXY",
  "all_proxy",
  "BASH_ENV",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "CES_CREDENTIAL_URL",
  "CES_DATA_DIR",
  "CES_MANAGED_MODE",
  "CES_SERVICE_TOKEN",
  "CREDENTIAL_SECURITY_DIR",
  "GATEWAY_INTERNAL_URL",
  "GATEWAY_IPC_SOCKET_DIR",
  "GATEWAY_SECURITY_DIR",
  "GNUPGHOME",
  "GPG_TTY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "INTERNAL_GATEWAY_BASE_URL",
  "NO_PROXY",
  "no_proxy",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "VELLUM_BACKUP_KEY_PATH",
  "WORKLIN_CONTROL_DB",
  "WORKLIN_RUNTIME_ROOT",
]);

const PLATFORM_SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_KEY|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/;

const DEFAULT_BLOCKED_PATHS = [
  "/ces-security",
  "/gateway-security",
  "/home/assistant",
  "/home/ces",
  "/home/gateway",
  "/root",
  "/run/ces-bootstrap",
  "/run/secrets",
  "/var/run/secrets",
];

function isWithinPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function trustedBubblewrapPath(): string | null {
  for (const path of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next fixed system path.
    }
  }
  return null;
}

function runtimeSiblingPaths(
  runtimeRoot: string,
  workspaceDir: string,
): string[] {
  if (!isAbsolute(runtimeRoot) || !existsSync(runtimeRoot)) return [];
  const root = realpathSync(runtimeRoot);
  const workspace = realpathSync(workspaceDir);
  if (!isWithinPath(root, workspace)) return [root];

  const siblings: string[] = [];
  let current = root;
  while (current !== workspace) {
    const nextSegment = relative(current, workspace).split(sep)[0];
    if (!nextSegment) break;
    for (const entry of readdirSync(current)) {
      if (entry === nextSegment) continue;
      siblings.push(join(current, entry));
    }
    current = join(current, nextSegment);
  }
  return siblings;
}

function blockedHostPaths(
  env: Record<string, string>,
  workspaceDir: string,
): string[] {
  const hostEnv = process.env as Record<string, string | undefined>;
  const configured = [
    env.ASSISTANT_IPC_SOCKET_DIR,
    env.ASSISTANT_SKILL_IPC_SOCKET_DIR,
    env.CES_BOOTSTRAP_SOCKET_DIR,
    env.CES_DATA_DIR,
    env.CREDENTIAL_SECURITY_DIR,
    env.GATEWAY_IPC_SOCKET_DIR,
    env.GATEWAY_SECURITY_DIR,
    env.WORKLIN_CONTROL_DB,
    hostEnv.ASSISTANT_IPC_SOCKET_DIR,
    hostEnv.ASSISTANT_SKILL_IPC_SOCKET_DIR,
    hostEnv.CES_BOOTSTRAP_SOCKET_DIR,
    hostEnv.CES_DATA_DIR,
    hostEnv.CREDENTIAL_SECURITY_DIR,
    hostEnv.GATEWAY_IPC_SOCKET_DIR,
    hostEnv.GATEWAY_SECURITY_DIR,
    hostEnv.WORKLIN_CONTROL_DB,
  ];
  const paths = new Set(DEFAULT_BLOCKED_PATHS);
  for (const value of configured) {
    if (value && isAbsolute(value)) paths.add(resolve(value));
  }
  const runtimeRoot = hostEnv.WORKLIN_RUNTIME_ROOT ?? env.WORKLIN_RUNTIME_ROOT;
  if (runtimeRoot) {
    for (const sibling of runtimeSiblingPaths(runtimeRoot, workspaceDir)) {
      paths.add(sibling);
    }
  }
  return [...paths];
}

function maskArgsForPath(path: string): string[] {
  if (!existsSync(path)) return [];
  const realPath = realpathSync(path);
  if (statSync(realPath).isDirectory()) {
    return ["--tmpfs", realPath];
  }
  return ["--ro-bind", "/dev/null", realPath];
}

export function buildPlatformSandboxEnv(
  source: Record<string, string>,
  workspaceDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      PLATFORM_CHILD_ENV_DENYLIST.has(key) ||
      PLATFORM_SECRET_ENV_PATTERN.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  env.HOME = workspaceDir;
  env.TMPDIR = "/tmp";
  env.VELLUM_WORKSPACE_DIR = workspaceDir;
  env.VELLUM_DATA_DIR = resolve(workspaceDir, "data");
  return env;
}

export function buildPlatformSandboxArgs(options: {
  workspaceDir: string;
  cwd: string;
  command: string;
  args: readonly string[];
  networkMode: PlatformSandboxNetworkMode;
  blockedPaths: readonly string[];
}): string[] {
  if (options.networkMode === "proxied") {
    throw new Error(PLATFORM_SANDBOX_PROXIED_NETWORK_ERROR);
  }
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--disable-userns",
    "--cap-drop",
    "ALL",
  ];
  // Platform subprocesses are offline-only until Worklin has a
  // kernel-enforced egress boundary. Environment proxy variables are not an
  // isolation boundary because a process could simply bypass the proxy.
  args.push("--unshare-net");
  args.push(
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    options.workspaceDir,
    options.workspaceDir,
  );
  const maskedPaths = new Set<string>();
  for (const path of options.blockedPaths) {
    const maskArgs = maskArgsForPath(path);
    const destination = maskArgs.at(-1);
    if (!destination || maskedPaths.has(destination)) continue;
    maskedPaths.add(destination);
    args.push(...maskArgs);
  }
  args.push("--chdir", options.cwd, "--", options.command, ...options.args);
  return args;
}

function defaultProbe(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): PlatformSandboxProbeResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5_000,
    encoding: "utf8",
  });
  if (result.error) {
    return { available: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      available: false,
      error:
        result.stderr?.trim() ||
        `bubblewrap capability probe exited with status ${result.status}`,
    };
  }
  return { available: true };
}

export function preparePlatformSandboxLaunch(
  options: {
    workspaceDir: string;
    cwd: string;
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    networkMode: PlatformSandboxNetworkMode;
  },
  dependencies: PlatformSandboxDependencies = {},
): PlatformSandboxPreparation {
  if (options.networkMode === "proxied") {
    return {
      ok: false,
      error: PLATFORM_SANDBOX_PROXIED_NETWORK_ERROR,
    };
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux") {
    return {
      ok: false,
      error:
        "Platform shell execution requires Linux bubblewrap isolation; this runtime cannot provide it.",
    };
  }

  let workspaceDir: string;
  let cwd: string;
  try {
    workspaceDir = realpathSync(options.workspaceDir);
    cwd = realpathSync(options.cwd);
  } catch (error) {
    return {
      ok: false,
      error: `Platform sandbox path validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isWithinPath(workspaceDir, cwd)) {
    return {
      ok: false,
      error:
        "Platform sandbox working directory must be inside the tenant workspace.",
    };
  }

  const command =
    dependencies.bubblewrapPath === undefined
      ? trustedBubblewrapPath()
      : dependencies.bubblewrapPath;
  if (!command) {
    return {
      ok: false,
      error:
        "Platform shell execution is unavailable because bubblewrap is not installed at a trusted system path.",
    };
  }

  const env = buildPlatformSandboxEnv(options.env, workspaceDir);
  const blockedPaths = blockedHostPaths(options.env, workspaceDir);
  let launchArgs: string[];
  let probeArgs: string[];
  try {
    launchArgs = buildPlatformSandboxArgs({
      workspaceDir,
      cwd,
      command: options.command,
      args: options.args,
      networkMode: options.networkMode,
      blockedPaths,
    });
    probeArgs = buildPlatformSandboxArgs({
      workspaceDir,
      cwd,
      command: "/bin/true",
      args: [],
      networkMode: options.networkMode,
      blockedPaths,
    });
  } catch (error) {
    return {
      ok: false,
      error: `Platform sandbox could not mask protected storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const probe = (dependencies.probe ?? defaultProbe)(command, probeArgs, {
    cwd,
    env,
  });
  if (!probe.available) {
    return {
      ok: false,
      error:
        "Platform shell execution is unavailable because bubblewrap cannot create the required filesystem, process, and network namespaces. " +
        (probe.error ?? "The capability probe failed."),
    };
  }
  return {
    ok: true,
    launch: {
      command,
      args: launchArgs,
      cwd,
      env,
    },
  };
}

export function terminateSandboxProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  killProcessGroup: typeof process.kill = process.kill.bind(process),
): void {
  if (child.pid != null) {
    try {
      killProcessGroup(-child.pid, "SIGKILL");
      return;
    } catch {
      // The namespace leader may already have exited.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The direct child may already have exited.
  }
}
