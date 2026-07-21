import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const entrypointPath = join(import.meta.dir, "entrypoint.sh");
const entrypoint = readFileSync(entrypointPath, "utf8");

describe("production pooled-worker runtime", () => {
  test("starts the assistant and gateway without a nested control plane", () => {
    expect(entrypoint).toContain(
      'start_as gateway bash -lc "cd /app/gateway && exec bun --smol run src/index.ts"',
    );
    expect(entrypoint).toContain(
      'start_as assistant bash -lc "cd /app/assistant && exec /app/assistant/docker-entrypoint.sh"',
    );
    expect(entrypoint).toContain(
      'if [[ "${WORKLIN_RUNTIME_MODE}" == "combined" ]]; then',
    );
    expect(entrypoint).toContain(
      '"${WORKLIN_RUNTIME_MODE}" == "pooled_worker"',
    );
    expect(entrypoint).toContain(
      "WORKLIN_CONTROL_PLANE_INTERNAL_URL is required for pooled workers",
    );
    expect(entrypoint).toContain(
      "WORKLIN_RUNTIME_WORKER_STACK_ID is required for pooled workers",
    );
    expect(entrypoint).toContain(
      "ACTOR_TOKEN_SIGNING_KEY must be the explicit 64-hex derived key for this pooled worker",
    );
    expect(entrypoint).toContain(
      'pooled_ipc_socket_dir="/run/worklin-runtime-ipc"',
    );
    expect(entrypoint).toContain('pooled_workspace_dir="/data/workspace"');
    expect(entrypoint).toContain(
      "VELLUM_WORKSPACE_DIR must use the isolated pooled tenant workspace path",
    );
    expect(entrypoint).toContain(
      ': "${GATEWAY_IPC_SOCKET_DIR:=${pooled_ipc_socket_dir}}"',
    );
    expect(entrypoint).toContain(
      "GATEWAY_IPC_SOCKET_DIR must use the non-workspace pooled runtime path",
    );
    expect(entrypoint).toContain(
      'pooled_authority_dir="${GATEWAY_IPC_SOCKET_DIR%/}/runtime-worker-authority"',
    );
    expect(entrypoint).toContain(
      'chown gateway:vellum "${pooled_authority_dir}"',
    );
    expect(entrypoint).toContain(
      'chmod 2750 "${pooled_authority_dir}"',
    );
    expect(entrypoint).toContain(
      ': "${WORKLIN_CONTROL_PLANE_INTERNAL_URL:=http://127.0.0.1:${WORKLIN_CONTROL_PLANE_PORT}}"',
    );
    expect(entrypoint).toContain(': "${GATEWAY_PORT:=${PORT}}"');
    expect(entrypoint).not.toContain(
      'if [[ "${WORKLIN_RUNTIME_MODE}" != "isolated" ]]; then',
    );
  });

  test("fails before startup without an explicit private control-plane URL", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
    };
    delete env.WORKLIN_CONTROL_PLANE_INTERNAL_URL;
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "WORKLIN_CONTROL_PLANE_INTERNAL_URL is required for pooled workers",
    );
  });

  test("fails before startup without an immutable worker binding", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
      WORKLIN_CONTROL_PLANE_INTERNAL_URL:
        "http://control-plane.railway.internal:8082",
    };
    delete env.WORKLIN_RUNTIME_WORKER_STACK_ID;
    delete env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE;
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "WORKLIN_RUNTIME_WORKER_STACK_ID is required for pooled workers",
    );
  });

  test("rejects an authority path outside the shared runtime directory", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
      WORKLIN_CONTROL_PLANE_INTERNAL_URL:
        "http://control-plane.railway.internal:8082",
      WORKLIN_RUNTIME_WORKER_STACK_ID: "worker-1",
      WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE:
        "/tmp/unshared-authority.json",
    };
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE must use the shared runtime authority path",
    );
  });

  test("rejects a pooled IPC path inside the tenant workspace", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
      WORKLIN_CONTROL_PLANE_INTERNAL_URL:
        "http://control-plane.railway.internal:8082",
      WORKLIN_RUNTIME_WORKER_STACK_ID: "worker-1",
      GATEWAY_IPC_SOCKET_DIR: "/data/workspace/runtime-ipc",
    };
    delete env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE;
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "GATEWAY_IPC_SOCKET_DIR must use the non-workspace pooled runtime path",
    );
  });

  test("rejects a pooled tenant workspace that contains the IPC runtime", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
      WORKLIN_CONTROL_PLANE_INTERNAL_URL:
        "http://control-plane.railway.internal:8082",
      WORKLIN_RUNTIME_WORKER_STACK_ID: "worker-1",
      VELLUM_WORKSPACE_DIR: "/run",
    };
    delete env.GATEWAY_IPC_SOCKET_DIR;
    delete env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE;
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "VELLUM_WORKSPACE_DIR must use the isolated pooled tenant workspace path",
    );
  });

  test("fails before startup without the worker-derived actor signing key", () => {
    const env = {
      ...process.env,
      WORKLIN_RUNTIME_MODE: "pooled_worker",
      WORKLIN_CONTROL_PLANE_INTERNAL_URL:
        "http://control-plane.railway.internal:8082",
      WORKLIN_RUNTIME_WORKER_STACK_ID: "worker-1",
    };
    delete env.ACTOR_TOKEN_SIGNING_KEY;
    delete env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE;
    const result = Bun.spawnSync(["bash", entrypointPath], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "ACTOR_TOKEN_SIGNING_KEY must be the explicit 64-hex derived key for this pooled worker",
    );
  });
});
