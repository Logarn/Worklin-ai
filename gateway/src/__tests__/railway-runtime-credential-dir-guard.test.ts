import { describe, expect, test } from "bun:test";

describe("Railway runtime credential directory wiring", () => {
  test("runtime stores CES credentials under a CES-owned writable directory", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(entrypoint).toContain(
      ': "${CREDENTIAL_SECURITY_DIR:=${CES_DATA_DIR%/}/security}"',
    );
    expect(entrypoint).toContain(
      'fallback_credential_security_dir="${CES_DATA_DIR%/}/security"',
    );
    expect(entrypoint).toContain(
      'runuser -u ces -g ces -G vellum -- test -w "${CREDENTIAL_SECURITY_DIR}"',
    );
    expect(dockerfile).toContain(
      "ENV CREDENTIAL_SECURITY_DIR=/data/ces-data/security",
    );
    expect(dockerfile).not.toContain(
      "ENV CREDENTIAL_SECURITY_DIR=/data/ces-security",
    );
  });
});
