import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function keyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptString(plaintext: string, passphrase: string): EncryptedEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromPassphrase(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptString(envelope: EncryptedEnvelope, passphrase: string): string {
  if (envelope.alg !== "aes-256-gcm" || envelope.v !== 1) {
    throw new Error("unsupported encrypted envelope");
  }
  const decipher = createDecipheriv(
    envelope.alg,
    keyFromPassphrase(passphrase, Buffer.from(envelope.salt, "base64")),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptJson(value: unknown, passphrase: string): EncryptedEnvelope {
  return encryptString(JSON.stringify(value), passphrase);
}

export function decryptJson<T>(envelope: EncryptedEnvelope, passphrase: string): T {
  return JSON.parse(decryptString(envelope, passphrase)) as T;
}
