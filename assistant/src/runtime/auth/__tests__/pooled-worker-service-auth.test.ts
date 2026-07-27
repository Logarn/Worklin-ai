import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  assertPooledWorkerLeaseAuthorityFile,
  createPooledWorkerLeaseFileAuthority,
  type PooledWorkerLeaseAuthority,
  type PooledWorkerLeaseBinding,
  validatePooledWorkerServiceAuthorization,
} from "../pooled-worker-service-auth.js";
import type { TokenClaims } from "../types.js";

const ACTIVE_BINDING: PooledWorkerLeaseBinding = {
  organizationId: "org-1",
  userId: "user-1",
  assistantId: "asst-1",
  workerStackId: "worker-1",
  leaseGeneration: 2,
  leaseExpiresAtMs: 120_000,
};

function authority(
  binding: PooledWorkerLeaseBinding | null = ACTIVE_BINDING,
): PooledWorkerLeaseAuthority {
  return {
    resolveActiveLease: () => binding,
  };
}

function claims(
  leaseOverrides: Record<string, unknown> = {},
  tokenOverrides: Partial<TokenClaims> = {},
): TokenClaims {
  return {
    iss: "vellum-auth",
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    exp: 90,
    policy_epoch: 1,
    iat: 60,
    jti: "request-1",
    service_tenant_context: {
      version: 1,
      organization_id: "org-1",
      assistant_id: "asst-1",
      service_id: "gateway",
      request_id: "request-1",
    },
    pooled_worker_lease: {
      version: 1,
      issuer_service_id: "runtime_dispatcher",
      organization_id: "org-1",
      user_id: "user-1",
      assistant_id: "asst-1",
      worker_stack_id: "worker-1",
      lease_generation: 2,
      lease_expires_at: 120,
      ...leaseOverrides,
    },
    ...tokenOverrides,
  } as TokenClaims;
}

function validate(
  tokenClaims: TokenClaims,
  leaseAuthority: PooledWorkerLeaseAuthority | null = authority(),
) {
  return validatePooledWorkerServiceAuthorization({
    claims: tokenClaims,
    pooledRuntime: true,
    expectedWorkerStackId: "worker-1",
    nowSeconds: 61,
    authority: leaseAuthority,
  });
}

