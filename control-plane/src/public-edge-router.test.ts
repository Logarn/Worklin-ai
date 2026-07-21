import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";

import {
  createPublicEdgeRouter,
  routeInitialRequest,
} from "./public-edge-router.js";

const ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH =
  "/v1/live-voice/providers/elevenlabs/upstream";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("public edge", () => {
  test("routes every request through the control plane", () => {
    const options = {
      controlPlaneUrl: "http://control-plane.internal:8082",
    };
    expect(
      routeInitialRequest(
        Buffer.from(
          `GET ${ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH}?trace=voice-1 HTTP/1.1\r\n`,
        ),
        options,
      ).toString(),
    ).toBe("http://control-plane.internal:8082/");
    expect(
      routeInitialRequest(
        Buffer.from(
          `GET ${ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH}/extra HTTP/1.1\r\n`,
        ),
        options,
      ).toString(),
    ).toBe("http://control-plane.internal:8082/");
    expect(
      routeInitialRequest(
        Buffer.from(
          `GET ${ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH} HTTP/1.1\r\n` +
            "Host: public-edge.example.com\r\n" +
            "Connection: keep-alive\r\n\r\n" +
            "GET /v1/contacts HTTP/1.1\r\n" +
            "Host: localhost\r\n\r\n",
        ),
        options,
      ).toString(),
    ).toBe("http://control-plane.internal:8082/");
  });

  test("sends the ElevenLabs path only to the control plane", async () => {
    let controlPlaneRequest = "";
    const controlPlaneUrl = await listenResponder(
      "control-plane",
      (request) => {
        controlPlaneRequest = request;
      },
    );
    const edge = createPublicEdgeRouter({ controlPlaneUrl });
    const edgeUrl = new URL(await listen(edge));

    expect(await rawRequest(edgeUrl, "/readyz")).toEndWith("control-plane");
    expect(
      await rawRequest(edgeUrl, ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH, {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "X-ElevenLabs-Speech-Engine-Authorization": "signed-provider-token",
      }),
    ).toEndWith("control-plane");
    expect(controlPlaneRequest).toContain(
      `GET ${ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH} HTTP/1.1`,
    );
  });

  test("keeps WebSocket frames flowing only to the control plane", async () => {
    const controlPlaneUrl = await listenUpgradeEcho();
    const edge = createPublicEdgeRouter({ controlPlaneUrl });
    const edgeUrl = new URL(await listen(edge));

    expect(await rawUpgradeEcho(edgeUrl, "voice-frame")).toBe("voice-frame");
  });
});

async function listenResponder(
  body: string,
  onRequest?: (request: string) => void,
): Promise<string> {
  const server = createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      onRequest?.(request);
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
          "Connection: close\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
          body,
      );
    });
  });
  return await listen(server);
}

async function rawRequest(
  target: URL,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      const requestHeaders = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\n${requestHeaders}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("close", () => resolve(response));
  });
}

async function listenUpgradeEcho(): Promise<string> {
  const server = createServer((socket) => {
    let upgraded = false;
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (upgraded) {
        socket.write(chunk);
        return;
      }
      request = Buffer.concat([request, Buffer.from(chunk)]);
      const headersEnd = request.indexOf("\r\n\r\n");
      if (headersEnd === -1) return;
      upgraded = true;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
      );
      const remaining = request.subarray(headersEnd + 4);
      if (remaining.length > 0) socket.write(remaining);
    });
  });
  return await listen(server);
}

async function rawUpgradeEcho(target: URL, payload: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    let response = Buffer.alloc(0);
    let sentPayload = false;
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET ${ELEVENLABS_SPEECH_ENGINE_UPSTREAM_PATH} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, Buffer.from(chunk)]);
      const headersEnd = response.indexOf("\r\n\r\n");
      if (headersEnd === -1) return;
      if (!sentPayload) {
        sentPayload = true;
        socket.write(payload);
        return;
      }
      const echoed = response.subarray(headersEnd + 4).toString();
      if (echoed !== payload) return;
      resolve(echoed);
      socket.destroy();
    });
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an IP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}
