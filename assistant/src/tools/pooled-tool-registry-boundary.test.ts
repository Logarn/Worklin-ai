import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import { executeWebFetch } from "./network/web-fetch.js";
import {
  __resetRegistryForTesting,
  getTool,
  getToolOwner,
  getWorkspaceToolNames,
  initializeTools,
  registerExternalTools,
  registerSkillTools,
  registerTool,
  resetToolRegistryForTenantAssignment,
} from "./registry.js";
import type { Tool } from "./types.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const root = mkdtempSync(join(tmpdir(), "worklin-pooled-tools-"));
const workspaceDir = join(root, "workspace");

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    category: "test",
    executionTarget: "sandbox",
    defaultRiskLevel: RiskLevel.Low,
    input_schema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: "ok", isError: false }),
  };
}

beforeAll(async () => {
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  mkdirSync(join(workspaceDir, "tools"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "tools", "stale_tenant_tool.json"),
    JSON.stringify({
      name: "stale_tenant_tool",
      description: "must never load before assignment",
    }),
  );
  registerExternalTools({ kind: "skill", id: "stale-external-skill" }, [
    fakeTool("stale_external_tool"),
  ]);
  await initializeTools({ profile: "pooled" });
});

afterAll(() => {
  __resetRegistryForTesting();
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalRuntimeMode === undefined) {
    delete process.env.WORKLIN_RUNTIME_MODE;
  } else {
    process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("pooled tool registry boundary", () => {
  test("keeps ordinary sandbox/request-bound primitives", () => {
    for (const name of [
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "web_fetch",
      "remember",
      "recall",
      "ask_question",
      "ui_show",
    ]) {
      expect(getTool(name), name).toBeDefined();
      expect(getToolOwner(name), name).toBeUndefined();
    }
  });

  test("omits host, global extension, CES, workflow, and stale workspace tools", () => {
    for (const name of [
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_file_transfer",
      "bash",
      "host_bash",
      "make_authenticated_request",
      "run_authenticated_command",
      "manage_secure_command_tool",
      "run_workflow",
      "manage_workflows",
      "credential_store",
      "notify_parent",
      "request_system_permission",
      "skill_execute",
      "skill_load",
      "web_search",
      "app_open",
      "stale_external_tool",
      "stale_tenant_tool",
    ]) {
      expect(getTool(name), name).toBeUndefined();
      expect(getToolOwner(name), name).toBeUndefined();
    }
    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("rejects adversarial dynamic skill tools regardless of target", () => {
    const hostTool: Tool = {
      ...fakeTool("tenant_host_tool"),
      executionTarget: "host",
    };
    const sandboxTool = fakeTool("tenant_sandbox_tool");
    expect(registerSkillTools("tenant-a", [hostTool, sandboxTool])).toEqual([]);
    expect(getTool("tenant_host_tool")).toBeUndefined();
    expect(getTool("tenant_sandbox_tool")).toBeUndefined();
  });

  test("never honors private-network web fetch opt-in", async () => {
    const result = await executeWebFetch({
      url: "http://127.0.0.1:3000/internal",
      allow_private_network: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Refusing to fetch local/private network target",
    );
  });

  test("rejects late module registration and preserves the baseline on reuse", () => {
    expect(() => registerTool(fakeTool("tenant_a_late_core_tool"))).toThrow(
      "outside the reviewed pooled-worker allowlist",
    );
    expect(getTool("tenant_a_late_core_tool")).toBeUndefined();

    resetToolRegistryForTenantAssignment();

    expect(getTool("tenant_a_late_core_tool")).toBeUndefined();
    expect(getToolOwner("tenant_a_late_core_tool")).toBeUndefined();
    expect(getTool("file_read")).toBeDefined();
    expect(getTool("host_bash")).toBeUndefined();
  });
});
