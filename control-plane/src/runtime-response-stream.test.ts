import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createRuntimeProxyAbortLifecycle,
  pipeRuntimeResponseBody,
} from "./runtime-response-stream.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test proxy did not bind.");
  }
  return address.port;
}

describe("runtime response stream cancellation", () => {
  test("a socket close after a heartbeat cancels upstream and reaches pooled-handle cleanup", async () => {
    // Bun's Node HTTP compatibility does not currently surface a peer reset to
    // ServerResponse in a deterministic test. Run the socket-level integration
    // fixture in Node, which is also the contract Express exposes here.
    const fixture = fileURLToPath(
      new URL("./runtime-response-stream.socket-fixture.mjs", import.meta.url),
    );
    const child = Bun.spawn(
      ["node", "--experimental-strip-types", fixture],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(
      exitCode,
      [stdout, stderr].filter(Boolean).join("\n"),
    ).toBe(0);
  });

  test("normal EOF completes without marking the downstream as aborted", async () => {
    const app = express();
    let upstreamSignal: AbortSignal | undefined;

    app.get("/proxy", async (req, res) => {
      const lifetime = createRuntimeProxyAbortLifecycle(req, res);
      upstreamSignal = lifetime.controller.signal;
      try {
        await pipeRuntimeResponseBody(
          res,
          new Response("complete", { status: 200 }),
          lifetime.controller.signal,
        );
      } finally {
        lifetime.cleanup();
      }
    });

    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/proxy`);

    expect(await response.text()).toBe("complete");
    expect(upstreamSignal?.aborted).toBe(false);
  });
});
