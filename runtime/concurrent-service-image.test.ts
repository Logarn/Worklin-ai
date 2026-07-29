import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const entrypoint = readFileSync(
  join(import.meta.dir, "entrypoint.sh"),
  "utf8",
);
const dockerfile = readFileSync(
  join(import.meta.dir, "Dockerfile"),
  "utf8",
);

describe("concurrent service image", () => {
  test("uses the shared HTTP kernel without launching the single-tenant assistant", () => {
    expect(entrypoint).toContain(
      'elif [[ "${WORKLIN_RUNTIME_MODE}" == "concurrent_service" ]]',
    );
    expect(entrypoint).toContain(
      "exec bun run src/concurrent-runtime/main.ts",
    );
    expect(entrypoint).toContain(
      'RUNTIME_ASSISTANT_SCOPE_MODE:=tenant_context',
    );
    expect(entrypoint).toContain(
      "CONCURRENT_RUNTIME_DATABASE_URL is required",
    );
    expect(entrypoint).toContain(
      "WORKLIN_PLATFORM_ASSISTANT_ID must be unset",
    );
  });

  test("ships the assistant, gateway, and credential executor packages", () => {
    expect(dockerfile).toContain("COPY assistant/");
    expect(dockerfile).toContain("COPY gateway/");
    expect(dockerfile).toContain("COPY credential-executor/");
  });
});
