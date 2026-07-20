import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const entrypoint = readFileSync(join(import.meta.dir, "entrypoint.sh"), "utf8");

describe("production control-plane-only runtime", () => {
  test("starts only the public control plane before shared runtime setup", () => {
    const modeStart = entrypoint.indexOf(
      'if [[ "${WORKLIN_RUNTIME_MODE}" == "control-plane" ]]; then',
    );
    const modeEnd = entrypoint.indexOf("\nfi", modeStart);
    const sharedSetup = entrypoint.indexOf(
      'start_as ces bash -lc "cd /app/credential-executor',
    );
    const modeBlock = entrypoint.slice(modeStart, modeEnd);

    expect(modeStart).toBeGreaterThan(-1);
    expect(modeEnd).toBeGreaterThan(modeStart);
    expect(modeEnd).toBeLessThan(sharedSetup);
    expect(modeBlock).toContain("cd /app/control-plane");
    expect(modeBlock).toContain("src/index.ts");
    expect(modeBlock).toContain("src/public-edge.ts");
    expect(modeBlock).not.toContain("/app/assistant");
    expect(modeBlock).not.toContain("/app/gateway");
    expect(modeBlock).not.toContain("/app/credential-executor");
    expect(modeBlock).toContain("wait_for_process_exit");
  });
});