describe("pooled worker service authorization", () => {
  test("accepts an initialized idle authority at boot but authorizes no tenant", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "pooled-authority-")),
    );
    const authorityFile = join(directory, "active-lease.json");
    try {
      writeFileSync(
        authorityFile,
        JSON.stringify({
          version: 1,
          worker_stack_id: "worker-1",
          authority_generation: 0,
          active_lease: null,
        }),
        { mode: 0o600 },
      );
      assertPooledWorkerLeaseAuthorityFile(authorityFile, "worker-1");
      expect(
        validate(
          claims(),
          createPooledWorkerLeaseFileAuthority(authorityFile, "worker-1"),
        ),
      ).toEqual({
        ok: false,
        reason: "pooled_worker_lease_inactive",
        unavailable: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts an exact dispatcher token for the authoritative active lease", () => {
    expect(validate(claims())).toEqual({ ok: true });
  });

  test("accepts an explicitly lease-bound gateway ingress token", () => {
    expect(
      validate(claims({}, { scope_profile: "gateway_ingress_v1" })),
    ).toEqual({ ok: true });
  });

  test("accepts an actor principal carrying the same lease generation", () => {
    const actorClaims = claims(
      {},
      {
        sub: "actor:self:principal-1",
        scope_profile: "actor_client_v1",
        service_tenant_context: undefined,
        tenant_context: {
          version: 1,
          organization_id: "org-1",
          user_id: "user-1",
          assistant_id: "asst-1",
          actor_id: "principal-1",
          request_id: "request-1",
        },
      },
    );

    expect(validate(actorClaims)).toEqual({ ok: true });
    expect(
      validate(claims({}, { sub: "actor:self:principal-1" })),
    ).toMatchObject({
      ok: false,
      reason: "pooled_worker_lease_claim_malformed",
    });
  });

  test("rejects a static gateway token without a lease claim", () => {
    const token = claims();
    delete (token as TokenClaims & { pooled_worker_lease?: unknown })
      .pooled_worker_lease;

    expect(validate(token)).toEqual({
      ok: false,
      reason: "pooled_worker_lease_claim_missing",
      unavailable: false,
    });
  });

  test.each([
    ["organization", { organization_id: "org-2" }],
    ["user", { user_id: "user-2" }],
    ["assistant", { assistant_id: "asst-2" }],
  ])("rejects a mismatched %s binding", (_label, override) => {
    expect(validate(claims(override))).toMatchObject({
      ok: false,
      unavailable: false,
    });
  });

  test("rejects a token minted for another worker", () => {
    expect(
      validatePooledWorkerServiceAuthorization({
        claims: claims({ worker_stack_id: "worker-2" }),
        pooledRuntime: true,
        expectedWorkerStackId: "worker-1",
        nowSeconds: 61,
        authority: authority(),
      }),
    ).toEqual({
      ok: false,
      reason: "pooled_worker_lease_worker_mismatch",
      unavailable: false,
    });
  });

  test("rejects an expired token and an expired lease", () => {
    expect(
      validatePooledWorkerServiceAuthorization({
        claims: claims({}, { exp: 61 }),
        pooledRuntime: true,
        expectedWorkerStackId: "worker-1",
        nowSeconds: 61,
        authority: authority(),
      }),
    ).toEqual({
      ok: false,
      reason: "pooled_worker_lease_expired",
      unavailable: false,
    });
    expect(
      validate(
        claims(),
        authority({ ...ACTIVE_BINDING, leaseExpiresAtMs: 61_000 }),
      ),
    ).toEqual({
      ok: false,
      reason: "pooled_worker_lease_inactive",
      unavailable: false,
    });
  });

  test("rejects a stale generation after release or reassignment", () => {
    expect(
      validate(
        claims({ lease_generation: 1 }),
        authority({ ...ACTIVE_BINDING, leaseGeneration: 2 }),
      ),
    ).toEqual({
      ok: false,
      reason: "pooled_worker_lease_generation_stale",
      unavailable: false,
    });
    expect(validate(claims(), authority(null))).toEqual({
      ok: false,
      reason: "pooled_worker_lease_inactive",
      unavailable: false,
    });
  });

  test("fails closed when the active-lease authority is unavailable", () => {
    expect(validate(claims(), null)).toEqual({
      ok: false,
      reason: "pooled_worker_lease_authority_unavailable",
      unavailable: true,
    });
    expect(
      validate(claims(), {
        resolveActiveLease: () => {
          throw new Error("authority offline");
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: "pooled_worker_lease_authority_unavailable",
      unavailable: true,
    });
  });

  test("reads the production lease authority on every authorization", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "pooled-authority-")),
    );
    const authorityFile = join(directory, "active-lease.json");
    try {
      writeFileSync(
        authorityFile,
        JSON.stringify({
          version: 1,
          worker_stack_id: "worker-1",
          authority_generation: 2,
          active_lease: {
            organization_id: "org-1",
            user_id: "user-1",
            assistant_id: "asst-1",
            worker_stack_id: "worker-1",
            lease_generation: 2,
            lease_expires_at_ms: 120_000,
          },
        }),
        { mode: 0o600 },
      );
      chmodSync(authorityFile, 0o600);
      const fileAuthority = createPooledWorkerLeaseFileAuthority(
        authorityFile,
        "worker-1",
      );
      expect(validate(claims(), fileAuthority)).toEqual({ ok: true });

      writeFileSync(
        authorityFile,
        JSON.stringify({
          version: 1,
          worker_stack_id: "worker-1",
          authority_generation: 2,
          active_lease: null,
        }),
        { mode: 0o600 },
      );
      chmodSync(authorityFile, 0o600);
      expect(validate(claims(), fileAuthority)).toEqual({
        ok: false,
        reason: "pooled_worker_lease_inactive",
        unavailable: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects writable and symlinked authority files", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "pooled-authority-")),
    );
    const authorityFile = join(directory, "active-lease.json");
    const symlinkFile = join(directory, "active-lease-link.json");
    try {
      writeFileSync(
        authorityFile,
        JSON.stringify({
          version: 1,
          worker_stack_id: "worker-1",
          authority_generation: 2,
          active_lease: null,
        }),
        { mode: 0o600 },
      );
      chmodSync(authorityFile, 0o622);
      expect(() =>
        createPooledWorkerLeaseFileAuthority(
          authorityFile,
          "worker-1",
        ).resolveActiveLease("worker-1"),
      ).toThrow("unsafe");

      chmodSync(authorityFile, 0o600);
      symlinkSync(authorityFile, symlinkFile);
      expect(() =>
        createPooledWorkerLeaseFileAuthority(
          symlinkFile,
          "worker-1",
        ).resolveActiveLease("worker-1"),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves dedicated runtime static service tokens", () => {
    const token = claims();
    delete (token as TokenClaims & { pooled_worker_lease?: unknown })
      .pooled_worker_lease;
    expect(
      validatePooledWorkerServiceAuthorization({
        claims: token,
        pooledRuntime: false,
        expectedWorkerStackId: "",
        nowSeconds: 61,
        authority: null,
      }),
    ).toEqual({ ok: true });
  });
});
