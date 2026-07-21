import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";

import express from "express";

import {
  createRuntimeProxyAbortLifecycle,
  pipeRuntimeResponseBody,
} from "./runtime-response-stream.ts";

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for proxy cancellation.");
}

const app = express();
app.use(express.json());

let upstreamCancelled = false;
let upstreamSignal;
let pooledHandleFinished = false;

app.post("/proxy", async (req, res) => {
  const lifetime = createRuntimeProxyAbortLifecycle(req, res);
  upstreamSignal = lifetime.controller.signal;
  let heartbeat;
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(" "));
        heartbeat = setInterval(() => {
          controller.enqueue(new TextEncoder().encode(" "));
        }, 20);
      },
      cancel() {
        upstreamCancelled = true;
        if (heartbeat) clearInterval(heartbeat);
      },
    }),
    {
      status: 202,
      headers: { "content-type": "application/json" },
    },
  );

  res.status(upstream.status);
  res.setHeader("content-type", "application/json");
  try {
    await pipeRuntimeResponseBody(res, upstream, lifetime.controller.signal);
  } finally {
    lifetime.cleanup();
    // Mirrors proxyToGateway's finally block, where the pooled request handle
    // is revoked and finished after response piping settles.
    pooledHandleFinished = true;
  }
});

const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");

await new Promise((resolve, reject) => {
  const socket = connect(address.port, "127.0.0.1");
  let received = "";
  let dropped = false;
  socket.setEncoding("utf8");
  socket.setTimeout(1_000, () => {
    socket.destroy(new Error("Timed out waiting for proxy heartbeat."));
  });
  socket.once("connect", () => {
    socket.write(
      [
        "POST /proxy HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Content-Type: application/json",
        "Content-Length: 2",
        "Connection: keep-alive",
        "",
        "{}",
      ].join("\r\n"),
    );
  });
  socket.on("data", (chunk) => {
    received += chunk;
    const bodyStart = received.indexOf("\r\n\r\n");
    if (!dropped && bodyStart >= 0 && received.length > bodyStart + 4) {
      dropped = true;
      socket.resetAndDestroy();
    }
  });
  socket.once("close", () => {
    if (dropped) resolve();
  });
  socket.once("error", (error) => {
    if (error.code === "ECONNRESET") {
      resolve();
      return;
    }
    reject(error);
  });
});

await waitFor(
  () =>
    upstreamCancelled &&
    upstreamSignal?.aborted === true &&
    pooledHandleFinished,
);
assert.equal(upstreamSignal?.aborted, true);
assert.equal(upstreamCancelled, true);
assert.equal(pooledHandleFinished, true);

await new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});
