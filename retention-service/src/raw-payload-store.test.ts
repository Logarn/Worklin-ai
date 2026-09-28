import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  FilesystemRawPayloadStore,
  rawPayloadEndpointForBun,
  S3RawPayloadStore,
} from "./raw-payload-store.js";

describe("encrypted raw payload storage", () => {
  test("builds Bun's virtual-hosted endpoint from Railway bucket metadata", () => {
    expect(
      rawPayloadEndpointForBun({
        endpoint: "https://t3.storageapi.dev",
        bucket: "worklin-retention-test",
        virtualHostedStyle: true,
      }),
    ).toBe("https://worklin-retention-test.t3.storageapi.dev");
    expect(
      rawPayloadEndpointForBun({
        endpoint: "https://worklin-retention-test.t3.storageapi.dev",
        bucket: "worklin-retention-test",
        virtualHostedStyle: true,
      }),
    ).toBe("https://worklin-retention-test.t3.storageapi.dev");
  });

  test("uses a tenant-scoped replay key and never receives plaintext", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    const deletes: string[] = [];
    const store = new S3RawPayloadStore({
      endpoint: "https://storage.example.test",
      bucket: "test",
      accessKeyId: "access",
      secretAccessKey: "secret",
      virtualHostedStyle: true,
      client: {
        async write(key, value) {
          writes.push({ key, value });
          return value.length;
        },
        async list() {
          return { contents: [] };
        },
        async delete(key) {
          deletes.push(key);
        },
      },
    });

    const key = await store.putEncryptedPayload({
      organizationId: "11111111-1111-4111-8111-111111111111",
      integrationId: "22222222-2222-4222-8222-222222222222",
      eventId: "33333333-3333-4333-8333-333333333333",
      occurredAt: new Date("2026-07-28T12:00:00.000Z"),
      encryptedPayload: "encrypted-envelope",
    });

    expect(key).toBe(
      "source-events/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/2026-07-28/33333333-3333-4333-8333-333333333333.worklin-encrypted",
    );
    expect(writes).toEqual([{ key, value: "encrypted-envelope" }]);
    expect(await store.ready()).toBe(true);
    await store.deleteEncryptedPayload(key);
    expect(deletes).toEqual([key]);
  });

  test("refuses to delete objects outside the retention prefix", async () => {
    const store = new S3RawPayloadStore({
      endpoint: "https://storage.example.test",
      bucket: "test",
      accessKeyId: "access",
      secretAccessKey: "secret",
      virtualHostedStyle: true,
      client: {
        async write() {
          return 0;
        },
        async list() {
          return { contents: [] };
        },
        async delete() {
          throw new Error("must not be called");
        },
      },
    });
    expect(
      store.deleteEncryptedPayload("../another-tenant/object"),
    ).rejects.toThrow("invalid");
  });

  test("atomically stores encrypted payloads in the configured directory", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "worklin-retention-payloads-"),
    );
    try {
      const store = new FilesystemRawPayloadStore({ rootDirectory });
      expect(await store.ready()).toBe(true);

      const key = await store.putEncryptedPayload({
        organizationId: "11111111-1111-4111-8111-111111111111",
        integrationId: "22222222-2222-4222-8222-222222222222",
        eventId: "33333333-3333-4333-8333-333333333333",
        occurredAt: new Date("2026-07-28T12:00:00.000Z"),
        encryptedPayload: "encrypted-envelope",
      });
      const payloadPath = join(rootDirectory, ...key.split("/"));
      expect(await readFile(payloadPath, "utf8")).toBe(
        "encrypted-envelope",
      );
      expect(
        (await readdir(dirname(payloadPath))).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
      await store.putEncryptedPayload({
        organizationId: "11111111-1111-4111-8111-111111111111",
        integrationId: "22222222-2222-4222-8222-222222222222",
        eventId: "33333333-3333-4333-8333-333333333333",
        occurredAt: new Date("2026-07-28T12:00:00.000Z"),
        encryptedPayload: "updated-encrypted-envelope",
      });
      expect(await readFile(payloadPath, "utf8")).toBe(
        "updated-encrypted-envelope",
      );
      if (process.platform !== "win32") {
        expect((await stat(payloadPath)).mode & 0o777).toBe(0o600);
      }

      await store.deleteEncryptedPayload(key);
      expect(await Bun.file(payloadPath).exists()).toBe(false);
      await store.deleteEncryptedPayload(key);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("rejects unsafe local roots and object references", async () => {
    expect(
      () => new FilesystemRawPayloadStore({ rootDirectory: "relative/path" }),
    ).toThrow("absolute");

    const rootDirectory = await mkdtemp(
      join(tmpdir(), "worklin-retention-payloads-"),
    );
    try {
      const store = new FilesystemRawPayloadStore({ rootDirectory });
      expect(
        store.deleteEncryptedPayload("source-events/org/../../secret"),
      ).rejects.toThrow("invalid");
      expect(
        store.putEncryptedPayload({
          organizationId: "../outside",
          integrationId: "22222222-2222-4222-8222-222222222222",
          eventId: "33333333-3333-4333-8333-333333333333",
          occurredAt: new Date("2026-07-28T12:00:00.000Z"),
          encryptedPayload: "encrypted-envelope",
        }),
      ).rejects.toThrow("invalid");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
