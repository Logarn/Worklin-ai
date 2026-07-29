import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

function purposeKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), purpose, 32),
  );
}

export class RetentionCrypto {
  readonly #encryptionKey: Buffer;
  readonly #blindIndexKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error("Retention encryption key must be 32 bytes.");
    }
    this.#encryptionKey = purposeKey(masterKey, "retention-field-encryption-v1");
    this.#blindIndexKey = purposeKey(masterKey, "retention-blind-index-v1");
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string, context: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      value.split(".");
    if (
      version !== VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      throw new Error("Unsupported encrypted retention value.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#encryptionKey,
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  blindIndex(value: string, namespace: string): string {
    return createHmac("sha256", this.#blindIndexKey)
      .update(namespace)
      .update("\0")
      .update(value.trim().toLocaleLowerCase())
      .digest("hex");
  }

  sealRoute(payload: {
    organizationId: string;
    integrationId: string;
    provider: "shopify" | "klaviyo";
  }): string {
    return this.encrypt(
      JSON.stringify(payload),
      "retention-webhook-route-v1",
    );
  }

  openRoute(value: string): {
    organizationId: string;
    integrationId: string;
    provider: "shopify" | "klaviyo";
  } {
    const parsed = JSON.parse(
      this.decrypt(value, "retention-webhook-route-v1"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.integrationId !== "string" ||
      (parsed.provider !== "shopify" && parsed.provider !== "klaviyo")
    ) {
      throw new Error("Invalid retention webhook route.");
    }
    return {
      organizationId: parsed.organizationId,
      integrationId: parsed.integrationId,
      provider: parsed.provider,
    };
  }
}
