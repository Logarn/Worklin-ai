import {
  lstat,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface PooledWorkspaceTenant {
  orgId: string;
  assistantId: string;
}

export interface PooledWorkspaceSanitizeReceipt {
  status: "sanitized" | "already_sanitized";
  workerStackId: string;
  remainingTenantPaths: 0;
  credentialsTouched: false;
}

export interface PooledWorkspaceBinding {
  tenant: PooledWorkspaceTenant;
  workerStackId: string;
  workspaceRoot: string;
  tenantWorkspacePath: string;
}

export interface PooledWorkspaceSanitizationProofs {
  tenant: PooledWorkspaceTenant;
  workerStackId: string;
  leaseReleased: true;
  activeLeaseToken: null;
  activeTenantProcessCount: 0;
  activeTenantSessionCount: 0;
}

export interface PooledWorkspaceProofGuard {
  resolveCurrentTenantWorkspace(input: {
    tenant: PooledWorkspaceTenant;
    workerStackId: string;
  }): Promise<PooledWorkspaceBinding>;

  /**
   * The production implementation must hold the worker assignment/process
   * fence for the full callback. A point-in-time check is insufficient because
   * a new lease or tenant process could otherwise race workspace deletion.
   */
  withExclusiveSanitizationProofs<T>(
    input: {
      tenant: PooledWorkspaceTenant;
      workerStackId: string;
    },
    operation: (proofs: PooledWorkspaceSanitizationProofs) => Promise<T>,
  ): Promise<T>;
}

export interface PooledWorkspacePathStat {
  kind: "file" | "directory" | "symlink" | "other";
  identity: string;
}

export interface PooledWorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<PooledWorkspacePathStat>;
  readDirectory(path: string): Promise<readonly string[]>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
}

export interface PooledWorkspaceSanitizerDependencies {
  proofGuard: PooledWorkspaceProofGuard;
  fileSystem: PooledWorkspaceFileSystem;
  cesSecurityPaths: readonly string[];
  gatewaySecurityPaths: readonly string[];
}

export interface PooledWorkspaceSanitizer {
  sanitize(input: {
    tenant: PooledWorkspaceTenant;
    workerStackId: string;
  }): Promise<PooledWorkspaceSanitizeReceipt>;
}

interface ScannedEntry {
  path: string;
  kind: "file" | "directory";
  identity: string;
}

interface CanonicalDirectory {
  path: string;
  identity: string;
}

export function createPooledWorkspaceSanitizer(
  dependencies: PooledWorkspaceSanitizerDependencies,
): PooledWorkspaceSanitizer {
  const { proofGuard, fileSystem, cesSecurityPaths, gatewaySecurityPaths } =
    dependencies;
  if (!proofGuard || !fileSystem) {
    throw new Error(
      "Pooled workspace sanitizer requires filesystem and proof guards.",
    );
  }
  if (cesSecurityPaths.length === 0 || gatewaySecurityPaths.length === 0) {
    throw new Error(
      "Pooled workspace sanitizer requires explicit CES and gateway security paths.",
    );
  }

  return {
    sanitize: async (input) => {
      assertOpaqueId(input.tenant.orgId, "organization");
      assertOpaqueId(input.tenant.assistantId, "assistant");
      assertOpaqueId(input.workerStackId, "worker stack");

      return proofGuard.withExclusiveSanitizationProofs(
        input,
        async (proofs) => {
          assertProofs(proofs, input);
          const binding = await proofGuard.resolveCurrentTenantWorkspace(input);
          assertBinding(binding, input);

          const boundary = await resolveSanitizationBoundary({
            binding,
            fileSystem,
            cesSecurityPaths,
            gatewaySecurityPaths,
          });
          const entries = await scanWorkspaceTree(
            fileSystem,
            boundary.workspace.path,
          );
          await assertBoundaryUnchanged(fileSystem, boundary);
          for (const entry of entries) {
            await assertBoundaryUnchanged(fileSystem, boundary);
            await assertEntryUnchanged(
              fileSystem,
              boundary.workspace.path,
              entry,
            );
            if (entry.kind === "directory") {
              await fileSystem.fsyncDirectory(entry.path);
              await fileSystem.removeDirectory(entry.path);
            } else {
              await fileSystem.removeFile(entry.path);
            }
          }

          await assertBoundaryUnchanged(fileSystem, boundary);
          await fileSystem.fsyncDirectory(boundary.workspace.path);
          const remaining = await scanWorkspaceTree(
            fileSystem,
            boundary.workspace.path,
          );
          if (remaining.length !== 0) {
            throw new Error(
              "Pooled workspace sanitization verification found remaining tenant paths.",
            );
          }
          await assertBoundaryUnchanged(fileSystem, boundary);
          await fileSystem.fsyncDirectory(boundary.workspace.path);

          return {
            status: entries.length === 0 ? "already_sanitized" : "sanitized",
            workerStackId: input.workerStackId,
            remainingTenantPaths: 0,
            credentialsTouched: false,
          };
        },
      );
    },
  };
}

