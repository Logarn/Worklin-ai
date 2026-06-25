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

export const platformApiBaseUrl = normalizeConfiguredOrigin(
  import.meta.env.VITE_PLATFORM_API_BASE_URL,
);

export const authApiBaseUrl =
  normalizeConfiguredOrigin(import.meta.env.VITE_AUTH_API_BASE_URL) ??
  platformApiBaseUrl;

export const daemonApiBaseUrl =
  normalizeConfiguredOrigin(import.meta.env.VITE_DAEMON_API_BASE_URL) ??
  platformApiBaseUrl;

export function resolveAuthActionUrl(path: string): string {
  const origin = authApiBaseUrl ?? window.location.origin;
  return new URL(path, origin).href;
}
