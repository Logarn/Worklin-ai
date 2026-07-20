import {
  connect as connectTcp,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { connect as connectTls } from "node:tls";

const MAX_INITIAL_REQUEST_BYTES = 64 * 1024;
const ROUTE_TIMEOUT_MS = 10_000;

export type PublicEdgeRouterOptions = {
  controlPlaneUrl: string;
};

export function routeInitialRequest(
  _initialRequest: Buffer,
  options: PublicEdgeRouterOptions,
): URL {
  return new URL(options.controlPlaneUrl);
}

export function createPublicEdgeRouter(
  options: PublicEdgeRouterOptions,
): Server {
  return createServer((clientSocket) => {
    let initialRequest = Buffer.alloc(0);
    let routed = false;

    clientSocket.on("error", () => {});
    clientSocket.setTimeout(ROUTE_TIMEOUT_MS, () => {
      sendError(clientSocket, 408, "Request Timeout");
    });

    const handleInitialData = (chunk: Buffer) => {
      initialRequest = Buffer.concat([initialRequest, chunk]);
      const headersEnd = initialRequest.indexOf("\r\n\r\n");
      if (headersEnd === -1) {
        if (initialRequest.length > MAX_INITIAL_REQUEST_BYTES) {
          sendError(clientSocket, 431, "Request Header Fields Too Large");
        }
        return;
      }
      if (headersEnd > MAX_INITIAL_REQUEST_BYTES) {
        sendError(clientSocket, 431, "Request Header Fields Too Large");
        return;
      }

      routed = true;
      clientSocket.pause();
      clientSocket.off("data", handleInitialData);
      connectUpstream(
        routeInitialRequest(initialRequest, options),
        clientSocket,
        initialRequest,
      );
    };

    clientSocket.on("data", handleInitialData);
    clientSocket.once("close", () => {
      if (!routed) initialRequest = Buffer.alloc(0);
    });
  });
}

function connectUpstream(
  target: URL,
  clientSocket: Socket,
  initialRequest: Buffer,
): void {
  let connected = false;
  const upstreamSocket =
    target.protocol === "https:"
      ? connectTls({
          host: target.hostname,
          port: Number(target.port || 443),
          servername: target.hostname,
        })
      : connectTcp({
          host: target.hostname,
          port: Number(target.port || 80),
        });
  const connectEvent =
    target.protocol === "https:" ? "secureConnect" : "connect";

  upstreamSocket.once(connectEvent, () => {
    connected = true;
    clientSocket.setTimeout(0);
    upstreamSocket.write(initialRequest);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.resume();
  });
  upstreamSocket.once("error", () => {
    if (connected) clientSocket.destroy();
    else sendError(clientSocket, 502, "Bad Gateway");
  });
  clientSocket.once("close", () => upstreamSocket.destroy());
}

function sendError(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}
