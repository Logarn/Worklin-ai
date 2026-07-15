import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimRuntimeAssistant,
  readRuntimeAssistantClaim,
} from "./runtime-assistant-claim.js";

const originalSecurityDir = process.env.GATEWAY_SECURITY_DIR;
const temporaryDirectories: string[] = [];

function useTemporarySecurityDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "worklin-runtime-claim-"));
  temporaryDirectories.push(directory);
  process.env.GATEWAY_SECURITY_DIR = directory;
  return directory;
}

afterEach(() => {
  if (originalSecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = originalSecurityDir;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime assistant claim", () => {
  test("persists the first assistant and accepts idempotent claims", () => {
    useTemporarySecurityDir();

    expect(claimRuntimeAssistant("assistant-1")).toEqual({
      ok: true,
      assistantId: "assistant-1",
      claimed: true,
    });
    expect(claimRuntimeAssistant("assistant-1")).toEqual({
      ok: true,
      assistantId: "assistant-1",
      claimed: false,
    });
    expect(readRuntimeAssistantClaim()).toBe("assistant-1");
  });

  test("rejects a different assistant after the slot is claimed", () => {
    useTemporarySecurityDir();
    expect(claimRuntimeAssistant("assistant-1").ok).toBe(true);

    expect(claimRuntimeAssistant("assistant-2")).toEqual({
      ok: false,
      reason: "claimed_by_another_assistant",
    });
    expect(readRuntimeAssistantClaim()).toBe("assistant-1");
  });

  test("rejects invalid assistant identifiers without creating a claim", () => {
    useTemporarySecurityDir();

    expect(claimRuntimeAssistant("\n")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(readRuntimeAssistantClaim()).toBeNull();
  });
});
