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
