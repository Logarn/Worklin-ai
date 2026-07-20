import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

const runtimeDir = import.meta.dir;
const repositoryDir = join(runtimeDir, "..");
const dockerfile = readFileSync(join(runtimeDir, "Dockerfile"), "utf8");
const assistantPackage = JSON.parse(
  readFileSync(join(repositoryDir, "assistant", "package.json"), "utf8"),
) as { bin?: { assistant?: string } };
const assistantEntrypoint = join(repositoryDir, "assistant", "src", "index.ts");

describe("production runtime assistant CLI", () => {
  test("installs and smoke-tests the real task CLI on PATH", () => {
    expect(assistantPackage.bin?.assistant).toBe("./src/index.ts");
    expect(readFileSync(assistantEntrypoint, "utf8")).toStartWith(
      "#!/usr/bin/env bun",
    );
    expect(statSync(assistantEntrypoint).mode & 0o111).not.toBe(0);

    expect(dockerfile).toContain(
      "ln -sf /app/assistant/src/index.ts /usr/local/bin/assistant",
    );
    expect(dockerfile).toContain("assistant task --help");
    expect(dockerfile).toContain(
      'grep -F "Manage task templates and work queue items"',
    );

    const appCopyIndex = dockerfile.indexOf("COPY --from=builder /app /app");
    const smokeTestIndex = dockerfile.indexOf("assistant task --help");
    expect(appCopyIndex).toBeGreaterThan(-1);
    expect(smokeTestIndex).toBeGreaterThan(appCopyIndex);
  });

  test("task commands use only the current stack's assistant IPC socket", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "worklin-runtime-cli-"));
    const fakeBinDir = join(tempDir, "bin");
    const workspaceDir = join(tempDir, "workspace");
    const socketDir = join(tempDir, "assistant-ipc");
    const assistantCommand = join(fakeBinDir, "assistant");

    mkdirSync(fakeBinDir);
    symlinkSync(assistantEntrypoint, assistantCommand);

    try {
      const result = Bun.spawnSync(
        [assistantCommand, "task", "list", "--json"],
        {
          env: {
            HOME: tempDir,
            PATH: `${dirname(process.execPath)}:${fakeBinDir}:/usr/bin:/bin`,
            VELLUM_WORKSPACE_DIR: workspaceDir,
            ASSISTANT_IPC_SOCKET_DIR: socketDir,
          },
        },
      );

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout.toString()) as {
        ok: boolean;
        error: string;
      };
      expect(output.ok).toBe(false);
      expect(output.error).toContain(join(socketDir, "assistant.sock"));
      expect(output.error).not.toContain("/data/workspace");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
