import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Seals secrets (provider credentials, bot tokens) at rest with AES-256-GCM.
 * The key derives from SOLOAGENT_SECRET, or a random secret generated on first boot.
 */
export class Sealer {
  #key: Buffer;

  constructor(secret: string) {
    this.#key = scryptSync(secret, "soloagent.dev/v1", 32);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(sealed: string): string {
    const parts = sealed.split(".");
    if (parts.length !== 4) throw new Error("Unrecognized sealed value");
    const [version, iv, tag, body] = parts;
    if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("Unrecognized sealed value");
    const ivBuf = Buffer.from(iv, "base64url");
    const tagBuf = Buffer.from(tag, "base64url");
    if (ivBuf.length !== 12 || tagBuf.length !== 16) throw new Error("Unrecognized sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, ivBuf, { authTagLength: 16 });
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}
