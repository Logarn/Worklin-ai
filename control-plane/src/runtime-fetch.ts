export type RuntimeFetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Prevent private runtime requests from reusing a socket across deployments. */
export function runtimeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImplementation: RuntimeFetchImplementation = globalThis.fetch,
): Promise<Response> {
  return fetchImplementation(input, {
    ...init,
    keepalive: false,
  });
}
