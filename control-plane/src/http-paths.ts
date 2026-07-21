export function normalizeHttpPath(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function pathEquals(pathname: string, expected: string): boolean {
  return normalizeHttpPath(pathname) === normalizeHttpPath(expected);
}

export function pathIsOrStartsWith(
  pathname: string,
  expectedPrefix: string,
): boolean {
  const normalizedPath = normalizeHttpPath(pathname);
  const normalizedPrefix = normalizeHttpPath(expectedPrefix);
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

export function canonicalizeAssistantRequestPath(
  pathname: string,
): string | null {
  if (/\/{2,}/.test(pathname) || pathname.includes("\\")) return null;

  const canonicalSegments: string[] = [];
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      /[\u0000-\u001f\u007f\\/?#%]/.test(decoded)
    ) {
      return null;
    }
    canonicalSegments.push(decoded);
  }

  return canonicalSegments.join("/");
}
