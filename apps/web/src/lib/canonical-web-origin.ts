export const CANONICAL_WORKLIN_WEB_HOST = "worklin-ai.vercel.app";
export const CANONICAL_WORKLIN_WEB_ORIGIN =
  `https://${CANONICAL_WORKLIN_WEB_HOST}`;

const LEGACY_WORKLIN_WEB_HOST = "ai-retention-marketer.vercel.app";
const VERCEL_HOST_SUFFIX = ".vercel.app";

function isWorklinVercelHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === LEGACY_WORKLIN_WEB_HOST ||
    (normalized.endsWith(VERCEL_HOST_SUFFIX) &&
      normalized.startsWith("worklin-"))
  );
}

export function resolveCanonicalWorklinWebUrl(
  currentUrl: string,
): string | null {
  const url = new URL(currentUrl);
  if (
    url.hostname.toLowerCase() === CANONICAL_WORKLIN_WEB_HOST ||
    !isWorklinVercelHost(url.hostname)
  ) {
    return null;
  }

  url.protocol = "https:";
  url.hostname = CANONICAL_WORKLIN_WEB_HOST;
  url.port = "";
  return url.toString();
}
