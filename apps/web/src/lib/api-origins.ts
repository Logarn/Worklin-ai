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

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function resolveHostedProxyOrigin(
  configuredOrigins: Array<string | undefined>,
): string | undefined {
  if (typeof window === "undefined") return undefined;

  let current: URL;
  try {
    current = new URL(window.location.origin);
  } catch {
    return undefined;
  }

  if (isLoopbackHostname(current.hostname)) return undefined;

  const hasCrossOriginTarget = configuredOrigins.some((origin) => {
    if (!origin) return false;
    try {
      return new URL(origin).origin !== current.origin;
    } catch {
      return false;
    }
  });

  return hasCrossOriginTarget ? current.origin : undefined;
}

function joinBaseAndPath(base: string, path: string): string {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = path.replace(/^\//, "");
  return new URL(normalizedPath, normalizedBase).toString();
}

const HOSTED_PROXY_PATH_PREFIXES = ["/_allauth/", "/v1/"] as const;

/** Normalize same-origin proxy requests before they reach the hosting layer. */
export function normalizeHostedProxyPath(
  path: string,
  currentOrigin = typeof window === "undefined" ? "" : window.location.origin,
): string {
  if (!currentOrigin) return path;

  let url: URL;
  try {
    url = new URL(path, currentOrigin);
  } catch {
    return path;
  }

  if (url.origin !== currentOrigin) return path;

  const shouldNormalize =
    url.pathname === "/callback/" ||
    HOSTED_PROXY_PATH_PREFIXES.some((prefix) =>
      url.pathname.startsWith(prefix),
    );

  if (!shouldNormalize || !url.pathname.endsWith("/")) return path;

  url.pathname = url.pathname.replace(/\/+$/, "");
  if (/^https?:\/\//.test(path)) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

const configuredPlatformApiBaseUrl = normalizeConfiguredOrigin(
  import.meta.env.VITE_PLATFORM_API_BASE_URL,
);
const configuredAuthApiBaseUrl = normalizeConfiguredOrigin(
  import.meta.env.VITE_AUTH_API_BASE_URL,
);
const configuredDaemonApiBaseUrl = normalizeConfiguredOrigin(
  import.meta.env.VITE_DAEMON_API_BASE_URL,
);
const hostedProxyOrigin = resolveHostedProxyOrigin([
  configuredPlatformApiBaseUrl,
  configuredAuthApiBaseUrl,
  configuredDaemonApiBaseUrl,
]);

// Hosted Worklin serves the SPA on Vercel and proxies the control-plane paths
// (`/callback`, `/_allauth/*`, `/v1/*`) back to Railway. Keeping the public
// origin single-domain avoids Safari / privacy-mode third-party-cookie drops
// during login, hatching, and assistant bootstrap.
export const platformApiBaseUrl =
  hostedProxyOrigin ?? configuredPlatformApiBaseUrl;

export const authApiBaseUrl =
  hostedProxyOrigin ?? configuredAuthApiBaseUrl ?? platformApiBaseUrl;

export const daemonApiBaseUrl =
  hostedProxyOrigin ??
  configuredDaemonApiBaseUrl ??
  platformApiBaseUrl;

export function resolvePlatformActionUrl(path: string): string {
  const base = platformApiBaseUrl ?? window.location.origin;
  return joinBaseAndPath(base, path);
}

export function resolveAuthActionUrl(path: string): string {
  const base = authApiBaseUrl ?? window.location.origin;
  return joinBaseAndPath(base, path);
}
