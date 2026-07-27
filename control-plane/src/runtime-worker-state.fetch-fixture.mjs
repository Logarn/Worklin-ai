import { appendFileSync } from "node:fs";

const realFetch = globalThis.fetch.bind(globalThis);
const stateBody = new TextEncoder().encode("pooled-state");
const statePathPattern =
  /^\/worklin-pool-test-state\/tenant-state\/org-pool\/asst-pool\/generation-[1-9]\d*\.vbundle$/u;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (
    url.origin !== "https://storage.googleapis.com" ||
    !statePathPattern.test(url.pathname) ||
    (request.method !== "HEAD" && request.method !== "GET")
  ) {
    return realFetch(input, init);
  }

  const auditPath = process.env.WORKLIN_TEST_STATE_FETCH_AUDIT_PATH;
  if (auditPath) {
    appendFileSync(
      auditPath,
      `${JSON.stringify({ method: request.method, path: url.pathname })}\n`,
    );
  }
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(stateBody.byteLength),
  };
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(stateBody, { status: 200, headers });
};
