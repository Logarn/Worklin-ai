import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { FileSystemOps } from "../../tools/shared/filesystem/file-ops-service.js";
import { sandboxPolicy } from "../../tools/shared/filesystem/path-policy.js";
import { measurePooledWorkspaceState } from "../migrations/pooled-state-export.js";
import type { PooledRuntimeLeaseIdentity } from "../pooled-runtime-drain-fence.js";
import {
  assertPooledWorkspaceFileMutationWithinQuota,
  assertPooledWorkspaceQuotaAssignment,
  installPooledWorkspaceQuotaForAssignment,
  resetPooledWorkspaceQuotaForTenantAssignment,
} from "../pooled-workspace-quota.js";

const roots: string[] = [];
const priorRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: "org-a", assistantId: "assistant-a" },
  workerStackId: "worker-1",
  generation: 1,
};

afterEach(() => {
  resetPooledWorkspaceQuotaForTenantAssignment();
  if (priorRuntimeMode === undefined) delete process.env.WORKLIN_RUNTIME_MODE;
  else process.env.WORKLIN_RUNTIME_MODE = priorRuntimeMode;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pooled-quota-")));
  roots.push(root);
  return root;
}

function pooledOps(workspaceDir: string): FileSystemOps {
  process.env.WORKLIN_RUNTIME_MODE = "pooled";
  return new FileSystemOps(
    (path, options) => sandboxPolicy(path, workspaceDir, options),
    { beforeWrite: assertPooledWorkspaceFileMutationWithinQuota },
  );
}

describe("pooled workspace quota", () => {
  test("accounts cumulative file writes exactly before touching disk", () => {
    const workspaceDir = workspace();
    const baseline = measurePooledWorkspaceState(workspaceDir).totalBytes;
    installPooledWorkspaceQuotaForAssignment(
      IDENTITY,
      workspaceDir,
      baseline + 10,
    );
    const ops = pooledOps(workspaceDir);

    expect(ops.writeFileSafe({ path: "first.txt", content: "12345" }).ok).toBe(
      true,
    );
    expect(ops.writeFileSafe({ path: "second.txt", content: "67890" }).ok).toBe(
      true,
    );
    const rejected = ops.writeFileSafe({ path: "third.txt", content: "x" });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain("storage quota");
    }
    expect(measurePooledWorkspaceState(workspaceDir).totalBytes).toBe(
      baseline + 10,
    );
  });

  test("rejects an oversized edit and preserves the original file", () => {
    const workspaceDir = workspace();
    const target = join(workspaceDir, "note.txt");
    writeFileSync(target, "x");
    const baseline = measurePooledWorkspaceState(workspaceDir).totalBytes;
    installPooledWorkspaceQuotaForAssignment(
      IDENTITY,
      workspaceDir,
      baseline + 2,
    );
    const ops = pooledOps(workspaceDir);

    const rejected = ops.editFileSafe({
      path: "note.txt",
      oldString: "x",
      newString: "xxxx",
      replaceAll: false,
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.message).toContain("storage quota");
    }
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("binds quota state to the exact tenant and lease generation", () => {
    const workspaceDir = workspace();
    installPooledWorkspaceQuotaForAssignment(IDENTITY, workspaceDir, 0);

    expect(() =>
      assertPooledWorkspaceQuotaAssignment(
        {
          ...IDENTITY,
          tenant: { orgId: "org-b", assistantId: "assistant-b" },
        },
        workspaceDir,
        0,
      ),
    ).toThrow("does not match the active assignment");
    expect(() =>
      assertPooledWorkspaceQuotaAssignment(
        { ...IDENTITY, generation: 2 },
        workspaceDir,
        0,
      ),
    ).toThrow("does not match the active assignment");
  });
});
