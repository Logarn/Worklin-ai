import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "bun:test";

import type { AuthContext, Scope } from "../../auth/types.js";
import {
  exportPooledWorkerState,
  requireVerifiedPooledStateServiceContext,
  sanitizePooledStateConfig,
} from "../pooled-state-export.js";
import { validateVBundle } from "../vbundle-validator.js";

const BUNDLE_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = new Date("2026-07-20T14:00:00.000Z");
const WORKER = "worker-1";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function serviceAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    subject: "svc:gateway:self",
    principalType: "svc_gateway",
    assistantId: "self",
    scopeProfile: "gateway_service_v1",
    scopes: new Set<Scope>(["internal.write"]),
    policyEpoch: 1,
    serviceTenantContext: {
      version: 1,
      organizationId: "org-1",
      assistantId: "assistant-1",
      serviceId: "gateway",
      requestId: "request-1",
    },
    ...overrides,
  };
}

async function workspaceFixture(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pooled-export-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "data", "db"), { recursive: true });
  await writeFile(
    join(workspace, "data", "db", "assistant.db"),
    "database-state",
  );
  await writeFile(
    join(workspace, "config.json"),
    JSON.stringify({
      theme: "dark",
      webhook_secret: "gateway-secret",
      nested: {
        apiKey: "provider-secret",
        safe: "preserved",
      },
    }),
  );
  return workspace;
}

function exportInput(workspaceDir: string) {
  return {
    authContext: serviceAuth(),
    workspaceDir,
    workerStackId: WORKER,
    generation: 3,
    bundleId: BUNDLE_ID,
    createdAt: CREATED_AT,
    assistantName: "Worklin",
    runtimeVersion: "1.0.0",
  };
}

describe("pooled state service context", () => {
  test("accepts only a verified gateway service tenant binding", () => {
    expect(requireVerifiedPooledStateServiceContext(serviceAuth())).toEqual({
      organizationId: "org-1",
      assistantId: "assistant-1",
      serviceId: "gateway",
      requestId: "request-1",
    });

    const denied: AuthContext[] = [
      serviceAuth({ principalType: "actor" }),
      serviceAuth({ subject: "svc:gateway:other-assistant" }),
      serviceAuth({ scopeProfile: "gateway_ingress_v1" }),
      serviceAuth({ scopes: new Set<Scope>() }),
      serviceAuth({ serviceTenantContext: undefined }),
      serviceAuth({
        serviceTenantContext: {
          version: 1,
          organizationId: undefined,
          assistantId: "assistant-1",
          serviceId: "gateway",
          requestId: "request-1",
        },
      }),
    ];
    for (const context of denied) {
      expect(() => requireVerifiedPooledStateServiceContext(context)).toThrow(
        "Verified gateway tenant context is required",
      );
    }
  });
});

