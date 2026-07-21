import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import { getIdentityChangeEpoch } from "../../workspace/identity-change-invalidation.js";
import { VellumAcpClientHandler } from "../client-handler.js";

const ACP_SESSION_ID = "acp-session-abc";
const PARENT_CONVERSATION_ID = "conv-xyz";
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-handler-test-")));
  testDirs.push(dir);
  return dir;
}

function makeHandler(): {
  handler: VellumAcpClientHandler;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const handler = new VellumAcpClientHandler(
    ACP_SESSION_ID,
    (msg) => {
      sent.push(msg);
    },
    PARENT_CONVERSATION_ID,
  );
  return { handler, sent };
}

describe("VellumAcpClientHandler.sessionUpdate", () => {
  test("forwards agent_thought_chunk as an acp_session_update", async () => {
    const { handler, sent } = makeHandler();

    const notification: SessionNotification = {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "internal reasoning here" },
      },
    };

    await handler.sessionUpdate(notification);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_update",
      acpSessionId: ACP_SESSION_ID,
      updateType: "agent_thought_chunk",
      content: "internal reasoning here",
    });
  });

  test("agent_thought_chunk does not contribute to accumulated response text", async () => {
    const { handler } = makeHandler();

    await handler.sessionUpdate({
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      },
    });

    // Thoughts are forwarded for UI display but should not be treated as the
    // agent's final response text.
    expect(handler.responseText).toBe("");
  });
});

describe("VellumAcpClientHandler replay suppression", () => {
  function messageChunk(text: string): SessionNotification {
    return {
      sessionId: ACP_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    };
  }

  test("updates received while suppressed are dropped", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate(messageChunk("replayed history"));

    expect(sent).toHaveLength(0);
    expect(handler.responseText).toBe("");
  });

  test("updates after endReplaySuppression() flow normally", async () => {
    const { handler, sent } = makeHandler();

    handler.beginReplaySuppression();
    await handler.sessionUpdate(messageChunk("replayed history"));
    handler.endReplaySuppression();
    await handler.sessionUpdate(messageChunk("live response"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "acp_session_update",
      acpSessionId: ACP_SESSION_ID,
      updateType: "agent_message_chunk",
      content: "live response",
    });
    expect(handler.responseText).toBe("live response");
  });
});

describe("VellumAcpClientHandler.writeTextFile", () => {
  test("coordinates writes through an alias of workspace IDENTITY.md", async () => {
    const workspaceDir = makeTempDir();
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const aliasPath = join(workspaceDir, "identity-alias.md");
    writeFileSync(identityPath, "original identity");
    symlinkSync(identityPath, aliasPath);
    const beforeEpoch = getIdentityChangeEpoch();
    const { handler } = makeHandler();

    await handler.writeTextFile({
      sessionId: ACP_SESSION_ID,
      path: aliasPath,
      content: "ACP identity",
    });

    expect(readFileSync(identityPath, "utf-8")).toBe("ACP identity");
    expect(getIdentityChangeEpoch()).toBe(beforeEpoch + 1);
  });
});
