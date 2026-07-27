import { describe, expect, test } from "bun:test";

import { S3Client } from "bun";

import {
  assertPooledStateSignedObjectUrl,
  normalizePooledStateStorageBinding,
} from "../pooled-state-signed-url.js";

const BUCKET = "worklin-runtime-state";
const OBJECT_KEY = "tenant-state/org-a/assistant-a/generation-3.vbundle";
const CREDENTIALS = {
  accessKeyId: "railway-access-key",
  secretAccessKey: "railway-secret-key-value",
  region: "auto",
};

function signedUrl(style: "path" | "virtual", objectKey = OBJECT_KEY): string {
  const endpoint =
    style === "virtual"
      ? `https://${BUCKET}.storage.railway.app`
      : "https://storage.railway.app";
  return new S3Client({
    ...CREDENTIALS,
    bucket: BUCKET,
    endpoint,
    virtualHostedStyle: style === "virtual",
  }).presign(objectKey, {
    method: "PUT",
    expiresIn: 600,
    type: "application/octet-stream",
  });
}

function binding(style: "path" | "virtual") {
  return normalizePooledStateStorageBinding({
    stateProvider: "s3",
    stateBucket: BUCKET,
    stateEndpoint: "https://storage.railway.app",
    stateRegion: "auto",
    stateUrlStyle: style,
  });
}

describe("pooled state signed S3 URLs", () => {
  test("accepts exact virtual-hosted and path-style Railway URLs", () => {
    expect(
      assertPooledStateSignedObjectUrl(
        signedUrl("virtual"),
        binding("virtual"),
        OBJECT_KEY,
      ).hostname,
    ).toBe(`${BUCKET}.storage.railway.app`);
    expect(
      assertPooledStateSignedObjectUrl(
        signedUrl("path"),
        binding("path"),
        OBJECT_KEY,
      ).pathname,
    ).toBe(`/${BUCKET}/${OBJECT_KEY}`);
  });

  test("rejects cross-tenant paths, host swaps, traversal, and redirects", () => {
    const valid = signedUrl("virtual");
    const otherTenant = "tenant-state/org-b/assistant-b/generation-3.vbundle";
    expect(() =>
      assertPooledStateSignedObjectUrl(valid, binding("virtual"), otherTenant),
    ).toThrow("object path");

    const hostSwap = new URL(valid);
    hostSwap.hostname = "attacker.example.com";
    expect(() =>
      assertPooledStateSignedObjectUrl(
        hostSwap.href,
        binding("virtual"),
        OBJECT_KEY,
      ),
    ).toThrow("endpoint");

    const traversal = new URL(valid);
    traversal.pathname = `/${encodeURIComponent("../other")}`;
    expect(() =>
      assertPooledStateSignedObjectUrl(
        traversal.href,
        binding("virtual"),
        OBJECT_KEY,
      ),
    ).toThrow("object path");

    const redirect = new URL(valid);
    redirect.searchParams.set("redirect", "https://attacker.example.com");
    expect(() =>
      assertPooledStateSignedObjectUrl(
        redirect.href,
        binding("virtual"),
        OBJECT_KEY,
      ),
    ).toThrow("query");
    expect(() =>
      assertPooledStateSignedObjectUrl(
        valid,
        binding("virtual"),
        "tenant-state/../assistant-a/generation-3.vbundle",
      ),
    ).toThrow("object key");
  });

  test("rejects missing, duplicated, or malformed AWS signature fields", () => {
    for (const mutate of [
      (url: URL) => url.searchParams.delete("X-Amz-Signature"),
      (url: URL) => url.searchParams.append("X-Amz-Date", "20260720T000000Z"),
      (url: URL) => url.searchParams.set("X-Amz-SignedHeaders", "host;x-evil"),
      (url: URL) =>
        url.searchParams.set(
          "X-Amz-Credential",
          "access/20260720/other/s3/aws4_request",
        ),
    ]) {
      const url = new URL(signedUrl("virtual"));
      mutate(url);
      expect(() =>
        assertPooledStateSignedObjectUrl(
          url.href,
          binding("virtual"),
          OBJECT_KEY,
        ),
      ).toThrow();
    }
  });

  test("stores only provider metadata and rejects credential-shaped endpoints", () => {
    const normalized = binding("virtual");
    expect(normalized).toEqual({
      stateProvider: "s3",
      stateBucket: BUCKET,
      stateEndpoint: "https://storage.railway.app/",
      stateRegion: "auto",
      stateUrlStyle: "virtual",
    });
    expect(JSON.stringify(normalized)).not.toContain(
      CREDENTIALS.secretAccessKey,
    );
    expect(() =>
      normalizePooledStateStorageBinding({
        stateProvider: "s3",
        stateBucket: BUCKET,
        stateEndpoint: "https://access:secret@storage.railway.app",
        stateRegion: "auto",
      }),
    ).toThrow("endpoint");
  });
});