describe("pooled state export", () => {
  test("emits a deterministic credential-free manifest and receipt", async () => {
    const workspace = await workspaceFixture();
    await mkdir(join(workspace, "credentials"), { recursive: true });
    await mkdir(join(workspace, "data", "secrets"), { recursive: true });
    await writeFile(
      join(workspace, "credentials", "provider-key"),
      "ces-secret",
    );
    await writeFile(
      join(workspace, "data", "secrets", "gateway-key"),
      "gateway-secret",
    );
    await writeFile(join(workspace, ".backup.key"), "backup-secret");

    const first = await exportPooledWorkerState(exportInput(workspace));
    const second = await exportPooledWorkerState(exportInput(workspace));
    try {
      expect(first.receipt).toEqual(second.receipt);
      expect(
        readFileSync(first.tempPath).equals(readFileSync(second.tempPath)),
      ).toBe(true);
      expect(first.receipt).toMatchObject({
        tenant: {
          organizationId: "org-1",
          assistantId: "assistant-1",
        },
        workerStackId: WORKER,
        generation: 3,
        bundleId: BUNDLE_ID,
        createdAt: CREATED_AT.toISOString(),
        credentialsIncluded: 0,
        secretsRedacted: true,
      });
      expect(first.receipt.files.map(({ path }) => path)).toEqual(
        [...first.receipt.files.map(({ path }) => path)].sort(),
      );
      expect(first.receipt.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(first.receipt.manifestChecksumSha256).toBe(
        first.manifest.checksum,
      );
      expect(first.receipt.byteSize).toBeGreaterThan(0);
      expect(validateVBundle(readFileSync(first.tempPath)).is_valid).toBe(true);

      const entries = readTarEntries(readFileSync(first.tempPath));
      expect(
        [...entries.keys()].some((path) => path.includes("credentials")),
      ).toBe(false);
      expect([...entries.keys()].some((path) => path.includes("secrets"))).toBe(
        false,
      );
      expect(entries.has("workspace/.backup.key")).toBe(false);
      const config = JSON.parse(
        new TextDecoder().decode(entries.get("workspace/config.json")),
      ) as Record<string, unknown>;
      expect(config).toEqual({
        theme: "dark",
        nested: { safe: "preserved" },
      });
      const exportedText = [...entries.values()]
        .map((value) => new TextDecoder().decode(value))
        .join("\n");
      expect(exportedText).not.toContain("ces-secret");
      expect(exportedText).not.toContain("gateway-secret");
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("never invokes an external credential collector", async () => {
    const workspace = await workspaceFixture();
    const artifact = await exportPooledWorkerState(exportInput(workspace));
    try {
      expect(
        artifact.manifest.contents.some(({ path }) =>
          path.startsWith("credentials/"),
        ),
      ).toBe(false);
      expect(artifact.receipt.credentialsIncluded).toBe(0);
      expect(artifact.manifest.secrets_redacted).toBe(true);
    } finally {
      await artifact.cleanup();
    }
  });

  test("rejects every workspace symlink", async () => {
    const workspace = await workspaceFixture();
    await writeFile(join(workspace, "target.txt"), "safe");
    await symlink("target.txt", join(workspace, "link.txt"));

    await expect(
      exportPooledWorkerState(exportInput(workspace)),
    ).rejects.toThrow("rejected workspace symlinks");
  });

  test("rejects a workspace reached through a symlinked parent", async () => {
    const workspace = await workspaceFixture();
    const root = resolve(workspace, "..");
    const linkedRoot = join(root, "linked-root");
    await symlink(root, linkedRoot);

    await expect(
      exportPooledWorkerState(exportInput(join(linkedRoot, "workspace"))),
    ).rejects.toThrow("canonical absolute directory");
  });

  test("rejects deeply encoded traversal paths and cleans the temporary archive", async () => {
    const workspace = await workspaceFixture();
    await mkdir(join(workspace, "%2525252e%2525252e"), { recursive: true });
    await writeFile(
      join(workspace, "%2525252e%2525252e", "outside.txt"),
      "should-not-export",
    );

    await expect(
      exportPooledWorkerState(exportInput(workspace)),
    ).rejects.toThrow("traversal or a secret namespace");
  });

  test("rejects unverified actor context before reading the workspace", async () => {
    const workspace = await workspaceFixture();
    await expect(
      exportPooledWorkerState({
        ...exportInput(workspace),
        authContext: serviceAuth({ principalType: "actor" }),
      }),
    ).rejects.toThrow("Verified gateway tenant context is required");
  });
});

describe("pooled config sanitizer", () => {
  test("recursively strips secret-shaped keys and fails closed on invalid JSON", () => {
    expect(
      JSON.parse(
        sanitizePooledStateConfig(
          JSON.stringify({
            safe: true,
            api_token: "secret",
            maxTokens: 8_192,
            nested: { password: "secret", keep: "yes" },
          }),
        ),
      ),
    ).toEqual({
      safe: true,
      maxTokens: 8_192,
      nested: { keep: "yes" },
    });
    expect(() => sanitizePooledStateConfig("{broken")).toThrow(
      "rejected invalid workspace config",
    );
  });
});

function readTarEntries(archive: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(archive);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let paxPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decodeField(header, 0, 100);
    const size = Number.parseInt(decodeField(header, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156] ?? 0);
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      const match = /\d+ path=([^\n]+)\n/u.exec(new TextDecoder().decode(data));
      paxPath = match?.[1];
      continue;
    }
    entries.set(paxPath ?? name, new Uint8Array(data));
    paxPath = undefined;
  }
  return entries;
}

function decodeField(
  buffer: Uint8Array,
  start: number,
  length: number,
): string {
  let end = start;
  while (end < start + length && buffer[end] !== 0) end += 1;
  return new TextDecoder().decode(buffer.subarray(start, end));
}
