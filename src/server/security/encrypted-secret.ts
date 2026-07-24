import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { inspect } from "node:util";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const CURRENT_KEY_VERSION = 1;

export type SecretEncryptionErrorCode =
  | "invalid_secret_key"
  | "invalid_secret_encoding"
  | "secret_key_version_unsupported"
  | "secret_authentication_failed";

export type EncryptedSecretStorageRecord = Readonly<{
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}>;

export type ChannelSecretsKeyState =
  | Readonly<{
      status: "ready";
      key: ChannelSecretsKey;
    }>
  | Readonly<{
      status: "blocked";
      code:
        | "channel_secrets_key_missing"
        | "channel_secrets_key_invalid";
    }>;

export class SecretEncryptionError extends Error {
  readonly code: SecretEncryptionErrorCode;

  constructor(code: SecretEncryptionErrorCode) {
    super(code);
    this.name = "SecretEncryptionError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: SecretEncryptionErrorCode }> {
    return { code: this.code };
  }
}

export class EncryptedSecret {
  readonly keyVersion: number;
  readonly #ciphertext: Buffer;
  readonly #nonce: Buffer;
  readonly #authTag: Buffer;

  private constructor(record: EncryptedSecretStorageRecord) {
    this.keyVersion = record.keyVersion;
    this.#ciphertext = Buffer.from(record.ciphertext);
    this.#nonce = Buffer.from(record.nonce);
    this.#authTag = Buffer.from(record.authTag);
    Object.freeze(this);
  }

  static fromStorage(record: {
    ciphertext: Buffer | string;
    nonce: Buffer | string;
    authTag: Buffer | string;
    keyVersion: number;
  }): EncryptedSecret {
    if (record.keyVersion !== CURRENT_KEY_VERSION) {
      throw new SecretEncryptionError(
        "secret_key_version_unsupported",
      );
    }
    const ciphertext = decodeStorageValue(record.ciphertext);
    const nonce = decodeStorageValue(record.nonce);
    const authTag = decodeStorageValue(record.authTag);
    if (
      ciphertext.length === 0 ||
      nonce.length !== NONCE_BYTES ||
      authTag.length !== AUTH_TAG_BYTES
    ) {
      throw new SecretEncryptionError("invalid_secret_encoding");
    }
    return new EncryptedSecret({
      ciphertext,
      nonce,
      authTag,
      keyVersion: record.keyVersion,
    });
  }

  toStorageRecord(): EncryptedSecretStorageRecord {
    return {
      ciphertext: Buffer.from(this.#ciphertext),
      nonce: Buffer.from(this.#nonce),
      authTag: Buffer.from(this.#authTag),
      keyVersion: this.keyVersion,
    };
  }

  toJSON(): Readonly<{
    configured: true;
    keyVersion: number;
  }> {
    return {
      configured: true,
      keyVersion: this.keyVersion,
    };
  }

  toString(): string {
    return `[EncryptedSecret keyVersion=${this.keyVersion}]`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export class ChannelSecretsKey {
  readonly keyVersion = CURRENT_KEY_VERSION;
  readonly #material: Buffer;

  private constructor(material: Buffer) {
    this.#material = Buffer.from(material);
    Object.freeze(this);
  }

  static fromBase64(encoded: string): ChannelSecretsKey {
    return new ChannelSecretsKey(decodeKey(encoded));
  }

  encrypt(plaintext: string): EncryptedSecret {
    return encryptSecret(plaintext, {
      key: this.#material,
      keyVersion: this.keyVersion,
    });
  }

  decrypt(encrypted: EncryptedSecret): string {
    return decryptSecret(encrypted, this.#material);
  }

  toJSON(): Readonly<{
    configured: true;
    keyVersion: number;
  }> {
    return {
      configured: true,
      keyVersion: this.keyVersion,
    };
  }

  toString(): string {
    return `[ChannelSecretsKey keyVersion=${this.keyVersion}]`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export function createChannelSecretsKey(
  encoded: string | undefined,
): ChannelSecretsKeyState {
  if (encoded === undefined || encoded.length === 0) {
    return Object.freeze({
      status: "blocked",
      code: "channel_secrets_key_missing",
    });
  }
  try {
    return Object.freeze({
      status: "ready",
      key: ChannelSecretsKey.fromBase64(encoded),
    });
  } catch {
    return Object.freeze({
      status: "blocked",
      code: "channel_secrets_key_invalid",
    });
  }
}

export function encryptSecret(
  plaintext: string,
  input: {
    key: Buffer;
    keyVersion: number;
  },
): EncryptedSecret {
  const key = validateRawKey(input.key);
  if (input.keyVersion !== CURRENT_KEY_VERSION) {
    throw new SecretEncryptionError(
      "secret_key_version_unsupported",
    );
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return EncryptedSecret.fromStorage({
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion: input.keyVersion,
  });
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  rawKey: Buffer,
): string {
  const key = validateRawKey(rawKey);
  if (encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new SecretEncryptionError(
      "secret_key_version_unsupported",
    );
  }
  const storage = encrypted.toStorageRecord();
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      storage.nonce,
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAuthTag(storage.authTag);
    return Buffer.concat([
      decipher.update(storage.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretEncryptionError(
      "secret_authentication_failed",
    );
  }
}

export function encryptedSecretFromStorage(record: {
  ciphertext: Buffer | string;
  nonce: Buffer | string;
  authTag: Buffer | string;
  keyVersion: number;
}): EncryptedSecret {
  return EncryptedSecret.fromStorage(record);
}

function validateRawKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new SecretEncryptionError("invalid_secret_key");
  }
  return Buffer.from(key);
}

function decodeKey(encoded: string): Buffer {
  const decoded = decodeCanonicalBase64(encoded);
  if (decoded.length !== KEY_BYTES) {
    throw new SecretEncryptionError("invalid_secret_key");
  }
  return decoded;
}

function decodeStorageValue(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  try {
    return decodeCanonicalBase64(value);
  } catch {
    throw new SecretEncryptionError("invalid_secret_encoding");
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new SecretEncryptionError("invalid_secret_encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new SecretEncryptionError("invalid_secret_encoding");
  }
  return decoded;
}
