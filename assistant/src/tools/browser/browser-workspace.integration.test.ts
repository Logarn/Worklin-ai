import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chromium } from "playwright";

import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserNavigate,
  executeBrowserSnapshot,
  executeBrowserType,
  executeBrowserWaitFor,
} from "./browser-execution.js";
import { browserManager, setLaunchFn } from "./browser-manager.js";
import {
  markBrowserWorkspaceWorking,
  resetBrowserWorkspacesForTests,
  syncBrowserWorkspaceAfterTool,
} from "./browser-workspace.js";

interface SurfaceCall {
  tool: string;
  input: Record<string, unknown>;
}

describe("browser workspace real task", () => {
  const profileDir = mkdtempSync(join(tmpdir(), "worklin-browser-task-"));
  const surfaceCalls: SurfaceCall[] = [];
  let server: ReturnType<typeof Bun.serve>;

  const context: ToolContext = {
    conversationId: "browser-workspace-real-task",
    workingDir: profileDir,
    trustClass: "guardian",
    proxyToolResolver: async (tool, input) => {
      surfaceCalls.push({ tool, input });
      if (tool === "ui_show") {
        return {
          content: JSON.stringify({ surfaceId: "surface-browser-real-task" }),
          isError: false,
        };
      }
      return { content: "updated", isError: false };
    },
  };

  async function runBrowserStep(
    toolName: string,
    input: Record<string, unknown>,
    execute: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    await markBrowserWorkspaceWorking(toolName, context);
    const result = await execute();
    await syncBrowserWorkspaceAfterTool(toolName, input, result, context);
    if (result.isError) {
      throw new Error(`${toolName}: ${result.content}`);
    }
    expect(result.isError).toBe(false);
    return result;
  }

  beforeAll(() => {
    resetBrowserWorkspacesForTests();
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    setLaunchFn(
      async (_userDataDir, _options) =>
        chromium.launchPersistentContext(profileDir, {
          headless: true,
          ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
          viewport: { width: 1100, height: 760 },
        }) as never,
    );
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html>
        <html>
          <head><title>Campaign workspace</title></head>
          <body>
            <main>
              <h1>Campaign setup</h1>
              <label for="campaign-name">Campaign name</label>
              <input id="campaign-name" aria-label="Campaign name" />
              <button id="save" type="button">Save campaign</button>
              <p id="status" role="status">Waiting for details</p>
            </main>
            <script>
              document.querySelector('#save').addEventListener('click', () => {
                const name = document.querySelector('#campaign-name').value;
                document.querySelector('#status').textContent = 'Campaign ready: ' + name;
                document.title = 'Campaign saved';
              });
            </script>
          </body>
        </html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
    });
  });

  afterAll(async () => {
    server.stop(true);
    await browserManager.closeAllPages();
    setLaunchFn(null);
    resetBrowserWorkspacesForTests();
    rmSync(profileDir, { recursive: true, force: true });
  });

  const realBrowserTest =
    process.env.WORKLIN_REAL_BROWSER_TEST === "1" ? test : test.skip;

  realBrowserTest(
    "navigates, types, clicks, verifies the result, and publishes safe live updates",
    async () => {
      const url = `http://127.0.0.1:${server.port}/task?token=private#step`;
      await runBrowserStep(
        "browser_navigate",
        { url, browser_mode: "local", allow_private_network: true },
        () =>
          executeBrowserNavigate(
            {
              url,
              browser_mode: "local",
              allow_private_network: true,
            },
            context,
          ),
      );
      await runBrowserStep(
        "browser_type",
        {
          selector: "#campaign-name",
          text: "Retention Launch",
          browser_mode: "local",
        },
        () =>
          executeBrowserType(
            {
              selector: "#campaign-name",
              text: "Retention Launch",
              browser_mode: "local",
            },
            context,
          ),
      );
      await runBrowserStep(
        "browser_click",
        { selector: "#save", browser_mode: "local" },
        () =>
          executeBrowserClick(
            { selector: "#save", browser_mode: "local" },
            context,
          ),
      );
      await runBrowserStep(
        "browser_wait_for",
        { text: "Campaign ready: Retention Launch", browser_mode: "local" },
        () =>
          executeBrowserWaitFor(
            {
              text: "Campaign ready: Retention Launch",
              browser_mode: "local",
            },
            context,
          ),
      );
      const snapshot = await runBrowserStep(
        "browser_snapshot",
        { browser_mode: "local" },
        () => executeBrowserSnapshot({ browser_mode: "local" }, context),
      );

      expect(snapshot.content).toContain("Campaign saved");
      expect(snapshot.content).toContain('value="Retention Launch"');

      const failureInput = { element_id: "e999", browser_mode: "local" };
      await markBrowserWorkspaceWorking("browser_click", context);
      const failedClick = await executeBrowserClick(failureInput, context);
      expect(failedClick.isError).toBe(true);
      await syncBrowserWorkspaceAfterTool(
        "browser_click",
        failureInput,
        failedClick,
        context,
      );
      const errorUpdate = [...surfaceCalls]
        .reverse()
        .find(
          (call) =>
            call.tool === "ui_update" &&
            (call.input.data as Record<string, unknown>).status === "error",
        );
      expect(errorUpdate?.input).toMatchObject({
        data: {
          status: "error",
          errorMessage: "Worklin could not complete the latest browser step.",
        },
      });
      await runBrowserStep("browser_snapshot", { browser_mode: "local" }, () =>
        executeBrowserSnapshot({ browser_mode: "local" }, context),
      );

      const show = surfaceCalls.find((call) => call.tool === "ui_show");
      expect(show?.input).toMatchObject({
        surface_type: "browser_view",
        title: "Browser",
        display: "panel",
        persistent: true,
      });
      const updates = surfaceCalls.filter((call) => call.tool === "ui_update");
      expect(
        updates.some(
          (call) =>
            (call.input.data as Record<string, unknown>).status === "working",
        ),
      ).toBe(true);
      const lastReady = [...updates]
        .reverse()
        .find(
          (call) =>
            (call.input.data as Record<string, unknown>).status === "ready",
        );
      expect(lastReady?.input).toMatchObject({
        surface_id: "surface-browser-real-task",
        data: {
          url: `http://127.0.0.1:${server.port}/task`,
          title: "Campaign saved",
          status: "ready",
          connectionLabel: "Worklin browser",
        },
      });

      const serializedCalls = JSON.stringify(surfaceCalls);
      expect(serializedCalls).not.toContain("Retention Launch");
      expect(serializedCalls).not.toContain("token=private");

      const closeInput = { browser_mode: "local" };
      const closeResult = await executeBrowserClose(closeInput, context);
      await syncBrowserWorkspaceAfterTool(
        "browser_close",
        closeInput,
        closeResult,
        context,
      );
      expect(closeResult.isError).toBe(false);
      const closed = [...surfaceCalls]
        .reverse()
        .find(
          (call) =>
            call.tool === "ui_update" &&
            (call.input.data as Record<string, unknown>).status === "closed",
        );
      expect(closed).toBeDefined();
    },
    60_000,
  );
});
