export type RetentionAssistantOperatorRequest = {
  organizationId: string;
  userId: string;
  assistantId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseRetentionAssistantOperatorRequest(
  value: unknown,
  maxBodyBytes: number,
): RetentionAssistantOperatorRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    !isBoundedString(input.organizationId, 64) ||
    !UUID_PATTERN.test(input.organizationId) ||
    !isBoundedString(input.userId, 512) ||
    !isBoundedString(input.assistantId, 256) ||
    (input.method !== "GET" && input.method !== "POST") ||
    !isBoundedString(input.path, 512) ||
    !isRetentionAssistantOperatorRoute(input.method, input.path)
  ) {
    return null;
  }
  if (
    input.method === "GET" &&
    Object.prototype.hasOwnProperty.call(input, "body")
  ) {
    return null;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(input.body ?? null);
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBodyBytes) return null;
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    assistantId: input.assistantId,
    method: input.method,
    path: input.path,
    ...(input.method === "POST" ? { body: input.body ?? {} } : {}),
  };
}

export function isRetentionAssistantOperatorRoute(
  method: "GET" | "POST",
  path: string,
): boolean {
  if (
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /%(?:2f|5c)/iu.test(path) ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }
  if (method === "GET") {
    return (
      path === "/v1/retention/status" ||
      /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/approval-preview$/iu.test(
        path,
      )
    );
  }
  return (
    path === "/v1/retention/brands" ||
    path === "/v1/retention/programs" ||
    path === "/v1/retention/segments" ||
    path === "/v1/retention/reasoning/claim" ||
    path === "/v1/retention/decisions/complete" ||
    path === "/v1/retention/campaigns" ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/audience\/freeze$/iu.test(
      path,
    ) ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/generation\/prepare$/iu.test(
      path,
    ) ||
    /^\/v1\/retention\/campaigns\/[0-9a-f-]+\/messages$/iu.test(path)
  );
}

export function retentionAssistantOperatorProxyRequest(
  input: RetentionAssistantOperatorRequest,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  return new Request(new URL(input.path, "http://retention.internal"), {
    method: input.method,
    headers,
    ...(input.method === "POST"
      ? { body: JSON.stringify(input.body ?? {}) }
      : {}),
  });
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}
