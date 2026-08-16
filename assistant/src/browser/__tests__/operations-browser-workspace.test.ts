import { describe, expect, mock, test } from "bun:test";

import type { ToolContext, ToolExecutionResult } from "../../tools/types.js";

const workspaceCalls: Array<{
  phase: "working" | "complete";
  toolName: string;
  input?: Record<string, unknown>;
  result?: ToolExecutionResult;
  context: ToolContext;
}> = [];

mock.module("../../tools/browser/browser-workspace.js", () => ({
  markBrowserWorkspaceWorking: async (
    toolName: string,
    context: ToolContext,
  ) => {
    workspaceCalls.push({ phase: "working", toolName, context });
  },
  syncBrowserWorkspaceAfterTool: async (
    toolName: string,
    input: Record<string, unknown>,
    result: ToolExecutionResult,
    context: ToolContext,
  ) => {
    workspaceCalls.push({
      phase: "complete",
      toolName,
      input,
      result,
      context,
    });
  },
}));

const { executeBrowserOperation } = await import("../operations.js");

describe("browser operation workspace lifecycle", () => {
  test("wraps CLI browser operations with the browser workspace lifecycle", async () => {
    workspaceCalls.length = 0;
    const context: ToolContext = {
      workingDir: "/tmp",
      conversationId: "conversation-live",
      trustClass: "guardian",
      proxyToolResolver: async () => ({ content: "ok", isError: false }),
    };
    const input = { browser_mode: "extension" };

    const result = await executeBrowserOperation(
      "wait_for_download",
      input,
      context,
    );

    expect(result.isError).toBe(true);
    expect(workspaceCalls).toHaveLength(2);
    expect(workspaceCalls[0]).toMatchObject({
      phase: "working",
      toolName: "browser_wait_for_download",
      context,
    });
    expect(workspaceCalls[1]).toMatchObject({
      phase: "complete",
      toolName: "browser_wait_for_download",
      input,
      result,
      context,
    });
  });
});
