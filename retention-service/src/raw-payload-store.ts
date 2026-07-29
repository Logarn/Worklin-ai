import { S3Client } from "bun";

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
    if (
      reference.startsWith("/") ||
      reference.includes("..") ||
      reference.includes("\\") ||
      !reference.startsWith("source-events/")
    ) {
      throw new Error("Raw payload reference is invalid.");
    }
    await this.client.delete(reference);
  }
}
