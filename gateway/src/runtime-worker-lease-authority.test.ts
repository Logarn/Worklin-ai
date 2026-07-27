import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { RuntimeWorkerLeaseClaim } from "./auth/types.js";
import {
  initializeRuntimeWorkerLeaseAuthority,
  installRuntimeWorkerLeaseAuthority,
  revokeRuntimeWorkerLeaseAuthority,
} from "./runtime-worker-lease-authority.js";

function claim(
  generation: number,
  overrides: Partial<RuntimeWorkerLeaseClaim> = {},
): RuntimeWorkerLeaseClaim {
  return {
    version: 1,
    issuer_service_id: "runtime_dispatcher",
    organization_id: "org-1",
    user_id: "user-1",
    assistant_id: "asst-1",
    worker_stack_id: "worker-1",
    lease_generation: generation,
    lease_expires_at: 120 + generation,
    ...overrides,
  };
}

describe("runtime worker lease authority", () => {
  test("initializes an idle worker without authorizing a tenant", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "gateway-authority-")),
    );
    const authorityFile = join(
      directory,
      "lease-authority",
      "active-lease.json",
    );
    try {
      expect(
        initializeRuntimeWorkerLeaseAuthority(authorityFile, "worker-1"),
      ).toBe("initialized");
      expect(
        initializeRuntimeWorkerLeaseAuthority(authorityFile, "worker-1"),
      ).toBe("idempotent");
      expect(JSON.parse(readFileSync(authorityFile, "utf8"))).toEqual({
        version: 1,
        worker_stack_id: "worker-1",
        authority_generation: 0,
        active_lease: null,
      });
      expect(statSync(authorityFile).mode & 0o777).toBe(0o640);
      expect(statSync(join(directory, "lease-authority")).mode & 0o777).toBe(
        0o750,
      );

      expect(installRuntimeWorkerLeaseAuthority(authorityFile, claim(1))).toBe(
        "installed",
      );
      expect(
        initializeRuntimeWorkerLeaseAuthority(authorityFile, "worker-1"),
      ).toBe("idempotent");
      expect(
        JSON.parse(readFileSync(authorityFile, "utf8")).authority_generation,
      ).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically installs, revokes, and fences stale generations", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "gateway-authority-")),
    );
    const authorityFile = join(directory, "active-lease.json");
    try {
      expect(installRuntimeWorkerLeaseAuthority(authorityFile, claim(1))).toBe(
        "installed",
      );
      expect(installRuntimeWorkerLeaseAuthority(authorityFile, claim(1))).toBe(
        "idempotent",
      );
      expect(
        revokeRuntimeWorkerLeaseAuthority(authorityFile, {
          workerStackId: "worker-1",
          leaseGeneration: 1,
        }),
      ).toBe("revoked");
      expect(installRuntimeWorkerLeaseAuthority(authorityFile, claim(1))).toBe(
        "stale",
      );

      expect(
        installRuntimeWorkerLeaseAuthority(
          authorityFile,
          claim(2, {
            organization_id: "org-2",
            user_id: "user-2",
            assistant_id: "asst-2",
          }),
        ),
      ).toBe("installed");
      expect(
        revokeRuntimeWorkerLeaseAuthority(authorityFile, {
          workerStackId: "worker-1",
          leaseGeneration: 1,
        }),
      ).toBe("stale");

      expect(JSON.parse(readFileSync(authorityFile, "utf8"))).toMatchObject({
        version: 1,
        worker_stack_id: "worker-1",
        authority_generation: 2,
        active_lease: {
          organization_id: "org-2",
          user_id: "user-2",
          assistant_id: "asst-2",
          worker_stack_id: "worker-1",
          lease_generation: 2,
          lease_expires_at_ms: 122_000,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects conflicting tenants within one generation", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "gateway-authority-")),
    );
    const authorityFile = join(directory, "active-lease.json");
    try {
      installRuntimeWorkerLeaseAuthority(authorityFile, claim(1));
      expect(() =>
        installRuntimeWorkerLeaseAuthority(
          authorityFile,
          claim(1, { assistant_id: "asst-2" }),
        ),
      ).toThrow("generation conflicts");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
