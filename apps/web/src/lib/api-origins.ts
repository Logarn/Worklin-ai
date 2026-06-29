function normalizeConfiguredOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid API origin: ${trimmed}`);
  }
}

const CANONICAL_WEB_ORIGIN = "https://worklin-ai.vercel.app";
const LEGACY_WEB_ORIGIN = "https://ai-retention-marketer.vercel.app";

function shouldUseHostedProxy(): boolean {
  if (typeof window === "undefined") return false;
  const origin = window.location.origin;
  return origin === CANONICAL_WEB_ORIGIN || origin === LEGACY_WEB_ORIGIN;
}

function resolveHostedOrigin(value: string | undefined): string | undefined {
  return shouldUseHostedProxy() ? undefined : normalizeConfiguredOrigin(value);
}

export const platformApiBaseUrl = normalizeConfiguredOrigin(
  resolveHostedOrigin(import.meta.env.VITE_PLATFORM_API_BASE_URL),
);

export const authApiBaseUrl =
  resolveHostedOrigin(import.meta.env.VITE_AUTH_API_BASE_URL) ??
  platformApiBaseUrl;

export const daemonApiBaseUrl =
  resolveHostedOrigin(import.meta.env.VITE_DAEMON_API_BASE_URL) ??
  platformApiBaseUrl;

export function resolveAuthActionUrl(path: string): string {
  const origin = authApiBaseUrl ?? window.location.origin;
  return new URL(path, origin).href;
}
