import { afterEach, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authCallbackErrorHandler } from "./auth-callback-error.js";

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function request(path: string, status: number) {
  const app = express();
  app.use((_req, _res, next) => next(Object.assign(new Error("private provider details"), { status })));
  app.use(authCallbackErrorHandler("https://app.example.com"));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ detail: "Internal server error." });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
}

test("missing transaction cookie gives a safe fresh-login link", async () => {
  const response = await request("/callback?code=example-code&state=example-state", 400);
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await response.text();
  expect(body).toContain('href="https://app.example.com/account/login"');
  expect(body).not.toContain("private provider details");
  expect(body).not.toContain("example-code");
  expect(body).not.toContain("example-state");
});

test("unauthorized callback with trailing slash is recoverable", async () => {
  const response = await request("/callback/", 401);
  expect(response.status).toBe(401);
  expect(await response.text()).toContain("Please sign in again");
});

test("unrelated failures and server errors retain the ordinary error path", async () => {
  for (const [path, status] of [["/v1/example", 400], ["/callback", 500]] as const) {
    const response = await request(path, status);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: "Internal server error." });
  }
});
