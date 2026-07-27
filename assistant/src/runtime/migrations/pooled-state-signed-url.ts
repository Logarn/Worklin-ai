import { validateGcsSignedUrl } from "./gcs-signed-url.js";

export type PooledStateProvider = "gcs" | "s3";
export type PooledStateS3UrlStyle = "path" | "virtual";

export interface PooledStateStorageBindingInput {
  stateProvider?: PooledStateProvider;
  stateBucket: string;
  stateEndpoint?: string;
  stateRegion?: string;
  stateUrlStyle?: PooledStateS3UrlStyle;
}

export type PooledStateStorageBinding =
  | Readonly<{
      stateProvider: "gcs";
      stateBucket: string;
    }>
  | Readonly<{
      stateProvider: "s3";
      stateBucket: string;
      stateEndpoint: string;
      stateRegion: string;
      stateUrlStyle: PooledStateS3UrlStyle;
    }>;

const CONTENT_TYPE = "application/octet-stream";

export function normalizePooledStateStorageBinding(
  input: PooledStateStorageBindingInput,
): PooledStateStorageBinding {
  const stateBucket = assertBucket(input.stateBucket);
  const provider = input.stateProvider ?? "gcs";
  if (provider === "gcs") {
    if (input.stateEndpoint || input.stateRegion || input.stateUrlStyle) {
      throw new Error("GCS pooled state metadata must not include S3 fields.");
    }
    return Object.freeze({ stateProvider: "gcs", stateBucket });
  }
  if (provider !== "s3") {
    throw new Error("Pooled worker state provider is invalid.");
  }
  const stateEndpoint = parseEndpoint(input.stateEndpoint ?? "").href;
  const stateRegion = input.stateRegion?.trim() ?? "";
  const stateUrlStyle = input.stateUrlStyle ?? "virtual";
  if (
    !/^[A-Za-z0-9._-]{1,64}$/u.test(stateRegion) ||
    (stateUrlStyle !== "virtual" && stateUrlStyle !== "path")
  ) {
    throw new Error("Pooled worker S3 state metadata is invalid.");
  }
  if (stateUrlStyle === "virtual" && stateBucket.includes(".")) {
    throw new Error(
      "Virtual-hosted pooled S3 buckets must be a single DNS label.",
    );
  }
  return Object.freeze({
    stateProvider: "s3",
    stateBucket,
    stateEndpoint,
    stateRegion,
    stateUrlStyle,
  });
}

export function assertPooledStateSignedObjectUrl(
  rawUrl: string,
  binding: PooledStateStorageBinding,
  objectKey: string,
): URL {
  assertObjectKey(objectKey);
  if (binding.stateProvider === "gcs") {
    if (!validateGcsSignedUrl(rawUrl).ok) {
      throw new Error("Pooled GCS signed URL is invalid.");
    }
    const url = new URL(rawUrl);
    const expectedPath = `/${encodeSegment(
      binding.stateBucket,
    )}/${encodeObjectKey(objectKey)}`;
    if (url.pathname !== expectedPath) {
      throw new Error("Pooled state URL object path is invalid.");
    }
    return url;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Pooled S3 signed URL is invalid.");
  }
  const endpoint = parseEndpoint(binding.stateEndpoint);
  const expectedOrigin =
    binding.stateUrlStyle === "path"
      ? endpoint.origin
      : virtualHostedOrigin(endpoint, binding.stateBucket);
  const expectedPath =
    binding.stateUrlStyle === "path"
      ? `/${encodeSegment(binding.stateBucket)}/${encodeObjectKey(objectKey)}`
      : `/${encodeObjectKey(objectKey)}`;
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  ) {
    throw new Error("Pooled S3 signed URL endpoint or object path is invalid.");
  }

  const allowed = new Set([
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
    "response-content-type",
  ]);
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => !allowed.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw new Error("Pooled S3 signed URL query is invalid.");
  }
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  const date = url.searchParams.get("X-Amz-Date") ?? "";
  const expires = url.searchParams.get("X-Amz-Expires") ?? "";
  const credentialParts = credential.split("/");
  const responseType = url.searchParams.get("response-content-type");
  if (
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !/^\d{8}T\d{6}Z$/u.test(date) ||
    !/^[1-9]\d{0,5}$/u.test(expires) ||
    Number(expires) > 7 * 24 * 60 * 60 ||
    !/^[a-f0-9]{64}$/u.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    url.searchParams.get("X-Amz-SignedHeaders") !== "host" ||
    credentialParts.length !== 5 ||
    !credentialParts[0] ||
    credentialParts[1] !== date.slice(0, 8) ||
    credentialParts[2] !== binding.stateRegion ||
    credentialParts[3] !== "s3" ||
    credentialParts[4] !== "aws4_request" ||
    (responseType !== null && responseType !== CONTENT_TYPE)
  ) {
    throw new Error("Pooled S3 signed URL authorization is invalid.");
  }
  return url;
}

function virtualHostedOrigin(endpoint: URL, bucket: string): string {
  if (
    endpoint.hostname === bucket ||
    endpoint.hostname.startsWith(`${bucket}.`)
  ) {
    return endpoint.origin;
  }
  return `https://${bucket}.${endpoint.hostname}`;
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Pooled worker S3 state endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      endpoint.hostname,
    ) ||
    endpoint.hostname.endsWith(".localhost") ||
    endpoint.hostname.endsWith(".local")
  ) {
    throw new Error("Pooled worker S3 state endpoint is invalid.");
  }
  endpoint.pathname = "/";
  return endpoint;
}

function assertObjectKey(objectKey: string): void {
  const match =
    /^tenant-state\/([^/]+)\/([^/]+)\/generation-[1-9]\d*\.vbundle$/u.exec(
      objectKey,
    );
  if (!match?.[1] || !match[2] || /[\u0000-\u001f\u007f]/u.test(objectKey)) {
    throw new Error("Pooled state object key is invalid.");
  }
  for (const encoded of [match[1], match[2]]) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw new Error("Pooled state object key is invalid.");
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      encodeURIComponent(decoded) !== encoded
    ) {
      throw new Error("Pooled state object key is invalid.");
    }
  }
}

function assertBucket(bucket: string): string {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/u.test(bucket) ||
    bucket.includes("..") ||
    bucket.startsWith("goog") ||
    /^(\d{1,3}\.){3}\d{1,3}$/u.test(bucket)
  ) {
    throw new Error("Pooled worker state bucket is invalid.");
  }
  return bucket;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodeSegment).join("/");
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
