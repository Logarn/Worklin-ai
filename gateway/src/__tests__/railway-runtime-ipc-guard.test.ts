import { describe, expect, test } from "bun:test";

describe("Railway runtime gateway IPC wiring", () => {
  test("uses the shared volume and waits for the gateway before assistant startup", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();

    expect(entrypoint).toContain(
      ': "${GATEWAY_IPC_SOCKET_DIR:=${VELLUM_WORKSPACE_DIR%/}/runtime-ipc}"',
    );
    expect(entrypoint).toContain(
      'gateway_socket_path="${GATEWAY_IPC_SOCKET_DIR%/}/gateway.sock"',
    );
    expect(entrypoint).toContain(
      'if [[ ! -S "${gateway_socket_path}" ]]; then',
    );
    expect(entrypoint).toContain('chmod 660 "${gateway_socket_path}"');

    const gatewayStart = entrypoint.indexOf(
      'start_as gateway bash -lc "cd /app/gateway',
    );
    const gatewayWait = entrypoint.indexOf(
      'if [[ ! -S "${gateway_socket_path}" ]]; then',
    );
    const assistantStart = entrypoint.indexOf(
      'start_as assistant bash -lc "cd /app/assistant',
    );

    expect(gatewayStart).toBeGreaterThan(-1);
    expect(gatewayWait).toBeGreaterThan(gatewayStart);
    expect(assistantStart).toBeGreaterThan(gatewayWait);
  });
});
