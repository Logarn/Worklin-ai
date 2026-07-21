import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { AssistantIpcServer } from "../assistant-server.js";

const originalSocketDir = process.env.ASSISTANT_IPC_SOCKET_DIR;
let server: AssistantIpcServer | null = null;
let socketDir: string | null = null;

async function waitForSocketMode(
  socketPath: string,
  expectedMode: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    !existsSync(socketPath) ||
    (statSync(socketPath).mode & 0o777) !== expectedMode
  ) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${socketPath} to use mode ${expectedMode.toString(8)}`,
      );
    }
    await Bun.sleep(10);
  }
}

afterEach(() => {
  server?.stop();
  server = null;
  if (originalSocketDir === undefined) {
    delete process.env.ASSISTANT_IPC_SOCKET_DIR;
  } else {
    process.env.ASSISTANT_IPC_SOCKET_DIR = originalSocketDir;
  }
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  socketDir = null;
});

describe("AssistantIpcServer socket permissions", () => {
  test("uses group-connectable permissions initially and after watchdog rebind", async () => {
    socketDir = mkdtempSync(join(tmpdir(), "worklin-assistant-ipc-"));
    process.env.ASSISTANT_IPC_SOCKET_DIR = socketDir;
    const socketPath = join(socketDir, "assistant.sock");

    server = new AssistantIpcServer({ watchdogIntervalMs: 0 });
    await server.start();
    await waitForSocketMode(socketPath, 0o660);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);

    unlinkSync(socketPath);
    expect(await server.rebindIfMissing()).toBe(true);
    await waitForSocketMode(socketPath, 0o660);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
  });
});
