import { isLoopbackHost } from "../runtime/middleware/auth.js";

export const RUNTIME_HTTP_LOOPBACK_FALLBACK_HOST = "127.0.0.1";

const LISTEN_ERROR_CODES = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EPERM",
]);

/**
 * Retry non-loopback runtime HTTP bind failures on loopback so the gateway
 * can still reach the assistant within a shared container.
 */
export function shouldRetryRuntimeHttpOnLoopback(
  hostname: string,
  err: unknown,
): boolean {
  if (isLoopbackHost(hostname)) return false;
  if (!err || typeof err !== "object") return false;

  const maybeError = err as { code?: unknown; syscall?: unknown };
  return (
    maybeError.syscall === "listen" ||
    (typeof maybeError.code === "string" &&
      LISTEN_ERROR_CODES.has(maybeError.code))
  );
}
