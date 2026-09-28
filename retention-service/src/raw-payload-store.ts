import { S3Client } from "bun";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from "node:path";

export interface RawPayloadStore {
  putEncryptedPayload(input: {
    organizationId: string;
    integrationId: string;
    eventId: string;
    occurredAt: Date;
    encryptedPayload: string;
  }): Promise<string>;
  deleteEncryptedPayload(reference: string): Promise<void>;
  ready(): Promise<boolean>;
}

interface RawObjectClient {
  write(
    key: string,
    value: string,
    options?: BlobPropertyBag,
  ): Promise<number>;
  list(options?: { maxKeys?: number }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export function rawPayloadEndpointForBun(input: {
  endpoint: string;
  bucket: string;
  virtualHostedStyle: boolean;
}): string {
  const endpoint = new URL(input.endpoint);
  if (
    input.virtualHostedStyle &&
    !endpoint.hostname.startsWith(`${input.bucket}.`)
  ) {
    endpoint.hostname = `${input.bucket}.${endpoint.hostname}`;
  }
  return endpoint.toString().replace(/\/$/, "");
}

export function rawPayloadReference(input: {
  organizationId: string;
  integrationId: string;
  eventId: string;
  occurredAt: Date;
}): string {
  const day = input.occurredAt.toISOString().slice(0, 10);
  return [
    "source-events",
    input.organizationId,
    input.integrationId,
    day,
    `${input.eventId}.worklin-encrypted`,
  ].join("/");
}

const SAFE_REFERENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RAW_PAYLOAD_SUFFIX = ".worklin-encrypted";

function rawPayloadReferenceSegments(reference: string): string[] {
  const segments = reference.split("/");
  const eventFile = segments[4] ?? "";
  const eventId = eventFile.endsWith(RAW_PAYLOAD_SUFFIX)
    ? eventFile.slice(0, -RAW_PAYLOAD_SUFFIX.length)
    : "";
  if (
    reference.startsWith("/") ||
    reference.includes("\\") ||
    segments.length !== 5 ||
    segments[0] !== "source-events" ||
    !SAFE_REFERENCE_SEGMENT.test(segments[1] ?? "") ||
    !SAFE_REFERENCE_SEGMENT.test(segments[2] ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(segments[3] ?? "") ||
    !SAFE_REFERENCE_SEGMENT.test(eventId)
  ) {
    throw new Error("Raw payload reference is invalid.");
  }
  return segments;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

export class FilesystemRawPayloadStore implements RawPayloadStore {
  readonly rootDirectory: string;

  constructor(input: { rootDirectory: string }) {
    if (!isAbsolute(input.rootDirectory)) {
      throw new Error("Raw payload directory must be absolute.");
    }
    this.rootDirectory = resolve(input.rootDirectory);
    if (this.rootDirectory === parse(this.rootDirectory).root) {
      throw new Error("Raw payload directory cannot be a filesystem root.");
    }
  }

  async putEncryptedPayload(input: {
    organizationId: string;
    integrationId: string;
    eventId: string;
    occurredAt: Date;
    encryptedPayload: string;
  }): Promise<string> {
    const reference = rawPayloadReference(input);
    const destination = this.pathForReference(reference);
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = join(
      directory,
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(input.encryptedPayload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, destination);
      await chmod(destination, 0o600);
      await syncDirectory(directory);
      return reference;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async ready(): Promise<boolean> {
    const probe = join(
      this.rootDirectory,
      `.worklin-readiness-${randomUUID()}`,
    );
    let handle;
    try {
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.rootDirectory, 0o700);
      handle = await open(probe, "wx", 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await unlink(probe);
      await syncDirectory(this.rootDirectory);
      return true;
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(probe).catch(() => undefined);
      return false;
    }
  }

  async deleteEncryptedPayload(reference: string): Promise<void> {
    const destination = this.pathForReference(reference);
    try {
      await unlink(destination);
      await syncDirectory(dirname(destination));
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  private pathForReference(reference: string): string {
    const segments = rawPayloadReferenceSegments(reference);
    const destination = resolve(this.rootDirectory, ...segments);
    const rootPrefix = this.rootDirectory.endsWith(sep)
      ? this.rootDirectory
      : `${this.rootDirectory}${sep}`;
    if (!destination.startsWith(rootPrefix)) {
      throw new Error("Raw payload reference is invalid.");
    }
    return destination;
  }
}

export class S3RawPayloadStore implements RawPayloadStore {
  readonly client: RawObjectClient;

  constructor(input: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    virtualHostedStyle: boolean;
    client?: RawObjectClient;
  }) {
    this.client =
      input.client ??
      new S3Client({
        endpoint: rawPayloadEndpointForBun(input),
        bucket: input.bucket,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        ...(input.region ? { region: input.region } : {}),
        virtualHostedStyle: input.virtualHostedStyle,
      });
  }

  async putEncryptedPayload(input: {
    organizationId: string;
    integrationId: string;
    eventId: string;
    occurredAt: Date;
    encryptedPayload: string;
  }): Promise<string> {
    const key = rawPayloadReference(input);
    await this.client.write(key, input.encryptedPayload, {
      type: "application/vnd.worklin.encrypted-payload",
    });
    return key;
  }

  async ready(): Promise<boolean> {
    try {
      await this.client.list({ maxKeys: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async deleteEncryptedPayload(reference: string): Promise<void> {
    rawPayloadReferenceSegments(reference);
    await this.client.delete(reference);
  }
}