async function resolveSanitizationBoundary(input: {
  binding: PooledWorkspaceBinding;
  fileSystem: PooledWorkspaceFileSystem;
  cesSecurityPaths: readonly string[];
  gatewaySecurityPaths: readonly string[];
}): Promise<{
  workspaceRoot: CanonicalDirectory;
  workspace: CanonicalDirectory;
}> {
  const workspaceRoot = await resolveCanonicalDirectory(
    input.fileSystem,
    input.binding.workspaceRoot,
    "workspace root",
  );
  const workspace = await resolveCanonicalDirectory(
    input.fileSystem,
    input.binding.tenantWorkspacePath,
    "tenant workspace",
  );
  if (!isStrictlyWithin(workspaceRoot.path, workspace.path)) {
    throw new Error(
      "Pooled workspace path is not a strict child of the workspace root.",
    );
  }

  const protectedPaths = [
    ...input.cesSecurityPaths.map((path) => ({
      path,
      label: "CES security",
    })),
    ...input.gatewaySecurityPaths.map((path) => ({
      path,
      label: "gateway security",
    })),
  ];
  for (const protectedPath of protectedPaths) {
    const canonical = await resolveCanonicalDirectory(
      input.fileSystem,
      protectedPath.path,
      `${protectedPath.label} path`,
    );
    if (pathsOverlap(workspace.path, canonical.path)) {
      throw new Error(
        `Pooled workspace overlaps a protected ${protectedPath.label} path.`,
      );
    }
  }
  return { workspaceRoot, workspace };
}

async function resolveCanonicalDirectory(
  fileSystem: PooledWorkspaceFileSystem,
  path: string,
  label: string,
): Promise<CanonicalDirectory> {
  if (
    !path ||
    path !== path.trim() ||
    !isAbsolute(path) ||
    path.includes("\u0000")
  ) {
    throw new Error(`Pooled ${label} is ambiguous or invalid.`);
  }
  const lexical = resolve(path);
  const stat = await fileSystem.lstat(lexical);
  if (stat.kind === "symlink") {
    throw new Error(`Pooled ${label} must not be a symlink.`);
  }
  if (stat.kind !== "directory") {
    throw new Error(`Pooled ${label} must be an existing directory.`);
  }
  const canonical = await fileSystem.realpath(lexical);
  if (canonical !== lexical) {
    throw new Error(
      `Pooled ${label} contains a symlink or non-canonical path component.`,
    );
  }
  if (!stat.identity) {
    throw new Error(`Pooled ${label} identity could not be proven.`);
  }
  return { path: canonical, identity: stat.identity };
}

async function assertBoundaryUnchanged(
  fileSystem: PooledWorkspaceFileSystem,
  boundary: {
    workspaceRoot: CanonicalDirectory;
    workspace: CanonicalDirectory;
  },
): Promise<void> {
  for (const directory of [boundary.workspaceRoot, boundary.workspace]) {
    const stat = await fileSystem.lstat(directory.path);
    if (
      stat.kind !== "directory" ||
      stat.identity !== directory.identity ||
      (await fileSystem.realpath(directory.path)) !== directory.path
    ) {
      throw new Error(
        "Pooled workspace boundary changed during sanitization; deletion was stopped.",
      );
    }
  }
}

