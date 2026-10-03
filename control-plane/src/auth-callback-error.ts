import type { ErrorRequestHandler } from "express";

/** Recover from rejected OIDC transactions without exposing callback details. */
export function authCallbackErrorHandler(publicOrigin: string): ErrorRequestHandler {
  const loginUrl = new URL("/account/login", publicOrigin).href;
  return (error: unknown, req, res, next) => {
    const status = error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
    if (
      res.headersSent ||
      (req.path !== "/callback" && req.path !== "/callback/") ||
      (status !== 400 && status !== 401)
    ) {
      next(error);
      return;
    }
    console.warn("auth_callback_rejected", { status });
    res.status(status)
      .set("Cache-Control", "private, no-store")
      .set("Referrer-Policy", "no-referrer")
      .type("html")
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in again — Worklin</title></head>
<body><main><h1>Please sign in again</h1>
<p>Your sign-in session expired or could not be verified. Start a fresh sign-in to continue.</p>
<p><a href="${loginUrl}">Sign in to Worklin</a></p></main></body></html>`);
  };
}
