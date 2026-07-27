import {
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { inspect } from "node:util";

const BACKUP_KEY_BYTES = 32;
const BACKUP_KEY_VERSION = 1;

export type BackupErrorCode =
  | "backup_encryption_key_missing"
  | "backup_encryption_key_invalid"
  | "backup_encryption_key_reused"
  | "backup_authentication_failed"
  | "backup_archive_invalid"
  | "backup_checksum_mismatch"
  | "backup_scope_mismatch"
  | "backup_agent_mismatch"
  | "channel_secret_key_mismatch"
  | "backup_attachment_invalid"
  | "backup_not_found"
  | "backup_not_ready"
  | "backup_restore_confirmation_required";

export type BackupEncryptionKeyState =
  | Readonly<{
      status: "ready";
      key: BackupEncryptionKey;
    }>
  | Readonly<{
      status: "blocked";
      code:
        | "backup_encryption_key_missing"
        | "backup_encryption_key_invalid"
        | "backup_encryption_key_reused";
    }>;

export type BackupScope = Readonly<{
  userId: string;
  agentId: string;
}>;

export type BackupTableManifest = Readonly<{
  rows: number;
  sha256: string;
}>;

export type BackupFileManifest = Readonly<{
  size: number;
  sha256: string;
}>;

export type BackupAttachmentManifest =
  BackupFileManifest & Readonly<{
    storageKey: string;
    mimeType: string;
  }>;

export type BackupMatrixStoreManifest =
  BackupFileManifest & Readonly<{
    connectionId: string;
  }>;

export type BackupManifest = Readonly<{
  formatVersion: 1;
  createdAt: string;
  source: BackupScope;
  channelSecretKeyFingerprint: string | null;
  tables: Readonly<
    Record<string, BackupTableManifest>
  >;
  attachments: readonly BackupAttachmentManifest[];
  matrixStores: readonly BackupMatrixStoreManifest[];
}>;

export type BackupArchiveContents = Readonly<{
  manifest: BackupManifest;
  tables: Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  attachments: Readonly<Record<string, Buffer>>;
  matrixStores: Readonly<Record<string, Buffer>>;
}>;

export type BackupJobStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "restoring";

export type BackupJobKind = "disaster_recovery" | "imported";

export type BackupJob = Readonly<{
  id: string;
  userId: string;
  agentId: string;
  name: string;
  description: string;
  status: BackupJobStatus;
  kind: BackupJobKind;
  storageKey: string | null;
  checksum: string | null;
  sizeBytes: number | null;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date;
}>;

export class BackupEncryptionKey {
  readonly keyVersion = BACKUP_KEY_VERSION;
  readonly #material: Buffer;

  private constructor(material: Buffer) {
    this.#material = Buffer.from(material);
    Object.freeze(this);
  }

  static fromBase64(value: string): BackupEncryptionKey {
    const material = decodeBackupKey(value);
    return new BackupEncryptionKey(material);
  }

  encrypt(
    plaintext: Buffer,
    nonce: Buffer,
    aad: Buffer,
  ): Readonly<{ ciphertext: Buffer; authTag: Buffer }> {
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#material,
      nonce,
    );
    cipher.setAAD(aad);
    return {
      ciphertext: Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]),
      authTag: cipher.getAuthTag(),
    };
  }

  decrypt(
    ciphertext: Buffer,
    nonce: Buffer,
    authTag: Buffer,
    aad: Buffer,
  ): Buffer {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#material,
        nonce,
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new BackupKeyOperationError(
        "backup_authentication_failed",
      );
    }
  }

  fingerprint(domain: string): string {
    return `sha256:${
      createHash("sha256")
        .update("digitalmate.backup-key-fingerprint\0")
        .update(domain)
        .update("\0")
        .update(this.#material)
        .digest("hex")
    }`;
  }

  equalsBytes(value: Buffer): boolean {
    return (
      value.length === this.#material.length
      && value.equals(this.#material)
    );
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
    return `[BackupEncryptionKey keyVersion=${this.keyVersion}]`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export class BackupKeyOperationError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode) {
    super(code);
    this.name = "BackupKeyOperationError";
    this.code = code;
  }
}

export function createBackupEncryptionKey(
  encoded: string | undefined,
  input: Readonly<{
    appSecret?: string;
    channelSecretsKey?: string;
  }> = {},
): BackupEncryptionKeyState {
  if (!encoded?.trim()) {
    return {
      status: "blocked",
      code: "backup_encryption_key_missing",
    };
  }
  if (
    encoded.trim() === input.appSecret?.trim()
    || encoded.trim() === input.channelSecretsKey?.trim()
  ) {
    return {
      status: "blocked",
      code: "backup_encryption_key_reused",
    };
  }
  let key: BackupEncryptionKey;
  try {
    key = BackupEncryptionKey.fromBase64(encoded);
  } catch {
    return {
      status: "blocked",
      code: "backup_encryption_key_invalid",
    };
  }
  const forbidden = [
    input.appSecret
      ? Buffer.from(input.appSecret, "utf8")
      : null,
    decodeOptionalKey(input.channelSecretsKey),
  ].filter((value): value is Buffer => value !== null);
  if (forbidden.some((value) => key.equalsBytes(value))) {
    return {
      status: "blocked",
      code: "backup_encryption_key_reused",
    };
  }
  return { status: "ready", key };
}

function decodeBackupKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (
    decoded.length !== BACKUP_KEY_BYTES
    || decoded.toString("base64") !== trimmed
  ) {
    throw new BackupKeyOperationError(
      "backup_encryption_key_invalid",
    );
  }
  return decoded;
}

function decodeOptionalKey(
  value: string | undefined,
): Buffer | null {
  if (!value?.trim()) return null;
  try {
    return decodeBackupKey(value);
  } catch {
    return null;
  }
}