async function scanWorkspaceTree(
  fileSystem: PooledWorkspaceFileSystem,
  workspacePath: string,
): Promise<ScannedEntry[]> {
  const entries: ScannedEntry[] = [];

  const scan = async (directory: string): Promise<void> => {
    const names = await fileSystem.readDirectory(directory);
    for (const name of names) {
      assertDirectoryEntryName(name);
      const path = resolve(directory, name);
      if (!isStrictlyWithin(workspacePath, path)) {
        throw new Error("Pooled workspace entry escapes the tenant workspace.");
      }
      const stat = await fileSystem.lstat(path);
      if (stat.kind === "symlink") {
        throw new Error(
          "Pooled workspace sanitization rejects symbolic links.",
        );
      }
      if (stat.kind !== "file" && stat.kind !== "directory") {
        throw new Error(
          "Pooled workspace sanitization rejects unsupported filesystem entries.",
        );
      }
      const canonical = await fileSystem.realpath(path);
      if (canonical !== path || !isStrictlyWithin(workspacePath, canonical)) {
        throw new Error(
          "Pooled workspace entry resolves outside its tenant boundary.",
        );
      }
      if (!stat.identity) {
        throw new Error("Pooled workspace entry identity could not be proven.");
      }
      if (stat.kind === "directory") await scan(path);
      entries.push({ path, kind: stat.kind, identity: stat.identity });
    }
  };

  await scan(workspacePath);
  return entries;
}

async function assertEntryUnchanged(
  fileSystem: PooledWorkspaceFileSystem,
  workspacePath: string,
  entry: ScannedEntry,
): Promise<void> {
  if (!isStrictlyWithin(workspacePath, entry.path)) {
    throw new Error("Pooled workspace deletion target escaped its boundary.");
  }
  const current = await fileSystem.lstat(entry.path);
  if (
    current.kind !== entry.kind ||
    current.identity !== entry.identity ||
    (await fileSystem.realpath(entry.path)) !== entry.path
  ) {
    throw new Error(
      "Pooled workspace changed during sanitization; deletion was stopped.",
    );
  }
}

function assertBinding(
  binding: PooledWorkspaceBinding,
  input: { tenant: PooledWorkspaceTenant; workerStackId: string },
): void {
  if (
    binding.workerStackId !== input.workerStackId ||
    binding.tenant.orgId !== input.tenant.orgId ||
    binding.tenant.assistantId !== input.tenant.assistantId
  ) {
    throw new Error(
      "Pooled workspace binding belongs to another tenant or worker.",
    );
  }
}

function assertProofs(
  proofs: PooledWorkspaceSanitizationProofs,
  input: { tenant: PooledWorkspaceTenant; workerStackId: string },
): void {
  if (
    proofs.workerStackId !== input.workerStackId ||
    proofs.tenant.orgId !== input.tenant.orgId ||
    proofs.tenant.assistantId !== input.tenant.assistantId ||
    proofs.leaseReleased !== true ||
    proofs.activeLeaseToken !== null ||
    proofs.activeTenantProcessCount !== 0 ||
    proofs.activeTenantSessionCount !== 0
  ) {
    throw new Error(
      "Pooled workspace sanitization requires a released lease and zero active tenant processes or sessions.",
    );
  }
}

function assertDirectoryEntryName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\u0000")
  ) {
    throw new Error("Pooled workspace contains an ambiguous entry name.");
  }
}

function assertOpaqueId(value: string, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 255 ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new Error(`Pooled workspace ${label} id is invalid.`);
  }
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    isStrictlyWithin(left, right) ||
    isStrictlyWithin(right, left)
  );
}

export function createNodePooledWorkspaceFileSystem(): PooledWorkspaceFileSystem {
  return {
    realpath,
    lstat: async (path) => {
      const stat = await lstat(path);
      return {
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        identity: `${stat.dev}:${stat.ino}`,
      };
    },
    readDirectory: async (path) => readdir(path),
    removeFile: async (path) => unlink(path),
    removeDirectory: async (path) => rmdir(path),
    fsyncDirectory: async (path) => {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}
