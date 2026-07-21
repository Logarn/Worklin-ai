import { validatePooledWorkerLeaseClaims } from "../../auth/pooled-worker-lease.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { revokeRuntimeWorkerLeaseAuthority } from "../../runtime-worker-lease-authority.js";

const MAX_BODY_BYTES = 4 * 1024;

interface RevokeRequestBody {
  worker_stack_id: string;
  lease_generation: number;
}

export function createRuntimeWorkerLeaseRevokeHandler(
  config: Pick<
    GatewayConfig,
    "runtimeWorkerLeaseAuthorityFile" | "runtimeWorkerStackId"
  >,
) {
  return async (req: Request): Promise<Response> => {
    if (
      !config.runtimeWorkerStackId ||
      !config.runtimeWorkerLeaseAuthorityFile
    ) {
      return Response.json(
        { error: "Worker lease authority unavailable" },
        { status: 503 },
      );
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const verified = validateEdgeToken(token);
    if (!verified.ok) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const subject = parseSub(verified.claims.sub);
    if (
      !subject.ok ||
      subject.principalType !== "svc_gateway" ||
      verified.claims.scope_profile !== "gateway_service_v1"
    ) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const lease = validatePooledWorkerLeaseClaims(
      verified.claims,
      config.runtimeWorkerStackId,
    );
    if (!lease.ok || !lease.claim) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await readRevokeBody(req);
    if (
      !body ||
      body.worker_stack_id !== lease.claim.worker_stack_id ||
      body.lease_generation !== lease.claim.lease_generation
    ) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const update = revokeRuntimeWorkerLeaseAuthority(
        config.runtimeWorkerLeaseAuthorityFile,
        {
          workerStackId: lease.claim.worker_stack_id,
          leaseGeneration: lease.claim.lease_generation,
        },
      );
      if (update === "stale") {
        return Response.json({ error: "Stale lease" }, { status: 409 });
      }
      if (update !== "revoked" && update !== "already_revoked") {
        return Response.json(
          { error: "Worker lease authority unavailable" },
          { status: 503 },
        );
      }
      return Response.json({
        status: update,
        worker_stack_id: lease.claim.worker_stack_id,
        lease_generation: lease.claim.lease_generation,
      });
    } catch {
      return Response.json(
        { error: "Worker lease authority unavailable" },
        { status: 503 },
      );
    }
  };
}

async function readRevokeBody(req: Request): Promise<RevokeRequestBody | null> {
  if (
    req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return null;
  }
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.worker_stack_id !== "string" ||
    !Number.isSafeInteger(record.lease_generation) ||
    (record.lease_generation as number) < 1
  ) {
    return null;
  }
  return {
    worker_stack_id: record.worker_stack_id,
    lease_generation: record.lease_generation as number,
  };
}
