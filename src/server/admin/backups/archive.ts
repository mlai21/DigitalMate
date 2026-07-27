import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "fflate";

import {
  BackupEncryptionKey,
  BackupKeyOperationError,
  type BackupArchiveContents,
  type BackupAttachmentManifest,
  type BackupErrorCode,
  type BackupFileManifest,
  type BackupManifest,
  type BackupMatrixStoreManifest,
  type BackupScope,
  type BackupTableManifest,
} from "@/server/admin/backups/types";

const MAGIC = Buffer.from("DMBACKUP1", "ascii");
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4_096;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);

type OuterHeader = Readonly<{
  formatVersion: 1;
  keyVersion: number;
  nonce: string;
  authTag: string;
}>;

export class BackupArchiveError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode) {
    super(code);
    this.name = "BackupArchiveError";
    this.code = code;
  }
}

export function createEncryptedBackupArchive(
  input: BackupArchiveContents,
  encryptionKey: BackupEncryptionKey,
): Buffer {
  const innerArchive = createInnerArchive(input);
  if (innerArchive.length > MAX_ARCHIVE_BYTES) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const headerCore = {
    formatVersion: FORMAT_VERSION,
    keyVersion: encryptionKey.keyVersion,
    nonce: nonce.toString("base64"),
  } as const;
  const aad = encodeHeaderCore(headerCore);
  const encrypted = encryptionKey.encrypt(
    innerArchive,
    nonce,
    aad,
  );
  const header: OuterHeader = {
    ...headerCore,
    authTag: encrypted.authTag.toString("base64"),
  };
  const encodedHeader = Buffer.from(
    JSON.stringify(header),
    "utf8",
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(encodedHeader.length, 0);
  return Buffer.concat([
    MAGIC,
    headerLength,
    encodedHeader,
    encrypted.ciphertext,
  ]);
}

export function inspectEncryptedBackupArchive(
  archive: Buffer,
  encryptionKey: BackupEncryptionKey,
  options: Readonly<{
    expectedScope?: BackupScope;
    expectedChannelSecretKeyFingerprint?: string | null;
  }> = {},
): Readonly<{
  entries: readonly string[];
  contents: BackupArchiveContents;
}> {
  const { header, ciphertext } = decodeOuterArchive(archive);
  const nonce = decodeFixedBase64(
    header.nonce,
    NONCE_BYTES,
  );
  const authTag = decodeFixedBase64(
    header.authTag,
    AUTH_TAG_BYTES,
  );
  let plaintext: Buffer;
  try {
    plaintext = encryptionKey.decrypt(
      ciphertext,
      nonce,
      authTag,
      encodeHeaderCore({
        formatVersion: header.formatVersion,
        keyVersion: header.keyVersion,
        nonce: header.nonce,
      }),
    );
  } catch (error) {
    if (
      error instanceof BackupKeyOperationError
      && error.code === "backup_authentication_failed"
    ) {
      throw new BackupArchiveError(
        "backup_authentication_failed",
      );
    }
    throw error;
  }
  const entries = unzipArchive(plaintext);
  const contents = parseInnerArchive(entries);
  assertExpectedScope(contents.manifest, options.expectedScope);
  if (
    options.expectedChannelSecretKeyFingerprint
      !== undefined
    && contents.manifest.channelSecretKeyFingerprint
      !== options.expectedChannelSecretKeyFingerprint
  ) {
    throw new BackupArchiveError(
      "channel_secret_key_mismatch",
    );
  }
  return {
    entries: Object.keys(entries).sort(),
    contents,
  };
}

export async function writeEncryptedBackupArchive(
  input: Readonly<{
    rootDirectory: string;
    storageKey: string;
    contents: BackupArchiveContents;
    encryptionKey: BackupEncryptionKey;
  }>,
): Promise<Readonly<{
  storageKey: string;
  checksum: string;
  sizeBytes: number;
}>> {
  assertUuid(input.storageKey);
  const root = path.resolve(input.rootDirectory);
  const filePath = path.resolve(root, input.storageKey);
  assertContainedPath(root, filePath);
  const bytes = createEncryptedBackupArchive(
    input.contents,
    input.encryptionKey,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const handle = await open(filePath, "wx", 0o600);
  let completed = false;
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) {
      await unlink(filePath).catch(() => undefined);
    }
  }
  return {
    storageKey: input.storageKey,
    checksum: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

function createInnerArchive(
  input: BackupArchiveContents,
): Buffer {
  const entries: Record<string, Uint8Array> = {};
  const tableManifest: Record<
    string,
    BackupTableManifest
  > = {};
  for (
    const [table, rows]
      of Object.entries(input.tables).sort(([left], [right]) =>
        left.localeCompare(right)
      )
  ) {
    if (!TABLE_PATTERN.test(table)) {
      throw new BackupArchiveError("backup_archive_invalid");
    }
    const bytes = strToU8(JSON.stringify(rows));
    entries[`database/${table}.json`] = bytes;
    tableManifest[table] = {
      rows: rows.length,
      sha256: sha256(bytes),
    };
  }
  const attachmentManifest: BackupAttachmentManifest[] =
    [];
  for (
    const descriptor of [...input.manifest.attachments]
      .sort((left, right) =>
        left.storageKey.localeCompare(right.storageKey)
      )
  ) {
    assertUuid(descriptor.storageKey);
    assertAttachmentMimeType(descriptor.mimeType);
    const bytes = input.attachments[descriptor.storageKey];
    if (!bytes) {
      throw new BackupArchiveError(
        "backup_attachment_invalid",
      );
    }
    entries[`attachments/${descriptor.storageKey}`] = bytes;
    attachmentManifest.push({
      storageKey: descriptor.storageKey,
      mimeType: descriptor.mimeType,
      ...fileManifest(bytes),
    });
  }
  const matrixManifest: BackupMatrixStoreManifest[] = [];
  for (
    const descriptor of [...input.manifest.matrixStores]
      .sort((left, right) =>
        left.connectionId.localeCompare(right.connectionId)
      )
  ) {
    assertUuid(descriptor.connectionId);
    const bytes = input.matrixStores[descriptor.connectionId];
    if (!bytes) {
      throw new BackupArchiveError("backup_archive_invalid");
    }
    entries[
      `matrix/connections/${descriptor.connectionId}/crypto-store.bin`
    ] = bytes;
    matrixManifest.push({
      connectionId: descriptor.connectionId,
      ...fileManifest(bytes),
    });
  }
  const manifest: BackupManifest = {
    ...input.manifest,
    tables: tableManifest,
    attachments: attachmentManifest,
    matrixStores: matrixManifest,
  };
  entries["manifest.json"] = strToU8(
    JSON.stringify(manifest),
  );
  return Buffer.from(zipSync(entries, { level: 6 }));
}

function parseInnerArchive(
  entries: Readonly<Record<string, Uint8Array>>,
): BackupArchiveContents {
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  const manifest = parseManifest(manifestBytes);
  assertWhitelistedEntries(entries, manifest);
  const tables: Record<
    string,
    readonly Record<string, unknown>[]
  > = {};
  for (const [table, expected] of Object.entries(
    manifest.tables,
  )) {
    if (!TABLE_PATTERN.test(table)) {
      throw new BackupArchiveError("backup_archive_invalid");
    }
    const bytes = entries[`database/${table}.json`];
    if (
      !bytes
      || sha256(bytes) !== expected.sha256
    ) {
      throw new BackupArchiveError(
        "backup_checksum_mismatch",
      );
    }
    const rows = parseJson(bytes);
    if (
      !Array.isArray(rows)
      || rows.length !== expected.rows
      || rows.some((row) => !isRecord(row))
    ) {
      throw new BackupArchiveError("backup_archive_invalid");
    }
    tables[table] = rows as Record<string, unknown>[];
  }
  const attachments: Record<string, Buffer> = {};
  for (const expected of manifest.attachments) {
    assertUuid(expected.storageKey);
    assertAttachmentMimeType(expected.mimeType);
    const bytes =
      entries[`attachments/${expected.storageKey}`];
    assertFile(bytes, expected);
    attachments[expected.storageKey] = Buffer.from(bytes);
  }
  const matrixStores: Record<string, Buffer> = {};
  for (const expected of manifest.matrixStores) {
    assertUuid(expected.connectionId);
    const bytes =
      entries[
        `matrix/connections/${expected.connectionId}/crypto-store.bin`
      ];
    assertFile(bytes, expected);
    matrixStores[expected.connectionId] = Buffer.from(bytes);
  }
  return {
    manifest,
    tables,
    attachments,
    matrixStores,
  };
}

function assertWhitelistedEntries(
  entries: Readonly<Record<string, Uint8Array>>,
  manifest: BackupManifest,
): void {
  const allowed = new Set<string>(["manifest.json"]);
  for (const table of Object.keys(manifest.tables)) {
    allowed.add(`database/${table}.json`);
  }
  for (const attachment of manifest.attachments) {
    allowed.add(`attachments/${attachment.storageKey}`);
  }
  for (const store of manifest.matrixStores) {
    allowed.add(
      `matrix/connections/${store.connectionId}/crypto-store.bin`,
    );
  }
  if (
    Object.keys(entries).some((entry) => !allowed.has(entry))
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
}

function decodeOuterArchive(archive: Buffer): {
  header: OuterHeader;
  ciphertext: Buffer;
} {
  if (
    archive.length < MAGIC.length + 4
    || !archive.subarray(0, MAGIC.length).equals(MAGIC)
    || archive.length > MAX_ARCHIVE_BYTES
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  const headerLength = archive.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (
    headerLength <= 0
    || headerLength > MAX_HEADER_BYTES
    || ciphertextStart >= archive.length
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  const parsed = parseJson(
    archive.subarray(headerStart, ciphertextStart),
  );
  if (
    !isRecord(parsed)
    || parsed.formatVersion !== FORMAT_VERSION
    || parsed.keyVersion !== 1
    || typeof parsed.nonce !== "string"
    || typeof parsed.authTag !== "string"
    || Object.keys(parsed).some(
      (key) =>
        ![
          "formatVersion",
          "keyVersion",
          "nonce",
          "authTag",
        ].includes(key),
    )
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  return {
    header: parsed as OuterHeader,
    ciphertext: archive.subarray(ciphertextStart),
  };
}

function parseManifest(bytes: Uint8Array): BackupManifest {
  const parsed = parseJson(bytes);
  if (
    !isRecord(parsed)
    || parsed.formatVersion !== FORMAT_VERSION
    || typeof parsed.createdAt !== "string"
    || !isScope(parsed.source)
    || (
      parsed.channelSecretKeyFingerprint !== null
      && typeof parsed.channelSecretKeyFingerprint !== "string"
    )
    || !isRecord(parsed.tables)
    || !Array.isArray(parsed.attachments)
    || !Array.isArray(parsed.matrixStores)
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  return parsed as BackupManifest;
}

function unzipArchive(
  plaintext: Buffer,
): Record<string, Uint8Array> {
  try {
    return unzipSync(plaintext);
  } catch {
    throw new BackupArchiveError("backup_archive_invalid");
  }
}

function assertExpectedScope(
  manifest: BackupManifest,
  expected: BackupScope | undefined,
): void {
  if (!expected) return;
  if (manifest.source.userId !== expected.userId) {
    throw new BackupArchiveError("backup_scope_mismatch");
  }
  if (manifest.source.agentId !== expected.agentId) {
    throw new BackupArchiveError("backup_agent_mismatch");
  }
}

function assertFile(
  bytes: Uint8Array | undefined,
  expected: BackupFileManifest,
): asserts bytes is Uint8Array {
  if (
    !bytes
    || bytes.length !== expected.size
    || sha256(bytes) !== expected.sha256
  ) {
    throw new BackupArchiveError(
      "backup_checksum_mismatch",
    );
  }
}

function fileManifest(
  bytes: Uint8Array,
): BackupFileManifest {
  return {
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function encodeHeaderCore(input: Readonly<{
  formatVersion: 1;
  keyVersion: number;
  nonce: string;
}>): Buffer {
  return Buffer.from(JSON.stringify(input), "utf8");
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new BackupArchiveError("backup_archive_invalid");
  }
}

function decodeFixedBase64(
  value: string,
  bytes: number,
): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== bytes
    || decoded.toString("base64") !== value
  ) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
  return decoded;
}

function assertAttachmentMimeType(value: string): void {
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(value)) {
    throw new BackupArchiveError(
      "backup_attachment_invalid",
    );
  }
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
}

function assertContainedPath(
  root: string,
  target: string,
): void {
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new BackupArchiveError("backup_archive_invalid");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  );
}

function isScope(value: unknown): value is BackupScope {
  return (
    isRecord(value)
    && typeof value.userId === "string"
    && typeof value.agentId === "string"
  );
}
