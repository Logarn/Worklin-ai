import { describe, expect, it, mock } from "bun:test";

mock.module("../../agent/image-optimize.js", () => ({
  optimizeImageForTransport: (data: string, mediaType: string) => ({
    data,
    mediaType,
  }),
}));

mock.module("./browser-manager.js", () => ({
  browserManager: {
    getPreferredBackendKind: () => "local",
  },
}));

mock.module("./cdp-client/factory.js", () => ({
  getCdpClient: () => ({
    kind: "local",
    conversationId: "browser-workspace-working",
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "https://example.com/" } };
        }
        if (expression === "document.title") {
          return { result: { value: "Example" } };
        }
      }
      if (method === "Page.captureScreenshot") {
        return { data: "dGVzdA==" };
      }
      return {};
    },
    dispose: () => {},
  }),
}));

import type { ToolContext } from "../types.js";
import {
  browserActivityForTool,
  markBrowserWorkspaceWorking,
  resetBrowserWorkspacesForTests,
  syncBrowserWorkspaceAfterTool,
} from "./browser-workspace.js";

describe("browserActivityForTool", () => {
  it("never exposes text entered into a page", () => {
    const activity = browserActivityForTool(
      "browser_type",
      { text: "private-password", ref: "input-1" },
      false,
      123,
    );

    expect(activity).toEqual({
      id: "123-browser_type",
      label: "Entered text securely",
      status: "completed",
      timestamp: 123,
    });
    expect(JSON.stringify(activity)).not.toContain("private-password");
  });

  it("never exposes saved credentials entered into a page", () => {
    const activity = browserActivityForTool(
      "browser_fill_credential",
      { credential_id: "credential-secret", selector: "#password" },
      false,
      234,
    );

    expect(activity).toEqual({
      id: "234-browser_fill_credential",
      label: "Filled a saved sign-in field securely",
      status: "completed",
      timestamp: 234,
    });
    expect(JSON.stringify(activity)).not.toContain("credential-secret");
  });

  it("removes credentials, query parameters, and fragments from navigation URLs", () => {
    const activity = browserActivityForTool(
      "browser_navigate",
      { url: "https://user:pass@example.com/private?token=secret#account" },
      false,
      456,
    );

    expect(activity.detail).toBe("https://example.com/private");
    expect(JSON.stringify(activity)).not.toContain("secret");
    expect(JSON.stringify(activity)).not.toContain("user");
  });

  it("uses a friendly generic label for failed steps", () => {
    const activity = browserActivityForTool(
      "browser_click",
      { ref: "button-1" },
      true,
      789,
    );

    expect(activity.label).toBe("Browser step could not be completed");
    expect(activity.status).toBe("error");
  });

  it("publishes a working state between completed browser steps", async () => {
    resetBrowserWorkspacesForTests();
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const context: ToolContext = {
      conversationId: "browser-workspace-working",
      workingDir: "/tmp",
      trustClass: "guardian",
      proxyToolResolver: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === "ui_show") {
          return {
            content: JSON.stringify({ surfaceId: "surface-browser" }),
            isError: false,
          };
        }
        return { content: "updated", isError: false };
      },
    };

    await syncBrowserWorkspaceAfterTool(
      "browser_navigate",
      { url: "https://example.com" },
      { content: "opened", isError: false },
      context,
    );
    await markBrowserWorkspaceWorking("browser_click", context);

    const update = [...calls]
      .reverse()
      .find((call) => call.tool === "ui_update");
    expect(update?.input).toMatchObject({
      surface_id: "surface-browser",
      data: { status: "working", errorMessage: undefined },
    });
  });
});
